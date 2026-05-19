import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import JSZip from "jszip";
import { extractIndexableText } from "../src/document-text";
import { ingestSource, loadIndexStats } from "../src/indexer";
import { writeJson } from "../src/io";
import { searchWorkspace } from "../src/search";
import { SCHEMA_VERSION, type SourceEntry, type WorkspaceManifest } from "../src/types";
import { defaultConfig, workspaceFromRoot } from "../src/workspace";

test("extractIndexableText reads PDF text", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kbx-pdf-extract-"));
  try {
    const filePath = path.join(root, "roadmap.pdf");
    await writeFile(filePath, makePdf("PDF roadmap alpha token"));

    const text = await extractIndexableText(filePath, ".pdf");

    assert.match(text, /PDF roadmap alpha token/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("extractIndexableText reads DOCX text", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kbx-docx-extract-"));
  try {
    const filePath = path.join(root, "brief.docx");
    await writeFile(filePath, await makeDocx("DOCX roadmap beta token"));

    const text = await extractIndexableText(filePath, ".docx");

    assert.match(text, /DOCX roadmap beta token/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("extractIndexableText reads PPTX text", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kbx-pptx-extract-"));
  try {
    const filePath = path.join(root, "deck.pptx");
    await writeFile(filePath, await makePptx("PPTX planning gamma token"));

    const text = await extractIndexableText(filePath, ".pptx");

    assert.match(text, /PPTX planning gamma token/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("extractIndexableText reads XLSX text", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kbx-xlsx-extract-"));
  try {
    const filePath = path.join(root, "matrix.xlsx");
    await writeFile(filePath, await makeXlsx("XLSX planning delta token"));

    const text = await extractIndexableText(filePath, ".xlsx");

    assert.match(text, /XLSX planning delta token/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("extractIndexableText reads EPUB text", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kbx-epub-extract-"));
  try {
    const filePath = path.join(root, "manual.epub");
    await writeFile(filePath, await makeEpub("EPUB planning epsilon token"));

    const text = await extractIndexableText(filePath, ".epub");

    assert.match(text, /EPUB planning epsilon token/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("extractIndexableText strips EPUB script and style blocks with loose end tags", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kbx-epub-filter-"));
  try {
    const filePath = path.join(root, "manual.epub");
    await writeFile(filePath, await makeEpubChapter(`
<html xmlns="http://www.w3.org/1999/xhtml">
  <body>
    <script>script hidden token</script foo="bar">
    <style>.hidden { content: "style hidden token"; }</style >
    <p>EPUB visible eta token</p>
  </body>
</html>`));

    const text = await extractIndexableText(filePath, ".epub");

    assert.match(text, /EPUB visible eta token/);
    assert.doesNotMatch(text, /script hidden token/);
    assert.doesNotMatch(text, /style hidden token/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("extractIndexableText rejects binary content with a text extension", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kbx-binary-text-"));
  try {
    const filePath = path.join(root, "binary.txt");
    await writeFile(filePath, Buffer.from([0x00, 0x9f, 0x92, 0x96, 0x01]));

    await assert.rejects(
      () => extractIndexableText(filePath, ".txt"),
      /does not look like UTF-8 text/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ingestSource skips binary content with a text extension", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kbx-binary-text-ingest-"));
  const previousEmbedder = process.env.KBX_EMBEDDER;
  process.env.KBX_EMBEDDER = "hash";
  try {
    const workspace = workspaceFromRoot(root);
    await mkdir(workspace.kbxDir, { recursive: true });
    await writeFile(path.join(root, "binary.txt"), Buffer.from([0x00, 0x9f, 0x92, 0x96, 0x01]));
    await writeFile(path.join(root, "note.md"), "# Note\n\nplain searchable token\n", "utf8");
    await writeJson(workspace.manifestPath, manifest("test-model", 3));
    await writeJson(workspace.configPath, defaultConfig);
    const source: SourceEntry = { path: ".", kind: "workspace", include: [], exclude: [] };
    await writeJson(workspace.sourcesPath, [source]);

    const result = await ingestSource(workspace, source);
    const stats = await loadIndexStats(workspace, "test-model", 3);

    assert.equal(result.skipped, 1);
    assert.equal("binary.txt" in stats.files, false);
    assert.equal("note.md" in stats.files, true);
  } finally {
    restoreEnv("KBX_EMBEDDER", previousEmbedder);
    await rm(root, { recursive: true, force: true });
  }
});

test("ingestSource indexes document content for search", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kbx-document-search-"));
  const previousEmbedder = process.env.KBX_EMBEDDER;
  process.env.KBX_EMBEDDER = "hash";
  try {
    const workspace = workspaceFromRoot(root);
    await mkdir(workspace.kbxDir, { recursive: true });
    await writeFile(path.join(root, "roadmap.pdf"), makePdf("PDF launch checklist omega token"));
    await writeFile(path.join(root, "brief.docx"), await makeDocx("DOCX strategy memo zeta token"));
    await writeFile(path.join(root, "deck.pptx"), await makePptx("PPTX launch notes theta token"));
    await writeFile(path.join(root, "matrix.xlsx"), await makeXlsx("XLSX launch sheet iota token"));
    await writeFile(path.join(root, "manual.epub"), await makeEpub("EPUB launch chapter kappa token"));
    await writeFile(path.join(root, "screen.png"), makePngWithText("ocr", "PNG screenshot lambda token"));
    await writeJson(workspace.manifestPath, manifest("test-model", 3));
    await writeJson(workspace.configPath, defaultConfig);
    const source: SourceEntry = { path: ".", kind: "workspace", include: [], exclude: [] };
    await writeJson(workspace.sourcesPath, [source]);

    await ingestSource(workspace, source);

    const pdfHits = await searchWorkspace(workspace, "omega token", 3);
    const docxHits = await searchWorkspace(workspace, "zeta token", 3);
    const pptxHits = await searchWorkspace(workspace, "theta token", 3);
    const xlsxHits = await searchWorkspace(workspace, "iota token", 3);
    const epubHits = await searchWorkspace(workspace, "kappa token", 3);
    const pngHits = await searchWorkspace(workspace, "lambda token", 3);
    assert.equal(pdfHits[0]?.source, "roadmap.pdf");
    assert.equal(docxHits[0]?.source, "brief.docx");
    assert.equal(pptxHits[0]?.source, "deck.pptx");
    assert.equal(xlsxHits[0]?.source, "matrix.xlsx");
    assert.equal(epubHits[0]?.source, "manual.epub");
    assert.equal(pngHits[0]?.source, "screen.png");
  } finally {
    restoreEnv("KBX_EMBEDDER", previousEmbedder);
    await rm(root, { recursive: true, force: true });
  }
});

function makePdf(text: string): Buffer {
  const escaped = text.replace(/[\\()]/g, "\\$&");
  const stream = `BT /F1 24 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n",
    "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
    `5 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`
  ];

  let output = "%PDF-1.4\n";
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(output));
    output += object;
  }
  const xrefOffset = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    output += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(output, "binary");
}

function makePngWithText(keyword: string, value: string): Buffer {
  const chunks = [
    pngChunk("IHDR", Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0])),
    pngChunk("tEXt", Buffer.from(`${keyword}\0${value}`, "latin1")),
    pngChunk("IEND", Buffer.alloc(0))
  ];
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ...chunks]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length, 0);
  header.write(type, 4, 4, "latin1");
  return Buffer.concat([header, data, Buffer.alloc(4)]);
}

async function makeDocx(text: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);
  zip.folder("_rels")?.file(".rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);
  zip.folder("word")?.file("document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>${escapeXml(text)}</w:t></w:r></w:p>
  </w:body>
</w:document>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

async function makePptx(text: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
</Types>`);
  zip.folder("ppt")?.folder("slides")?.file("slide1.xml", `<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${escapeXml(text)}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>
</p:sld>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

async function makeXlsx(text: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`);
  zip.folder("xl")?.file("workbook.xml", `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheets><sheet name="Roadmap" sheetId="1" r:id="rId1"/></sheets>
</workbook>`);
  zip.folder("xl")?.file("sharedStrings.xml", `<?xml version="1.0" encoding="UTF-8"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>${escapeXml(text)}</t></si></sst>`);
  zip.folder("xl")?.folder("worksheets")?.file("sheet1.xml", `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData>
</worksheet>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

async function makeEpub(text: string): Promise<Buffer> {
  return makeEpubChapter(`<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Chapter</h1><p>${escapeXml(text)}</p></body></html>`);
}

async function makeEpubChapter(chapter: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip");
  zip.folder("META-INF")?.file("container.xml", `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`);
  zip.folder("OEBPS")?.file("content.opf", `<?xml version="1.0" encoding="UTF-8"?>
<package version="3.0" xmlns="http://www.idpf.org/2007/opf">
  <manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest>
  <spine><itemref idref="chapter"/></spine>
</package>`);
  zip.folder("OEBPS")?.file("chapter.xhtml", chapter);
  return zip.generateAsync({ type: "nodebuffer" });
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function manifest(modelName: string, dim: number): WorkspaceManifest {
  return {
    workspace_id: "test-workspace",
    name: "test",
    model: modelName,
    dim,
    schema_version: SCHEMA_VERSION,
    created_at: "2026-05-01T00:00:00.000Z",
    updated_at: "2026-05-01T00:00:00.000Z"
  };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
