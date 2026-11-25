/**
 * HTTP API + the static review screen.
 *   GET  /api/cities                  registered cities (id, name, region — never a host)
 *   GET  /api/default-period          one year up to today
 *   POST /api/collect                 { city, start, end, simulate? } → report + source status + details
 *   POST /api/docx                    { report, suggestedIntegrations?, edited? } → .docx; remembers the
 *                                     contract number and the integration changes for the city
 *   GET  /api/history                 recent collections/documents + monthly usage
 *   GET  /api/history/reports/:id/docx  rebuilds a past document from its stored content
 */
import { resolve } from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { CITIES, findCity, publicCity } from "./cities.js";
import { collect, PrimarySourceError, SOURCE_IDS, type FaultPlan } from "./collect.js";
import { projectRoot, type Config } from "./config.js";
import { fileNameFor, renderDocx } from "./docx/render.js";
import { errorMessage, HttpError } from "./errors.js";
import type { UsageHistory } from "./history.js";
import type { CityMemory } from "./memory.js";
import { defaultPeriod, validatePeriod, type Period } from "./period.js";
import { ReportSchema, type Report } from "./report.js";
import type { Sources } from "./sources/types.js";

const CollectBody = z.object({
  city: z.string().min(1).max(80),
  start: z.string(),
  end: z.string(),
  simulate: z.record(z.enum(SOURCE_IDS), z.enum(["fail", "hang"])).optional(),
});

const DocxBody = z.object({
  report: ReportSchema,
  suggestedIntegrations: z.array(z.string().max(300)).max(60).optional(),
  /** The analyst changed something on the review screen. */
  edited: z.boolean().optional(),
});

export interface AppDeps {
  cfg: Config;
  sources: Sources;
  memory: CityMemory;
  history: UsageHistory;
  template: Buffer;
  now?: () => Date;
}

/** No login in the demo; production sits behind directory (AD) login and records the account. */
const userOf = (req: Request) => (req.get("x-demo-user") ?? "demo-analyst").replace(/[^\w.@-]/g, "").slice(0, 64) || "demo-analyst";

function sendDocx(res: Response, buf: Buffer, name: string) {
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${name.normalize("NFD").replace(/[^\x20-\x7E]/g, "")}"; filename*=UTF-8''${encodeURIComponent(name)}`,
  );
  res.send(buf);
}

export function createApp(deps: AppDeps) {
  const { cfg, history, memory } = deps;
  const now = deps.now ?? (() => new Date());
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "512kb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/api/cities", (_req, res) => {
    res.json(CITIES.map(publicCity));
  });

  app.get("/api/default-period", (_req, res) => {
    res.json({ ...defaultPeriod(now(), cfg.timeZone), faultInjection: cfg.allowFaultInjection });
  });

  app.post("/api/collect", async (req, res) => {
    const body = CollectBody.safeParse(req.body);
    if (!body.success) throw new HttpError(400, "Send city, start and end.");
    const city = findCity(body.data.city);
    if (!city) throw new HttpError(404, "City not found in the registry.");
    let period: Period;
    try {
      period = validatePeriod(body.data.start, body.data.end);
    } catch (e) {
      throw new HttpError(400, errorMessage(e));
    }
    if (body.data.simulate && Object.keys(body.data.simulate).length && !cfg.allowFaultInjection)
      throw new HttpError(400, "Fault simulation is disabled on this server.");

    const t0 = performance.now();
    const event = { user: userOf(req), cityId: city.id, cityName: city.name, start: period.start, end: period.end };
    try {
      const result = await collect(city, period, {
        sources: deps.sources,
        memory,
        timeoutMs: cfg.sourceTimeoutMs,
        cityDbTimeoutMs: cfg.cityDbTimeoutMs,
        timeZone: cfg.timeZone,
        connectionKey: cfg.connectionKey,
        faults: body.data.simulate as FaultPlan | undefined,
      });
      history.collection({
        ...event,
        durationMs: performance.now() - t0,
        error: null,
        failedSources: result.sources.filter((s) => !s.ok).map((s) => s.id),
        warnings: result.warnings,
      });
      res.json(result);
    } catch (e) {
      const msg = errorMessage(e);
      history.collection({ ...event, durationMs: performance.now() - t0, error: msg, failedSources: ["cityDb"], warnings: [] });
      if (e instanceof PrimarySourceError) throw new HttpError(502, msg);
      throw e;
    }
  });

  app.post("/api/docx", async (req, res) => {
    const body = DocxBody.safeParse(req.body);
    if (!body.success) throw new HttpError(400, `Invalid report: ${body.error.issues[0]?.path.join(".") ?? "?"} ${body.error.issues[0]?.message ?? ""}`.trim());
    const r: Report = body.data.report;
    const city = findCity(r.city.id);
    if (!city) throw new HttpError(404, "City not found in the registry.");
    try {
      validatePeriod(r.period.start, r.period.end);
    } catch (e) {
      throw new HttpError(400, errorMessage(e));
    }
    // The name printed on the document is the registry's, whatever the browser sent.
    r.city = publicCity(city);
    const buf = await renderDocx(r, deps.template, now());
    memory.rememberDownload(city.id, r.contract, r.integrations, body.data.suggestedIntegrations ?? []);
    const name = fileNameFor(r);
    history.report({ user: userOf(req), report: r, edited: body.data.edited ?? false, fileName: name, bytes: buf.length });
    sendDocx(res, buf, name);
  });

  app.get("/api/history", (_req, res) => {
    res.json({ reports: history.recentReports(15), collections: history.recentCollections(15), monthly: history.monthly() });
  });

  app.get("/api/history/reports/:id/docx", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "Invalid id.");
    const r = history.reportContent(id);
    if (!r) throw new HttpError(404, "No such document in the history.");
    sendDocx(res, await renderDocx(r, deps.template, now()), fileNameFor(r));
  });

  app.use(express.static(resolve(projectRoot, "public"), { index: "index.html" }));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = err instanceof HttpError ? err.status : (err as { status?: number })?.status === 400 ? 400 : 500;
    const msg = err instanceof HttpError ? err.message : status === 400 ? "Malformed request." : "Unexpected error while building the report.";
    if (status >= 500) console.error(errorMessage(err));
    res.status(status).json({ error: msg });
  });
  return app;
}
