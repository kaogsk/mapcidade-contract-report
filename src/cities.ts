/**
 * Registered cities. Production reads this list from the shared database-connection registry; the
 * demo ships three fictional cities, each exercising a different path of the collector:
 *
 *   Rivermeadow — large; every source answers; >10 department profiles (the cut at 10 kicks in).
 *   Lakeside    — only generic profiles (departments come from the user registry), mobile forms
 *                 configured but unused, certificates issued through the legacy endpoint.
 *   Oakwood     — small; its VM never answers (disks section comes out "not available"), no
 *                 contract number in any ticket, no certificate issued in the period.
 *
 * Addresses are documentation ranges (RFC 5737). The browser never sees `dbHost`/`dbLocation`.
 */
import type { City } from "./sources/types.js";

export const CITIES: readonly City[] = [
  {
    id: "rivermeadow",
    name: "Rivermeadow",
    region: "North Valley",
    dbHost: "198.51.100.21",
    dbLocation: "cities/rivermeadow.db",
    helpdeskOrg: "City of Rivermeadow",
  },
  {
    id: "lakeside",
    name: "Lakeside",
    region: "Lakes Region",
    dbHost: "198.51.100.34",
    dbLocation: "cities/lakeside.db",
    helpdeskOrg: "Lakeside City Hall",
  },
  {
    id: "oakwood",
    name: "Oakwood",
    region: "East Hills",
    dbHost: "203.0.113.47",
    dbLocation: "cities/oakwood.db",
    helpdeskOrg: "Oakwood Municipality",
  },
];

export function findCity(id: string): City | undefined {
  return CITIES.find((c) => c.id === id.trim().toLowerCase());
}

/** What the browser may see. */
export const publicCity = (c: City) => ({ id: c.id, name: c.name, region: c.region });
