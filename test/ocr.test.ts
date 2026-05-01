import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { extractIndexableText, isDocumentExtension } from "../src/document-text";
import { extractPngText } from "../src/ocr";

test("image extensions are indexable document-like inputs", () => {
  assert.equal(isDocumentExtension(".png"), true);
  assert.equal(isDocumentExtension(".jpg"), true);
});

test("extractPngText reads PNG tEXt chunks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kbx-png-text-"));
  try {
    const filePath = path.join(root, "screenshot.png");
    await writeFile(filePath, makePngWithText("ocr", "embedded screenshot alpha token"));

    const text = await extractPngText(filePath);

    assert.match(text, /embedded screenshot alpha token/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("extractIndexableText can use an external OCR command", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kbx-ocr-command-"));
  const previous = process.env.KBX_OCR_COMMAND;
  try {
    const imagePath = path.join(root, "scan.jpg");
    const scriptPath = path.join(root, "ocr.mjs");
    await writeFile(imagePath, "not a real image", "utf8");
    await writeFile(scriptPath, `process.stdout.write("external OCR beta token\\n");`, "utf8");
    process.env.KBX_OCR_COMMAND = `"${process.execPath}" "${scriptPath}" {file}`;

    const text = await extractIndexableText(imagePath, ".jpg");

    assert.match(text, /external OCR beta token/);
  } finally {
    if (previous === undefined) {
      delete process.env.KBX_OCR_COMMAND;
    } else {
      process.env.KBX_OCR_COMMAND = previous;
    }
    await rm(root, { recursive: true, force: true });
  }
});

function makePngWithText(keyword: string, value: string): Buffer {
  const chunks = [
    chunk("IHDR", Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0])),
    chunk("tEXt", Buffer.from(`${keyword}\0${value}`, "latin1")),
    chunk("IEND", Buffer.alloc(0))
  ];
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ...chunks]);
}

function chunk(type: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length, 0);
  header.write(type, 4, 4, "latin1");
  return Buffer.concat([header, data, Buffer.alloc(4)]);
}
