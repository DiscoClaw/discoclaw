type JsonExtractOptions = {
  arrayOnly?: boolean;
  objectOnly?: boolean;
};

type FencedBlock = {
  lang: string;
  body: string;
};

function isAllowedStart(ch: string, opts: JsonExtractOptions): boolean {
  if (opts.arrayOnly) return ch === '[';
  if (opts.objectOnly) return ch === '{';
  return ch === '[' || ch === '{';
}

function parseBalancedJsonCandidate(raw: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]!;

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{' || ch === '[') {
      depth++;
      continue;
    }

    if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) {
        return raw.slice(start, i + 1);
      }
      if (depth < 0) return null;
    }
  }

  return null;
}

function extractFromText(raw: string, opts: JsonExtractOptions): string | null {
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (!isAllowedStart(ch, opts)) continue;

    const candidate = parseBalancedJsonCandidate(raw, i);
    if (!candidate) continue;

    try {
      const parsed = JSON.parse(candidate);
      if (opts.arrayOnly && !Array.isArray(parsed)) continue;
      if (opts.objectOnly && (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object')) {
        continue;
      }
      return candidate;
    } catch {
      // Keep scanning for the next candidate.
    }
  }

  return null;
}

function extractFencedBlocks(raw: string): FencedBlock[] {
  const blocks: FencedBlock[] = [];
  let cursor = 0;

  while (cursor < raw.length) {
    const open = raw.indexOf('```', cursor);
    if (open === -1) break;

    const langLineEnd = raw.indexOf('\n', open + 3);
    if (langLineEnd === -1) break;

    const lang = raw.slice(open + 3, langLineEnd).trim().toLowerCase();
    const close = raw.indexOf('```', langLineEnd + 1);
    if (close === -1) break;

    blocks.push({
      lang,
      body: raw.slice(langLineEnd + 1, close),
    });
    cursor = close + 3;
  }

  return blocks;
}

function isJsonFenceLanguage(lang: string): boolean {
  if (!lang) return true;
  return lang === 'json' || lang === 'jsonc' || lang === 'javascript' || lang === 'js';
}

export function extractFirstJsonValue(raw: string, opts: JsonExtractOptions = {}): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const fencedBlocks = extractFencedBlocks(trimmed);
  for (const block of fencedBlocks) {
    if (!isJsonFenceLanguage(block.lang)) continue;
    const fromFence = extractFromText(block.body, opts);
    if (fromFence) return fromFence;
  }

  return extractFromText(trimmed, opts);
}
