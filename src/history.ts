/**
 * Usage history in the tool's OWN database — the only database it ever writes to. One row per
 * collection (with duration, which sources failed, warnings) and one per downloaded document (with
 * the headline numbers and the full content, so an old document can be rebuilt exactly).
 *
 * Recording never delays or breaks the response: a failure goes to the log and nothing else.
 * Never stored: connection strings, tokens, hosts.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { errorMessage } from "./errors.js";
import { handled, ReportSchema, totalTickets, type Report } from "./report.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS collections (
  id            INTEGER PRIMARY KEY,
  at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  user_name     TEXT NOT NULL,
  city_id       TEXT NOT NULL,
  city_name     TEXT,
  period_start  TEXT,
  period_end    TEXT,
  duration_ms   INTEGER NOT NULL,
  success       INTEGER NOT NULL,
  error         TEXT,               -- already sanitized
  failed_sources TEXT,              -- JSON array of source ids
  warnings      TEXT                -- JSON array
);
CREATE INDEX IF NOT EXISTS ix_collections_at ON collections (at DESC);

CREATE TABLE IF NOT EXISTS reports (
  id              INTEGER PRIMARY KEY,
  at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  user_name       TEXT NOT NULL,
  city_id         TEXT NOT NULL,
  city_name       TEXT NOT NULL,
  period_start    TEXT NOT NULL,
  period_end      TEXT NOT NULL,
  contract        TEXT,
  edited          INTEGER NOT NULL, -- 1 = analyst changed something on the review screen
  file_name       TEXT NOT NULL,
  bytes           INTEGER NOT NULL,
  users           INTEGER,
  avg_accesses    INTEGER,
  layers          INTEGER,
  tickets_total   INTEGER,          -- NULL when the ticket source was unavailable
  tickets_handled INTEGER,
  n_departments   INTEGER,
  n_integrations  INTEGER,
  n_mobile        INTEGER,
  n_certificates  INTEGER,
  unavailable     TEXT,             -- JSON array of sections printed as "not available"
  content         TEXT NOT NULL     -- the report as rendered (JSON)
);
CREATE INDEX IF NOT EXISTS ix_reports_at ON reports (at DESC);

CREATE VIEW IF NOT EXISTS monthly_usage AS
WITH c AS (
  SELECT substr(at, 1, 7) AS month, count(*) AS collections,
         sum(success = 0) AS failed_collections,
         round(avg(CASE WHEN success = 1 THEN duration_ms END) / 1000.0, 1) AS avg_collection_s
    FROM collections GROUP BY 1
), r AS (
  SELECT substr(at, 1, 7) AS month, count(*) AS documents, sum(edited) AS edited_documents,
         count(DISTINCT city_id) AS cities
    FROM reports GROUP BY 1
), m AS (SELECT month FROM c UNION SELECT month FROM r)
SELECT m.month,
       coalesce(c.collections, 0) AS collections, coalesce(c.failed_collections, 0) AS failed_collections, c.avg_collection_s,
       coalesce(r.documents, 0) AS documents, coalesce(r.edited_documents, 0) AS edited_documents, coalesce(r.cities, 0) AS cities
  FROM m LEFT JOIN c USING (month) LEFT JOIN r USING (month)
 ORDER BY m.month DESC;
`;

export interface CollectionEvent {
  user: string;
  cityId: string;
  cityName: string | null;
  start: string | null;
  end: string | null;
  durationMs: number;
  error: string | null;
  failedSources: string[];
  warnings: string[];
}

export interface ReportEvent {
  user: string;
  report: Report;
  edited: boolean;
  fileName: string;
  bytes: number;
}

export class UsageHistory {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }

  private safely(what: string, fn: () => void): void {
    try {
      fn();
    } catch (e) {
      console.error(`[history] ${what}: could not record: ${errorMessage(e)}`);
    }
  }

  collection(ev: CollectionEvent): void {
    this.safely("collections", () =>
      this.db
        .prepare(
          `INSERT INTO collections (user_name, city_id, city_name, period_start, period_end, duration_ms, success, error, failed_sources, warnings)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          ev.user.slice(0, 64),
          ev.cityId.slice(0, 80),
          ev.cityName,
          ev.start,
          ev.end,
          Math.round(ev.durationMs),
          ev.error ? 0 : 1,
          ev.error ? errorMessage(ev.error).slice(0, 1000) : null,
          JSON.stringify(ev.failedSources),
          JSON.stringify(ev.warnings.slice(0, 50)),
        ),
    );
  }

  report(ev: ReportEvent): void {
    const r = ev.report;
    this.safely("reports", () =>
      this.db
        .prepare(
          `INSERT INTO reports (user_name, city_id, city_name, period_start, period_end, contract, edited, file_name, bytes,
                                users, avg_accesses, layers, tickets_total, tickets_handled,
                                n_departments, n_integrations, n_mobile, n_certificates, unavailable, content)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          ev.user.slice(0, 64),
          r.city.id,
          r.city.name,
          r.period.start,
          r.period.end,
          r.contract || null,
          ev.edited ? 1 : 0,
          ev.fileName,
          ev.bytes,
          r.users,
          r.avgAccessesPerMonth,
          r.layers,
          r.tickets ? totalTickets(r.tickets) : null,
          r.tickets ? handled(r.tickets) : null,
          r.departments.length,
          r.integrations.length,
          r.mobile.length,
          r.certificates.length,
          JSON.stringify(Object.keys(r.notes)),
          JSON.stringify(r),
        ),
    );
  }

  recentReports(limit = 20): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        `SELECT id, at, user_name, city_name, period_start, period_end, contract, edited, file_name, bytes,
                users, avg_accesses, layers, tickets_total, unavailable
           FROM reports ORDER BY id DESC LIMIT ?`,
      )
      .all(limit)
      .map((row) => ({ ...row, unavailable: JSON.parse(String(row.unavailable ?? "[]")) as string[] }));
  }

  recentCollections(limit = 20): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        `SELECT id, at, user_name, city_name, period_start, period_end, duration_ms, success, error, failed_sources
           FROM collections ORDER BY id DESC LIMIT ?`,
      )
      .all(limit)
      .map((row) => ({ ...row, failed_sources: JSON.parse(String(row.failed_sources ?? "[]")) as string[] }));
  }

  monthly(): Array<Record<string, unknown>> {
    return this.db.prepare("SELECT * FROM monthly_usage").all();
  }

  /** The exact content of a past document, to rebuild it. */
  reportContent(id: number): Report | null {
    const row = this.db.prepare("SELECT content FROM reports WHERE id = ?").get(id) as { content: string } | undefined;
    if (!row) return null;
    return ReportSchema.parse(JSON.parse(row.content));
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }
}
