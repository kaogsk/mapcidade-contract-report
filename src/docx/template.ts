/**
 * The report template, written from scratch as raw OOXML: a generic A4 layout with a header, a
 * page-numbered footer, paragraph/table styles and two list definitions. `npm run template` writes
 * it to templates/contract-summary-template.docx.
 *
 * In production the template is a file owned by the business side (letterhead, logos, footer with
 * the office address) and replaced whenever they change it. The generator therefore treats the
 * template as an opaque file and only swaps the BODY of word/document.xml; header, footer, styles,
 * numbering and section settings come out byte for byte. A test holds that line.
 *
 * Fixed zip timestamps make the build reproducible: the same source always yields the same bytes.
 */
import JSZip from "jszip";

export const BODY_PLACEHOLDER = "{{REPORT_BODY}}";

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** A4, 2.5 cm sides. Text width = 11906 − 1418 − 1134 = 9354 twips. */
export const TEXT_WIDTH_TWIPS = 9354;

const ACCENT = "0F766E";
const INK = "1F2937";
const MUTED = "6B7280";

const contentTypes = `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>
<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>
<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;

const rootRels = `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;

const documentRels = `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rIdNumbering" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
<Relationship Id="rIdSettings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>
<Relationship Id="rIdHeader1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>
<Relationship Id="rIdFooter1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>
</Relationships>`;

const document = `${HEAD}<w:document ${W} ${R}><w:body>
<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>${BODY_PLACEHOLDER}</w:t></w:r></w:p>
<w:sectPr>
<w:headerReference w:type="default" r:id="rIdHeader1"/>
<w:footerReference w:type="default" r:id="rIdFooter1"/>
<w:pgSz w:w="11906" w:h="16838"/>
<w:pgMar w:top="1701" w:right="1134" w:bottom="1418" w:left="1418" w:header="709" w:footer="567" w:gutter="0"/>
<w:cols w:space="708"/>
</w:sectPr>
</w:body></w:document>`;

const pStyle = (id: string, name: string, pPr: string, rPr: string, extra = "") =>
  `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/>${extra}<w:qFormat/><w:pPr>${pPr}</w:pPr><w:rPr>${rPr}</w:rPr></w:style>`;

const styles = `${HEAD}<w:styles ${W}>
<w:docDefaults>
<w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Arial" w:cs="Arial"/><w:color w:val="${INK}"/><w:sz w:val="21"/><w:szCs w:val="21"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="100" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault>
</w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
${pStyle("Title", "Title", '<w:jc w:val="center"/><w:spacing w:before="0" w:after="60"/>', `<w:b/><w:caps/><w:color w:val="${ACCENT}"/><w:spacing w:val="10"/><w:sz w:val="30"/><w:szCs w:val="30"/>`)}
${pStyle("Subtitle", "Subtitle", '<w:jc w:val="center"/><w:spacing w:after="40"/>', `<w:b/><w:color w:val="${INK}"/><w:sz w:val="22"/><w:szCs w:val="22"/>`)}
${pStyle("PeriodLine", "Period Line", '<w:jc w:val="center"/><w:spacing w:after="360"/>', `<w:i/><w:color w:val="${MUTED}"/><w:sz w:val="20"/><w:szCs w:val="20"/>`)}
${pStyle("Heading1", "heading 1", `<w:keepNext/><w:spacing w:before="320" w:after="120"/><w:pBdr><w:bottom w:val="single" w:sz="8" w:space="2" w:color="${ACCENT}"/></w:pBdr><w:outlineLvl w:val="0"/>`, `<w:b/><w:caps/><w:color w:val="${ACCENT}"/><w:sz w:val="23"/><w:szCs w:val="23"/>`, '<w:next w:val="Normal"/>')}
${pStyle("Heading2", "heading 2", '<w:keepNext/><w:spacing w:before="200" w:after="60"/><w:outlineLvl w:val="1"/>', `<w:b/><w:color w:val="${INK}"/><w:sz w:val="21"/><w:szCs w:val="21"/>`, '<w:next w:val="Normal"/>')}
${pStyle("Fact", "Fact", `<w:tabs><w:tab w:val="right" w:leader="dot" w:pos="${TEXT_WIDTH_TWIPS}"/></w:tabs><w:spacing w:after="60"/>`, "")}
${pStyle("ListParagraph", "List Paragraph", '<w:ind w:left="720"/><w:contextualSpacing/><w:spacing w:after="40"/>', "")}
${pStyle("Note", "Note", `<w:pBdr><w:left w:val="single" w:sz="18" w:space="6" w:color="D97706"/></w:pBdr><w:shd w:val="clear" w:color="auto" w:fill="FFF7ED"/><w:ind w:left="160"/><w:spacing w:after="100"/>`, '<w:i/><w:color w:val="9A3412"/><w:sz w:val="19"/><w:szCs w:val="19"/>')}
${pStyle("TableText", "Table Text", '<w:spacing w:before="40" w:after="40"/>', '<w:sz w:val="19"/><w:szCs w:val="19"/>')}
${pStyle("Header", "header", `<w:tabs><w:tab w:val="right" w:pos="${TEXT_WIDTH_TWIPS}"/></w:tabs><w:pBdr><w:bottom w:val="single" w:sz="4" w:space="4" w:color="D1D5DB"/></w:pBdr><w:spacing w:after="0"/>`, `<w:color w:val="${MUTED}"/><w:sz w:val="17"/><w:szCs w:val="17"/>`)}
${pStyle("Footer", "footer", '<w:jc w:val="center"/><w:spacing w:after="0"/>', `<w:color w:val="${MUTED}"/><w:sz w:val="16"/><w:szCs w:val="16"/>`)}
<w:style w:type="table" w:styleId="ReportTable"><w:name w:val="Report Table"/><w:tblPr><w:tblBorders>
<w:top w:val="single" w:sz="4" w:space="0" w:color="D1D5DB"/><w:left w:val="single" w:sz="4" w:space="0" w:color="D1D5DB"/>
<w:bottom w:val="single" w:sz="4" w:space="0" w:color="D1D5DB"/><w:right w:val="single" w:sz="4" w:space="0" w:color="D1D5DB"/>
<w:insideH w:val="single" w:sz="4" w:space="0" w:color="D1D5DB"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="D1D5DB"/>
</w:tblBorders><w:tblCellMar><w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>
</w:styles>`;

const lvl = (ilvl: number, fmt: string, text: string, left: number, color: string) =>
  `<w:lvl w:ilvl="${ilvl}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/>` +
  `<w:pPr><w:ind w:left="${left}" w:hanging="360"/></w:pPr><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:color w:val="${color}"/></w:rPr></w:lvl>`;

/** numId 1 = bullets (level 0 "•", level 1 "–"); numId 2 = numbered steps. */
const numbering = `${HEAD}<w:numbering ${W}>
<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${lvl(0, "bullet", "•", 720, ACCENT)}${lvl(1, "bullet", "–", 1440, MUTED)}</w:abstractNum>
<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${lvl(0, "decimal", "%1.", 720, ACCENT)}</w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`;

const settings = `${HEAD}<w:settings ${W}><w:defaultTabStop w:val="708"/><w:characterSpacingControl w:val="doNotCompress"/>
<w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`;

const header = `${HEAD}<w:hdr ${W}><w:p><w:pPr><w:pStyle w:val="Header"/></w:pPr>
<w:r><w:rPr><w:b/><w:color w:val="${ACCENT}"/></w:rPr><w:t>MapCidade</w:t></w:r>
<w:r><w:t xml:space="preserve"> · Municipal GIS platform</w:t></w:r>
<w:r><w:tab/><w:t>Contract Summary Report</w:t></w:r></w:p></w:hdr>`;

const footer = `${HEAD}<w:ftr ${W}><w:p><w:pPr><w:pStyle w:val="Footer"/></w:pPr>
<w:r><w:t xml:space="preserve">Page </w:t></w:r><w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple>
<w:r><w:t xml:space="preserve"> of </w:t></w:r><w:fldSimple w:instr=" NUMPAGES "><w:r><w:t>1</w:t></w:r></w:fldSimple></w:p>
<w:p><w:pPr><w:pStyle w:val="Footer"/></w:pPr><w:r><w:t>Figures cover the stated period only and come from the platform's own records.</w:t></w:r></w:p></w:ftr>`;

const FIXED_DATE = "2026-01-01T00:00:00Z";

const core = `${HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>Contract Summary Report</dc:title><dc:creator>MapCidade</dc:creator><cp:lastModifiedBy>MapCidade</cp:lastModifiedBy>
<dcterms:created xsi:type="dcterms:W3CDTF">${FIXED_DATE}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${FIXED_DATE}</dcterms:modified>
</cp:coreProperties>`;

const app = `${HEAD}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>mapcidade-contract-report</Application></Properties>`;

/** Every part of the template, in zip order ([Content_Types].xml first, as Word expects). */
export const TEMPLATE_PARTS: ReadonlyArray<[string, string]> = [
  ["[Content_Types].xml", contentTypes],
  ["_rels/.rels", rootRels],
  ["docProps/core.xml", core],
  ["docProps/app.xml", app],
  ["word/document.xml", document],
  ["word/_rels/document.xml.rels", documentRels],
  ["word/styles.xml", styles],
  ["word/numbering.xml", numbering],
  ["word/settings.xml", settings],
  ["word/header1.xml", header],
  ["word/footer1.xml", footer],
];

export async function buildTemplate(): Promise<Buffer> {
  const zip = new JSZip();
  const date = new Date(FIXED_DATE);
  for (const [path, xml] of TEMPLATE_PARTS) zip.file(path, xml, { date });
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 9 } });
}
