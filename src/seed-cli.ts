/** `npm run seed [YYYY-MM-DD]` — (re)creates the fake sources' data, relative to that day (default: today). */
import { loadConfig } from "./config.js";
import { todayIso, validatePeriod, addDays } from "./period.js";
import { seedAll } from "./seed.js";

const cfg = loadConfig();
const arg = process.argv[2];
const refDate = arg ? validatePeriod(addDays(arg, -1), arg).end : todayIso(new Date(), cfg.timeZone);
const t0 = Date.now();
seedAll(cfg.dataDir, refDate, cfg.connectionKey);
console.log(`seeded ${cfg.dataDir} relative to ${refDate} in ${Date.now() - t0} ms`);
