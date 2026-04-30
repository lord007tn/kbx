import { asyncBufferFromUrl, parquetMetadataAsync, parquetReadObjects } from "hyparquet";
import { compressors } from "hyparquet-compressors";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const dataset = "open-index/open-markdown";
const shard = "data/CC-MAIN-2026-12/00/00/000057.parquet";
const url = `https://huggingface.co/datasets/${dataset}/resolve/main/${shard}`;
const byteLength = 5_660_653;
const targetCount = Number.parseInt(process.env.KBX_EXAMPLE_DOCS ?? "500", 10);
const outDir = path.resolve("examples/hf-open-markdown/files");

if (!Number.isInteger(targetCount) || targetCount < 1) {
  throw new Error("KBX_EXAMPLE_DOCS must be a positive integer");
}

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const file = await asyncBufferFromUrl({ url, byteLength });
const metadata = await parquetMetadataAsync(file);
const rowEnd = Math.min(Number(metadata.num_rows), Math.max(targetCount * 4, targetCount));
const rows = await parquetReadObjects({
  file,
  rowStart: 0,
  rowEnd,
  columns: ["doc_id", "url", "host", "markdown"],
  compressors
});

const manifest = {
  dataset,
  dataset_url: `https://huggingface.co/datasets/${dataset}`,
  shard,
  generated_at: new Date().toISOString(),
  requested_docs: targetCount,
  written_docs: 0,
  files: []
};

for (const row of rows) {
  if (manifest.written_docs >= targetCount) {
    break;
  }

  const markdown = String(row.markdown ?? "").trim();
  if (!isUsefulMarkdown(markdown)) {
    continue;
  }

  const index = String(manifest.written_docs + 1).padStart(4, "0");
  const host = sanitizeSegment(String(row.host ?? "unknown"));
  const fileName = `${index}-${host}.md`;
  const filePath = path.join(outDir, fileName);
  const content = [
    "---",
    `source_dataset: ${JSON.stringify(dataset)}`,
    `source_url: ${JSON.stringify(String(row.url ?? ""))}`,
    `source_doc_id: ${JSON.stringify(String(row.doc_id ?? ""))}`,
    "---",
    "",
    markdown,
    ""
  ].join("\n");

  await writeFile(filePath, content, "utf8");
  manifest.written_docs += 1;
  manifest.files.push({
    file: `files/${fileName}`,
    url: String(row.url ?? ""),
    doc_id: String(row.doc_id ?? "")
  });
}

await writeFile(
  path.resolve("examples/hf-open-markdown/manifest.generated.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8"
);

console.log(`Wrote ${manifest.written_docs} Markdown files to ${outDir}`);
if (manifest.written_docs < targetCount) {
  console.log(`Only ${manifest.written_docs} useful rows found in the scanned shard range.`);
}

function isUsefulMarkdown(value) {
  if (value.length < 300) {
    return false;
  }
  const replacementChars = [...value].filter((char) => char === "\uFFFD").length;
  if (replacementChars / value.length > 0.002) {
    return false;
  }
  const words = value.match(/[A-Za-z]{3,}/g) ?? [];
  return words.length >= 50;
}

function sanitizeSegment(value) {
  const sanitized = value
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return sanitized || "unknown";
}
