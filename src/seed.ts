/**
 * Synthetic data for the fake sources. Deterministic (seeded PRNG) and relative to a reference day,
 * so "the last 12 months" always has data and a test can pin the numbers.
 *
 *   data/cities/<id>.db        city databases (node:sqlite)
 *   data/support-mirror.db     local mirror of the helpdesk
 *   data/helpdesk-tickets.json what the ticketing API answers
 *   data/vms.json              canned `df` output per VM, and which VM never answers
 *
 * Everything here is invented. Names of people, vendors and cities are fictional.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CITIES } from "./cities.js";
import { encryptConnection } from "./sources/connections.js";
import type { FakeVm } from "./sources/disks.js";
import type { HelpdeskTicket } from "./sources/types.js";
import { addDays } from "./period.js";

/** mulberry32: tiny, fast, good enough for fixtures. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rand = () => number;
const pick = <T>(r: Rand, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
const between = (r: Rand, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
/** Weighted choice over [item, weight] pairs. */
function weighted<T>(r: Rand, xs: ReadonlyArray<readonly [T, number]>): T {
  const total = xs.reduce((s, [, w]) => s + w, 0);
  let x = r() * total;
  for (const [v, w] of xs) if ((x -= w) < 0) return v;
  return xs[xs.length - 1]![0];
}
const time = (r: Rand) => `${String(between(r, 7, 19)).padStart(2, "0")}:${String(between(r, 0, 59)).padStart(2, "0")}:${String(between(r, 0, 59)).padStart(2, "0")}`;

/** History length: a bit over a year, so a default period is fully covered with data before it. */
const DAYS_OF_HISTORY = 450;

const CITY_SCHEMA = `
CREATE TABLE users (id INTEGER PRIMARY KEY, login TEXT UNIQUE NOT NULL, email TEXT, department TEXT);
CREATE TABLE profiles (id INTEGER PRIMARY KEY, name TEXT, expired INTEGER NOT NULL DEFAULT 0);
CREATE TABLE access_log (id INTEGER PRIMARY KEY, user_login TEXT NOT NULL, profile TEXT, accessed_at TEXT NOT NULL);
CREATE INDEX ix_access_log_at ON access_log (accessed_at);
CREATE TABLE layer_registry (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE data_tables (id INTEGER PRIMARY KEY, name TEXT NOT NULL, connection TEXT);
CREATE TABLE themes (id INTEGER PRIMARY KEY, name TEXT, profile_id INTEGER, table_id INTEGER, table_name TEXT, most_used INTEGER);
CREATE TABLE edit_log (id INTEGER PRIMARY KEY, user_id INTEGER, profile_id INTEGER, table_name TEXT, action TEXT, at TEXT NOT NULL);
CREATE INDEX ix_edit_log_at ON edit_log (at);
CREATE TABLE certificates (id INTEGER PRIMARY KEY, name TEXT);
-- Only the primary key is indexed, like the production table: see server-log-range.ts.
CREATE TABLE server_log (id INTEGER PRIMARY KEY, endpoint TEXT NOT NULL, params TEXT, at TEXT NOT NULL);
`;

interface ThemeSpec {
  name: string;
  profile: string;
  table: string | null;
  mostUsed: number;
}

interface CitySpec {
  seed: number;
  cityUsers: number;
  /** Departments in the user registry (Lakeside's only clue). */
  registryDepartments: string[];
  /** [profile, access weight]; weight 0 = never used; negative = expired. */
  profiles: Array<readonly [string, number]>;
  accessesPerDay: number;
  layers: number;
  themes: ThemeSpec[];
  /** [table name, decrypted connection] — the seed encrypts it like the platform does. */
  connections: Array<readonly [string, string]>;
  /** [form, theme table, profile]. null = the city has no mobile module at all. */
  mobileForms: Array<readonly [string, string, string]> | null;
  /** [table, inserts per day] for the mobile tables. */
  mobileInsertsPerDay: Array<readonly [string, number]>;
  certificates: string[];
  certificateEndpoint: "report" | "legacy" | "none";
  certificatesPerDay: number;
  serverNoisePerDay: number;
  landSyncRuns: number;
  externalTables: string[];
}

const RIVERMEADOW: CitySpec = {
  seed: 11,
  cityUsers: 180,
  registryDepartments: ["Finance", "Urban Planning", "Environment", "Public Works", "Health"],
  profiles: [
    ["Finance - Edit", 9],
    ["Finance - View", 6],
    ["Dept. Urban Planning Advanced 1", 8],
    ["Dept. Urban Planning Advanced 2", 4],
    ["Dept. Urban Planning", 3],
    ["Environment", 6],
    ["Public Works - Edit", 5],
    ["Public Works - View", 3],
    ["Health", 2],
    ["Education", 2],
    ["Housing-Advanced", 3],
    ["Housing-Basic", 1],
    ["Transit", 2],
    ["Tax Office", 5],
    ["Parks and Recreation", 1],
    ["Civil Defense", 0.6],
    ["Social Services", 0.4],
    ["Administrator", 4],
    ["Public portal", 2],
    ["MapCidade Support", 3],
    ["Training 2026 - Staff", 1.5],
    ["Test", 0.5],
    ["Water Utility", 0],
    ["Old Cadastre Team", -1],
  ],
  accessesPerDay: 36,
  layers: 342,
  themes: [
    { name: "Parcels", profile: "Finance - Edit", table: "parcels", mostUsed: 980 },
    { name: "Buildings", profile: "Dept. Urban Planning Advanced 1", table: "buildings", mostUsed: 760 },
    { name: "Street centerlines", profile: "Public Works - Edit", table: "streets", mostUsed: 640 },
    { name: "Zoning", profile: "Dept. Urban Planning Advanced 1", table: "zoning", mostUsed: 610 },
    { name: "Property registry - Tributa", profile: "Finance - Edit", table: "tributa_property", mostUsed: 580 },
    { name: "Business licenses - Tributa", profile: "Tax Office", table: "tributa_business", mostUsed: 420 },
    { name: "Building permits", profile: "Dept. Urban Planning Advanced 1", table: "permits_view", mostUsed: 300 },
    { name: "Street lights", profile: "Public Works - Edit", table: "street_lights", mostUsed: 280 },
    { name: "Tree inventory", profile: "Environment", table: "trees", mostUsed: 270 },
    { name: "Drainage network", profile: "Public Works - View", table: "drainage", mostUsed: 240 },
    { name: "Health units", profile: "Health", table: "health_units", mostUsed: 150 },
    { name: "Schools", profile: "Education", table: "schools", mostUsed: 140 },
    { name: "Bus stops", profile: "Transit", table: "bus_stops", mostUsed: 120 },
    { name: "Cemetery plots", profile: "Public Works - View", table: "cemetery_plots", mostUsed: 60 },
    { name: "Parcels BKP 2025", profile: "Finance - Edit", table: "parcels_bkp", mostUsed: 900 },
    { name: "Training sandbox", profile: "Training 2026 - Staff", table: "sandbox", mostUsed: 999 },
    { name: "_aux_grid", profile: "Administrator", table: "aux_grid", mostUsed: 999 },
    { name: "Orthophoto 2024", profile: "Administrator", table: null, mostUsed: 999 },
  ],
  connections: [
    ["cemetery_plots", "dbsrv-cemetery.rivermeadow.example;1433;cemetery;gis_reader;s3cr3t-demo;sqlserver"],
    ["permits_view", "https://api.permitly.example/v2;tok_demo_123;rest"],
    ["parcels", "localhost;5432;rivermeadow_edit;editor;demo-pass;postgres"],
  ],
  mobileForms: [
    ["Mobile - Street Light Survey", "street_lights", "Public Works - Edit"],
    ["Tree Inventory", "trees", "Environment"],
    ["Mobile Tree Inventory", "trees", "Administrator"],
    ["Pothole Report", "streets", "Public Works - Edit"],
    ["Sidewalk Inspection BKP", "streets", "Administrator"],
  ],
  mobileInsertsPerDay: [
    ["street_lights", 3],
    ["trees", 5],
    ["streets", 2],
  ],
  certificates: ["Zoning Certificate", "Address Certificate", "Property Boundary Certificate", "Land Use Certificate", "Occupancy Certificate", "Zoning Certificate - test"],
  certificateEndpoint: "report",
  certificatesPerDay: 7,
  serverNoisePerDay: 80,
  landSyncRuns: 24,
  externalTables: ["ext_property_parcels", "ext_tax_snapshot"],
};

const LAKESIDE: CitySpec = {
  seed: 23,
  cityUsers: 38,
  registryDepartments: ["Finance", "Planning", "Environment", "Public Works", "Tax Office", "Planning", "Finance"],
  profiles: [
    ["Administrator", 4],
    ["City Hall - View", 8],
    ["City Hall - Edit", 3],
    ["Public portal", 1],
    ["MapCidade Support", 2],
    ["Field Survey", 1],
  ],
  accessesPerDay: 6,
  layers: 118,
  themes: [
    { name: "Lots - CivicSoft", profile: "City Hall - Edit", table: "lots", mostUsed: 400 },
    { name: "Taxpayers - CivicSoft", profile: "City Hall - View", table: "taxpayers", mostUsed: 210 },
    { name: "Roads", profile: "City Hall - View", table: "roads", mostUsed: 300 },
    { name: "Neighborhoods", profile: "City Hall - View", table: "neighborhoods", mostUsed: 180 },
    { name: "Cemetery plots (integration)", profile: "City Hall - View", table: "cemetery", mostUsed: 40 },
    { name: "Rivers and lakes", profile: "City Hall - View", table: "hydrography", mostUsed: 90 },
  ],
  connections: [],
  mobileForms: [
    ["Mobile - Lot Survey", "lots", "City Hall - Edit"],
    ["Road Damage", "roads", "City Hall - Edit"],
  ],
  mobileInsertsPerDay: [],
  certificates: ["Zoning Certificate", "Address Certificate"],
  certificateEndpoint: "legacy",
  certificatesPerDay: 1.2,
  serverNoisePerDay: 25,
  landSyncRuns: 0,
  externalTables: [],
};

const OAKWOOD: CitySpec = {
  seed: 37,
  cityUsers: 14,
  registryDepartments: ["Planning"],
  profiles: [
    ["Planning - Edit", 3],
    ["Planning - View", 2],
    ["Environment", 1],
    ["Administrator", 1],
    ["Training 2026 - Staff", 0.6],
  ],
  accessesPerDay: 2.5,
  layers: 41,
  themes: [
    { name: "Lots", profile: "Planning - Edit", table: "lots", mostUsed: 120 },
    { name: "Roads", profile: "Planning - View", table: "roads", mostUsed: 80 },
    { name: "Protected areas", profile: "Environment", table: "protected_areas", mostUsed: 30 },
  ],
  connections: [],
  mobileForms: null,
  mobileInsertsPerDay: [],
  certificates: ["Address Certificate", "Zoning Certificate", "Copy of Zoning Certificate"],
  certificateEndpoint: "none",
  certificatesPerDay: 0,
  serverNoisePerDay: 10,
  landSyncRuns: 0,
  externalTables: ["ext_import_batch", "ext_sync_a1"],
};

export const CITY_SPECS: Record<string, CitySpec> = { rivermeadow: RIVERMEADOW, lakeside: LAKESIDE, oakwood: OAKWOOD };

const FIRST = ["Ana", "Bruno", "Carla", "Diego", "Elisa", "Felipe", "Gabi", "Hugo", "Iris", "Joel", "Kaua", "Lia", "Marta", "Nico", "Olga", "Pedro", "Rita", "Saulo", "Tania", "Vitor"];
const LAST = ["Alder", "Birch", "Cedar", "Dune", "Elm", "Fern", "Grove", "Heath", "Ivy", "Juniper", "Kestrel", "Linden", "Maple", "North", "Orchard", "Pine"];

/** Poisson-ish daily count: mean λ, weekdays busier than weekends. */
function dailyCount(r: Rand, mean: number, day: string): number {
  const dow = new Date(`${day}T12:00:00Z`).getUTCDay();
  const m = dow === 0 || dow === 6 ? mean * 0.25 : mean * 1.3;
  let n = Math.floor(m);
  if (r() < m - n) n++;
  return Math.max(0, n + between(r, -Math.ceil(m * 0.3), Math.ceil(m * 0.3)));
}

export function seedCityDb(db: DatabaseSync, spec: CitySpec, refDate: string, connectionKey: string): void {
  const r = prng(spec.seed);
  db.exec(CITY_SCHEMA);
  db.exec("BEGIN");
  try {
    // users: city staff, vendor staff, the anonymous visitor, two accounts with no e-mail
    const insUser = db.prepare("INSERT INTO users (login, email, department) VALUES (?, ?, ?)");
    const cityLogins: string[] = [];
    for (let i = 0; i < spec.cityUsers; i++) {
      const login = `${pick(r, FIRST).toLowerCase()}.${pick(r, LAST).toLowerCase()}${i}`;
      insUser.run(login, `${login}@city.example`, pick(r, spec.registryDepartments));
      cityLogins.push(login);
    }
    const vendorLogins = Array.from({ length: 5 }, (_, i) => `vendor.analyst${i}`);
    for (const l of vendorLogins) insUser.run(l, `${l}@mapcidade.example`, null);
    insUser.run("visitor", "visitor@city.example", null);
    insUser.run("legacy.kiosk", null, null);
    insUser.run("legacy.scanner", null, null);

    const insProfile = db.prepare("INSERT INTO profiles (name, expired) VALUES (?, ?)");
    const profileId = new Map<string, number>();
    for (const [name, w] of spec.profiles) {
      const res = insProfile.run(name, w < 0 ? 1 : 0);
      profileId.set(name, Number(res.lastInsertRowid));
    }

    // accesses, day by day
    const insAccess = db.prepare("INSERT INTO access_log (user_login, profile, accessed_at) VALUES (?, ?, ?)");
    const used = spec.profiles.filter(([, w]) => w > 0);
    const vendorProfiles = new Set(["MapCidade Support", "Field Survey", "Test"]);
    for (let d = DAYS_OF_HISTORY; d >= 0; d--) {
      const day = addDays(refDate, -d);
      const count = dailyCount(r, spec.accessesPerDay, day);
      for (let i = 0; i < count; i++) {
        const profile = weighted(r, used);
        const login = vendorProfiles.has(profile) || r() < 0.06 ? pick(r, vendorLogins) : r() < 0.02 ? "visitor" : pick(r, cityLogins);
        insAccess.run(login, profile, `${day} ${time(r)}`);
      }
    }

    const insLayer = db.prepare("INSERT INTO layer_registry (name) VALUES (?)");
    for (let i = 1; i <= spec.layers; i++) insLayer.run(`layer_${String(i).padStart(4, "0")}`);

    const insTable = db.prepare("INSERT INTO data_tables (name, connection) VALUES (?, ?)");
    const tableId = new Map<string, number>();
    const conns = new Map(spec.connections);
    for (const t of new Set(spec.themes.map((t) => t.table).filter((t): t is string => !!t))) {
      const plain = conns.get(t);
      const res = insTable.run(t, plain ? encryptConnection(plain, connectionKey) : null);
      tableId.set(t, Number(res.lastInsertRowid));
    }
    const insTheme = db.prepare("INSERT INTO themes (name, profile_id, table_id, table_name, most_used) VALUES (?, ?, ?, ?, ?)");
    const themeId = new Map<string, number>();
    for (const t of spec.themes) {
      const res = insTheme.run(t.name, profileId.get(t.profile) ?? null, t.table ? (tableId.get(t.table) ?? null) : null, t.table, t.mostUsed);
      if (t.table && !themeId.has(t.table)) themeId.set(t.table, Number(res.lastInsertRowid));
    }

    if (spec.mobileForms) {
      db.exec("CREATE TABLE mobile_forms (id INTEGER PRIMARY KEY, theme_id INTEGER, profile_id INTEGER, name TEXT)");
      const insForm = db.prepare("INSERT INTO mobile_forms (theme_id, profile_id, name) VALUES (?, ?, ?)");
      for (const [name, table, profile] of spec.mobileForms) insForm.run(themeId.get(table) ?? null, profileId.get(profile) ?? null, name);
    }
    const insEdit = db.prepare("INSERT INTO edit_log (user_id, profile_id, table_name, action, at) VALUES (?, ?, ?, ?, ?)");
    const formProfile = new Map((spec.mobileForms ?? []).map(([, table, profile]) => [table, profileId.get(profile) ?? null]));
    for (let d = DAYS_OF_HISTORY; d >= 0; d--) {
      const day = addDays(refDate, -d);
      for (const [table, perDay] of spec.mobileInsertsPerDay) {
        const n = dailyCount(r, perDay, day);
        for (let i = 0; i < n; i++) {
          // ~10% are vendor staff testing in production: they must not count
          const userId = r() < 0.1 ? spec.cityUsers + 1 + between(r, 0, 4) : between(r, 1, spec.cityUsers);
          insEdit.run(userId, formProfile.get(table) ?? null, table, r() < 0.8 ? "insert" : "update", `${day} ${time(r)}`);
        }
      }
    }

    const insCert = db.prepare("INSERT INTO certificates (name) VALUES (?)");
    for (const c of spec.certificates) insCert.run(c);
    const insLog = db.prepare("INSERT INTO server_log (endpoint, params, at) VALUES (?, ?, ?)");
    const noise = ["/wms", "/wfs", "/tiles/{z}/{x}/{y}", "/api/search", "/api/login", "/api/themes"];
    const certWeights = spec.certificates.map((c, i) => [i, c.includes("test") ? 0.3 : spec.certificates.length - i] as const);
    for (let d = DAYS_OF_HISTORY; d >= 0; d--) {
      const day = addDays(refDate, -d);
      const events: Array<[string, string]> = [];
      const nNoise = dailyCount(r, spec.serverNoisePerDay, day);
      for (let i = 0; i < nNoise; i++) events.push([pick(r, noise), "{}"]);
      const nCert = spec.certificateEndpoint === "none" ? 0 : dailyCount(r, spec.certificatesPerDay, day);
      for (let i = 0; i < nCert; i++) {
        const idx = weighted(r, certWeights);
        events.push(
          spec.certificateEndpoint === "report"
            ? ["/api/certificates/report", `reportId=[${idx + 1}]&format=[pdf]`]
            : ["/rest/json/issueCertificate", JSON.stringify({ type: [spec.certificates[idx]] })],
        );
      }
      // ids grow with time, as in production (one day's events sorted by time)
      const stamped = events.map((e) => [...e, `${day} ${time(r)}`] as const).sort((a, b) => a[2].localeCompare(b[2]));
      for (const [endpoint, params, at] of stamped) insLog.run(endpoint, params, at);
    }

    if (spec.landSyncRuns > 0) {
      db.exec("CREATE TABLE land_sync_runs (id INTEGER PRIMARY KEY, ran_at TEXT)");
      const ins = db.prepare("INSERT INTO land_sync_runs (ran_at) VALUES (?)");
      for (let i = 0; i < spec.landSyncRuns; i++) ins.run(`${addDays(refDate, -i * 14)} 02:00:00`);
    }
    for (const t of spec.externalTables) db.exec(`CREATE TABLE ${t} (id INTEGER PRIMARY KEY, payload TEXT)`);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

// ── helpdesk mirror ─────────────────────────────────────────────────────────

const MIRROR_SCHEMA = `
CREATE TABLE tickets (
  id INTEGER PRIMARY KEY, city TEXT NOT NULL, subject TEXT NOT NULL,
  created_at TEXT NOT NULL,          -- UTC instant, ISO 8601
  base_status TEXT NOT NULL,         -- New, InAttendance, Stopped, Resolved, Closed, Canceled
  current_team TEXT, owner_history TEXT  -- JSON [{team}]
);
CREATE INDEX ix_tickets_city_created ON tickets (city, created_at);
`;

const SUBJECTS = ["Layer not loading", "Cannot export report", "Permission for new user", "Map print cut off", "Search returns nothing", "Form field missing", "Slow map", "Certificate layout"];

export function seedMirror(db: DatabaseSync, refDate: string): void {
  const r = prng(99);
  db.exec(MIRROR_SCHEMA);
  const ins = db.prepare("INSERT INTO tickets (city, subject, created_at, base_status, current_team, owner_history) VALUES (?, ?, ?, ?, ?, ?)");
  const perCity: Record<string, number> = { Rivermeadow: 150, Lakeside: 46, Oakwood: 14 };
  db.exec("BEGIN");
  for (const [city, n] of Object.entries(perCity)) {
    for (let i = 0; i < n; i++) {
      const day = addDays(refDate, -between(r, 0, DAYS_OF_HISTORY));
      const path = weighted(r, [
        [["Triage", "L1"], 70],
        [["Triage", "L1", "L2"], 12],
        [["Triage", "L1", "L2", "L3"], 8],
        [["Triage", "L1", "L3"], 4],
        [["Triage"], 6],
      ] as const);
      // an escalated ticket often ends back in L1 for the reply: the level must come from history
      const current = path.length > 2 && r() < 0.4 ? "L1" : path[path.length - 1]!;
      const status = weighted(r, [
        ["Closed", 50],
        ["Resolved", 30],
        ["InAttendance", 8],
        ["Stopped", 4],
        ["Canceled", 8],
      ] as const);
      ins.run(city, pick(r, SUBJECTS), `${day}T${time(r)}.000Z`, status, current, JSON.stringify(path.map((team) => ({ team }))));
    }
  }
  ins.run("Rivermeadow", "CONTRACT 53/2025 | annual renewal of the platform", `${addDays(refDate, -200)}T14:00:00.000Z`, "Closed", "Triage", "[]");
  ins.run("Rivermeadow", "Contract 12/2021 - old addendum", `${addDays(refDate, -420)}T14:00:00.000Z`, "Closed", "Triage", "[]");
  ins.run("Lakeside", "Contract no. 7/2024 - signed addendum", `${addDays(refDate, -90)}T13:00:00.000Z`, "Closed", "L1", "[]");
  db.exec("COMMIT");
}

// ── ticketing API ───────────────────────────────────────────────────────────

const usDate = (iso: string) => {
  const [y, m, d] = iso.split("-");
  return `${m}/${d}/${y}`;
};

export function helpdeskTickets(refDate: string): HelpdeskTicket[] {
  const at = (daysAgo: number) => `${addDays(refDate, -daysAgo)}T15:30:00.000Z`;
  const t: HelpdeskTicket[] = [
    { id: 9001, subject: `CTR_RIVERMEADOW_01_2025: Onsite training - ${usDate(addDays(refDate, -118))}`, createdDate: at(120), baseStatus: "Closed", organizations: ["City of Rivermeadow"] },
    { id: 9002, subject: "Remote training for the Finance team", createdDate: at(64), baseStatus: "Resolved", organizations: ["City of Rivermeadow", "MapCidade Customer Success"] },
    { id: 9003, subject: "Training profile request for new hires", createdDate: at(40), baseStatus: "Closed", organizations: ["City of Rivermeadow"] },
    { id: 9004, subject: "Training session - mobile app", createdDate: at(30), baseStatus: "Canceled", organizations: ["City of Rivermeadow"] },
    { id: 9005, subject: "Internal training on the new release", createdDate: at(20), baseStatus: "Closed", organizations: ["MapCidade Customer Success"] },
    { id: 9006, subject: "RE: Training session - field data collection app", createdDate: at(75), baseStatus: "Closed", organizations: ["Lakeside City Hall"] },
    { id: 9007, subject: "Onsite training - planning team", createdDate: at(500), baseStatus: "Closed", organizations: ["Oakwood Municipality"] },
    { id: 9008, subject: "Map not loading", createdDate: at(10), baseStatus: "Closed", organizations: ["Oakwood Municipality"] },
    { id: 9009, subject: "Training refund for travel", createdDate: at(12), baseStatus: "Closed", organizations: ["City of Rivermeadow"] },
  ];
  return t;
}

// ── VMs ─────────────────────────────────────────────────────────────────────

const GIB = 1024 ** 3;
function dfLine(dev: string, totalGb: number, usedGb: number, mount: string): string {
  const total = Math.round(totalGb * GIB);
  const used = Math.round(usedGb * GIB);
  return `${dev} ${total} ${used} ${total - used} ${Math.round((used / total) * 100)}% ${mount}`;
}

export function fakeVms(): Record<string, FakeVm> {
  const head = "Filesystem 1-blocks Used Available Capacity Mounted on";
  return {
    "198.51.100.21": {
      latencyMs: 700,
      df: [
        head,
        dfLine("/dev/mapper/vg0-root", 96.7, 46.1, "/"),
        "tmpfs 8312573952 0 8312573952 0% /dev/shm",
        dfLine("/dev/sda1", 1, 0.3, "/boot"),
        dfLine("/dev/sdb1", 1476, 1258.3, "/opt/disk01"),
        dfLine("/dev/sdc1", 500, 112.4, "/opt/disk02"),
      ].join("\n"),
    },
    "198.51.100.34": {
      latencyMs: 400,
      df: [head, dfLine("/dev/vda1", 80, 31.2, "/"), dfLine("/dev/vdb1", 250, 149.9, "/data1")].join("\n"),
    },
    // Oakwood's VM: the SSH login never completes; the collector's deadline cuts it off.
    "203.0.113.47": { behavior: "hang" },
  };
}

// ── everything ──────────────────────────────────────────────────────────────

export function seedAll(dataDir: string, refDate: string, connectionKey: string): void {
  for (const city of CITIES) {
    const spec = CITY_SPECS[city.id];
    if (!spec) continue;
    const path = join(dataDir, city.dbLocation);
    mkdirSync(dirname(path), { recursive: true });
    rmSync(path, { force: true });
    const db = new DatabaseSync(path);
    seedCityDb(db, spec, refDate, connectionKey);
    db.close();
  }
  const mirrorPath = join(dataDir, "support-mirror.db");
  rmSync(mirrorPath, { force: true });
  const mirror = new DatabaseSync(mirrorPath);
  seedMirror(mirror, refDate);
  mirror.close();
  writeFileSync(join(dataDir, "helpdesk-tickets.json"), JSON.stringify(helpdeskTickets(refDate), null, 2));
  writeFileSync(join(dataDir, "vms.json"), JSON.stringify(fakeVms(), null, 2));
  writeFileSync(join(dataDir, "seed.json"), JSON.stringify({ refDate, seededAt: new Date().toISOString() }, null, 2));
}
