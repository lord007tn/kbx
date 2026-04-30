import matter from "gray-matter";
import crypto from "node:crypto";

export interface ChunkInput {
  source: string;
  content: string;
  maxChars: number;
  overlapChars: number;
  stripFrontmatter?: boolean;
}

export interface TextChunk {
  id: string;
  text: string;
  chunk_idx: number;
}

export function chunkMarkdown(input: ChunkInput): TextChunk[] {
  return chunkText({
    ...input,
    stripFrontmatter: true
  });
}

export function chunkText(input: ChunkInput): TextChunk[] {
  const content = input.stripFrontmatter === true ? matter(input.content).content : input.content;
  const text = content.replace(/\r\n/g, "\n").trim();
  if (text.length === 0) {
    return [];
  }

  const chunks: TextChunk[] = [];
  let start = 0;
  while (start < text.length) {
    const end = findChunkEnd(text, start, input.maxChars);
    const chunkText = text.slice(start, end).trim();
    if (chunkText.length > 0) {
      chunks.push({
        id: chunkId(input.source, chunks.length),
        text: chunkText,
        chunk_idx: chunks.length
      });
    }

    if (end >= text.length) {
      break;
    }
    start = findChunkStart(text, Math.max(end - input.overlapChars, start + 1));
  }

  return chunks;
}

function findChunkStart(text: string, desiredStart: number): number {
  let start = Math.max(0, desiredStart);
  while (start > 0 && !/\s/.test(text[start - 1] ?? "")) {
    start -= 1;
  }
  return start;
}

function findChunkEnd(text: string, start: number, maxChars: number): number {
  const hardEnd = Math.min(start + maxChars, text.length);
  if (hardEnd >= text.length) {
    return text.length;
  }

  const window = text.slice(start, hardEnd);
  const paragraphBreak = window.lastIndexOf("\n\n");
  if (paragraphBreak > maxChars * 0.4) {
    return start + paragraphBreak;
  }

  const sentenceBreak = Math.max(window.lastIndexOf(". "), window.lastIndexOf("? "), window.lastIndexOf("! "));
  if (sentenceBreak > maxChars * 0.5) {
    return start + sentenceBreak + 1;
  }

  const whitespace = window.lastIndexOf(" ");
  if (whitespace > maxChars * 0.5) {
    return start + whitespace;
  }

  return hardEnd;
}

function chunkId(source: string, index: number): string {
  return crypto.createHash("sha256").update(`${source}:${index}`).digest("hex").slice(0, 24);
}
