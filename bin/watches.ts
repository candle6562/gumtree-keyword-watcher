#!/usr/bin/env node
import { findWatch, loadWatches, normalizeName, saveWatches, type MarketWatch } from "../src/watches.js";

function usage(): never {
  throw new Error(
    "Usage: watches <list|create|show|delete|add|remove|pause|resume|frequency|distance|min-price|max-price|max-age|category|notify-on-run|rename> [watch] [value]"
  );
}

function parseWatchAndRest(watches: MarketWatch[], args: string[]): { name: string; rest: string[] } {
  if (args.length === 0) usage();
  const normalized = args.map((arg) => normalizeName(arg));
  for (let size = normalized.length; size >= 1; size -= 1) {
    const candidate = normalizeName(normalized.slice(0, size).join(" "));
    if (findWatch(watches, candidate)) {
      return { name: candidate, rest: args.slice(size) };
    }
  }
  return { name: normalizeName(args[0]), rest: args.slice(1) };
}

function formatWatch(watch: MarketWatch): string {
  return [
    `Watch: ${watch.name}`,
    `Status: ${watch.enabled ? "on" : "paused"}`,
    `Frequency: ${watch.frequency}`,
    `Distance: ${watch.distanceKm} km`,
    `Min price: ${watch.minPrice !== undefined ? `£${watch.minPrice}` : "off"}`,
    `Max price: ${watch.maxPrice !== undefined ? `£${watch.maxPrice}` : "off"}`,
    `Max age: ${watch.maxAgeDays ?? 1} day(s)`,
    `Gumtree category: ${watch.gumtreeCategory ?? "for-sale"}`,
    `Notify on run alerts: ${watch.noChange ? "on" : "off"}`,
    "Terms:",
    ...(watch.terms.length ? watch.terms.map((term) => `- ${term}`) : ["- none"])
  ].join("\n");
}

function main(): void {
  const [cmd, ...args] = process.argv.slice(2);
  const watches = loadWatches();

  switch (cmd) {
    case "list": {
      if (watches.length === 0) {
        console.log("No watches configured.");
        return;
      }
      console.log(watches.map(formatWatch).join("\n\n"));
      return;
    }
    case "create": {
      const name = normalizeName(args.join(" "));
      if (!name) usage();
      if (findWatch(watches, name)) {
        console.log(`Already exists: ${name}`);
        return;
      }
      watches.push({ name, enabled: true, frequency: "10m", distanceKm: 20, noChange: false, terms: [name.toLowerCase()] });
      saveWatches(watches);
      console.log(`Created watch: ${name}`);
      console.log(`Added default term: ${name.toLowerCase()}`);
      return;
    }
    case "show": {
      const name = normalizeName(args.join(" "));
      const watch = findWatch(watches, name);
      if (!watch) throw new Error(`Watch not found: ${name}`);
      console.log(formatWatch(watch));
      return;
    }
    case "delete":
    case "rm": {
      const name = normalizeName(args.join(" "));
      if (!name) throw new Error("Usage: watches delete <watch>");
      const watch = findWatch(watches, name);
      if (!watch) throw new Error(`Watch not found: ${name}`);
      const next = watches.filter((item) => item.name.toLowerCase() !== watch.name.toLowerCase());
      saveWatches(next);
      console.log(`Deleted watch: ${watch.name}`);
      return;
    }
    case "add": {
      const { name, rest } = parseWatchAndRest(watches, args);
      const term = rest.join(" ").trim().toLowerCase();
      if (!term) throw new Error("Usage: watches add <watch> <term>");
      const watch = findWatch(watches, name);
      if (!watch) throw new Error(`Watch not found: ${name}`);
      if (watch.terms.includes(term)) {
        console.log(`Already watching in ${watch.name}: ${term}`);
        return;
      }
      watch.terms.push(term);
      saveWatches(watches);
      console.log(`Added to ${watch.name}: ${term}`);
      return;
    }
    case "remove": {
      const { name, rest } = parseWatchAndRest(watches, args);
      const term = rest.join(" ").trim().toLowerCase();
      const watch = findWatch(watches, name);
      if (!watch) throw new Error(`Watch not found: ${name}`);
      const next = watch.terms.filter((item) => item !== term);
      if (next.length === watch.terms.length) {
        console.log(`Not found in ${watch.name}: ${term}`);
        return;
      }
      watch.terms = next;
      saveWatches(watches);
      console.log(`Removed from ${watch.name}: ${term}`);
      return;
    }
    case "pause":
    case "resume": {
      const name = normalizeName(args.join(" "));
      const watch = findWatch(watches, name);
      if (!watch) throw new Error(`Watch not found: ${name}`);
      watch.enabled = cmd === "resume";
      saveWatches(watches);
      console.log(`${cmd === "resume" ? "Resumed" : "Paused"}: ${watch.name}`);
      return;
    }
    case "frequency": {
      const { name, rest } = parseWatchAndRest(watches, args);
      const frequency = rest.join(" ").trim().toLowerCase();
      if (!/^(10m|30m|1h|daily)$/.test(frequency)) throw new Error("Frequency must be 10m, 30m, 1h, or daily");
      const watch = findWatch(watches, name);
      if (!watch) throw new Error(`Watch not found: ${name}`);
      watch.frequency = frequency;
      saveWatches(watches);
      console.log(`Frequency for ${watch.name}: ${frequency}`);
      return;
    }
    case "distance": {
      const { name, rest } = parseWatchAndRest(watches, args);
      const raw = rest.join(" ").trim().toLowerCase().replace(/\s*km$/, "");
      const distanceKm = Number(raw);
      if (!Number.isInteger(distanceKm) || distanceKm < 1 || distanceKm > 1000) {
        throw new Error("Usage: watches distance <watch> <1-1000 km>");
      }
      const watch = findWatch(watches, name);
      if (!watch) throw new Error(`Watch not found: ${name}`);
      watch.distanceKm = distanceKm;
      saveWatches(watches);
      console.log(`Distance for ${watch.name}: ${distanceKm} km`);
      return;
    }
    case "category": {
      const { name, rest } = parseWatchAndRest(watches, args);
      const raw = rest.join(" ").trim().toLowerCase();
      const watch = findWatch(watches, name);
      if (!watch) throw new Error(`Watch not found: ${name}`);
      if (raw === "off" || raw === "default" || raw === "for-sale") {
        delete watch.gumtreeCategory;
        saveWatches(watches);
        console.log(`Gumtree category for ${watch.name}: for-sale (default)`);
        return;
      }
      if (!/^[a-z0-9-]+$/.test(raw)) {
        throw new Error("Usage: watches category <watch> <gumtree-category-slug|default>");
      }
      watch.gumtreeCategory = raw;
      saveWatches(watches);
      console.log(`Gumtree category for ${watch.name}: ${raw}`);
      return;
    }
    case "max-age": {
      const { name, rest } = parseWatchAndRest(watches, args);
      const raw = rest.join(" ").trim().toLowerCase().replace(/\s*days?$/, "").replace(/d$/, "");
      const watch = findWatch(watches, name);
      if (!watch) throw new Error(`Watch not found: ${name}`);
      const days = Number(raw);
      // Facebook's own "Date listed" filter only offers these three windows, and
      // both sources share the window so their results stay comparable.
      if (days !== 1 && days !== 7 && days !== 30) {
        throw new Error("Usage: watches max-age <watch> <1|7|30>");
      }
      watch.maxAgeDays = days;
      saveWatches(watches);
      console.log(`Max age for ${watch.name}: ${days} day(s)`);
      return;
    }
    case "min-price":
    case "max-price": {
      const bound = cmd === "min-price" ? "minPrice" : "maxPrice";
      const label = cmd === "min-price" ? "Min price" : "Max price";
      const { name, rest } = parseWatchAndRest(watches, args);
      const raw = rest.join(" ").trim().toLowerCase().replace(/^£/, "").replace(/,/g, "");
      const watch = findWatch(watches, name);
      if (!watch) throw new Error(`Watch not found: ${name}`);
      if (raw === "off" || raw === "none" || (raw === "0" && bound === "minPrice")) {
        delete watch[bound];
        saveWatches(watches);
        console.log(`${label} for ${watch.name}: off`);
        return;
      }
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 0 || value > 1000000) {
        throw new Error(`Usage: watches ${cmd} <watch> <price|off>`);
      }
      if (bound === "maxPrice" && watch.minPrice !== undefined && value < watch.minPrice) {
        throw new Error(`Max price (£${value}) must not be below min price (£${watch.minPrice})`);
      }
      if (bound === "minPrice" && watch.maxPrice !== undefined && value > watch.maxPrice) {
        throw new Error(`Min price (£${value}) must not exceed max price (£${watch.maxPrice})`);
      }
      watch[bound] = value;
      saveWatches(watches);
      console.log(`${label} for ${watch.name}: £${value}`);
      return;
    }
    // `notify-on-run` and `notify` used to fall through into the min-price case,
    // so asking to change notifications silently set a price instead. They are
    // aliases of `no-change` below, where the notify logic actually lives.
    case "notify-on-run":
    case "notify":
    case "no-change":
    case "no-found": {
      const { name, rest } = parseWatchAndRest(watches, args);
      const value = rest.join(" ").trim().toLowerCase();
      if (!/^(on|off)$/.test(value)) throw new Error(`Usage: watches notify-on-run <watch> <on|off>`);
      const watch = findWatch(watches, name);
      if (!watch) throw new Error(`Watch not found: ${name}`);
      watch.noChange = value === "on";
      saveWatches(watches);
      console.log(`Notify on run alerts for ${watch.name}: ${value}`);
      return;
    }
    case "rename": {
      const { name, rest } = parseWatchAndRest(watches, args);
      const nextName = normalizeName(rest.join(" "));
      if (!nextName) throw new Error("Usage: watches rename <watch> <new name>");
      const watch = findWatch(watches, name);
      if (!watch) throw new Error(`Watch not found: ${name}`);
      watch.name = nextName;
      saveWatches(watches);
      console.log(`Renamed watch: ${name} -> ${nextName}`);
      return;
    }
    default:
      usage();
  }
}

main();
