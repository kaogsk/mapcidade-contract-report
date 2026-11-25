/**
 * "Training" — suggested from two clues, then checked by the analyst:
 *
 * 1. The city's tickets opened in the period with "training" in the subject ("Onsite training -
 *    07/29/2026", logged by the customer-success team). They come from the helpdesk API (GET only),
 *    because the local mirror only keeps the support teams' tickets.
 * 2. Training profiles used in the period ("Training 2026 - Staff"), from the city database.
 */
import { Router } from "express";
import { readFileSync } from "node:fs";
import type { HelpdeskApi, HelpdeskTicket } from "./types.js";

export function foldAccents(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** Strips the project code at the start of a subject ("CTR_RIVERMEADOW_01_2025: …") and mail prefixes. */
export function cleanSubject(subject: string): string {
  return subject
    .replace(/^\s*(?:FW|FWD|RE)\s*:\s*/i, "")
    .replace(/^\s*[A-Z0-9]+(?:_[A-Za-z0-9]+)+\s*[:\-–|]\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Subjects that mention training but aren't a training session (a profile, a theme, a refund…). */
const NOT_A_TRAINING = /training profile|theme|layer|parcel|refund|purchase|payment|invoice/i;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function filterTrainings(tickets: HelpdeskTicket[], cityOrg: string): string[] {
  const target = new RegExp(`\\b${escapeRe(foldAccents(cityOrg))}\\b`);
  const out: string[] = [];
  for (const t of tickets) {
    const subject = t.subject ?? "";
    if (!/training/i.test(subject) || NOT_A_TRAINING.test(subject)) continue;
    if (t.baseStatus === "Canceled") continue;
    // The vendor's own organization is on many tickets too; it must be the city's.
    const orgs = (t.organizations ?? []).map(foldAccents);
    if (!orgs.some((o) => o && !o.includes("mapcidade") && target.test(o))) continue;
    const day = t.createdDate ? t.createdDate.slice(0, 10) : "";
    const text = cleanSubject(subject);
    // Customer success usually puts the date in the subject already.
    out.push(/\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2}/.test(text) || !day ? text : `${text} (${day})`);
  }
  return [...new Set(out)];
}

export function trainingProfileLine(profile: string, users: number): string {
  return `Training profile "${profile}" – used by ${users} ${users === 1 ? "user" : "users"} in the period`;
}

// ── implementations ─────────────────────────────────────────────────────────

/** In-process fake: a JSON file of tickets, filtered like the API would. */
export class FakeHelpdeskApi implements HelpdeskApi {
  private tickets: HelpdeskTicket[] | null;

  constructor(
    private readonly source: string | HelpdeskTicket[],
    private readonly latencyMs = 80,
  ) {
    this.tickets = Array.isArray(source) ? source : null;
  }

  private all(): HelpdeskTicket[] {
    if (!this.tickets) this.tickets = JSON.parse(readFileSync(this.source as string, "utf-8")) as HelpdeskTicket[];
    return this.tickets;
  }

  searchTickets(q: { createdFromUtc: string; createdToUtc: string; subjectContains: string }, signal: AbortSignal): Promise<HelpdeskTicket[]> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        try {
          resolve(searchIn(this.all(), q));
        } catch (e) {
          reject(e);
        }
      }, this.latencyMs);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("helpdesk API request aborted"));
      }, { once: true });
    });
  }
}

function searchIn(all: HelpdeskTicket[], q: { createdFromUtc: string; createdToUtc: string; subjectContains: string }): HelpdeskTicket[] {
  const needle = q.subjectContains.toLowerCase();
  return all.filter(
    (t) => (t.createdDate ?? "") >= q.createdFromUtc && (t.createdDate ?? "") < q.createdToUtc && (t.subject ?? "").toLowerCase().includes(needle),
  );
}

/**
 * HTTP client, the shape of the production one. The token goes in a header, never in the URL, so a
 * logged URL or a fetch error can't carry it.
 */
export class HttpHelpdeskApi implements HelpdeskApi {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  async searchTickets(q: { createdFromUtc: string; createdToUtc: string; subjectContains: string }, signal: AbortSignal): Promise<HelpdeskTicket[]> {
    const url = new URL(`${this.baseUrl.replace(/\/$/, "")}/tickets`);
    url.searchParams.set("createdFrom", q.createdFromUtc);
    url.searchParams.set("createdTo", q.createdToUtc);
    url.searchParams.set("subjectContains", q.subjectContains);
    url.searchParams.set("top", "500");
    const r = await fetch(url, { signal, headers: { Authorization: `Bearer ${this.token}`, Accept: "application/json" } });
    if (!r.ok) throw new Error(`helpdesk API answered ${r.status}`);
    const body = (await r.json()) as unknown;
    if (!Array.isArray(body)) throw new Error("helpdesk API answered something that is not a list");
    return body as HelpdeskTicket[];
  }
}

/** A tiny HTTP stand-in for the ticketing API, used to test the HTTP client end to end. */
export function fakeHelpdeskRouter(tickets: HelpdeskTicket[], token: string): Router {
  const r = Router();
  r.get("/tickets", (req, res) => {
    if (req.get("authorization") !== `Bearer ${token}`) {
      res.status(401).json({ error: "invalid token" });
      return;
    }
    const s = (k: string) => (typeof req.query[k] === "string" ? (req.query[k] as string) : "");
    const top = Math.min(500, Number(s("top")) || 100);
    res.json(searchIn(tickets, { createdFromUtc: s("createdFrom"), createdToUtc: s("createdTo"), subjectContains: s("subjectContains") }).slice(0, top));
  });
  return r;
}
