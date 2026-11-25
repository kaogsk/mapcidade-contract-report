/**
 * Renders a report into the template. Only the body of word/document.xml is rewritten; everything
 * else in the package (header, footer, styles, numbering, section settings) is copied untouched,
 * and docProps/core.xml only gets the title and the modification date.
 *
 * Section rules:
 * - a section in `report.hidden` is left out entirely, heading included;
 * - a section with a note (its source failed) prints the note in the "Note" style, so a gap in
 *   the data reads as missing data, not as "nothing happened";
 * - a visible list section with no items prints one empty bullet, for the analyst to fill in Word.
 */
import JSZip from "jszip";
import { displayDate } from "../period.js";
import { handled, totalTickets, type Disk, type Report, type Section } from "../report.js";
import { TEXT_WIDTH_TWIPS } from "./template.js";

export function xmlEscape(s: string): string {
  return (
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      // a control character makes the whole document unreadable for Word
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
  );
}

const BULLETS = 1;
const NUMBERED = 2;

function run(text: string, opts: { bold?: boolean; tab?: boolean } = {}): string {
  if (!text && !opts.tab) return "";
  const rPr = opts.bold ? "<w:rPr><w:b/></w:rPr>" : "";
  return `<w:r>${rPr}${opts.tab ? "<w:tab/>" : ""}${text ? `<w:t xml:space="preserve">${xmlEscape(text)}</w:t>` : ""}</w:r>`;
}

function para(style: string, ...runs: string[]): string {
  return `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr>${runs.join("")}</w:p>`;
}

function item(text: string, numId = BULLETS, level = 0): string {
  return `<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="${numId}"/></w:numPr></w:pPr>${run(text)}</w:p>`;
}

/** Items, or one empty bullet to fill in Word. */
const list = (items: string[], numId = BULLETS) => (items.length ? items.map((t) => item(t, numId)).join("") : item("", numId));

/** "Number of users ........ 182" (dotted leader to a right tab). */
const fact = (label: string, value: string) => para("Fact", run(label), run(value, { bold: true, tab: true }));

function table(headers: string[], rows: string[][], widths: number[]): string {
  const cell = (text: string, w: number, head: boolean, right: boolean) =>
    `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${head ? '<w:shd w:val="clear" w:color="auto" w:fill="E6F4F1"/>' : ""}</w:tcPr>` +
    `<w:p><w:pPr><w:pStyle w:val="TableText"/>${right ? '<w:jc w:val="right"/>' : ""}</w:pPr>${run(text, { bold: head })}</w:p></w:tc>`;
  const row = (cells: string[], head: boolean) =>
    `<w:tr>${head ? "<w:trPr><w:tblHeader/></w:trPr>" : ""}${cells.map((c, i) => cell(c, widths[i] ?? 1000, head, i > 0 && !head)).join("")}</w:tr>`;
  return (
    `<w:tbl><w:tblPr><w:tblStyle w:val="ReportTable"/><w:tblW w:w="${widths.reduce((a, b) => a + b, 0)}" w:type="dxa"/><w:tblLook w:val="04A0"/></w:tblPr>` +
    `<w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join("")}</w:tblGrid>` +
    row(headers, true) +
    rows.map((r) => row(r, false)).join("") +
    "</w:tbl><w:p/>"
  );
}

/** Thousands separator, fixed locale so the server's locale never changes the document. */
const n = (v: number) => v.toLocaleString("en-US");

/** 2.449 → "2.4"; 1258.3 → "1,258" (one decimal below 100, none above). */
export function gb(v: number): string {
  if (v >= 100) return Math.round(v).toLocaleString("en-US");
  const r = Math.round(v * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

export function diskLabel(d: Disk): string {
  return d.mount && d.mount !== "/" && !d.name.includes(d.mount) ? `${d.name} (${d.mount})` : d.name;
}

function disksTable(disks: Disk[]): string {
  if (!disks.length) return item("");
  const w = TEXT_WIDTH_TWIPS;
  return table(
    ["Disk", "Size (GB)", "Used (GB)", "Free (GB)", "Used"],
    disks.map((d) => [diskLabel(d), gb(d.totalGb), gb(d.usedGb), gb(d.freeGb), d.totalGb > 0 ? `${Math.round((d.usedGb / d.totalGb) * 100)}%` : "–"]),
    [w - 4 * 1500, 1500, 1500, 1500, 1500],
  );
}

function ticketsBlock(r: Report): string {
  const t = r.tickets;
  if (!t) return "";
  return (
    fact("Tickets handled (resolved + pending)", n(handled(t))) +
    fact("Tickets canceled", n(t.canceled)) +
    fact("Total tickets opened in the period", n(totalTickets(t))) +
    table(
      ["Highest level reached", "Resolved", "Pending"],
      [
        ["Level 1 (triage / first line)", n(t.resolved.l1), n(t.pending.l1)],
        ["Level 2", n(t.resolved.l2), n(t.pending.l2)],
        ["Level 3", n(t.resolved.l3), n(t.pending.l3)],
      ],
      [TEXT_WIDTH_TWIPS - 2 * 1800, 1800, 1800],
    )
  );
}

export function documentBody(r: Report): string {
  const hidden = new Set(r.hidden);
  const note = (s: Section) => (r.notes[s] ? para("Note", run(r.notes[s] ?? "")) : "");
  const section = (s: Section, heading: string, content: string, level: "Heading1" | "Heading2" = "Heading2") =>
    hidden.has(s) ? "" : para(level, run(heading)) + note(s) + content;
  const subtitle = r.contract ? `CONTRACT SUMMARY REPORT — CONTRACT No. ${r.contract}` : "CONTRACT SUMMARY REPORT";

  return [
    para("Title", run(`City of ${r.city.name}${r.city.region ? ` · ${r.city.region}` : ""}`)),
    para("Subtitle", run(subtitle)),
    para("PeriodLine", run(`Period: ${displayDate(r.period.start)} to ${displayDate(r.period.end)}`)),

    para("Heading1", run("Platform usage")),
    fact("Number of users", n(r.users)),
    fact("Average accesses per month", n(r.avgAccessesPerMonth)),
    fact("Layers loaded in the platform", n(r.layers)),
    section("disks", "Cloud storage in use", r.notes.disks && !r.disks.length ? "" : disksTable(r.disks)),
    section("layerExamples", "Examples of deployed layers", list(r.layerExamples)),
    section("departments", "User departments", list(r.departments)),
    section("trainings", "Training", r.notes.trainings && !r.trainings.length ? "" : list(r.trainings)),
    section("integrations", "Integrations delivered", list(r.integrations)),
    section("mobile", "Mobile (field data collection app)", list(r.mobile)),
    section("certificates", "Certificates", list(r.certificates)),

    section("tickets", "User support", ticketsBlock(r), "Heading1"),
    section("nextSteps", "Next steps", list(r.nextSteps, NUMBERED), "Heading1"),
  ].join("");
}

/** Swaps the content of <w:body>, keeping the template's final <w:sectPr>. */
export function replaceBody(documentXml: string, body: string): string {
  const open = documentXml.indexOf("<w:body>");
  const sect = documentXml.lastIndexOf("<w:sectPr");
  const close = documentXml.lastIndexOf("</w:body>");
  if (open < 0 || sect < open || close < sect) throw new Error("Unexpected template: body without a final w:sectPr.");
  return documentXml.slice(0, open + "<w:body>".length) + body + documentXml.slice(sect);
}

export async function renderDocx(r: Report, template: Buffer, now = new Date()): Promise<Buffer> {
  const zip = await JSZip.loadAsync(template);
  const doc = zip.file("word/document.xml");
  if (!doc) throw new Error("Template has no word/document.xml.");
  zip.file("word/document.xml", replaceBody(await doc.async("string"), documentBody(r)));

  const core = zip.file("docProps/core.xml");
  if (core) {
    const stamp = now.toISOString().replace(/\.\d{3}Z$/, "Z");
    const xml = (await core.async("string"))
      .replace(/(<dcterms:modified[^>]*>)[^<]*(<\/dcterms:modified>)/, `$1${stamp}$2`)
      .replace(/(<dc:title>)[^<]*(<\/dc:title>)/, `$1${xmlEscape(`Contract Summary Report – ${r.city.name}`)}$2`);
    zip.file("docProps/core.xml", xml);
  }
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

/** "Contract_Summary_Rivermeadow_2026-10-26.docx" */
export function fileNameFor(r: Report): string {
  const name = r.city.name.replace(/[\\/:*?"<>|]+/g, "").replace(/\s+/g, "_");
  return `Contract_Summary_${name}_${r.period.end}.docx`;
}
