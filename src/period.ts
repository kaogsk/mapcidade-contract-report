/**
 * Report period. Default: one year up to today ("26 Oct 2025 to 26 Oct 2026").
 *
 * Every count uses the window (start, end] in local days: the start day is exclusive, the end day
 * inclusive. A one-year report therefore covers exactly 365 days and the monthly average divides
 * by 12 — the same rule the analytics warehouse uses, so the two never disagree by a day.
 */

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export interface Period {
  /** YYYY-MM-DD, exclusive. */
  start: string;
  /** YYYY-MM-DD, inclusive. */
  end: string;
}

/** Today in the given time zone (late at night, UTC has already moved to the next day). */
export function todayIso(now = new Date(), timeZone = "UTC"): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(now);
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Same day one year earlier; Feb 29 becomes Feb 28. */
export function minusOneYear(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  const lastDay = new Date(Date.UTC(y - 1, m, 0)).getUTCDate();
  return `${y - 1}-${String(m).padStart(2, "0")}-${String(Math.min(d, lastDay)).padStart(2, "0")}`;
}

export function defaultPeriod(now = new Date(), timeZone = "UTC"): Period {
  const end = todayIso(now, timeZone);
  return { start: minusOneYear(end), end };
}

export function validatePeriod(start: unknown, end: unknown): Period {
  if (typeof start !== "string" || typeof end !== "string" || !ISO.test(start) || !ISO.test(end)) {
    throw new Error("Invalid period: use YYYY-MM-DD dates.");
  }
  // Date accepts 2026-02-30 by rolling it over to March; the round trip catches it.
  for (const d of [start, end]) {
    const parsed = new Date(`${d}T12:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== d) throw new Error(`Date does not exist: ${d}.`);
  }
  if (start >= end) throw new Error("The start date must be before the end date.");
  return { start, end };
}

export function daysIn(p: Period): number {
  return Math.round((Date.parse(`${p.end}T12:00:00Z`) - Date.parse(`${p.start}T12:00:00Z`)) / 86_400_000);
}

/** Months used for the monthly average (one year = 12). Never less than 1. */
export function monthsIn(p: Period): number {
  return Math.max(1, Math.round(daysIn(p) / (365.25 / 12)));
}

/**
 * Local-time bounds of the window as `[from, to)`, for columns stored in the city's local time
 * ("YYYY-MM-DD HH:MM:SS"). ISO text compares in time order, so an index on the column still works.
 */
export function localBounds(p: Period): [string, string] {
  return [`${addDays(p.start, 1)} 00:00:00`, `${addDays(p.end, 1)} 00:00:00`];
}

/** UTC instant of local midnight at the start of day `iso` in `timeZone`. */
export function localMidnightUtc(iso: string, timeZone: string): Date {
  const naive = Date.parse(`${iso}T00:00:00Z`);
  // Correct by the zone's offset; a second pass lands on the right side of a DST change.
  let guess = new Date(naive);
  for (let i = 0; i < 2; i++) guess = new Date(naive - offsetMs(guess, timeZone));
  return guess;
}

function offsetMs(at: Date, timeZone: string): number {
  const parts: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at)) {
    parts[p.type] = p.value;
  }
  const asUtc = Date.UTC(+(parts.year ?? 0), +(parts.month ?? 1) - 1, +(parts.day ?? 1), +(parts.hour ?? 0), +(parts.minute ?? 0), +(parts.second ?? 0));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** UTC bounds `[from, to)` of the window, for columns stored as UTC instants (ticket mirror). */
export function utcBounds(p: Period, timeZone: string): [string, string] {
  return [
    localMidnightUtc(addDays(p.start, 1), timeZone).toISOString(),
    localMidnightUtc(addDays(p.end, 1), timeZone).toISOString(),
  ];
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-26" → "26 Oct 2026" (unambiguous in any locale). */
export function displayDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return `${d} ${MONTHS[m - 1]} ${y}`;
}
