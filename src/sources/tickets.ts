/**
 * "User support" — the city's tickets in the period, read from the local mirror of the helpdesk
 * that another internal dashboard keeps in sync. The mirror only has tickets that went through the
 * support teams (Triage, L1, L2, L3).
 *
 * - Window: opened in (start, end], local day (same window as every other count).
 * - Level = the highest the ticket reached, from the current team or ANY step of its owner
 *   history: went through L3 → level 3; else through L2 → level 2; else level 1 (Triage, L1). An
 *   escalated ticket counts once, at the level where the technical work ended.
 * - Resolved = Resolved/Closed; pending = any other status but Canceled.
 * - Handled = resolved + pending; canceled stays apart and only enters the period total.
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import type { Tickets } from "../report.js";
import type { MirrorTicketCounts, TicketMirror } from "./types.js";

const reached = (team: string) =>
  `(current_team LIKE '%${team}%' OR EXISTS (
      SELECT 1 FROM json_each(coalesce(owner_history, '[]')) h WHERE json_extract(h.value, '$.team') LIKE '%${team}%'))`;

const LEVEL = `CASE WHEN ${reached("L3")} THEN 3 WHEN ${reached("L2")} THEN 2 ELSE 1 END`;

export class SqliteTicketMirror implements TicketMirror {
  private db: DatabaseSync | null = null;

  constructor(private readonly path: string) {}

  private open(): DatabaseSync {
    if (!this.db) {
      if (this.path !== ":memory:" && !existsSync(this.path)) throw new Error("ticket mirror database not found");
      this.db = new DatabaseSync(this.path, { readOnly: this.path !== ":memory:" });
    }
    return this.db;
  }

  /** Tests seed an in-memory mirror and hand the connection over. */
  static wrap(db: DatabaseSync): SqliteTicketMirror {
    const m = new SqliteTicketMirror(":memory:");
    m.db = db;
    return m;
  }

  async countTickets(city: string, fromUtc: string, toUtc: string): Promise<MirrorTicketCounts[]> {
    return this.open()
      .prepare(
        `SELECT ${LEVEL} AS level,
                CASE WHEN base_status IN ('Resolved', 'Closed') THEN 'resolved'
                     WHEN base_status = 'Canceled' THEN 'canceled'
                     ELSE 'pending' END AS outcome,
                count(*) AS n
           FROM tickets
          WHERE lower(city) = lower(?) AND created_at >= ? AND created_at < ?
          GROUP BY 1, 2`,
      )
      .all(city, fromUtc, toUtc) as unknown as MirrorTicketCounts[];
  }

  async contractSubjects(city: string): Promise<string[]> {
    const rows = this.open()
      .prepare(
        `SELECT subject FROM tickets
          WHERE lower(city) = lower(?) AND subject LIKE '%contract%'
          ORDER BY created_at DESC LIMIT 20`,
      )
      .all(city) as Array<{ subject: string }>;
    return rows.map((r) => r.subject);
  }

  close(): void {
    if (this.db?.isOpen) this.db.close();
    this.db = null;
  }
}

export function summarizeTickets(rows: MirrorTicketCounts[]): Tickets {
  const out: Tickets = { resolved: { l1: 0, l2: 0, l3: 0 }, pending: { l1: 0, l2: 0, l3: 0 }, canceled: 0 };
  for (const r of rows) {
    const k = `l${r.level}` as "l1" | "l2" | "l3";
    if (r.outcome === "canceled") out.canceled += r.n;
    else if (r.outcome === "resolved") out.resolved[k] += r.n;
    else out.pending[k] += r.n;
  }
  return out;
}

/** "CONTRACT 53/2025 | renewal" → "053/2025". Contract numbers print with 3 digits. */
export function extractContract(subject: string): string | null {
  const m = subject.match(/contract\s*(?:n(?:o|um(?:ber)?)?[º°.]*\s*)?#?\s*(\d{1,4})\s*\/\s*(\d{4})/i);
  if (!m) return null;
  return `${(m[1] ?? "").padStart(3, "0")}/${m[2]}`;
}

/** Contract number quoted in the most recent ticket of the city that quotes one. */
export function contractFromSubjects(subjects: string[]): string | null {
  for (const s of subjects) {
    const c = extractContract(s);
    if (c) return c;
  }
  return null;
}
