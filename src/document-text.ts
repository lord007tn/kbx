import { readFile } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import JSZip from "jszip";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import { extractImageText, isImageExtension } from "./ocr";

const PDF_MAX_PAGES = 200;
const DOCUMENT_EXTENSIONS = new Set([".pdf", ".docx", ".pptx", ".xlsx", ".epub"]);
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export class NonTextContentError extends Error {
  constructor(filePath: string) {
    super(`${filePath} does not look like UTF-8 text`);
    this.name = "NonTextContentError";
  }
}

export function isNonTextContentError(error: unknown): error is NonTextContentError {
  return error instanceof NonTextContentError;
}

export function isDocumentExtension(extension: string): boolean {
  return DOCUMENT_EXTENSIONS.has(extension) || isImageExtension(extension);
}

export async function extractIndexableText(filePath: string, extension: string): Promise<string> {
  if (isImageExtension(extension)) {
    return extractImageText(filePath, extension);
  }
  if (extension === ".pdf") {
    return extractPdfText(filePath);
  }
  if (extension === ".docx") {
    return extractDocxText(filePath);
  }
  if (extension === ".pptx") {
    return extractPptxText(filePath);
  }
  if (extension === ".xlsx") {
    return extractXlsxText(filePath);
  }
  if (extension === ".epub") {
    return extractEpubText(filePath);
  }
  return readUtf8TextFile(filePath);
}

async function readUtf8TextFile(filePath: string): Promise<string> {
  const data = await readFile(filePath);
  let text: string;
  try {
    text = utf8Decoder.decode(data);
  } catch {
    throw new NonTextContentError(filePath);
  }
  if (hasBinaryControlCharacters(text)) {
    throw new NonTextContentError(filePath);
  }
  return text;
}

async function extractPdfText(filePath: string): Promise<string> {
  const data = await readFile(filePath);
  const parser = new PDFParse({ data });
  try {
    const result = await parser.getText({ first: PDF_MAX_PAGES });
    return normalizeExtractedText(result.text);
  } finally {
    await parser.destroy();
  }
}

async function extractDocxText(filePath: string): Promise<string> {
  const result = await mammoth.extractRawText({ path: filePath });
  return normalizeExtractedText(result.value);
}

async function extractPptxText(filePath: string): Promise<string> {
  const zip = await JSZip.loadAsync(await readFile(filePath));
  const slides = zipFileNames(zip)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort(naturalSort);
  const sections: string[] = [];

  for (const [index, slidePath] of slides.entries()) {
    const xml = await zipText(zip, slidePath);
    const text = extractXmlTextNodeValues(xml).join(" ");
    if (text.trim()) {
      sections.push(`Slide ${index + 1}\n${text}`);
    }
  }

  return normalizeExtractedText(sections.join("\n\n"));
}

async function extractXlsxText(filePath: string): Promise<string> {
  const zip = await JSZip.loadAsync(await readFile(filePath));
  const sharedStrings = await readXlsxSharedStrings(zip);
  const sheetNames = await readXlsxSheetNames(zip);
  const sheets = zipFileNames(zip)
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
    .sort(naturalSort);
  const sections: string[] = [];

  for (const [index, sheetPath] of sheets.entries()) {
    const xml = await zipText(zip, sheetPath);
    const text = extractWorksheetText(xml, sharedStrings);
    if (text.trim()) {
      sections.push(`${sheetNames[index] ?? path.posix.basename(sheetPath, ".xml")}\n${text}`);
    }
  }

  return normalizeExtractedText(sections.join("\n\n"));
}

async function extractEpubText(filePath: string): Promise<string> {
  const zip = await JSZip.loadAsync(await readFile(filePath));
  const opfPath = await resolveEpubPackagePath(zip);
  if (!opfPath) {
    return "";
  }

  const opf = await zipText(zip, opfPath);
  const baseDir = path.posix.dirname(opfPath);
  const manifest = epubManifest(opf, baseDir);
  const spinePaths = epubSpinePaths(opf, manifest);
  const readingOrder = spinePaths.length > 0
    ? spinePaths
    : [...manifest.values()]
        .filter((item) => isEpubTextMediaType(item.mediaType))
        .map((item) => item.path);
  const sections: string[] = [];

  for (const contentPath of readingOrder) {
    const entry = zip.file(contentPath);
    if (!entry) {
      continue;
    }
    const html = await entry.async("text");
    const text = extractHtmlText(html);
    if (text.trim()) {
      sections.push(text);
    }
  }

  return normalizeExtractedText(sections.join("\n\n"));
}

async function readXlsxSharedStrings(zip: JSZip): Promise<string[]> {
  const entry = zip.file("xl/sharedStrings.xml");
  if (!entry) {
    return [];
  }

  const xml = await entry.async("text");
  return [...xml.matchAll(/<si\b[\s\S]*?<\/si>/gi)]
    .map((match) => extractXmlTextNodeValues(match[0]).join(""));
}

async function readXlsxSheetNames(zip: JSZip): Promise<string[]> {
  const entry = zip.file("xl/workbook.xml");
  if (!entry) {
    return [];
  }

  const xml = await entry.async("text");
  return [...xml.matchAll(/<sheet\b([^>]*)\/?>/gi)]
    .map((match) => xmlAttribute(match[1] ?? "", "name"))
    .filter((value): value is string => value !== undefined && value.trim() !== "");
}

function extractWorksheetText(xml: string, sharedStrings: string[]): string {
  const values: string[] = [];
  for (const match of xml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gi)) {
    const attributes = match[1] ?? "";
    const body = match[2] ?? "";
    const cellType = xmlAttribute(attributes, "t");

    if (cellType === "s") {
      const index = Number.parseInt(firstXmlTagValue(body, "v") ?? "", 10);
      const value = Number.isInteger(index) ? sharedStrings[index] : undefined;
      if (value) {
        values.push(value);
      }
      continue;
    }

    if (cellType === "inlineStr") {
      values.push(extractXmlTextNodeValues(body).join(""));
      continue;
    }

    const value = extractXmlTextNodeValues(body).join("") || firstXmlTagValue(body, "v");
    if (value?.trim()) {
      values.push(value);
    }
  }
  return values.join("\n");
}

async function resolveEpubPackagePath(zip: JSZip): Promise<string | null> {
  const container = zip.file("META-INF/container.xml");
  if (container) {
    const xml = await container.async("text");
    const rootfile = xml.match(/<rootfile\b([^>]*)\/?>/i);
    const fullPath = rootfile ? xmlAttribute(rootfile[1] ?? "", "full-path") : undefined;
    if (fullPath && zip.file(fullPath)) {
      return fullPath;
    }
  }

  return zipFileNames(zip).find((name) => name.toLowerCase().endsWith(".opf")) ?? null;
}

interface EpubManifestItem {
  path: string;
  mediaType: string;
}

function epubManifest(opf: string, baseDir: string): Map<string, EpubManifestItem> {
  const items = new Map<string, EpubManifestItem>();
  for (const match of opf.matchAll(/<item\b([^>]*)\/?>/gi)) {
    const attributes = match[1] ?? "";
    const id = xmlAttribute(attributes, "id");
    const href = xmlAttribute(attributes, "href");
    const mediaType = xmlAttribute(attributes, "media-type") ?? "";
    if (!id || !href) {
      continue;
    }

    items.set(id, {
      path: normalizeZipPath(baseDir, href),
      mediaType
    });
  }
  return items;
}

function epubSpinePaths(opf: string, manifest: Map<string, EpubManifestItem>): string[] {
  const paths: string[] = [];
  for (const match of opf.matchAll(/<itemref\b([^>]*)\/?>/gi)) {
    const idref = xmlAttribute(match[1] ?? "", "idref");
    const item = idref ? manifest.get(idref) : undefined;
    if (item && isEpubTextMediaType(item.mediaType)) {
      paths.push(item.path);
    }
  }
  return paths;
}

function isEpubTextMediaType(mediaType: string): boolean {
  return mediaType === "application/xhtml+xml" || mediaType === "text/html";
}

function extractHtmlText(value: string): string {
  return decodeXmlEntities(value)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/?(?:p|div|section|article|header|footer|h[1-6]|li|tr|br)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
}

function extractXmlTextNodeValues(xml: string): string[] {
  return [...xml.matchAll(/<(?:[A-Za-z0-9_.-]+:)?t\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?t>/g)]
    .map((match) => decodeXmlEntities(match[1] ?? ""))
    .filter((value) => value.trim() !== "");
}

function firstXmlTagValue(xml: string, tagName: string): string | undefined {
  const escaped = escapeRegExp(tagName);
  const match = xml.match(new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${escaped}\\b[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z0-9_.-]+:)?${escaped}>`, "i"));
  const value = match ? decodeXmlEntities(match[1] ?? "") : undefined;
  return value?.trim() ? value : undefined;
}

function xmlAttribute(attributes: string, name: string): string | undefined {
  const match = attributes.match(new RegExp(`\\b${escapeRegExp(name)}=(["'])([\\s\\S]*?)\\1`, "i"));
  const value = match ? decodeXmlEntities(match[2] ?? "") : undefined;
  return value?.trim() ? value : undefined;
}

function zipFileNames(zip: JSZip): string[] {
  return Object.values(zip.files)
    .filter((entry) => !entry.dir)
    .map((entry) => entry.name.replaceAll("\\", "/"));
}

async function zipText(zip: JSZip, name: string): Promise<string> {
  const entry = zip.file(name);
  if (!entry) {
    return "";
  }
  return entry.async("text");
}

function normalizeZipPath(baseDir: string, href: string): string {
  const decodedHref = decodeURIComponent(href.split("#", 1)[0] ?? href);
  return path.posix.normalize(path.posix.join(baseDir === "." ? "" : baseDir, decodedHref));
}

function naturalSort(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true });
}

function decodeXmlEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (entity, body: string) => {
    if (body.startsWith("#x")) {
      return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    }
    if (body.startsWith("#")) {
      return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    }
    return {
      amp: "&",
      lt: "<",
      gt: ">",
      quot: "\"",
      apos: "'"
    }[body] ?? entity;
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeExtractedText(value: string): string {
  return value
    .replace(/\u0000/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function hasBinaryControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 && code !== 9 && code !== 10 && code !== 12 && code !== 13) {
      return true;
    }
  }
  return false;
}
