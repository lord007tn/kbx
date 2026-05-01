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
  const content = matter(input.content).content.replace(/\r\n/g, "\n").trim();
  if (content.length === 0) {
    return [];
  }

  const sections = splitMarkdownSections(content);
  const chunks: TextChunk[] = [];
  for (const section of sections) {
    chunks.push(
      ...buildChunks({
        source: input.source,
        text: section,
        maxChars: input.maxChars,
        overlapChars: input.overlapChars,
        initialIndex: chunks.length
      })
    );
  }

  return chunks;
}

export function chunkText(input: ChunkInput): TextChunk[] {
  const content = input.stripFrontmatter === true ? matter(input.content).content : input.content;
  const text = content.replace(/\r\n/g, "\n").trim();
  if (text.length === 0) {
    return [];
  }

  return buildChunks({
    source: input.source,
    text,
    maxChars: input.maxChars,
    overlapChars: input.overlapChars,
    initialIndex: 0
  });
}

export function chunkSentences(input: ChunkInput): TextChunk[] {
  const content = input.stripFrontmatter === true ? matter(input.content).content : input.content;
  const text = content.replace(/\r\n/g, "\n").trim();
  if (text.length === 0) {
    return [];
  }

  const sentences = splitSentences(text);
  const chunks: TextChunk[] = [];
  let current = "";

  const flush = () => {
    const trimmed = current.trim();
    if (trimmed.length === 0) {
      current = "";
      return;
    }

    if (trimmed.length <= input.maxChars) {
      const chunkIndex = chunks.length;
      chunks.push({
        id: chunkId(input.source, chunkIndex),
        text: trimmed,
        chunk_idx: chunkIndex
      });
    } else {
      chunks.push(
        ...buildChunks({
          source: input.source,
          text: trimmed,
          maxChars: input.maxChars,
          overlapChars: input.overlapChars,
          initialIndex: chunks.length
        })
      );
    }
    current = "";
  };

  for (const sentence of sentences) {
    const next = current ? `${current} ${sentence}` : sentence;
    if (next.length > input.maxChars && current.length > 0) {
      flush();
      current = sentence;
    } else {
      current = next;
    }
  }
  flush();

  return chunks;
}

function buildChunks(input: {
  source: string;
  text: string;
  maxChars: number;
  overlapChars: number;
  initialIndex: number;
}): TextChunk[] {
  const chunks: TextChunk[] = [];
  let start = 0;
  while (start < input.text.length) {
    const end = findChunkEnd(input.text, start, input.maxChars);
    const chunkText = input.text.slice(start, end).trim();
    if (chunkText.length > 0) {
      const chunkIndex = input.initialIndex + chunks.length;
      chunks.push({
        id: chunkId(input.source, chunkIndex),
        text: chunkText,
        chunk_idx: chunkIndex
      });
    }

    if (end >= input.text.length) {
      break;
    }
    const nextStart = findChunkStart(input.text, Math.max(end - input.overlapChars, start + 1));
    start = nextStart > start
      ? nextStart
      : Math.min(end, start + Math.max(1, input.maxChars - input.overlapChars));
  }

  return chunks;
}

function splitMarkdownSections(text: string): string[] {
  const sections: string[] = [];
  let current: string[] = [];

  for (const line of text.split("\n")) {
    if (/^#{1,6}\s+\S/.test(line) && current.some((value) => value.trim().length > 0)) {
      sections.push(current.join("\n").trim());
      current = [];
    }
    current.push(line);
  }

  if (current.some((value) => value.trim().length > 0)) {
    sections.push(current.join("\n").trim());
  }

  return sections;
}

function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"`'([])/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
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

export function chunkId(source: string, index: number): string {
  return crypto.createHash("sha256").update(`${source}:${index}`).digest("hex").slice(0, 24);
}
