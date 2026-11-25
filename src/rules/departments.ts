/**
 * "User departments" = the city's department profiles that were used in the period, at most 10,
 * most accessed first.
 *
 * Access profiles are named by whoever configured the city, so the same department shows up under
 * many names. The rules below collapse them:
 *   "Finance - Edit" + "Finance - View"                                  → "Finance"
 *   "Dept. Urban Planning Advanced 1" + "… Advanced 2" + "Dept. Urban Planning" → "Urban Planning"
 *   "Housing-Advanced" + "Housing-Basic"                                 → "Housing"
 * and leave out what is not a department: vendor staff, support, training, test, public/visitor
 * and plain system roles ("Administrator").
 */
import { MAX_DEPARTMENTS } from "../report.js";

/**
 * A profile whose name contains one of these is never a department. "Public" alone is not here on
 * purpose: "Public Works" is a department, "Public portal" is not.
 */
const NOT_DEPARTMENT_CONTAINS =
  /mapcidade|vendor|support|onboarding|training|\btest\b|digitiz|quality control|^qc\b|field survey|certificate|operations manager|consult|\bpublic (?:access|portal|view)|valuation map|^adm\b|\bbkp\b|backup|^external\b|contractor/i;

/** Normalized names that are generic roles, not departments. */
const NOT_DEPARTMENT_EXACT = new Set([
  "administrator",
  "admin",
  "general administrator",
  "public",
  "geoportal",
  "citizen",
  "visitor",
  "city hall",
  "user",
  "default",
  "read only",
  "monitoring",
  "monitor",
  "advanced",
  "basic",
]);

/** Access-level suffix: " - Edit", " (View)", " Viewer", "-Advanced 2"… (only one is removed). */
const ACCESS_SUFFIX =
  /\s*(?:[-–]\s*|\(\s*|\s)(?:edit|editing|editor|view|viewer|read|read-only|admin|administrator|management|advanced|basic|intermediate|full)(?:\s*\d+)?\s*\)?\s*$/i;

export function normalizeProfile(profile: string): string {
  // "Module of Environment" / "Module Public Works" → the department
  let name = profile.replace(/\s+/g, " ").trim().replace(/^module\s+(?:of\s+)?/i, "");
  // "Dept. Finance" → "Finance" (the abbreviation identifies nothing; other profiles lack it)
  name = name.replace(/^dept\.?\s+/i, "");
  // One suffix only: "Monitoring - Administrator" becomes "Monitoring", nothing more.
  const stripped = name.replace(ACCESS_SUFFIX, "").trim();
  if (stripped.length >= 2) name = stripped;
  return name;
}

export function isDepartment(profile: string): boolean {
  const n = normalizeProfile(profile);
  if (!n) return false;
  if (NOT_DEPARTMENT_CONTAINS.test(profile) || NOT_DEPARTMENT_CONTAINS.test(n)) return false;
  return !NOT_DEPARTMENT_EXACT.has(n.toLowerCase()) && !NOT_DEPARTMENT_EXACT.has(profile.trim().toLowerCase());
}

export interface ProfileUsage {
  profile: string;
  accesses: number;
}

export interface Department {
  name: string;
  accesses: number;
  /** Original profiles merged into this line. */
  profiles: string[];
}

/** One row of the picker on the review screen (the analyst ticks which go into the report). */
export interface ProfileOption {
  name: string;
  accesses: number;
  profiles: string[];
  /** Looks like a department (not a system/vendor/test profile). */
  department: boolean;
  /** Among the 10 most accessed departments — comes ticked. */
  top: boolean;
  /** "profile" = access profile; "registry" = department field of the user registry. */
  origin: "profile" | "registry";
}

const key = (s: string) => s.toLocaleLowerCase("en");

export function topDepartments(usages: ProfileUsage[], max = MAX_DEPARTMENTS): { list: Department[]; total: number } {
  const acc = new Map<string, Department>();
  for (const u of usages) {
    if (!u.profile || !(u.accesses > 0) || !isDepartment(u.profile)) continue;
    const name = normalizeProfile(u.profile);
    const d = acc.get(key(name)) ?? { name, accesses: 0, profiles: [] };
    d.accesses += u.accesses;
    if (!d.profiles.includes(u.profile)) d.profiles.push(u.profile);
    acc.set(key(name), d);
  }
  const all = [...acc.values()].sort((a, b) => b.accesses - a.accesses || a.name.localeCompare(b.name, "en"));
  return { list: all.slice(0, max), total: all.length };
}

/**
 * Every active profile (used in the period or not), grouped by normalized name: first the 10 most
 * accessed departments (ticked), then the other departments, then profiles that don't look like a
 * department, and last whatever came from the user registry.
 */
export function profileOptions(active: ProfileUsage[], registry: ProfileUsage[] = [], max = MAX_DEPARTMENTS): ProfileOption[] {
  const top = new Set(topDepartments(active, max).list.map((d) => key(d.name)));
  const acc = new Map<string, ProfileOption>();
  for (const u of active) {
    if (!u.profile?.trim()) continue;
    const dept = isDepartment(u.profile);
    const name = dept ? normalizeProfile(u.profile) : u.profile.replace(/\s+/g, " ").trim();
    const o = acc.get(key(name)) ?? { name, accesses: 0, profiles: [], department: dept, top: false, origin: "profile" as const };
    o.accesses += Math.max(0, u.accesses);
    if (!o.profiles.includes(u.profile)) o.profiles.push(u.profile);
    o.top = top.has(key(name));
    acc.set(key(name), o);
  }
  for (const r of registry) {
    const name = r.profile?.replace(/\s+/g, " ").trim();
    if (!name || acc.has(key(name))) continue;
    acc.set(key(name), { name, accesses: r.accesses, profiles: [], department: true, top: false, origin: "registry" });
  }
  const rank = (o: ProfileOption) => (o.top ? 0 : o.origin === "registry" ? 3 : o.department ? 1 : 2);
  return [...acc.values()].sort((a, b) => rank(a) - rank(b) || b.accesses - a.accesses || a.name.localeCompare(b.name, "en"));
}
