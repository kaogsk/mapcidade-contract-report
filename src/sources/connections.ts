/**
 * External connections of the city's data tables — a signal of integration.
 *
 * The platform stores each connection string encrypted. Decrypted it reads
 * `host;port;database;user;password;type`, or `https://…;token;rest` for an API.
 *
 * ONLY TYPE, HOST AND DATABASE NAME LEAVE THIS MODULE. User, password and token never leave
 * `readConnection` — not in its return value, not in a log line, not in an error.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export interface Connection {
  /** postgres, sqlserver, mariadb, mysql, oracle, firebird, rest, soap… */
  type: string;
  /** Host (or host:port of an API). */
  host: string;
  database: string;
  /** An API (REST/SOAP) rather than a database. */
  service: boolean;
}

const TYPES = /^(postgres(?:ql)?|sql\s?server|mssql|mariadb|mysql|oracle|firebird|sybase|db2|rest|soap)$/i;

const keyOf = (secret: string) => createHash("sha256").update(secret).digest();

/** AES-256-GCM, base64(iv | tag | ciphertext). Used by the seed to store synthetic connections. */
export function encryptConnection(plain: string, secret: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", keyOf(secret), iv);
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString("base64");
}

function decrypt(stored: string, secret: string): string | null {
  try {
    const raw = Buffer.from(stored, "base64");
    if (raw.length < 29) return null;
    const d = createDecipheriv("aes-256-gcm", keyOf(secret), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

export function readConnection(stored: string, secret: string): Connection | null {
  const text = decrypt(stored, secret);
  if (text === null) return null;
  const fields = text.split(";").map((s) => s.trim());
  const first = fields[0] ?? "";
  // The type is found by value, not position: some rows have the fields in another order, and this
  // way a password field can never be mistaken for the type.
  const typeFound = fields.find((f, i) => i > 0 && TYPES.test(f));
  if (/^https?:\/\//i.test(first)) {
    let host = "";
    try {
      host = new URL(first).host;
    } catch {
      return null;
    }
    return { type: (typeFound ?? "rest").toLowerCase(), host, database: "", service: true };
  }
  if (!first || /\s/.test(first)) return null;
  const type = (typeFound ?? "postgres").toLowerCase().replace(/\s/g, "");
  const db = fields[2] && !/[;\s]/.test(fields[2]) && fields[2].length < 120 ? fields[2] : "";
  return { type, host: first, database: db, service: type === "rest" || type === "soap" };
}

function isPrivateHost(host: string): boolean {
  const h = host.replace(/[#:].*$/, "").toLowerCase();
  if (["localhost", "127.0.0.1", "::1", "0.0.0.0"].includes(h)) return true;
  const m = h.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (!m) return !h.includes("."); // bare name ("DBSRV02") = internal network
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

/**
 * A connection is an integration with a third-party system when it is an API, a DBMS other than
 * PostgreSQL, or a PostgreSQL outside the private network. A PostgreSQL on the city's own host or on
 * the private network is the platform's own infrastructure (editing database, staging copy…).
 */
export function isIntegration(c: Connection, cityDbHost: string): boolean {
  if (c.service) return true;
  if (!/^postgres/.test(c.type)) return true;
  return c.host !== cityDbHost && !isPrivateHost(c.host);
}

export function typeLabel(c: Connection): string {
  if (c.service) return c.type === "soap" ? "SOAP web service" : "REST web service";
  const labels: Record<string, string> = {
    sqlserver: "SQL Server",
    mssql: "SQL Server",
    mariadb: "MariaDB",
    mysql: "MySQL",
    oracle: "Oracle",
    firebird: "Firebird",
    sybase: "Sybase",
    db2: "DB2",
  };
  return labels[c.type] ?? "External PostgreSQL";
}
