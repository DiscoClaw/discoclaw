export type MarkdownCodeRange = {
  start: number;
  end: number;
};

function mergeRanges(ranges: MarkdownCodeRange[]): MarkdownCodeRange[] {
  if (ranges.length <= 1) return ranges;
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: MarkdownCodeRange[] = [sorted[0]!];
  for (let i = 1; i < sorted.length; i++) {
    const prev = merged[merged.length - 1]!;
    const cur = sorted[i]!;
    if (cur.start <= prev.end) {
      prev.end = Math.max(prev.end, cur.end);
    } else {
      merged.push(cur);
    }
  }
  return merged;
}

function collectIndentedCodeRanges(text: string, start: number, end: number, out: MarkdownCodeRange[]): void {
  let lineStart = start;
  let blockStart = -1;
  let blockEnd = -1;

  while (lineStart <= end) {
    const nl = text.indexOf('\n', lineStart);
    const hasNl = nl !== -1 && nl < end;
    const lineEnd = hasNl ? nl : end;
    const lineEndWithNl = hasNl ? nl + 1 : end;
    const line = text.slice(lineStart, lineEnd);
    const isBlank = /^[ \t]*$/.test(line);
    const isIndented = /^(?: {4,}|\t)/.test(line);

    if (blockStart === -1) {
      if (isIndented && !isBlank) {
        blockStart = lineStart;
        blockEnd = lineEndWithNl;
      }
    } else if (isIndented || isBlank) {
      if (isIndented) blockEnd = lineEndWithNl;
    } else {
      out.push({ start: blockStart, end: blockEnd });
      blockStart = -1;
      blockEnd = -1;
    }

    if (!hasNl) break;
    lineStart = lineEndWithNl;
  }

  if (blockStart !== -1) {
    out.push({ start: blockStart, end: blockEnd });
  }
}

function collectInlineCodeRanges(text: string, start: number, end: number, out: MarkdownCodeRange[]): void {
  let i = start;
  let inInline = false;
  let inlineTicks = 0;
  let inlineStart = -1;
  while (i < end) {
    if (text[i] !== '`') {
      i++;
      continue;
    }
    let ticks = 1;
    while (i + ticks < end && text[i + ticks] === '`') ticks++;
    if (!inInline) {
      inInline = true;
      inlineTicks = ticks;
      inlineStart = i;
    } else if (ticks === inlineTicks) {
      out.push({ start: inlineStart, end: i + ticks });
      inInline = false;
      inlineTicks = 0;
      inlineStart = -1;
    }
    i += ticks;
  }
}

export function computeMarkdownCodeRanges(text: string): MarkdownCodeRange[] {
  const ranges: MarkdownCodeRange[] = [];

  let inFence = false;
  let fenceChar = '';
  let fenceLen = 0;
  let fenceStart = 0;
  let lineStart = 0;
  while (lineStart <= text.length) {
    const nl = text.indexOf('\n', lineStart);
    const hasNl = nl !== -1;
    const lineEnd = hasNl ? nl : text.length;
    const lineEndWithNl = hasNl ? nl + 1 : text.length;
    const line = text.slice(lineStart, lineEnd);
    if (!inFence) {
      const open = line.match(/^[ \t]*(`{3,}|~{3,})/);
      if (open) {
        inFence = true;
        fenceChar = open[1]![0]!;
        fenceLen = open[1]!.length;
        fenceStart = lineStart;
      }
    } else {
      const closeRe = new RegExp(`^[ \\t]*\\${fenceChar}{${fenceLen},}[ \\t]*$`);
      if (closeRe.test(line)) {
        ranges.push({ start: fenceStart, end: lineEndWithNl });
        inFence = false;
        fenceChar = '';
        fenceLen = 0;
      }
    }
    if (!hasNl) break;
    lineStart = lineEndWithNl;
  }
  if (inFence) {
    ranges.push({ start: fenceStart, end: text.length });
  }

  const mergedFence = mergeRanges(ranges);
  let segStart = 0;
  for (const fence of mergedFence) {
    if (segStart < fence.start) {
      collectIndentedCodeRanges(text, segStart, fence.start, ranges);
    }
    segStart = fence.end;
  }
  if (segStart < text.length) {
    collectIndentedCodeRanges(text, segStart, text.length, ranges);
  }

  const mergedBlock = mergeRanges(ranges);
  segStart = 0;
  for (const block of mergedBlock) {
    if (segStart < block.start) {
      collectInlineCodeRanges(text, segStart, block.start, ranges);
    }
    segStart = block.end;
  }
  if (segStart < text.length) {
    collectInlineCodeRanges(text, segStart, text.length, ranges);
  }

  return mergeRanges(ranges);
}
