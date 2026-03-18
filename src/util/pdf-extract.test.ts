import { afterAll, describe, expect, it } from 'vitest';
import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { extractPdfText, extractPdfTextFromBuffer, MAX_PDF_BYTES, MAX_TEXT_LENGTH } from './pdf-extract.js';

/** Build a minimal valid single-page PDF containing the given text. */
function buildMinimalPdf(content: string): Buffer {
  const stream = `BT /F1 12 Tf 100 700 Td (${content}) Tj ET`;
  const lines = [
    '%PDF-1.0',
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
    `3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>endobj`,
    '4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj',
    `5 0 obj<</Length ${stream.length}>>stream`,
    stream,
    'endstream endobj',
  ];
  const body = lines.join('\n');
  const xref = [
    'xref',
    '0 6',
    '0000000000 65535 f ',
    '0000000009 00000 n ',
    '0000000058 00000 n ',
    '0000000115 00000 n ',
    '0000000266 00000 n ',
    '0000000340 00000 n ',
    `trailer<</Size 6/Root 1 0 R>>`,
    'startxref',
    String(body.length + 1),
    '%%EOF',
  ];
  return Buffer.from(body + '\n' + xref.join('\n'));
}

function tmpPath(name: string): string {
  return join(tmpdir(), `pdf-extract-test-${Date.now()}-${name}`);
}

describe('extractPdfText', () => {
  const cleanupPaths: string[] = [];

  afterAll(async () => {
    await Promise.all(cleanupPaths.map(p => unlink(p).catch(() => {})));
  });

  it('extracts text from a valid single-page PDF', async () => {
    const filePath = tmpPath('hello.pdf');
    cleanupPaths.push(filePath);
    await writeFile(filePath, buildMinimalPdf('Hello World'));

    const result = await extractPdfText(filePath);

    expect(result.totalPages).toBe(1);
    expect(result.text).toContain('Hello World');
  });

  it('returns totalPages count', async () => {
    const filePath = tmpPath('pages.pdf');
    cleanupPaths.push(filePath);
    await writeFile(filePath, buildMinimalPdf('Page content'));

    const result = await extractPdfText(filePath);

    expect(result.totalPages).toBeGreaterThanOrEqual(1);
    expect(typeof result.text).toBe('string');
  });

  it('throws on non-existent file', async () => {
    await expect(extractPdfText('/tmp/does-not-exist-pdf-extract-test.pdf')).rejects.toThrow();
  });

  it('throws on corrupt/non-PDF data', async () => {
    const filePath = tmpPath('corrupt.pdf');
    cleanupPaths.push(filePath);
    await writeFile(filePath, Buffer.from('this is not a pdf'));

    await expect(extractPdfText(filePath)).rejects.toThrow();
  });
});

describe('extractPdfTextFromBuffer', () => {
  it('extracts text from a valid PDF buffer', async () => {
    const pdf = buildMinimalPdf('Buffer test');
    const result = await extractPdfTextFromBuffer(new Uint8Array(pdf));

    expect(result.totalPages).toBe(1);
    expect(result.text).toContain('Buffer test');
  });

  it('throws when buffer exceeds size limit', async () => {
    // Create a Uint8Array that exceeds MAX_PDF_BYTES
    // We don't actually need valid PDF content — the size check happens before parsing
    const oversized = new Uint8Array(MAX_PDF_BYTES + 1);

    await expect(extractPdfTextFromBuffer(oversized)).rejects.toThrow('size limit');
  });

  it('throws on corrupt/non-PDF buffer', async () => {
    const garbage = new Uint8Array(Buffer.from('not a pdf file at all'));

    await expect(extractPdfTextFromBuffer(garbage)).rejects.toThrow();
  });

  it('exports expected constants', () => {
    expect(MAX_PDF_BYTES).toBe(25 * 1024 * 1024);
    expect(MAX_TEXT_LENGTH).toBe(500 * 1024);
  });
});
