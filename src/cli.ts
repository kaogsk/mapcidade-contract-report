/**
 * Generate from the terminal, no review screen:
 *   npm run generate -- rivermeadow                          one year up to today → out/
 *   npm run generate -- rivermeadow 2025-10-26 2026-10-26    explicit period
 *   npm run generate -- oakwood --json                       data only
 *   npm run generate -- lakeside --simulate helpdeskApi=fail,vmDisks=hang
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { findCity } from "./cities.js";
import { collect, SOURCE_IDS, type Fault, type FaultPlan, type SourceId } from "./collect.js";
import { loadConfig, projectRoot } from "./config.js";
import { fileNameFor, renderDocx } from "./docx/render.js";
import { errorMessage } from "./errors.js";
import { CityMemory } from "./memory.js";
import { defaultPeriod, validatePeriod } from "./period.js";
import { createFakeSources, ensureSeeded } from "./wiring.js";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  if (i < 0) return null;
  const v = args[i + 1] ?? "";
  args.splice(i, 2);
  return v;
};
const json = args.includes("--json");
if (json) args.splice(args.indexOf("--json"), 1);
const simulate = flag("--simulate");

const cfg = loadConfig();
const city = findCity(args[0] ?? "");
if (!city) {
  console.error("usage: npm run generate -- <rivermeadow|lakeside|oakwood> [start end] [--json] [--simulate source=fail|hang,…]");
  process.exit(2);
}
const faults: FaultPlan = {};
for (const part of (simulate ?? "").split(",").filter(Boolean)) {
  const [id, mode] = part.split("=") as [string, string];
  if (!SOURCE_IDS.includes(id as SourceId) || !["fail", "hang"].includes(mode)) {
    console.error(`bad --simulate entry: ${part}`);
    process.exit(2);
  }
  faults[id as SourceId] = mode as Fault;
}

try {
  ensureSeeded(cfg);
  const period = args[1] && args[2] ? validatePeriod(args[1], args[2]) : defaultPeriod(new Date(), cfg.timeZone);
  const result = await collect(city, period, {
    sources: createFakeSources(cfg),
    memory: new CityMemory(join(cfg.dataDir, "city-memory.json")),
    timeoutMs: cfg.sourceTimeoutMs,
    cityDbTimeoutMs: cfg.cityDbTimeoutMs,
    timeZone: cfg.timeZone,
    connectionKey: cfg.connectionKey,
    faults,
  });
  for (const w of result.warnings) console.error(`! ${w}`);
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    // The terminal prints every section: no review screen to switch one off.
    const report = { ...result.report, hidden: [] };
    const buf = await renderDocx(report, readFileSync(cfg.templatePath));
    const out = resolve(projectRoot, "out");
    mkdirSync(out, { recursive: true });
    const file = join(out, fileNameFor(report));
    writeFileSync(file, buf);
    const status = result.sources.map((s) => `${s.id}:${s.ok ? "ok" : "DOWN"} ${s.ms}ms`).join("  ");
    console.log(`${file} (${buf.length} bytes, ${result.details.durationMs} ms)\n${status}`);
  }
} catch (e) {
  console.error(errorMessage(e));
  process.exit(1);
}
