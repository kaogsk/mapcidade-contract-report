/**
 * node:sqlite implementations of CityDatabase (and the helpers the ticket mirror shares).
 *
 * The production database session is opened read-only (`default_transaction_read_only = on`), so a
 * stray write fails in the database itself. The fake keeps that guarantee: the city file is opened
 * with `readOnly: true`, and a test asserts that an INSERT is refused.
 */
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { CityDatabase, SqlParam } from "./types.js";

/** REGEXP and a capture-group extractor, so the SQL reads like the PostgreSQL original. */
export function registerFunctions(db: DatabaseSync): void {
  const cache = new Map<string, RegExp>();
  const re = (p: string) => {
    let r = cache.get(p);
    if (!r) {
      r = new RegExp(p, "i");
      cache.set(p, r);
    }
    return r;
  };
  // `x REGEXP p` calls regexp(p, x)
  db.function("regexp", { deterministic: true }, (pattern, value) =>
    typeof pattern === "string" && typeof value === "string" && re(pattern).test(value) ? 1 : 0,
  );
  db.function("regexp_group", { deterministic: true }, (value, pattern) => {
    if (typeof value !== "string" || typeof pattern !== "string") return null;
    return re(pattern).exec(value)?.[1] ?? null;
  });
}

export class SqliteCityDatabase implements CityDatabase {
  private constructor(private readonly db: DatabaseSync) {}

  static open(path: string): SqliteCityDatabase {
    if (!existsSync(path)) throw new Error(`city database not found (${path.split(/[\\/]/).pop()})`);
    const db = new DatabaseSync(path, { readOnly: true });
    registerFunctions(db);
    return new SqliteCityDatabase(db);
  }

  /** Wraps an already open connection (tests seed an in-memory database and hand it over). */
  static wrap(db: DatabaseSync): SqliteCityDatabase {
    registerFunctions(db);
    return new SqliteCityDatabase(db);
  }

  async query<T>(sql: string, params: SqlParam[] = []): Promise<T[]> {
    return this.db.prepare(sql).all(...params) as T[];
  }

  async tableExists(name: string): Promise<boolean> {
    const r = this.db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?").get(name);
    return r !== undefined;
  }

  async externalTables(): Promise<string[]> {
    const rows = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name LIKE 'ext\\_%' ESCAPE '\\' ORDER BY name")
      .all() as Array<{ name: string }>;
    return rows.map((r) => r.name);
  }

  async close(): Promise<void> {
    if (this.db.isOpen) this.db.close();
  }
}
