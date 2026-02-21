import { TaskStore } from './store.js';
import { createTaskService } from './service.js';
import { isTaskStatus, type TaskStatus } from './types.js';
import { resolveTaskDataPath } from './path-defaults.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function envOpt(name: string): string | undefined {
  const v = (process.env[name] ?? '').trim();
  return v || undefined;
}

/**
 * Extract the value for a named flag from an args array.
 * Supports both `--flag value` and `--flag=value` forms.
 */
function argValue(args: string[], ...flags: string[]): string | undefined {
  for (const flag of flags) {
    // --flag value
    const idx = args.indexOf(flag);
    if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
    // --flag=value
    const prefix = `${flag}=`;
    const hit = args.find((a) => a.startsWith(prefix));
    if (hit) return hit.slice(prefix.length);
  }
  return undefined;
}

function hasFlag(args: string[], ...flags: string[]): boolean {
  return flags.some((f) => args.includes(f));
}

/** Return non-flag positional arguments (args that don't start with `-`). */
function positional(args: string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('-')) {
      // Skip the next arg if this is a value-bearing flag.
      if (!a.includes('=') && i + 1 < args.length && !args[i + 1].startsWith('-')) {
        i++;
      }
    } else {
      result.push(a);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Store factory
// ---------------------------------------------------------------------------

async function getStore(): Promise<TaskStore> {
  const dataDir = envOpt('DISCOCLAW_DATA_DIR');
  const tasksPath =
    envOpt('DISCOCLAW_TASKS_PATH') ??
    resolveTaskDataPath(dataDir, 'tasks.jsonl');

  if (!tasksPath) {
    throw new Error('DISCOCLAW_TASKS_PATH or DISCOCLAW_DATA_DIR is required');
  }

  const store = new TaskStore({ persistPath: tasksPath });
  await store.load();
  return store;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const subcommand = args[0];

  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    process.stdout.write(
      [
        'Usage: task-cli <subcommand> [args]',
        '',
        'Subcommands:',
        '  create <title> [--description <d>] [--priority <n>] [--type <t>]',
        '                 [--owner <o>] [--assignee <o>] [--labels <l1,l2>]',
        '  quick  <title>                       — create and output only the ID',
        '  get    <id>                          — show a single task as a JSON array',
        '  list   [--status <s>] [--label <l>] [--limit <n>] [--all]',
        '  update <id> [--title <t>] [--description <d>] [--priority <n>]',
        '              [--status <s>] [--owner <o>] [--assignee <o>] [--external-ref <r>]',
        '  close  <id> [--reason <r>]',
        '  label-add <id> <label>',
        '',
        'Env vars: DISCOCLAW_TASKS_PATH, DISCOCLAW_DATA_DIR',
      ].join('\n') + '\n',
    );
    process.exit(0);
  }

  const rest = args.slice(1);

  switch (subcommand) {
    case 'create': {
      const pos = positional(rest);
      const title = pos[0];
      if (!title) throw new Error('create requires a title');

      const description = argValue(rest, '--description', '-d');
      const priorityStr = argValue(rest, '--priority', '-p');
      const issueType = argValue(rest, '--type', '-t');
      const owner = argValue(rest, '--owner', '--assignee');
      const labelsStr = argValue(rest, '--labels');
      const labels = labelsStr
        ? labelsStr.split(',').map((l) => l.trim()).filter(Boolean)
        : undefined;
      const priority = priorityStr != null ? Number(priorityStr) : undefined;

      const store = await getStore();
      const taskService = createTaskService(store);
      const task = taskService.create({
        title,
        ...(description !== undefined && { description }),
        ...(priority != null && Number.isFinite(priority) && { priority }),
        ...(issueType !== undefined && { issueType }),
        ...(owner !== undefined && { owner }),
        ...(labels?.length && { labels }),
      });

      await store.flush();
      process.stdout.write(JSON.stringify(task) + '\n');
      break;
    }

    case 'quick': {
      const title = rest[0];
      if (!title || title.startsWith('-')) throw new Error('quick requires a title');

      const store = await getStore();
      const taskService = createTaskService(store);
      const task = taskService.create({ title });
      await store.flush();
      process.stdout.write(task.id + '\n');
      break;
    }

    case 'get':
    case 'show': {
      const id = rest[0];
      if (!id) throw new Error(`${subcommand} requires an id`);

      const store = await getStore();
      const task = store.get(id);
      if (!task) {
        process.stderr.write(`not found: ${id}\n`);
        process.exit(1);
      }
      // Output as a JSON array to match the shape of bdShow / bd show --json.
      process.stdout.write(JSON.stringify([task]) + '\n');
      break;
    }

    case 'list': {
      const status = argValue(rest, '--status', '-s');
      const label = argValue(rest, '--label');
      const limitStr = argValue(rest, '--limit');
      const limit = limitStr != null ? Number(limitStr) : undefined;
      const all = hasFlag(rest, '--all');

      const store = await getStore();
      const tasks = store.list({
        status: all ? 'all' : (status ?? undefined),
        label: label ?? undefined,
        limit: limit != null && Number.isFinite(limit) ? limit : undefined,
      });

      process.stdout.write(JSON.stringify(tasks) + '\n');
      break;
    }

    case 'update': {
      const pos = positional(rest);
      const id = pos[0];
      if (!id) throw new Error('update requires an id');

      const title = argValue(rest, '--title');
      const description = argValue(rest, '--description', '-d');
      const priorityStr = argValue(rest, '--priority', '-p');
      const status = argValue(rest, '--status', '-s');
      const owner = argValue(rest, '--owner', '--assignee');
      const externalRef = argValue(rest, '--external-ref');
      const priority = priorityStr != null ? Number(priorityStr) : undefined;

      if (status && !isTaskStatus(status)) {
        throw new Error(
          `invalid status: ${status}. Must be one of: open, in_progress, blocked, closed`,
        );
      }

      const validStatus: TaskStatus | undefined = status && isTaskStatus(status) ? status : undefined;

      const store = await getStore();
      const taskService = createTaskService(store);
      taskService.update(id, {
        ...(title !== undefined && { title }),
        ...(description !== undefined && { description }),
        ...(priority != null && Number.isFinite(priority) && { priority }),
        ...(validStatus !== undefined && { status: validStatus }),
        ...(owner !== undefined && { owner }),
        ...(externalRef !== undefined && { externalRef }),
      });

      await store.flush();
      process.stdout.write(JSON.stringify(store.get(id)) + '\n');
      break;
    }

    case 'close': {
      const pos = positional(rest);
      const id = pos[0];
      if (!id) throw new Error('close requires an id');

      const reason = argValue(rest, '--reason', '-r');
      const store = await getStore();
      const taskService = createTaskService(store);
      taskService.close(id, reason ?? undefined);
      await store.flush();
      process.stdout.write(JSON.stringify(store.get(id)) + '\n');
      break;
    }

    case 'label-add': {
      const id = rest[0];
      const label = rest[1];
      if (!id || !label) throw new Error('label-add requires an id and a label');

      const store = await getStore();
      const taskService = createTaskService(store);
      taskService.addLabel(id, label);
      await store.flush();
      process.stdout.write(JSON.stringify(store.get(id)) + '\n');
      break;
    }

    default:
      throw new Error(`unknown subcommand: ${subcommand}`);
  }
}

// Only execute when invoked directly as a script, not when imported as a module.
if (import.meta.url === new URL(process.argv[1] ?? '', 'file:').href) {
  await main().catch((err) => {
    process.stderr.write((err instanceof Error ? err.message : String(err)) + '\n');
    process.exit(1);
  });
}
