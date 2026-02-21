export function taskActionsPromptSection(): string {
  return `### Task Tracking

**taskCreate** — Create a new task:
\`\`\`
<discord-action>{"type":"taskCreate","title":"Task title","description":"Optional details","priority":2,"tags":"feature,work"}</discord-action>
\`\`\`
- \`title\` (required): Task title.
- \`description\` (optional): Detailed description.
- \`priority\` (optional): 0-4 (0=highest, default 2).
- \`tags\` (optional): Comma-separated labels/tags.

**taskUpdate** — Update a task's fields:
\`\`\`
<discord-action>{"type":"taskUpdate","taskId":"ws-001","status":"in_progress","priority":1}</discord-action>
\`\`\`
- \`taskId\` (required): Task ID.
- \`title\`, \`description\`, \`priority\`, \`status\` (optional): Fields to update.

**taskClose** — Close a task:
\`\`\`
<discord-action>{"type":"taskClose","taskId":"ws-001","reason":"Done"}</discord-action>
\`\`\`

**taskShow** — Show task details:
\`\`\`
<discord-action>{"type":"taskShow","taskId":"ws-001"}</discord-action>
\`\`\`

**taskList** — List tasks:
\`\`\`
<discord-action>{"type":"taskList","status":"open","limit":10}</discord-action>
\`\`\`
- \`status\` (optional): Filter by status (open, in_progress, blocked, closed, all).
- \`label\` (optional): Filter by label.
- \`limit\` (optional): Max results.

**taskSync** — Run full sync between local task store and Discord threads:
\`\`\`
<discord-action>{"type":"taskSync"}</discord-action>
\`\`\`

**tagMapReload** — Reload tag map from disk (hot-reload without restart):
\`\`\`
<discord-action>{"type":"tagMapReload"}</discord-action>
\`\`\`

#### Task Quality Guidelines
- **Title**: imperative mood, specific, <60 chars. Good: "Add retry logic to webhook handler", "Plan March Denver trip". Bad: "fix stuff".
- **Description** should answer what/why/scope. Use markdown for structure. Include what "done" looks like for larger tasks.
- **Priority**: P0=urgent, P1=important, P2=normal (default), P3=nice-to-have, P4=someday.
- If the user explicitly asks to create a task, always create it.
- Apply the same description quality standards when using taskUpdate to backfill details.

#### Cross-Task References
When interacting with another task, always use task actions with its task ID, not channel-name based messaging actions:
- **Read task content**: \`taskShow <id>\`
- **Update a task**: \`taskUpdate <id>\`
- **Close a task**: \`taskClose <id>\`
- **Find tasks**: \`taskList\` (filter by status or label)
- **Reconcile Discord threads**: \`taskSync\``;
}
