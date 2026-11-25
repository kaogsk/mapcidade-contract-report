/**
 * Collection: runs the four sources IN PARALLEL, each under its own deadline, and turns what came
 * back into a report ready for review.
 *
 *   city database (primary) → users, accesses, layers, departments, mobile, certificates, integrations
 *   city VM over SSH        → disks
 *   helpdesk mirror         → ticket counts by level, contract number quoted in a ticket
 *   helpdesk API            → training sessions logged by customer success
 *   local memory            → contract number and integration changes from the last generation
 *
 * Failure policy:
 * - The city database is the report. If it fails, there is no report: the collection fails with a
 *   clear message (HTTP 502) and is recorded as failed.
 * - Any other source may fail or hang. Its deadline cuts it off, the error is sanitized, and every
 *   section that depends on it is marked "unavailable" (or "partial" when another source still fed
 *   it). The report still comes out; the document prints the section with an explicit note instead
 *   of silently printing zeros.
 */
import { collectCityData, type CityData } from "./sources/city-collect.js";
import { readVmDisks } from "./sources/disks.js";
import { filterTrainings, trainingProfileLine } from "./sources/helpdesk.js";
import { contractFromSubjects, summarizeTickets } from "./sources/tickets.js";
import type { City, Sources } from "./sources/types.js";
import { errorMessage } from "./errors.js";
import { mergeIntegrations, type CityMemory } from "./memory.js";
import { utcBounds, type Period } from "./period.js";
import { MAX_DEPARTMENTS, SECTIONS, type Disk, type Report, type Section, type Tickets } from "./report.js";
import { isExplicit } from "./rules/integrations.js";
import type { ProfileOption } from "./rules/departments.js";
import type { MobileUsage } from "./rules/names.js";

export const SOURCE_IDS = ["cityDb", "vmDisks", "ticketMirror", "helpdeskApi"] as const;
export type SourceId = (typeof SOURCE_IDS)[number];

export const SOURCE_LABELS: Record<SourceId, string> = {
  cityDb: "city database",
  vmDisks: "city VM (disk usage)",
  ticketMirror: "helpdesk mirror",
  helpdeskApi: "helpdesk API",
};

/** Which sources feed each section. nextSteps is typed by the analyst. */
export const SECTION_SOURCES: Record<Section, SourceId[]> = {
  disks: ["vmDisks"],
  layerExamples: ["cityDb"],
  departments: ["cityDb"],
  trainings: ["helpdeskApi", "cityDb"],
  integrations: ["cityDb"],
  mobile: ["cityDb"],
  certificates: ["cityDb"],
  tickets: ["ticketMirror"],
  nextSteps: [],
};

/** Demo-only: make a source fail at once, or hang until its deadline. */
export type Fault = "fail" | "hang";
export type FaultPlan = Partial<Record<SourceId, Fault>>;

export interface SourceStatus {
  id: SourceId;
  label: string;
  ok: boolean;
  ms: number;
  error?: string;
}

export type SectionState = "ok" | "partial" | "unavailable";

export interface CollectResult {
  report: Report;
  sources: SourceStatus[];
  sections: Record<Section, { state: SectionState; failed: SourceId[] }>;
  details: {
    accessesTotal: number;
    months: number;
    profiles: ProfileOption[];
    activeDepartments: number;
    departmentsOrigin: CityData["departmentsOrigin"];
    certificatesOrigin: CityData["certificatesOrigin"];
    certificateUsage: CityData["certificateUsage"];
    mobileUsage: MobileUsage[];
    mobileOrigin: CityData["mobileOrigin"];
    contractOrigin: "remembered" | "ticket" | "empty";
    integrationsOrigin: "remembered" | "suggested";
    /** Vendor-named detections: in the report by default (sent back so memory knows what was removed). */
    suggestedIntegrations: string[];
    /** Detections without a vendor name: shown on the screen only, for the analyst to tick. */
    genericIntegrations: string[];
    durationMs: number;
  };
  warnings: string[];
}

export class PrimarySourceError extends Error {}

export interface CollectDeps {
  sources: Sources;
  memory: CityMemory;
  timeoutMs: number;
  cityDbTimeoutMs: number;
  timeZone: string;
  connectionKey: string;
  faults?: FaultPlan;
}

type Outcome<T> = { ok: true; data: T; ms: number } | { ok: false; error: string; ms: number };

function applyFault<T>(id: SourceId, fault: Fault | undefined, fn: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (fault === "fail") return Promise.reject(new Error(`simulated outage: ${SOURCE_LABELS[id]} unreachable`));
  if (fault === "hang")
    return new Promise<T>((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
  return fn();
}

/** Runs one source under a deadline. Never throws: the outcome says what happened. */
export async function runSource<T>(
  id: SourceId,
  timeoutMs: number,
  fault: Fault | undefined,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<Outcome<T>> {
  const ac = new AbortController();
  const t0 = performance.now();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`no answer within ${(timeoutMs / 1000).toFixed(1)} s`));
      ac.abort();
    }, timeoutMs);
  });
  try {
    const data = await Promise.race([applyFault(id, fault, () => fn(ac.signal), ac.signal), deadline]);
    return { ok: true, data, ms: Math.round(performance.now() - t0) };
  } catch (e) {
    ac.abort();
    return { ok: false, error: errorMessage(e), ms: Math.round(performance.now() - t0) };
  } finally {
    clearTimeout(timer);
  }
}

const listSections: Section[] = ["disks", "layerExamples", "departments", "trainings", "integrations", "mobile", "certificates", "nextSteps"];

export async function collect(city: City, p: Period, deps: CollectDeps): Promise<CollectResult> {
  const t0 = performance.now();
  const faults = deps.faults ?? {};
  const warnings: string[] = [];
  const [fromUtc, toUtc] = utcBounds(p, deps.timeZone);
  const { sources } = deps;

  const cityP = runSource("cityDb", deps.cityDbTimeoutMs, faults.cityDb, async () => {
    const db = await sources.openCityDb(city);
    try {
      return await collectCityData(db, p, { cityDbHost: city.dbHost, connectionKey: deps.connectionKey });
    } finally {
      await db.close();
    }
  });
  // The VM is the city's database server: same address.
  const disksP = runSource("vmDisks", deps.timeoutMs, faults.vmDisks, (signal) => readVmDisks(sources.shell, city.dbHost, signal));
  const mirrorP = runSource("ticketMirror", deps.timeoutMs, faults.ticketMirror, async (signal) => {
    const rows = await sources.mirror.countTickets(city.name, fromUtc, toUtc, signal);
    return { tickets: summarizeTickets(rows), found: rows.length > 0, contract: contractFromSubjects(await sources.mirror.contractSubjects(city.name, signal)) };
  });
  const helpdeskP = runSource("helpdeskApi", deps.timeoutMs, faults.helpdeskApi, async (signal) =>
    filterTrainings(await sources.helpdesk.searchTickets({ createdFromUtc: fromUtc, createdToUtc: toUtc, subjectContains: "training" }, signal), city.helpdeskOrg),
  );

  const [cityR, disksR, mirrorR, helpdeskR] = await Promise.all([cityP, disksP, mirrorP, helpdeskP]);
  if (!cityR.ok) throw new PrimarySourceError(`Could not read the ${city.name} database: ${cityR.error}`);
  const cityData = cityR.data;

  const statuses: SourceStatus[] = (
    [
      ["cityDb", cityR],
      ["vmDisks", disksR],
      ["ticketMirror", mirrorR],
      ["helpdeskApi", helpdeskR],
    ] as Array<[SourceId, Outcome<unknown>]>
  ).map(([id, o]) => ({ id, label: SOURCE_LABELS[id], ok: o.ok, ms: o.ms, ...(o.ok ? {} : { error: o.error }) }));
  for (const s of statuses) if (!s.ok) warnings.push(`The ${s.label} could not be read (${s.error}). Its sections are marked as not available.`);

  // ── contract and integrations: memory first ────────────────────────────────
  const memory = deps.memory.recall(city.id);
  const mirrorContract = mirrorR.ok ? mirrorR.data.contract : null;
  const contract = memory.contract || mirrorContract || "";
  const explicit = cityData.suggestedIntegrations.filter(isExplicit);
  const generic = cityData.suggestedIntegrations.filter((i) => !isExplicit(i));
  const integrations = mergeIntegrations(explicit, memory);

  const trainings = [
    ...(helpdeskR.ok ? helpdeskR.data : []),
    ...cityData.trainingProfiles.map((t) => trainingProfileLine(t.profile, t.users)),
  ];
  const disks: Disk[] = disksR.ok ? disksR.data : [];
  const tickets: Tickets | null = mirrorR.ok ? mirrorR.data.tickets : null;

  if (mirrorR.ok && !mirrorR.data.found)
    warnings.push(`No ticket from "${city.name}" in the helpdesk mirror for this period — check the city's name in the helpdesk.`);
  if (!contract) warnings.push("Contract number not found: type it in (it will be remembered for next time).");
  if (cityData.mobileOrigin === "configured") warnings.push("No mobile record in the period: the list shows the configured forms.");
  if (cityData.certificatesOrigin === "configured") warnings.push("No certificate issued in the period: the list shows the configured ones.");
  if (cityData.departmentsOrigin === "registry")
    warnings.push("No department profile used in the period: the departments come from the registry of the users who accessed.");
  if (cityData.departmentsOrigin === "none") warnings.push("No department identified: tick them in the profile list.");
  if (cityData.departmentsOrigin === "profiles" && cityData.activeDepartments > MAX_DEPARTMENTS)
    warnings.push(`${cityData.activeDepartments} department profiles were used in the period: the ${MAX_DEPARTMENTS} most accessed come ticked (report limit).`);

  // ── section states and notes ───────────────────────────────────────────────
  const failed = new Set(statuses.filter((s) => !s.ok).map((s) => s.id));
  const sections = {} as CollectResult["sections"];
  const notes: Report["notes"] = {};
  for (const sec of SECTIONS) {
    const deps_ = SECTION_SOURCES[sec];
    const down = deps_.filter((d) => failed.has(d));
    const state: SectionState = down.length === 0 ? "ok" : down.length === deps_.length ? "unavailable" : "partial";
    sections[sec] = { state, failed: down };
    const labels = down.map((d) => SOURCE_LABELS[d]).join(" and ");
    if (state === "unavailable") notes[sec] = `Not available: the ${labels} could not be read when this report was generated.`;
    if (state === "partial") notes[sec] = `Partial: the ${labels} could not be read, so items from it are missing.`;
  }

  const report: Report = {
    city: { id: city.id, name: city.name, region: city.region },
    period: p,
    contract,
    users: cityData.users,
    avgAccessesPerMonth: cityData.avgAccessesPerMonth,
    disks,
    layers: cityData.layers,
    layerExamples: cityData.layerExamples,
    departments: cityData.departments,
    trainings,
    integrations,
    mobile: cityData.mobile,
    certificates: cityData.certificates,
    tickets,
    nextSteps: [],
    hidden: [],
    notes,
  };
  // An empty list section is left out by default — unless a source failed: then it prints with its
  // note, so the reader knows the gap is missing data, not "nothing happened".
  report.hidden = listSections.filter((s) => !notes[s] && isEmpty(report, s));

  return {
    report,
    sources: statuses,
    sections,
    details: {
      accessesTotal: cityData.accessesTotal,
      months: cityData.months,
      profiles: cityData.profiles,
      activeDepartments: cityData.activeDepartments,
      departmentsOrigin: cityData.departmentsOrigin,
      certificatesOrigin: cityData.certificatesOrigin,
      certificateUsage: cityData.certificateUsage,
      mobileUsage: cityData.mobileUsage,
      mobileOrigin: cityData.mobileOrigin,
      contractOrigin: memory.contract ? "remembered" : mirrorContract ? "ticket" : "empty",
      integrationsOrigin: memory.integrationsAdded?.length || memory.integrationsDropped?.length ? "remembered" : "suggested",
      suggestedIntegrations: explicit,
      genericIntegrations: generic,
      durationMs: Math.round(performance.now() - t0),
    },
    warnings,
  };
}

function isEmpty(r: Report, s: Section): boolean {
  if (s === "tickets") return r.tickets === null;
  const v = r[s];
  return Array.isArray(v) && v.length === 0;
}
