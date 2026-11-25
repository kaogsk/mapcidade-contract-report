/**
 * Everything that comes from the city database (SELECT only, read-only session).
 *
 * The rules for "a city user" and "an access" are the analytics warehouse's, so the two never
 * disagree: vendor staff (e-mail on the vendor domain, or no e-mail at all) and the anonymous
 * visitor don't count, and neither do internal profiles (support, QA, digitizing…).
 *
 * The production queries are PostgreSQL; these are the same queries in the SQLite dialect
 * (window functions instead of DISTINCT ON, a registered REGEXP instead of `~*`).
 */
import { localBounds, monthsIn, type Period } from "../period.js";
import { MAX_DEPARTMENTS } from "../report.js";
import { profileOptions, type ProfileOption } from "../rules/departments.js";
import { suggestIntegrations, type ConnectionGroup } from "../rules/integrations.js";
import { DISPOSABLE_NAME, mobileNames, rankMobile, type MobileUsage } from "../rules/names.js";
import { isIntegration, readConnection, typeLabel } from "./connections.js";
import { serverLogIdRange } from "./server-log-range.js";
import type { CityDatabase } from "./types.js";

/** City user = not vendor staff. NULL e-mail is excluded too (NOT LIKE on NULL is not true). */
const CITY_USER = "u.email NOT LIKE '%@mapcidade.example'";

/** Profiles the warehouse leaves out of the access count. */
const PROFILES_OUT_OF_ACCESSES = ["", "MapCidade Support", "Quality Control", "Digitizing", "Field Survey", "Test", "Operations Manager"];

/** Internal/test profiles: don't count for mobile forms, layer examples or integrations. */
const INTERNAL_PROFILE = "mapcidade|test|training|support|onboarding|field survey|digitiz|quality control";

/** Theme names that are no example to show a city. */
const INTERNAL_THEME = "training|test|bkp|backup|_old|\\bold\\b|replica|auxiliary|sample|delete";

export const MAX_LAYER_EXAMPLES = 10;
export const MAX_MOBILE = 20;
export const MAX_CERTIFICATES = 20;

export interface CityData {
  users: number;
  accessesTotal: number;
  months: number;
  avgAccessesPerMonth: number;
  layers: number;
  layerExamples: string[];
  /** Every active profile, with the 10 most accessed departments ticked. */
  profiles: ProfileOption[];
  /** Names that come ticked for the report. */
  departments: string[];
  /** Department profiles accessed in the period, before the cut at 10. */
  activeDepartments: number;
  departmentsOrigin: "profiles" | "registry" | "none";
  /** The 20 most used mobile forms in the period; with no use, the configured ones. */
  mobile: string[];
  mobileUsage: MobileUsage[];
  mobileOrigin: "usage" | "configured" | "none";
  certificates: string[];
  certificateUsage: Array<{ name: string; issued: number }>;
  certificatesOrigin: "issued" | "configured" | "none";
  suggestedIntegrations: string[];
  /** Training profiles used in the period ("Training 2026 - Staff", 41 users). */
  trainingProfiles: Array<{ profile: string; users: number }>;
}

export interface CityCollectOptions {
  /** Host of the city's database: a PostgreSQL there is the platform's own, not an integration. */
  cityDbHost: string;
  connectionKey: string;
}

export async function collectCityData(db: CityDatabase, p: Period, opts: CityCollectOptions): Promise<CityData> {
  const [from, to] = localBounds(p);

  const [users] = await db.query<{ n: number }>(`SELECT count(*) AS n FROM users u WHERE ${CITY_USER}`);

  const accesses = await db.query<{ profile: string | null; n: number; users: number }>(
    `SELECT a.profile AS profile, count(*) AS n, count(DISTINCT u.id) AS users
       FROM access_log a
       JOIN users u ON u.login = a.user_login
      WHERE a.accessed_at >= ? AND a.accessed_at < ?
        AND ${CITY_USER}
        AND lower(u.login) <> 'visitor'
        AND coalesce(a.profile, '') NOT IN (SELECT value FROM json_each(?))
      GROUP BY 1`,
    [from, to, JSON.stringify(PROFILES_OUT_OF_ACCESSES)],
  );
  const accessesTotal = accesses.reduce((s, r) => s + r.n, 0);
  const months = monthsIn(p);

  const active = (await db.query<{ name: string }>("SELECT DISTINCT name FROM profiles WHERE coalesce(expired, 0) = 0 AND name IS NOT NULL")).map(
    (r) => r.name,
  );
  const byProfile = new Map(accesses.map((r) => [r.profile ?? "", r]));
  const activeUsage = active.map((profile) => ({ profile, accesses: byProfile.get(profile)?.n ?? 0 }));
  const departmentInUse = profileOptions(activeUsage).some((o) => o.top);

  // A city that only uses generic profiles ("Administrator", "City Hall - View"): the department
  // comes from the registry of the users who accessed in the period, weighted by their accesses.
  const registry = departmentInUse
    ? []
    : (
        await db.query<{ department: string; n: number }>(
          `SELECT trim(u.department) AS department, count(*) AS n
             FROM access_log a JOIN users u ON u.login = a.user_login
            WHERE a.accessed_at >= ? AND a.accessed_at < ? AND ${CITY_USER} AND coalesce(trim(u.department), '') <> ''
            GROUP BY 1 ORDER BY 2 DESC`,
          [from, to],
        )
      ).map((r) => ({ profile: r.department, accesses: r.n }));

  const profiles = profileOptions(activeUsage, registry);
  const ticked = departmentInUse
    ? profiles.filter((o) => o.top).map((o) => o.name)
    : profiles
        .filter((o) => o.origin === "registry")
        .slice(0, MAX_DEPARTMENTS)
        .map((o) => o.name);
  const departmentsOrigin: CityData["departmentsOrigin"] = departmentInUse ? "profiles" : ticked.length ? "registry" : "none";

  const trainingProfiles = accesses
    .filter((r) => r.profile && active.includes(r.profile) && /training/i.test(r.profile))
    .sort((a, b) => b.users - a.users)
    .map((r) => ({ profile: r.profile as string, users: r.users }));

  const [layers] = await db.query<{ n: number }>("SELECT count(*) AS n FROM layer_registry");

  const examples = await db.query<{ name: string }>(
    `SELECT t.name AS name
       FROM themes t JOIN profiles p ON p.id = t.profile_id
      WHERE coalesce(p.expired, 0) = 0 AND NOT (p.name REGEXP ?)
        AND t.table_name IS NOT NULL AND t.name NOT LIKE '\\_%' ESCAPE '\\' AND NOT (t.name REGEXP ?)
      GROUP BY 1
      ORDER BY sum(coalesce(t.most_used, 0)) DESC, count(*) DESC, 1
      LIMIT ${MAX_LAYER_EXAMPLES}`,
    [INTERNAL_PROFILE, INTERNAL_THEME],
  );

  const mobile = await collectMobile(db, from, to);
  const certs = await collectCertificates(db, from, to);

  const activeThemes = await db.query<{ name: string }>(
    `SELECT DISTINCT t.name AS name FROM themes t JOIN profiles p ON p.id = t.profile_id
      WHERE coalesce(p.expired, 0) = 0 AND t.name IS NOT NULL`,
  );
  const landSyncRuns = (await db.tableExists("land_sync_runs"))
    ? ((await db.query<{ n: number }>("SELECT count(*) AS n FROM land_sync_runs"))[0]?.n ?? 0)
    : 0;

  return {
    users: users?.n ?? 0,
    accessesTotal,
    months,
    avgAccessesPerMonth: Math.round(accessesTotal / months),
    layers: layers?.n ?? 0,
    layerExamples: examples.map((r) => r.name.trim()),
    profiles,
    departments: ticked,
    activeDepartments: profiles.filter((o) => o.department && o.origin === "profile" && o.accesses > 0).length,
    departmentsOrigin,
    ...mobile,
    certificates: certs.origin === "issued" ? certs.names.slice(0, MAX_CERTIFICATES) : certs.names,
    certificateUsage: certs.usage,
    certificatesOrigin: certs.origin,
    suggestedIntegrations: suggestIntegrations(
      activeThemes.map((r) => r.name),
      active,
      landSyncRuns,
      { connections: await externalConnections(db, opts), externalTables: await db.externalTables() },
    ),
    trainingProfiles,
  };
}

/**
 * Mobile use = records inserted in the period into the tables of themes that have a mobile form,
 * by city users. The form's name is the one configured for the profile that inserted; when that
 * profile has none, the table's first form.
 */
async function collectMobile(db: CityDatabase, from: string, to: string): Promise<Pick<CityData, "mobile" | "mobileUsage" | "mobileOrigin">> {
  if (!(await db.tableExists("mobile_forms"))) return { mobile: [], mobileUsage: [], mobileOrigin: "none" };
  const usage = rankMobile(
    await db.query<{ name: string; n: number }>(
      `WITH mf AS (
         SELECT t.table_name, m.profile_id, m.name, m.id
           FROM mobile_forms m JOIN themes t ON t.id = m.theme_id
          WHERE t.table_name IS NOT NULL AND m.name IS NOT NULL
       ), per_profile AS (
         SELECT table_name, profile_id, name FROM (
           SELECT *, row_number() OVER (PARTITION BY table_name, profile_id ORDER BY id) AS rn FROM mf
         ) WHERE rn = 1
       ), per_table AS (
         SELECT table_name, name FROM (
           SELECT *, row_number() OVER (PARTITION BY table_name ORDER BY id) AS rn FROM mf
         ) WHERE rn = 1
       )
       SELECT coalesce(pp.name, pt.name) AS name, count(*) AS n
         FROM edit_log e
         JOIN per_table pt ON pt.table_name = e.table_name
         LEFT JOIN per_profile pp ON pp.table_name = e.table_name AND pp.profile_id = e.profile_id
         JOIN users u ON u.id = e.user_id
        WHERE e.at >= ? AND e.at < ? AND e.action = 'insert' AND ${CITY_USER}
        GROUP BY 1`,
      [from, to],
    ),
  );
  if (usage.length) return { mobile: usage.slice(0, MAX_MOBILE).map((m) => m.name), mobileUsage: usage, mobileOrigin: "usage" };
  const configured = await db.query<{ name: string }>(
    `SELECT DISTINCT m.name AS name
       FROM mobile_forms m JOIN profiles p ON p.id = m.profile_id
      WHERE coalesce(p.expired, 0) = 0 AND NOT (p.name REGEXP ?) AND m.name IS NOT NULL AND NOT (m.name REGEXP ?)`,
    [INTERNAL_PROFILE, INTERNAL_THEME],
  );
  const names = mobileNames(configured.map((r) => r.name));
  return { mobile: names, mobileUsage: [], mobileOrigin: names.length ? "configured" : "none" };
}

/**
 * Certificates issued in the period, most issued first, read from the server log. Two generations
 * of the platform log them differently: the current app calls `…/certificates/report` with
 * `reportId=[12]` (name in the catalog), the legacy one `…/issueCertificate` with the name in a
 * JSON body. Every issuance counts, including the public portal's: what matters here is which
 * certificates are in operation under the contract, not who issued them. With none issued: the
 * configured catalog.
 */
async function collectCertificates(
  db: CityDatabase,
  from: string,
  to: string,
): Promise<{ names: string[]; usage: CityData["certificateUsage"]; origin: CityData["certificatesOrigin"] }> {
  const hasCatalog = await db.tableExists("certificates");
  if (await db.tableExists("server_log")) {
    const [idFrom, idTo] = await serverLogIdRange(db, from.slice(0, 10), to.slice(0, 10));
    const rows = await db.query<{ name: string; n: number }>(
      `WITH ev AS (
         SELECT endpoint, params FROM server_log
          WHERE id >= ? AND id < ? AND at >= ? AND at < ?
            AND (endpoint LIKE '%/certificates/report' OR endpoint LIKE '%/issueCertificate')
       ), sub AS (
         SELECT regexp_group(params, 'reportId=\\[(\\d+)\\]') AS report_id, NULL AS kind FROM ev WHERE endpoint LIKE '%/report'
         UNION ALL
         SELECT NULL, regexp_group(params, '"type":\\["([^"]+)"\\]') FROM ev WHERE endpoint LIKE '%/issueCertificate'
       )
       SELECT trim(coalesce(sub.kind, c.name)) AS name, count(*) AS n
         FROM sub
         LEFT JOIN ${hasCatalog ? "certificates" : "(SELECT NULL AS id, NULL AS name)"} c
           ON sub.report_id IS NOT NULL AND CAST(c.id AS TEXT) = sub.report_id
        WHERE coalesce(sub.kind, c.name) IS NOT NULL
        GROUP BY 1 ORDER BY 2 DESC, 1`,
      [idFrom, idTo, from, to],
    );
    const usage = rows.filter((r) => !DISPOSABLE_NAME.test(r.name)).map((r) => ({ name: r.name, issued: r.n }));
    if (usage.length) return { names: usage.map((u) => u.name), usage, origin: "issued" };
  }
  const configured = hasCatalog
    ? (await db.query<{ name: string }>("SELECT DISTINCT trim(name) AS name FROM certificates WHERE name IS NOT NULL ORDER BY 1"))
        .map((r) => r.name)
        .filter((n) => !DISPOSABLE_NAME.test(n))
    : [];
  return configured.length ? { names: configured, usage: [], origin: "configured" } : { names: [], usage: [], origin: "none" };
}

/** Data tables tied to a third-party system, grouped by connection. Only type and host come out. */
async function externalConnections(db: CityDatabase, opts: CityCollectOptions): Promise<ConnectionGroup[]> {
  if (!(await db.tableExists("data_tables"))) return [];
  const rows = await db.query<{ conn: string; tables: string; themes: string }>(
    `SELECT d.connection AS conn,
            json_group_array(DISTINCT substr(d.name, 1, 120)) AS tables,
            json_group_array(DISTINCT t.name) AS themes
       FROM data_tables d
       LEFT JOIN themes t ON t.table_id = d.id
      WHERE coalesce(d.connection, '') <> ''
      GROUP BY 1`,
  );
  const groups = new Map<string, ConnectionGroup>();
  for (const r of rows) {
    const c = readConnection(r.conn, opts.connectionKey);
    if (!c || !isIntegration(c, opts.cityDbHost)) continue;
    const clean = (json: string) => (JSON.parse(json) as Array<string | null>).filter((s): s is string => !!s && !DISPOSABLE_NAME.test(s));
    const themes = clean(r.themes);
    const tables = clean(r.tables);
    if (!themes.length && !tables.length) continue;
    const type = typeLabel(c);
    const key = `${type}|${c.host}`;
    const g = groups.get(key) ?? { type, host: c.host, service: c.service, themes: [], tables: [] };
    g.themes.push(...themes);
    g.tables.push(...tables);
    groups.set(key, g);
  }
  return [...groups.values()];
}
