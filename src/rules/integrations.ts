/**
 * "Integrations delivered". No table records an integration, so the list is SUGGESTED from what an
 * integration leaves behind in the city database, then confirmed by the analyst:
 *
 *   1. a vendor's name in a theme or profile ("Property registry - Tributa", "Permitly");
 *   2. a data table whose connection points at a third-party system (another DBMS, a REST/SOAP
 *      service, or a PostgreSQL outside the private network) — see sources/connections.ts;
 *   3. tables loaded from another system (the `ext_` tables);
 *   4. runs of the land-registry sync job.
 *
 * Only lines with a vendor name go into the document by default ("explicit"). Generic findings
 * ("Cemetery – SQL Server", "Permits and processes (integration)") are shown on the review screen
 * for the analyst to tick — they are real signals, but too vague to print unconfirmed.
 *
 * All vendor names below are fictional.
 */

interface Vendor {
  name: string;
  re: RegExp;
}

export const VENDORS: readonly Vendor[] = [
  { name: "Tributa", re: /tributa/i },
  { name: "CivicSoft", re: /civic\s?soft/i },
  { name: "Arqon", re: /\barqon\b/i },
  { name: "DocFlow", re: /doc\s?flow/i },
  { name: "Permitly", re: /permitly/i },
  { name: "LandSync", re: /land\s?sync/i },
  { name: "GovBridge", re: /gov\s?bridge/i },
];

/**
 * Subject of an integration, guessed from the theme name. ORDER MATTERS: the first match wins, so
 * the specific subjects come before the broad one ("property transfer tax" and "property valuation
 * map" are not the property registry).
 */
const DOMAINS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "Property transfer tax", re: /transfer tax|\bptt\b/i },
  { name: "Land value map", re: /land value|valuation map/i },
  { name: "Property registry", re: /propert|real estate|\blots?\b|parcel/i },
  { name: "Business registry", re: /business|compan|economic activit|\bbiz\b/i },
  { name: "Taxpayers", re: /taxpayer|owner|person/i },
  { name: "Permits and processes", re: /permit|process|protocol/i },
  { name: "Cemetery", re: /cemeter|grave|burial/i },
];

/** Generic "integration" wording, no vendor. */
const GENERIC = /\bintegration\b|\bweb ?service\b|\bintegrated\b/i;
/** False positives of "integrat…" seen when sweeping theme names. */
const FALSE_GENERIC = /reintegrat|not integrated|integrated pest|integrity|integrated care/i;

function domainOf(name: string): string | null {
  for (const d of DOMAINS) if (d.re.test(name)) return d.name;
  return null;
}

/** Tables sharing one external connection (see sources/connections.ts). */
export interface ConnectionGroup {
  /** "SQL Server", "REST web service". */
  type: string;
  host: string;
  service: boolean;
  themes: string[];
  tables: string[];
}

export interface ExtraSignals {
  connections?: ConnectionGroup[];
  /** Tables loaded from another system (`ext_*`). */
  externalTables?: string[];
}

const GENERIC_SUFFIX = " (integration)";

/**
 * @param themes theme names of active profiles
 * @param profiles active profile names
 * @param landSyncRuns rows in the land-registry sync log (> 0 = LandSync in use)
 */
export function suggestIntegrations(themes: string[], profiles: string[] = [], landSyncRuns = 0, extras: ExtraSignals = {}): string[] {
  // Precedence: vendor by name > external connection > generic mention ("X (integration)").
  const base = byName(themes, profiles, landSyncRuns);
  const generic = base.filter((s) => s.endsWith(GENERIC_SUFFIX));
  const out = base.filter((s) => !s.endsWith(GENERIC_SUFFIX));
  const covered = new Set(out.map((s) => s.split(" – ")[0]));
  const add = (s: string, domain: string | null) => {
    if (domain && covered.has(domain)) return;
    if (!out.includes(s)) out.push(s);
    if (domain) covered.add(domain);
  };

  // External connection: if one of its themes/tables (or its host) names a vendor, the vendor line
  // covers it; otherwise it becomes "<subject> – <technology>", one per subject.
  for (const g of extras.connections ?? []) {
    const names = [...g.themes, ...g.tables];
    const vendor = VENDORS.find((v) => [...names, g.host].some((n) => v.re.test(n)));
    if (vendor) {
      const domain = predominantDomain(names);
      const i = out.findIndex((s) => s.endsWith(`– ${vendor.name}`));
      if (i < 0) add(`${domain ?? "Integration"} – ${vendor.name}`, null);
      else if (domain && out[i] === `Integration – ${vendor.name}`) out[i] = `${domain} – ${vendor.name}`;
      continue;
    }
    const tech = g.service ? `${g.type} (${g.host})` : g.type;
    const domains = DOMAINS.map((d) => d.name).filter((d) => names.some((n) => domainOf(n) === d));
    if (domains.length === 0) add(`Integration – ${tech}`, null);
    for (const d of domains) add(`${d} – ${tech}`, d);
  }
  for (const s of generic) add(s, s.replace(GENERIC_SUFFIX, ""));

  // ext_ tables: data loaded from another system. One with no recognizable subject only counts when
  // nothing else was found — it is usually the mirror of an integration already listed.
  const external = (extras.externalTables ?? []).filter((n) => !/bkp|backup|_old\b|test/i.test(n));
  const noDomain: string[] = [];
  for (const n of external) {
    const d = domainOf(n.replace(/^ext_/, "").replace(/_/g, " "));
    if (d) add(`${d} (external dataset)`, d);
    else noDomain.push(n);
  }
  if (noDomain.length && out.length === 0)
    add(`External datasets (${noDomain.slice(0, 3).join(", ")}${noDomain.length > 3 ? "…" : ""})`, null);
  return out;
}

/** Most frequent subject among the names (ties: first in DOMAINS order). */
function predominantDomain(names: string[]): string | null {
  const n = new Map<string, number>();
  for (const name of names) {
    const d = domainOf(name);
    if (d) n.set(d, (n.get(d) ?? 0) + 1);
  }
  let best: string | null = null;
  for (const d of DOMAINS) if ((n.get(d.name) ?? 0) > (best ? (n.get(best) ?? 0) : 0)) best = d.name;
  return best;
}

function byName(themes: string[], profiles: string[], landSyncRuns: number): string[] {
  const byVendor = new Map<string, Set<string>>();
  const generic = new Set<string>();

  const note = (name: string, fromTheme: boolean) => {
    if (!name || name.startsWith("_")) return;
    let found = false;
    for (const v of VENDORS) {
      if (!v.re.test(name)) continue;
      found = true;
      const domains = byVendor.get(v.name) ?? new Set<string>();
      // A profile name ("Permitly") says who, not what: only themes give the subject.
      const d = fromTheme ? domainOf(name) : null;
      if (d) domains.add(d);
      byVendor.set(v.name, domains);
    }
    if (!found && fromTheme && GENERIC.test(name) && !FALSE_GENERIC.test(name)) {
      const d = domainOf(name);
      if (d) generic.add(d);
    }
  };
  for (const t of themes) note(t, true);
  for (const p of profiles) note(p, false);
  if (landSyncRuns > 0 && !byVendor.has("LandSync")) byVendor.set("LandSync", new Set(["Property registry"]));

  const out: string[] = [];
  for (const v of VENDORS) {
    const domains = byVendor.get(v.name);
    if (!domains) continue;
    if (domains.size === 0) out.push(`Integration – ${v.name}`);
    // Fixed subject order, so the document doesn't reshuffle between two generations.
    for (const d of DOMAINS) if (domains.has(d.name)) out.push(`${d.name} – ${v.name}`);
  }
  const withVendor = new Set(out.map((s) => s.split(" – ")[0]));
  for (const d of DOMAINS) if (generic.has(d.name) && !withVendor.has(d.name)) out.push(`${d.name}${GENERIC_SUFFIX}`);
  return out;
}

/**
 * A line naming a vendor ("Property registry – Tributa") goes into the report by default. The rest
 * ("Integration – SQL Server", "Cemetery (integration)", "… (external dataset)") waits on the
 * review screen for the analyst to include it.
 */
export function isExplicit(line: string): boolean {
  return VENDORS.some((v) => line.endsWith(`– ${v.name}`));
}
