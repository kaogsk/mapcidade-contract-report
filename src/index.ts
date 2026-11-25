import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { buildTemplate } from "./docx/template.js";
import { UsageHistory } from "./history.js";
import { CityMemory } from "./memory.js";
import { createFakeSources, ensureSeeded } from "./wiring.js";

const cfg = loadConfig();
const seed = ensureSeeded(cfg);
if (seed.seeded) console.log(`[contract-report] fake sources seeded relative to ${seed.refDate}`);

if (!existsSync(cfg.templatePath)) {
  mkdirSync(dirname(cfg.templatePath), { recursive: true });
  writeFileSync(cfg.templatePath, await buildTemplate());
}

const app = createApp({
  cfg,
  sources: createFakeSources(cfg),
  memory: new CityMemory(join(cfg.dataDir, "city-memory.json")),
  history: new UsageHistory(join(cfg.dataDir, "history.db")),
  template: readFileSync(cfg.templatePath),
});

app.listen(cfg.port, cfg.host, () => {
  console.log(`[contract-report] http://${cfg.host}:${cfg.port}`);
});
