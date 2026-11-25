/**
 * The server log of a big city holds tens of millions of rows and is indexed only by its primary
 * key — and nobody gets to create an index on a city's production database. A query filtered by
 * date would scan the whole table.
 *
 * Ids grow with time, though. So the date window is turned into an id range [from, to) by binary
 * search on the primary key: each probe is an index seek (`WHERE id >= ? ORDER BY id LIMIT 1`).
 * About 2 × log2(rows) seeks replace a full scan.
 *
 * Before trusting that, the ids are sampled at 33 evenly spaced points: if the dates go backwards
 * by more than a day (a table restored out of order, ids reused), the search would be wrong, and
 * the whole id range is returned instead — slow but correct.
 */
import { addDays } from "../period.js";
import type { CityDatabase } from "./types.js";

export interface RangeStats {
  probes: number;
}

export async function serverLogIdRange(db: CityDatabase, fromDay: string, toDayExclusive: string, stats: RangeStats = { probes: 0 }): Promise<[number, number]> {
  const [lim] = await db.query<{ lo: number | null; hi: number | null }>("SELECT min(id) AS lo, max(id) AS hi FROM server_log");
  const lo = lim?.lo ?? null;
  const hi = lim?.hi ?? null;
  if (lo === null || hi === null) return [0, 0];
  const everything: [number, number] = [lo, hi + 1];

  let previous = "";
  for (let i = 0; i <= 32; i++) {
    stats.probes++;
    const [r] = await db.query<{ d: string }>("SELECT substr(at, 1, 10) AS d FROM server_log WHERE id >= ? ORDER BY id LIMIT 1", [
      Math.floor(lo + ((hi - lo) * i) / 32),
    ]);
    if (!r) continue;
    if (previous && addDays(r.d, 1) < previous) return everything;
    if (r.d > previous) previous = r.d;
  }
  return [await firstIdOnOrAfter(db, lo, hi, fromDay, stats), await firstIdOnOrAfter(db, lo, hi, toDayExclusive, stats)];
}

/** Smallest id whose date is >= day (hi + 1 when none). */
async function firstIdOnOrAfter(db: CityDatabase, lo0: number, hi0: number, day: string, stats: RangeStats): Promise<number> {
  let lo = lo0;
  let hi = hi0;
  let answer = hi0 + 1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    stats.probes++;
    // Alias is not "id": ORDER BY id would bind to the output column in some engines and lose the PK.
    const [x] = await db.query<{ pk: number; ok: number }>(
      "SELECT id AS pk, (at >= ?) AS ok FROM server_log WHERE id >= ? ORDER BY id LIMIT 1",
      [day, mid],
    );
    if (!x) hi = mid - 1;
    else if (x.ok) {
      answer = Math.min(answer, x.pk);
      hi = mid - 1;
    } else lo = x.pk + 1;
  }
  return answer;
}
