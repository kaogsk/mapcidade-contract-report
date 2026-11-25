/**
 * Wires the fake implementations of the four sources. Production swaps this one file: a pg-backed
 * CityDatabase, an ssh2-backed RemoteShell, a pg-backed TicketMirror and the HTTP helpdesk client.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.js";
import { daysIn, todayIso } from "./period.js";
import { seedAll } from "./seed.js";
import { FakeRemoteShell, type FakeVm } from "./sources/disks.js";
import { FakeHelpdeskApi, HttpHelpdeskApi } from "./sources/helpdesk.js";
import { SqliteCityDatabase } from "./sources/sqlite.js";
import { SqliteTicketMirror } from "./sources/tickets.js";
import type { Sources } from "./sources/types.js";

/** Seeds the fake sources when missing, or when the data is older than a week (the window slides). */
export function ensureSeeded(cfg: Config, now = new Date()): { refDate: string; seeded: boolean } {
  const today = todayIso(now, cfg.timeZone);
  const marker = join(cfg.dataDir, "seed.json");
  if (existsSync(marker)) {
    try {
      const { refDate } = JSON.parse(readFileSync(marker, "utf-8")) as { refDate: string };
      if (daysIn({ start: refDate, end: today }) <= 7) return { refDate, seeded: false };
    } catch {
      // unreadable marker: seed again
    }
  }
  seedAll(cfg.dataDir, today, cfg.connectionKey);
  return { refDate: today, seeded: true };
}

export function createFakeSources(cfg: Config): Sources {
  const vms = JSON.parse(readFileSync(join(cfg.dataDir, "vms.json"), "utf-8")) as Record<string, FakeVm>;
  const mirror = new SqliteTicketMirror(join(cfg.dataDir, "support-mirror.db"));
  return {
    openCityDb: async (city) => SqliteCityDatabase.open(join(cfg.dataDir, city.dbLocation)),
    shell: new FakeRemoteShell(vms),
    mirror,
    helpdesk: cfg.helpdeskApiUrl
      ? new HttpHelpdeskApi(cfg.helpdeskApiUrl, cfg.helpdeskApiToken)
      : new FakeHelpdeskApi(join(cfg.dataDir, "helpdesk-tickets.json")),
  };
}
