import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

const DEFAULT_OCR_TIMEOUT_MS = 30000;

export const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".tif", ".tiff", ".bmp"]);

export function isImageExtension(extension: string): boolean {
  return IMAGE_EXTENSIONS.has(extension);
}

export async function extractImageText(filePath: string, extension: string): Promise<string> {
  const metadataText = extension === ".png" ? await extractPngText(filePath) : "";
  const ocrText = await extractOcrText(filePath);
  return normalizeExtractedText([metadataText, ocrText].filter(Boolean).join("\n\n"));
}

export async function extractPngText(filePath: string): Promise<string> {
  const buffer = await readFile(filePath);
  if (buffer.length < 8 || buffer.subarray(0, 8).compare(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) !== 0) {
    return "";
  }

  const values: string[] = [];
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("latin1");
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) {
      break;
    }

    if (type === "tEXt") {
      const separator = buffer.indexOf(0, dataStart);
      if (separator > dataStart && separator < dataEnd) {
        values.push(buffer.subarray(separator + 1, dataEnd).toString("latin1"));
      }
    } else if (type === "iTXt") {
      const text = decodePngInternationalText(buffer.subarray(dataStart, dataEnd));
      if (text) {
        values.push(text);
      }
    }

    offset = dataEnd + 4;
    if (type === "IEND") {
      break;
    }
  }

  return normalizeExtractedText(values.join("\n"));
}

async function extractOcrText(filePath: string): Promise<string> {
  const commandLine = process.env.KBX_OCR_COMMAND;
  if (!commandLine) {
    return runOcrProcess("tesseract", [filePath, "stdout"], Number.parseInt(process.env.KBX_OCR_TIMEOUT_MS ?? String(DEFAULT_OCR_TIMEOUT_MS), 10))
      .catch(() => "");
  }

  const args = parseCommandLine(commandLine).map((part) => part.replaceAll("{file}", filePath));
  const command = args.shift();
  if (!command) {
    return "";
  }
  return runOcrProcess(command, args, Number.parseInt(process.env.KBX_OCR_TIMEOUT_MS ?? String(DEFAULT_OCR_TIMEOUT_MS), 10));
}

function decodePngInternationalText(data: Buffer): string {
  let offset = data.indexOf(0);
  if (offset < 0 || offset + 2 >= data.length) {
    return "";
  }

  const compressionFlag = data[offset + 1];
  offset += 2;
  if (compressionFlag !== 0) {
    return "";
  }

  const languageEnd = data.indexOf(0, offset);
  if (languageEnd < 0) {
    return "";
  }
  const translatedEnd = data.indexOf(0, languageEnd + 1);
  if (translatedEnd < 0) {
    return "";
  }
  return data.subarray(translatedEnd + 1).toString("utf8");
}

function runOcrProcess(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`OCR command timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`OCR command exited with ${code}: ${Buffer.concat(stderr).toString("utf8").trim()}`));
        return;
      }
      resolve(normalizeExtractedText(Buffer.concat(stdout).toString("utf8")));
    });
  });
}

function parseCommandLine(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: "\"" | "'" | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    const next = value[index + 1];
    if (char === "\\" && next && (next === "\\" || next === "\"" || next === "'" || /\s/.test(next))) {
      current += next;
      index += 1;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) {
    parts.push(current);
  }
  return parts;
}

function normalizeExtractedText(value: string): string {
  return value
    .replace(/\u0000/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
