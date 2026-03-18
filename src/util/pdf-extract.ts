import { readFile } from 'node:fs/promises';
import { getDocumentProxy, extractText } from 'unpdf';

/** Maximum PDF file size we'll attempt to extract text from (25 MB). */
export const MAX_PDF_BYTES = 25 * 1024 * 1024;

/** Maximum extracted text length returned (500 KB of text). */
export const MAX_TEXT_LENGTH = 500 * 1024;

export interface PdfExtractResult {
  text: string;
  totalPages: number;
}

/**
 * Extract text content from a PDF buffer.
 *
 * Uses `unpdf` (serverless PDF.js) to parse the PDF and return plain text.
 * Designed for non-Claude runtimes (Codex, Gemini) that lack native PDF
 * reading capability — the extracted text can be injected into the prompt.
 *
 * For Claude Code, the existing file-path + Read tool approach is preferred.
 */
export async function extractPdfTextFromBuffer(data: Uint8Array): Promise<PdfExtractResult> {
  if (data.byteLength > MAX_PDF_BYTES) {
    throw new Error(`PDF exceeds ${MAX_PDF_BYTES / (1024 * 1024)} MB size limit`);
  }

  const pdf = await getDocumentProxy(new Uint8Array(data));

  try {
    const { totalPages, text } = await extractText(pdf, { mergePages: true });

    let extracted = typeof text === 'string' ? text : (text as string[]).join('\n');

    if (extracted.length > MAX_TEXT_LENGTH) {
      extracted = extracted.slice(0, MAX_TEXT_LENGTH) + '\n[truncated]';
    }

    return { text: extracted, totalPages };
  } finally {
    pdf.destroy();
  }
}

/**
 * Extract text content from a PDF file on disk.
 *
 * Convenience wrapper that reads the file and delegates to `extractPdfTextFromBuffer`.
 */
export async function extractPdfText(filePath: string): Promise<PdfExtractResult> {
  const buffer = await readFile(filePath);
  return extractPdfTextFromBuffer(new Uint8Array(buffer));
}
