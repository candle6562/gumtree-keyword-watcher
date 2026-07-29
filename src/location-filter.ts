const ORIGIN = { lat: 55.0165, lon: -1.4493 }; // North Shields
const DEFAULT_RADIUS_KM = 20;

const LOCATIONS: Record<string, { lat: number; lon: number }> = {
  "north shields": { lat: 55.0165, lon: -1.4493 },
  "tynemouth": { lat: 55.0179, lon: -1.4256 },
  "whitley bay": { lat: 55.0456, lon: -1.4443 },
  "cullercoats": { lat: 55.0333, lon: -1.4333 },
  "monkseaton": { lat: 55.043, lon: -1.461 },
  "wallsend": { lat: 54.991, lon: -1.534 },
  "longbenton": { lat: 55.01, lon: -1.59 },
  "backworth": { lat: 55.035, lon: -1.527 },
  "shiremoor": { lat: 55.036, lon: -1.506 },
  "south shields": { lat: 54.999, lon: -1.43 },
  "jarrow": { lat: 54.98, lon: -1.48 },
  "hebburn": { lat: 54.974, lon: -1.515 },
  "newcastle": { lat: 54.978, lon: -1.617 },
  "newcastle upon tyne": { lat: 54.978, lon: -1.617 },
  "gateshead": { lat: 54.952, lon: -1.603 },
  "sunderland": { lat: 54.906, lon: -1.383 },
  "city of sunderland": { lat: 54.906, lon: -1.383 },
  "durham": { lat: 54.776, lon: -1.576 },
  "morpeth": { lat: 55.168, lon: -1.688 },
  "stanley": { lat: 54.868, lon: -1.698 },
  "ashington": { lat: 55.184, lon: -1.567 },
  "seaham": { lat: 54.839, lon: -1.335 },
  "darlington": { lat: 54.524, lon: -1.555 },
  "middlesbrough": { lat: 54.574, lon: -1.235 },
  "stockton-on-tees": { lat: 54.57, lon: -1.318 },
  "hartlepool": { lat: 54.686, lon: -1.212 },
  "carlisle": { lat: 54.895, lon: -2.938 },
  "york": { lat: 53.96, lon: -1.087 },
  "leeds": { lat: 53.8, lon: -1.549 },
  "edinburgh": { lat: 55.953, lon: -3.189 },
  "glasgow": { lat: 55.864, lon: -4.252 },
  "manchester": { lat: 53.48, lon: -2.242 },
  "birmingham": { lat: 52.486, lon: -1.89 },
  "london": { lat: 51.507, lon: -0.128 },
  "swalwell": { lat: 54.951, lon: -1.686 },
  "forest hall": { lat: 55.011, lon: -1.565 },
  "killingworth": { lat: 55.031, lon: -1.558 },
  "cramlington": { lat: 55.087, lon: -1.585 },
  "blyth": { lat: 55.127, lon: -1.508 },
  "blyth, northumberland": { lat: 55.127, lon: -1.508 },
  "bedlington": { lat: 55.132, lon: -1.598 }
};

function toRad(value: number): number {
  return (value * Math.PI) / 180;
}

function distanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const earthKm = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * earthKm * Math.asin(Math.sqrt(h));
}

/**
 * Excludes listings we can positively place outside the radius.
 *
 * This used to be `isWithinNorthShieldsRadius` and returned false for anything
 * it could not find in the gazetteer above — 42 hardcoded place names, so a
 * listing in Houghton le Spring (15km away) or Blaydon was silently deleted.
 * Measured on one camper van search, only 13 of 50 harvested listings survived
 * at 20km and 18 at 200km, almost all of the losses being real local results.
 *
 * Both sources now apply the radius themselves — Gumtree through its `distance`
 * search parameter, Facebook through its own location control — so this can
 * only subtract from an already-correct set. It is kept solely to drop the
 * distant "delivery available" listings Facebook mixes into local results, and
 * therefore an unrecognised place is now kept rather than discarded: a name we
 * do not know is not evidence that it is far away.
 */
export function isNotKnownToBeOutsideRadius(location?: string | null, radiusKm = DEFAULT_RADIUS_KM): boolean {
  if (!location) return true;
  const normalized = location.toLowerCase().replace(/,\s*united kingdom$/i, "").trim();
  if (/\b(alberta|canada|usa|united states)\b/.test(normalized)) return false;
  for (const [name, coords] of Object.entries(LOCATIONS)) {
    if (normalized === name || normalized.startsWith(`${name},`) || normalized.includes(name)) {
      return distanceKm(ORIGIN, coords) <= radiusKm;
    }
  }
  return true;
}
