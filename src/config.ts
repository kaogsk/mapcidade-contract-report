/**
 * Runtime configuration. Everything has a demo default, so `npm run dev` works with no `.env`.
 * Nothing here is a real host or credential: the shipped sources are all fakes.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

const int = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  templatePath: string;
  /** Deadline for each auxiliary source (VM disks, ticket mirror, helpdesk API). */
  sourceTimeoutMs: number;
  /** Deadline for the primary source (city database). Longer: a big city takes a while. */
  cityDbTimeoutMs: number;
  /** Calendar used to turn "a day" into a time window (counts use the city's local day, not UTC). */
  timeZone: string;
  connectionKey: string;
  /** Optional: use the HTTP helpdesk client against this base URL instead of the in-process fake. */
  helpdeskApiUrl: string;
  helpdeskApiToken: string;
  /** The demo lets the review screen simulate a source outage. Turn off when real sources are wired. */
  allowFaultInjection: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: int(env.PORT, 4601),
    host: env.HOST ?? "127.0.0.1",
    dataDir: resolve(projectRoot, env.DATA_DIR ?? "data"),
    templatePath: resolve(projectRoot, env.TEMPLATE_PATH ?? "templates/contract-summary-template.docx"),
    sourceTimeoutMs: int(env.SOURCE_TIMEOUT_MS, 6000),
    cityDbTimeoutMs: int(env.CITY_DB_TIMEOUT_MS, 60_000),
    timeZone: env.REPORT_TIMEZONE ?? "America/Sao_Paulo",
    connectionKey: env.CONNECTION_KEY ?? "demo-only-key-change-me",
    helpdeskApiUrl: env.HELPDESK_API_URL ?? "",
    helpdeskApiToken: env.HELPDESK_API_TOKEN ?? "",
    allowFaultInjection: env.ALLOW_FAULT_INJECTION !== "0",
  };
}
