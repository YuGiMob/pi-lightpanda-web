import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pagePrefixedMarkdown } from "./html-to-md.ts";
import { extractPdfText } from "./pdf.ts";
import { truncatePageText } from "./page-text.ts";

const MAX_TEXT_BYTES = 512 * 1024;
const MAX_PDF_BYTES = 10 * 1024 * 1024;
const BINARY_CHAR_RE = /[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f-\x9f\ufffd]/g;
const MIN_BINARY_CHARS = 16;
const BINARY_CHAR_DIVISOR = 8;
const TRUNCATED_FILE_SUFFIX = "... (file truncated at the read limit)";
const TRUNCATED_FILE_NOTICE = "\n\n" + TRUNCATED_FILE_SUFFIX;
const UTF32_LE_BOM = Buffer.from([0xff, 0xfe, 0x00, 0x00]);
const UTF32_BE_BOM = Buffer.from([0x00, 0x00, 0xfe, 0xff]);
const UTF16_LE_BOM = Buffer.from([0xff, 0xfe]);
const UTF16_BE_BOM = Buffer.from([0xfe, 0xff]);
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const PDF_MAGIC = Buffer.from("%PDF-");
const MAGIC_HEAD_BYTES = 1024;
const SKIPPED_MAGIC_PREFIX_BYTES = new Set([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20]);
const WINDOWS_PATH_RE = /^[a-zA-Z]:[\\/]/;
const HTML_FILE_EXTENSIONS = new Set([".htm", ".html", ".xht", ".xhtml"]);

export function parseLocalPath(url: string): string | null {
  const trimmed = url.trim();
  if (/^file:/i.test(trimmed)) {
    try {
      return fileURLToPath(trimmed);
    } catch {
      return "";
    }
  }
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) return join(homedir(), trimmed.slice(2));
  if (WINDOWS_PATH_RE.test(trimmed) || trimmed.startsWith("/") || /^\.{1,2}\//.test(trimmed)) return trimmed;
  return null;
}

function localFileFailure(err: unknown): string {
  return `Failed to read file: ${err instanceof Error ? err.message : String(err)}`;
}

function localFileContentType(filePath: string): string {
  const dot = filePath.lastIndexOf(".");
  return dot !== -1 && HTML_FILE_EXTENSIONS.has(filePath.slice(dot).toLowerCase()) ? "text/html" : "";
}

function looksBinary(text: string): boolean {
  return (text.match(BINARY_CHAR_RE) ?? []).length > Math.max(MIN_BINARY_CHARS, Math.floor(text.length / BINARY_CHAR_DIVISOR));
}

function withTruncation(text: string, truncated: boolean): string {
  return truncated ? text + TRUNCATED_FILE_NOTICE : text;
}

function hasPdfMagic(data: Buffer): boolean {
  const head = data.subarray(0, MAGIC_HEAD_BYTES);
  let start = 0;
  while (start < head.length && SKIPPED_MAGIC_PREFIX_BYTES.has(head[start])) start++;
  for (const bom of [UTF32_LE_BOM, UTF32_BE_BOM, UTF16_LE_BOM, UTF16_BE_BOM, UTF8_BOM]) {
    if (head.subarray(start).length >= bom.length && head.subarray(start, start + bom.length).equals(bom)) {
      start += bom.length;
      while (start < head.length && SKIPPED_MAGIC_PREFIX_BYTES.has(head[start])) start++;
      break;
    }
  }
  const magic = head.subarray(start);
  return magic.length >= PDF_MAGIC.length && magic.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC);
}

function decodeUtf32(bytes: Buffer, littleEndian: boolean): string {
  let out = "";
  let i = 0;
  if (bytes.length >= 4) {
    const first = littleEndian ? bytes.readUInt32LE(0) : bytes.readUInt32BE(0);
    if (first === 0xfeff) i = 4;
  }
  for (; i + 3 < bytes.length; i += 4) {
    const value = littleEndian ? bytes.readUInt32LE(i) : bytes.readUInt32BE(i);
    if (value === 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) out += "\ufffd";
    else out += String.fromCodePoint(value);
  }
  return out;
}

function decodeLocalText(bytes: Buffer): string {
  if (bytes.length >= 4 && bytes.subarray(0, 4).equals(UTF32_LE_BOM)) return decodeUtf32(bytes, true);
  if (bytes.length >= 4 && bytes.subarray(0, 4).equals(UTF32_BE_BOM)) return decodeUtf32(bytes, false);
  if (bytes.length >= 2 && bytes.subarray(0, 2).equals(UTF16_LE_BOM)) {
    return new TextDecoder("utf-16le", { fatal: false }).decode(bytes);
  }
  if (bytes.length >= 2 && bytes.subarray(0, 2).equals(UTF16_BE_BOM)) {
    return new TextDecoder("utf-16be", { fatal: false }).decode(bytes);
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

export async function readLocalFile(
  filePath: string,
  options: { signal?: AbortSignal; maxChars?: number; maxBytes?: number; maxPdfBytes?: number },
): Promise<string> {
  if (options.signal?.aborted) return "Failed to read file: cancelled.";
  let handle: FileHandle;
  try {
    handle = await open(filePath, "r");
  } catch (err) {
    return localFileFailure(err);
  }
  try {
    const stats = await handle.stat();
    if (stats.isDirectory()) return `Failed to read file: ${filePath} is a directory.`;
    const maxBytes = options.maxBytes ?? MAX_TEXT_BYTES;
    const maxPdfBytes = options.maxPdfBytes ?? MAX_PDF_BYTES;
    const length = Math.min(stats.size, Math.max(maxBytes, maxPdfBytes));
    const buffer = Buffer.alloc(Number(length));
    let read = 0;
    while (read < length) {
      const { bytesRead } = await handle.read(buffer, read, length - read, read);
      if (!bytesRead) break;
      read += bytesRead;
    }
    if (options.signal?.aborted) return "Failed to read file: cancelled.";
    const head = read < length ? buffer.subarray(0, read) : buffer;
    const isPdf = hasPdfMagic(head);
    const limit = isPdf ? maxPdfBytes : maxBytes;
    const truncated = stats.size > limit;
    const body = head.length > limit ? head.subarray(0, limit) : head;
    if (isPdf) {
      let pdfText: string;
      try {
        pdfText = await extractPdfText(body);
      } catch {
        return withTruncation("(PDF content could not be read as text)", truncated);
      }
      if (!pdfText) pdfText = "(PDF contains no extractable text)";
      return truncatePageText(withTruncation(pdfText, truncated), options.maxChars);
    }
    const text = decodeLocalText(body);
    if (looksBinary(text)) return `(binary content, ${body.length} bytes; not readable as text)`;
    const contentType = localFileContentType(filePath);
    const rendered = contentType.includes("html") ? pagePrefixedMarkdown(text) : text.trim();
    return truncatePageText(withTruncation(rendered, truncated), options.maxChars);
  } finally {
    await handle.close().catch(() => {});
  }
}
