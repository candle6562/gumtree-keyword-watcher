import { getContext } from "./remote-browser.mjs";

async function requireLogin(page) {
  const needsLogin = await page.evaluate('Boolean(document.querySelector(\'input[type="password"]\')) || location.pathname.startsWith("/login")');
  if (needsLogin) throw new Error('Facebook login required in the Windows Browser profile');
}

/**
 * Marketplace supports server-side filtering, which is both cheaper and more
 * accurate than pulling the default relevance-ranked page and filtering after
 * the fact — the unfiltered page is not ordered by recency, so taking its first
 * N cards and then applying an age filter discards recent listings that ranked
 * low on relevance.
 */
function buildSearchUrl({ query, areaId, exact, minPrice, maxPrice, daysSinceListed, radiusKm, sortBy }) {
  const params = new URLSearchParams({ query, exact: exact ? "true" : "false" });
  if (minPrice !== undefined && minPrice !== null) params.set("minPrice", String(minPrice));
  if (maxPrice !== undefined && maxPrice !== null) params.set("maxPrice", String(maxPrice));
  if (daysSinceListed !== undefined && daysSinceListed !== null) {
    params.set("daysSinceListed", String(daysSinceListed));
  }
  // Radius is deliberately not a URL parameter: Marketplace takes it from the
  // logged-in session's saved location, so it is set through the UI instead
  // (see ensureRadius). Passing it here silently does nothing.
  if (sortBy) params.set("sortBy", sortBy);

  const base = areaId
    ? `https://www.facebook.com/marketplace/${areaId}/search/`
    : "https://www.facebook.com/marketplace/search/";
  return `${base}?${params.toString()}`;
}

const ITEM_CARD_SELECTOR = 'a[href*="/marketplace/item/"]';

/** The radii Marketplace actually offers, in km. */
const RADIUS_OPTIONS = [1, 2, 5, 10, 20, 40, 60, 80, 100, 250, 500];

/** Smallest offered radius that still covers the requested distance. */
export function pickRadiusKm(targetKm) {
  return RADIUS_OPTIONS.find((km) => km >= targetKm) ?? RADIUS_OPTIONS[RADIUS_OPTIONS.length - 1];
}

/**
 * Set the search radius through Marketplace's own location control.
 *
 * Radius cannot be passed as a URL parameter — Marketplace reads it from the
 * session's saved location, which is why every search was running at whatever
 * radius the profile happened to be left on (40 km) regardless of what the
 * caller asked for. Driving the real UI keeps the setting in the persistent
 * browser profile, so it also survives into later searches.
 */
async function ensureRadius(page, targetKm) {
  const wanted = pickRadiusKm(targetKm);
  const locator = page.locator('[aria-label^="Location:"]').first();

  const label = await locator.getAttribute("aria-label").catch(() => null);
  const current = label?.match(/within\s+(\d+)\s*km/i);
  if (current && Number(current[1]) === wanted) {
    return { changed: false, radiusKm: wanted, previousKm: Number(current[1]) };
  }

  try {
    await locator.click({ timeout: 10000 });
    // The saved profile may also have a Notifications dialog open. Target the
    // location modal by name so it cannot collide with that persistent UI.
    const dialog = page.getByRole('dialog', { name: 'Change location', exact: true });
    await dialog.waitFor({ timeout: 10000 });

    await dialog.locator('label[role="combobox"]').first().click({ timeout: 10000 });
    // Exact match matters: "10 kilometres" is a substring of "100 kilometres".
    const optionName = wanted === 1 ? "1 kilometre" : `${wanted} kilometres`;
    await page.getByRole("option", { name: optionName, exact: true }).click({ timeout: 10000 });

    await dialog.getByRole("button", { name: "Apply", exact: true }).click({ timeout: 10000 });
    await page.waitForTimeout(3000);
    return {
      changed: true,
      radiusKm: wanted,
      previousKm: current ? Number(current[1]) : null
    };
  } catch (error) {
    // A radius we could not set is worth reporting, but the search itself is
    // still useful — the caller decides whether the wider net is acceptable.
    return {
      changed: false,
      radiusKm: current ? Number(current[1]) : null,
      requestedKm: wanted,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * Extracts every result card currently mounted in the DOM. Runs inside the page
 * on every scroll step rather than once at the end, because Marketplace
 * virtualises its result list: it unmounts cards that scroll out of view as it
 * mounts new ones below. Observed card counts on a single query went
 * 24, 25, 24, 25, 46, 20, 38, 40, 35, 24, 42, 30, 42 — so a single read after
 * scrolling captures only whichever window happens to be mounted at that
 * instant, silently dropping everything recycled along the way.
 */
const HARVEST_VISIBLE = `() => {
  const anchors = Array.from(document.querySelectorAll('a[href*="/marketplace/item/"]'));

  // Marketplace pads thin local inventory with nationwide listings, under a
  // heading that marks exactly where the radius stops applying. Everything after
  // it in document order is outside the requested area — that is why a 100km
  // search was returning Plymouth, Portrush and Lampeter. Facebook already tells
  // us the boundary, so honour it rather than trying to re-derive distance.
  const marker = Array.from(document.querySelectorAll("span,div,h2,h3")).find(
    (el) => /^results from outside (your|of your) search$/i.test((el.innerText || "").trim()),
  );
  const isOutside = (node) =>
    Boolean(marker) &&
    (marker.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

  const parseDistanceMiles = (lines) => {
    for (const line of lines) {
      const miles = line.match(/(\\d+(?:\\.\\d+)?)\\s*mi\\b/i);
      if (miles) return Number(miles[1]);
      const km = line.match(/(\\d+(?:\\.\\d+)?)\\s*km\\b/i);
      if (km) return Number(km[1]) * 0.621371;
    }
    return null;
  };
  const out = [];
  let excludedOutside = 0;
  for (const anchor of anchors) {
    if (!anchor.href) continue;
    if (isOutside(anchor)) { excludedOutside += 1; continue; }
    const card = anchor.closest("div") || anchor;
    // innerText (not textContent) respects CSS-rendered layout, inserting line
    // breaks between visually distinct blocks.
    const textLines = (card.innerText || card.textContent || "")
      .split("\\n").map((l) => l.trim()).filter(Boolean);
    // Cards read: [badge?] [price] [title] [location]. Matching location by
    // shape does not work outside the US — the previous pattern required
    // "Seattle, WA" and so never matched "City of Sunderland" or "Houghton le
    // Spring", leaving location null on every UK listing. Strip the lines we can
    // identify positively and take what is left by position.
    const isBadge = (l) => /^(just listed|sponsored|new)$/i.test(l);
    const isPrice = (l) => /^[£$€]\\s?\\d/.test(l) || /^free$/i.test(l);
    const isDistance = (l) => /^\\d+(?:\\.\\d+)?\\s*(mi|km)\\b/i.test(l);

    const price = textLines.find(isPrice) || null;
    const content = textLines.filter((l) => !isBadge(l) && !isPrice(l) && !isDistance(l) && l.length > 1);
    const title = content[0] || null;
    const location = content.length > 1 ? content[content.length - 1] : null;
    out.push({ url: anchor.href, title, price, location, distanceMiles: parseDistanceMiles(textLines) });
  }
  return { items: out, sawMarker: Boolean(marker), excludedOutside, total: anchors.length };
}`;

const SCROLL_STEP = `() => {
  const cards = document.querySelectorAll('a[href*="/marketplace/item/"]');
  if (!cards.length) return 0;
  // Scroll to the bottom-most card even though it is out-of-area: that is what
  // makes Marketplace render more of the grid, and further in-area cards only
  // appear as it does. Stopping at the last in-area card pins the viewport near
  // the top and the page never loads the rest (60km returned 3 of 18).
  cards[cards.length - 1].scrollIntoView({ block: "end" });
  return cards.length;
}`;

/**
 * Scroll the result list, accumulating cards by URL as we go, and stop once the
 * accumulated set stops growing (or we have enough). Returns telemetry so
 * callers can distinguish "no results" from "Facebook never rendered anything",
 * which are otherwise indistinguishable and were being silently conflated.
 */
/** Facebook appends tracking params; the caller's known set is canonical URLs. */
function stripQuery(url) {
  return String(url).split("?")[0];
}

async function harvestResults(page, maxResults, options = {}) {
  const {
    stepMs = 900,
    stableSteps = 4,
    timeoutMs = 60000,
    knownUrls = null,
    knownRunToStop = 8,
  } = options;
  const startedAt = Date.now();

  // No results at all is a legitimate outcome, so a timeout here is not fatal.
  await page.waitForSelector(ITEM_CARD_SELECTOR, { timeout: 15000 }).catch(() => {});

  const collected = new Map();
  const growth = [];
  let stable = 0;
  let steps = 0;
  let sawMarker = false;
  let previousTotal = -1;

  while (Date.now() - startedAt < timeoutMs) {
    steps += 1;
    const before = collected.size;

    const scan = await page.evaluate(`(${HARVEST_VISIBLE})()`).catch(() => null);
    const visible = scan?.items ?? [];
    if (scan?.sawMarker) sawMarker = true;
    const totalNow = scan?.total ?? 0;
    for (const item of visible) {
      // Merge field by field, keeping the first non-null value seen for each.
      // A card caught mid-paint can have a title and price but no location yet,
      // and a recycled re-render can come back emptier than the original — so
      // neither "first sighting wins" nor "last sighting wins" is safe.
      const existing = collected.get(item.url);
      if (!existing) {
        collected.set(item.url, item);
        continue;
      }
      for (const key of ["title", "price", "location", "distanceMiles"]) {
        if ((existing[key] === null || existing[key] === undefined) && item[key] != null) {
          existing[key] = item[key];
        }
      }
    }
    growth.push(collected.size);

    if (collected.size >= maxResults) {
      return {
        items: Array.from(collected.values()).slice(0, maxResults),
        harvested: collected.size, steps, growth, sawMarker,
        settleMs: Date.now() - startedAt, reason: "max_results",
      };
    }

    // Newest-first ordering means that once we reach listings the caller has
    // already recorded, everything further down is older and already known.
    // Scrolling on just to re-read them costs page time and render cycles for
    // nothing, and the extra activity is what attracts bot detection.
    //
    // A run rather than a single hit, because Facebook bumps a relisted item
    // back to the top: one known card at position 1 is routine and must not
    // abort the harvest.
    if (knownUrls && knownUrls.size > 0) {
      const ordered = Array.from(collected.keys());
      let run = 0;
      for (const url of ordered) {
        run = knownUrls.has(stripQuery(url)) ? run + 1 : 0;
        if (run >= knownRunToStop) break;
      }
      if (run >= knownRunToStop) {
        return {
          items: Array.from(collected.values()),
          harvested: collected.size, steps, growth, sawMarker,
          settleMs: Date.now() - startedAt, reason: "reached_known",
        };
      }
    }

    // Stop on the whole grid going quiet, not on the in-area set going quiet.
    // In-area cards keep appearing above the boundary as Marketplace renders
    // more of the grid, so in-area growth stalls long before the page is
    // exhausted — that read 3 of 18 results at 60km.
    stable = totalNow === previousTotal && collected.size === before ? stable + 1 : 0;
    previousTotal = totalNow;
    if (stable >= stableSteps) {
      return {
        items: Array.from(collected.values()),
        harvested: collected.size, steps, growth, sawMarker,
        settleMs: Date.now() - startedAt, reason: "exhausted",
      };
    }

    await page.evaluate(`(${SCROLL_STEP})()`).catch(() => {});
    await page.waitForTimeout(stepMs);
  }

  return {
    items: Array.from(collected.values()).slice(0, maxResults),
    harvested: collected.size, steps, growth, sawMarker,
    settleMs: Date.now() - startedAt, reason: "timeout",
  };
}

export async function runMarketplaceSearch(
  config,
  { query, maxResults, areaId, exact, radiusMiles, minPrice, maxPrice, daysSinceListed, radiusKm, sortBy, knownUrls, harvestTimeoutMs },
  allowRetry = true,
) {
  const context = await getContext(config);
  const page = await context.newPage();

  try {
    await page.goto(
      buildSearchUrl({ query, areaId, exact, minPrice, maxPrice, daysSinceListed, radiusKm, sortBy }),
      { waitUntil: "domcontentloaded", timeout: 60000 },
    );

    await page.waitForTimeout(1000);
    await requireLogin(page);

    // Radius must be applied before harvesting. Applying it does not swap the
    // results grid synchronously — Marketplace leaves the old cards mounted
    // while it refetches, so harvesting straight after returned the *previous*
    // radius's listings (a 60km->20km change still yielded Darlington and
    // Middlesbrough). Reload once the setting has been saved; it is session
    // state, so it survives the navigation and the grid comes back correct.
    const radius = radiusKm ? await ensureRadius(page, radiusKm) : null;
    if (radius?.changed) {
      await page.goto(
        buildSearchUrl({ query, areaId, exact, minPrice, maxPrice, daysSinceListed, radiusKm, sortBy }),
        { waitUntil: "domcontentloaded", timeout: 60000 },
      );
    }

    const harvest = await harvestResults(page, maxResults, {
      knownUrls: Array.isArray(knownUrls) && knownUrls.length > 0
        ? new Set(knownUrls.map(stripQuery))
        : null,
      ...(harvestTimeoutMs ? { timeoutMs: harvestTimeoutMs } : {}),
    });
    const items = harvest.items;
    if (items.length === 0) await requireLogin(page);

    const filtered = radiusMiles
      ? items.filter((item) => item.distanceMiles === null || item.distanceMiles <= radiusMiles)
      : items;

    // Debug aid only, so never let it fail the search. A fullPage capture of a
    // fully-scrolled results grid exceeds what Chrome will render and threw
    // "Unable to capture screenshot", discarding results we had already
    // harvested successfully.
    const screenshotPath = null;
    const screenshotOk = false;

    return {
      query,
      areaId,
      exact: Boolean(exact),
      radiusMiles,
      count: filtered.length,
      items: filtered,
      screenshotPath: screenshotOk ? screenshotPath : null,
      radius,
      harvest: {
        harvested: harvest.harvested,
        steps: harvest.steps,
        growth: harvest.growth,
        sawMarker: harvest.sawMarker,
        settleMs: harvest.settleMs,
        reason: harvest.reason,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (allowRetry && /target page, context or browser has been closed/i.test(message)) {
      return runMarketplaceSearch(
        config,
        { query, maxResults, areaId, exact, radiusMiles, minPrice, maxPrice, daysSinceListed, radiusKm, sortBy, knownUrls, harvestTimeoutMs },
        false,
      );
    }
    throw error;
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Reads one listing's own page. The search grid carries only title, price and
 * town; everything a buyer actually decides on — mileage, seat count, service
 * history, whether the air conditioning works — lives in the seller's free-text
 * description and the photos.
 */
const DETAIL_EXTRACT = `() => {
  const lines = (document.body.innerText || "").split("\\n").map((l) => l.trim()).filter(Boolean);
  const idx = (re) => lines.findIndex((l) => re.test(l));

  const priceLine = lines.find((l) => /^£\\s?[\\d,]+/.test(l)) || null;
  const listedLine = lines.find((l) => /^listed\\s+/i.test(l)) || null;

  // "About this vehicle" holds seller-declared facts as "Key: value" segments
  // joined by a middot.
  const aboutAt = idx(/^About this (vehicle|item)$/i);
  const descAt = idx(/^Seller's description$/i);
  const attributes = {};
  if (aboutAt !== -1) {
    const end = descAt !== -1 ? descAt : Math.min(aboutAt + 8, lines.length);
    for (const line of lines.slice(aboutAt + 1, end)) {
      for (const part of line.split("·")) {
        const m = part.match(/^\\s*([^:]{2,40}):\\s*(.+?)\\s*$/);
        if (m) { attributes[m[1].trim()] = m[2].trim(); continue; }
        // Mileage is the one vehicle field Facebook writes without a label:
        // "Driven 120,000 km". Skipping it lost the single most useful number
        // on the page, leaving mileage to be guessed from prose.
        //
        // The unit is not to be trusted and is not converted. Marketplace gives
        // UK sellers no miles option, so they type miles into a field labelled
        // km; converting would have turned a 120,000 mile van into 74,840.
        const driven = part.match(/^\\s*Driven\\s+([\\d,]+)\\s*(miles|mi|kilometres|kilometers|km)\\b/i);
        if (driven) {
          const value = Number(driven[1].replace(/,/g, ""));
          if (Number.isFinite(value)) {
            attributes.Mileage = value.toLocaleString("en-GB") + " miles";
            attributes["Mileage (as listed)"] = driven[0].trim();
          }
        }
      }
    }
  }

  // The description runs until Facebook's own trailing furniture.
  let description = null;
  if (descAt !== -1) {
    const rest = lines.slice(descAt + 1);
    const stop = rest.findIndex((l) =>
      /^(see more|see less|seller information|seller details|Location is approximate)$/i.test(l) ||
      /·\\s*Location is approximate$/i.test(l),
    );
    description = (stop === -1 ? rest : rest.slice(0, stop))
      .join("\\n")
      // Expanding leaves the toggle's own label glued to the final line.
      .replace(/\\s*See (more|less)\\s*$/i, "")
      .trim() || null;
  }

  const sellerAt = idx(/^Seller details$/i);
  const sellerName = sellerAt !== -1 ? lines[sellerAt + 1] || null : null;

  // Photos come back at several resolutions with the same underlying asset id;
  // key on that id so one photo is not counted many times.
  const seen = new Map();
  for (const img of document.querySelectorAll("img")) {
    if (img.naturalWidth < 300 || img.naturalHeight < 300) continue;
    if (!/fbcdn|scontent/.test(img.src)) continue;
    const id = (img.src.match(/\\/([0-9]{6,}_[0-9]+_[0-9]+)/) || [])[1] || img.src.split("?")[0];
    if (!seen.has(id)) seen.set(id, img.src);
  }

  return {
    title: (document.title || "").replace(/^Marketplace\\s*[–-]\\s*/, "").replace(/\\s*\\|\\s*Facebook$/, "") || null,
    price: priceLine,
    postedDate: listedLine,
    location: listedLine ? (listedLine.match(/\\s+in\\s+(.+)$/i) || [])[1] || null : null,
    attributes,
    description,
    sellerName,
    images: Array.from(seen.values()),
  };
}`;

export async function runMarketplaceDetail(config, { url, maxImages = 20 }) {
  const context = await getContext(config);
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(2500);
    await requireLogin(page);

    // Facebook truncates long descriptions behind "See more", and the hidden
    // part is exactly where mileage, service history and known faults live.
    // Photos hang in a lazily-populated carousel; nudge the page so more of them
    // decode before we read them off.
    await page.evaluate("window.scrollBy(0, 600)").catch(() => {});
    await page.waitForTimeout(800);

    const expanded = await page
      .getByText("See more", { exact: true })
      .first()
      .click({ timeout: 4000 })
      .then(() => true)
      .catch(() => false);
    if (expanded) await page.waitForTimeout(600);

    const detail = await page.evaluate(`(${DETAIL_EXTRACT})()`);
    return { url, descriptionExpanded: expanded, ...detail, images: (detail.images || []).slice(0, maxImages) };
  } finally {
    await page.close().catch(() => {});
  }
}
