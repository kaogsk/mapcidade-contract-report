import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { buildTemplate } from "../src/docx/template.js";
import { UsageHistory } from "../src/history.js";
import { CityMemory } from "../src/memory.js";
import { SqliteTicketMirror } from "../src/sources/tickets.js";
import { createFakeSources, ensureSeeded } from "../src/wiring.js";

const now = () => new Date("2026-11-25T15:00:00Z");
const dataDir = mkdtempSync(join(tmpdir(), "contract-report-"));
const cfg = loadConfig({ DATA_DIR: dataDir });
let app: ReturnType<typeof createApp>;
let mirror: SqliteTicketMirror;
const historyDb = new UsageHistory(":memory:");

beforeAll(async () => {
  ensureSeeded(cfg, now());
  const sources = createFakeSources(cfg);
  mirror = sources.mirror as SqliteTicketMirror;
  app = createApp({
    cfg,
    sources,
    memory: new CityMemory(join(dataDir, "city-memory.json")),
    history: historyDb,
    template: await buildTemplate(),
    now,
  });
});
afterAll(() => {
  mirror?.close();
  historyDb.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const selection = { city: "rivermeadow", start: "2025-11-25", end: "2026-11-25" };

describe("contract report HTTP workflow", () => {
  it("serves the review screen and city registry", async () => {
    await request(app).get("/").expect(200).expect(/Review collected data/);
    const { body } = await request(app).get("/api/cities").expect(200);
    expect(body).toContainEqual(expect.objectContaining({ id: selection.city, name: "Rivermeadow" }));
    expect(body[0]).not.toHaveProperty("host");
  });

  it("keeps collecting when an auxiliary source fails", async () => {
    const { body } = await request(app).post("/api/collect").send({ ...selection, simulate: { vmDisks: "fail" } }).expect(200);
    expect(body.sources).toContainEqual(expect.objectContaining({ id: "vmDisks", ok: false }));
    expect(body.report.notes.disks).toBeTruthy();
    expect(body.report.users).toBeGreaterThan(0);
  });

  it("rejects a report when the primary source fails", async () => {
    await request(app).post("/api/collect").send({ ...selection, simulate: { cityDb: "fail" } }).expect(502);
  });

  it("renders reviewed data and records generation history", async () => {
    const { body } = await request(app).post("/api/collect").send(selection).expect(200);
    const response = await request(app).post("/api/docx").send({
      report: { ...body.report, nextSteps: ["Schedule a review meeting"], hidden: [] },
      suggestedIntegrations: body.report.integrations,
      edited: true,
    }).buffer(true).parse((res, done) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => done(null, Buffer.concat(chunks)));
      res.on("error", done);
    }).expect(200);
    const zip = await JSZip.loadAsync(response.body);
    expect(await zip.file("word/document.xml")?.async("string")).toContain("Schedule a review meeting");
    const history = await request(app).get("/api/history").expect(200);
    expect(history.body.reports[0]).toEqual(expect.objectContaining({ edited: 1 }));
    await request(app).get(`/api/history/reports/${history.body.reports[0].id}/docx`).expect(200);
  });
});
