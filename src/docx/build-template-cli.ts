/** `npm run template` — (re)writes templates/contract-summary-template.docx from template.ts. */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { loadConfig } from "../config.js";
import { buildTemplate } from "./template.js";

const path = loadConfig().templatePath;
mkdirSync(dirname(path), { recursive: true });
const buf = await buildTemplate();
writeFileSync(path, buf);
console.log(`template written: ${path} (${buf.length} bytes)`);
