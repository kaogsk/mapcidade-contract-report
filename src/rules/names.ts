/**
 * Naming rules shared by the mobile-form and certificate lists: copies, tests and drafts never go
 * into a document sent to the city.
 */

/** Copy, test or draft ("… BKP 28.10", "permit_test", "_x_bkp_130126", "Old zoning"). */
export const DISPOSABLE_NAME = /^\s*_|\bbkp\b|_bkp|bkp_|backup|(?:^|[\s_.-])test(?:s|ing)?(?=$|[\s_.\d-])|_old\b|\bold\b|\bcopy\b|draft|delete/i;

/** "Mobile - Tree Inventory" → "Tree Inventory". */
export const cleanMobileName = (n: string) => n.replace(/^\s*mobile\s*[-–:]?\s*/i, "").replace(/\s+/g, " ").trim();

export interface MobileUsage {
  name: string;
  records: number;
}

/** Adds up by cleaned name (the same form repeated under several profiles), most used first. */
export function rankMobile(rows: Array<{ name: string | null; n: number }>): MobileUsage[] {
  const acc = new Map<string, MobileUsage>();
  for (const r of rows) {
    const name = cleanMobileName(r.name ?? "");
    if (!name || DISPOSABLE_NAME.test(name) || !(r.n > 0)) continue;
    const u = acc.get(name.toLowerCase()) ?? { name, records: 0 };
    u.records += r.n;
    acc.set(name.toLowerCase(), u);
  }
  return [...acc.values()].sort((a, b) => b.records - a.records || a.name.localeCompare(b.name, "en"));
}

/** Configured forms (fallback when nothing was recorded): cleaned, deduplicated, alphabetical. */
export function mobileNames(names: string[]): string[] {
  const seen = new Map<string, string>();
  for (const n of names) {
    const clean = cleanMobileName(n);
    if (clean && !DISPOSABLE_NAME.test(clean) && !seen.has(clean.toLowerCase())) seen.set(clean.toLowerCase(), clean);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b, "en"));
}
