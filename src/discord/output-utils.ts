export function splitDiscord(text: string, limit = 2000): string[] {
  // Minimal fence-safe markdown chunking.
  const normalized = text.replace(/\r\n?/g, '\n');
  if (normalized.length <= limit) return [normalized];

  const rawLines = normalized.split('\n');
  const chunks: string[] = [];

  let cur = '';
  let inFence = false;
  let fenceHeader = '```';

  const effectiveCurLen = () => {
    if (cur.length > 0) return cur.length;
    return inFence ? fenceHeader.length : 0;
  };

  const remainingRoom = () => {
    const base = effectiveCurLen();
    const sep = base > 0 ? 1 : 0;
    return Math.max(0, limit - base - sep);
  };

  const ensureFenceOpen = () => {
    if (cur) return;
    if (inFence) cur = `${fenceHeader}`;
  };

  const flush = () => {
    if (!cur) return;
    if (inFence && !cur.trimEnd().endsWith('```')) {
      const close = '\n```';
      if (cur.length + close.length <= limit) {
        cur += close;
      }
    }
    chunks.push(cur);
    cur = '';
  };

  const appendLine = (line: string) => {
    ensureFenceOpen();
    const sep = cur.length > 0 ? '\n' : '';
    cur += sep + line;
  };

  for (const line of rawLines) {
    const curLen = effectiveCurLen();
    const nextLen = (curLen ? curLen + 1 : 0) + line.length;
    if (nextLen > limit && cur) {
      flush();
    }

    if (line.length > remainingRoom()) {
      let rest = line;
      while (rest.length > 0) {
        const room = Math.max(1, remainingRoom());
        const take = rest.slice(0, room);
        appendLine(take);
        rest = rest.slice(room);
        if (rest.length > 0) {
          flush();
        }
      }
    } else {
      appendLine(line);
    }

    const trimmed = line.trimStart();
    if (trimmed.startsWith('```')) {
      if (!inFence) {
        inFence = true;
        fenceHeader = trimmed.trimEnd();
      } else {
        inFence = false;
        fenceHeader = '```';
      }
    }

    if (inFence && cur.length >= limit - 8) {
      flush();
    }
  }

  flush();
  return chunks.filter((c) => c.trim().length > 0);
}

export function truncateCodeBlocks(text: string, maxLines = 20): string {
  // Truncate fenced code blocks that exceed maxLines, keeping first/last lines.
  return text.replace(/^([ \t]*```[^\n]*\n)([\s\S]*?)(^[ \t]*```[ \t]*$)/gm, (_match, open: string, body: string, close: string) => {
    const lines = body.split('\n');
    const trimmedLines = lines.length > 0 && lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
    if (trimmedLines.length <= maxLines) return open + body + close;

    const keepTop = Math.ceil(maxLines / 2);
    const keepBottom = Math.floor(maxLines / 2);
    const omitted = trimmedLines.length - keepTop - keepBottom;
    const top = trimmedLines.slice(0, keepTop);
    const bottom = trimmedLines.slice(trimmedLines.length - keepBottom);
    return (
      open +
      top.join('\n') + '\n' +
      `... (${omitted} lines omitted)\n` +
      bottom.join('\n') + '\n' +
      close
    );
  });
}

export function renderDiscordTail(text: string, maxLines = 8, maxWidth = 56): string {
  const normalized = String(text ?? '').replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n').filter((l) => l.length > 0);
  const tail = lines.slice(-maxLines).map((l) =>
    l.length > maxWidth ? l.slice(0, maxWidth - 1) + '\u2026' : l,
  );
  while (tail.length < maxLines) tail.unshift('\u200b');
  const safe = tail.join('\n').replace(/```/g, '``\\`');
  return `\`\`\`text\n${safe}\n\`\`\``;
}

export function renderActivityTail(label: string, maxLines = 8, maxWidth = 56): string {
  const lines: string[] = [];
  for (let i = 0; i < maxLines; i++) lines.push('\u200b');
  const safe = lines.join('\n').replace(/```/g, '``\\`');
  // Use first non-empty line; fixes existing newline-only edge case
  const singleLine = label.split('\n').find((l) => l.length > 0) ?? '';
  const truncated = singleLine.length > maxWidth
    ? singleLine.slice(0, maxWidth - 1) + '\u2026'
    : singleLine;
  // Escape markdown chars that would break bold context or create formatting artifacts
  const safeLabel = truncated.replace(/([*_~|`\\[\]])/g, '\\$1');
  return `**${safeLabel}**\n\`\`\`text\n${safe}\n\`\`\``;
}

export function thinkingLabel(tick: number): string {
  const dotCounts = [1, 2, 3, 0];
  return 'Thinking' + '.'.repeat(dotCounts[tick % 4]);
}

export function selectStreamingOutput(opts: {
  deltaText: string;
  activityLabel: string;
  finalText: string;
  statusTick: number;
}): string {
  if (opts.deltaText) {
    const label = thinkingLabel(opts.statusTick);
    return `**${label}**\n${renderDiscordTail(opts.deltaText)}`;
  }
  if (opts.activityLabel) return renderActivityTail(opts.activityLabel);
  if (opts.finalText) return renderDiscordTail(opts.finalText);
  return renderActivityTail(thinkingLabel(opts.statusTick));
}
