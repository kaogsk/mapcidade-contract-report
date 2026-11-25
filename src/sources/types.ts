/**
 * The four sources behind a report, each behind an interface. The shipped implementations are
 * fakes (node:sqlite files, canned `df` output, an in-memory ticketing API); production wires the
 * same interfaces to PostgreSQL, SSH and the real helpdesk. The collector never knows which.
 */

/** A registered city. `dbHost` doubles as the VM address: the city's VM is its database server. */
export interface City {
  id: string;
  name: string;
  region: string;
  /** Host of the city's database server (and of its VM). Never sent to the browser. */
  dbHost: string;
  /** How to reach the city's database. For the fake: a SQLite file. */
  dbLocation: string;
  /** Organization name as it appears in the helpdesk. */
  helpdeskOrg: string;
}

export type SqlParam = string | number | null;

/** Read-only access to one city database. */
export interface CityDatabase {
  query<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): Promise<T[]>;
  tableExists(name: string): Promise<boolean>;
  /** Tables loaded from another system (production: the external schema; fake: `ext_*`). */
  externalTables(): Promise<string[]>;
  close(): Promise<void>;
}

/** Runs one command on a remote host and returns stdout (production: SSH). */
export interface RemoteShell {
  exec(host: string, command: string, signal: AbortSignal): Promise<string>;
}

export interface MirrorTicketCounts {
  level: 1 | 2 | 3;
  outcome: "resolved" | "pending" | "canceled";
  n: number;
}

/** Local mirror of the helpdesk, kept by another internal dashboard (production: a PostgreSQL schema). */
export interface TicketMirror {
  /** Tickets opened in the window [fromUtc, toUtc), grouped by highest level reached and outcome. */
  countTickets(city: string, fromUtc: string, toUtc: string, signal: AbortSignal): Promise<MirrorTicketCounts[]>;
  /** Most recent subjects that mention a contract number. */
  contractSubjects(city: string, signal: AbortSignal): Promise<string[]>;
}

export interface HelpdeskTicket {
  id: number;
  subject?: string;
  createdDate?: string;
  baseStatus?: string;
  organizations?: string[];
}

/** The ticketing SaaS API itself (read-only). Has what the mirror doesn't: non-support teams. */
export interface HelpdeskApi {
  searchTickets(q: { createdFromUtc: string; createdToUtc: string; subjectContains: string }, signal: AbortSignal): Promise<HelpdeskTicket[]>;
}

export interface Sources {
  openCityDb(city: City): Promise<CityDatabase>;
  shell: RemoteShell;
  mirror: TicketMirror;
  helpdesk: HelpdeskApi;
}
