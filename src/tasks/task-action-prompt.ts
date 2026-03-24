export function taskActionsPromptSection(): string {
  return `### Task Tracking

**taskCreate** — \`{"type":"taskCreate","title":"Add retry logic","description":"details","priority":2,"tags":"feature,work"}\`
\`title\` required. \`description\`, \`priority\` (0–4, default 2), \`tags\` (comma-sep) optional.

**taskUpdate** — \`{"type":"taskUpdate","taskId":"ws-001","status":"in_progress","priority":1}\`
\`taskId\` required. \`title\`, \`description\`, \`priority\`, \`status\` optional.

**taskClose** — \`{"type":"taskClose","taskId":"ws-001","reason":"Done"}\`

**taskShow** — \`{"type":"taskShow","taskId":"ws-001"}\`

**taskList** — \`{"type":"taskList","status":"open","limit":10}\`
\`status\` (open/in_progress/blocked/closed/all), \`label\`, \`limit\` optional.

**taskSync** — \`{"type":"taskSync"}\` — full local↔Discord sync.

**tagMapReload** — \`{"type":"tagMapReload"}\`

Quality: title in imperative mood, <60 chars. Priority: P0=urgent, P1=important, P2=normal, P3=nice-to-have, P4=someday. Description max 1900 chars.
Cross-task refs: use taskShow/taskUpdate/taskClose with task IDs, not messaging actions.`;
}
