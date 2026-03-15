import process from 'node:process';

function getArgValue(flag: string): string | null {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return null;
  return process.argv[idx + 1] ?? null;
}

function requireArg(name: string, v: string | null): string {
  if (v && v.trim()) return v.trim();
  throw new Error(`Missing required arg: ${name}`);
}

// Discord permission bitfield (https://discord.com/developers/docs/topics/permissions).
// Use BigInt to avoid footguns with larger bits like SEND_MESSAGES_IN_THREADS (1<<38).
const PERM = {
  ADD_REACTIONS: 1n << 6n,
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  MANAGE_MESSAGES: 1n << 13n,
  EMBED_LINKS: 1n << 14n,
  ATTACH_FILES: 1n << 15n,
  READ_MESSAGE_HISTORY: 1n << 16n,
  MANAGE_CHANNELS: 1n << 4n,
  MANAGE_GUILD: 1n << 5n,
  MANAGE_WEBHOOKS: 1n << 29n,
  MANAGE_THREADS: 1n << 34n,
  CREATE_PUBLIC_THREADS: 1n << 35n,
  CREATE_PRIVATE_THREADS: 1n << 36n,
  SEND_MESSAGES_IN_THREADS: 1n << 38n,
  ADMINISTRATOR: 1n << 3n,
} as const;

type Profile = 'minimal' | 'threads' | 'moderator' | 'admin';

function profilePerms(profile: Profile): bigint {
  // Baseline: can read/respond in channels + threads.
  const minimal =
    PERM.VIEW_CHANNEL |
    PERM.SEND_MESSAGES |
    PERM.READ_MESSAGE_HISTORY |
    PERM.SEND_MESSAGES_IN_THREADS;

  switch (profile) {
    case 'minimal':
      return minimal;
    case 'threads':
      // For creating/archiving/deleting threads.
      return (
        minimal |
        PERM.CREATE_PUBLIC_THREADS |
        PERM.CREATE_PRIVATE_THREADS |
        PERM.MANAGE_THREADS
      );
    case 'moderator':
      // Broad but not full admin: manage channels/threads/messages, useful for "ops" style bots.
      return (
        minimal |
        PERM.CREATE_PUBLIC_THREADS |
        PERM.CREATE_PRIVATE_THREADS |
        PERM.MANAGE_THREADS |
        PERM.MANAGE_MESSAGES |
        PERM.MANAGE_CHANNELS |
        PERM.MANAGE_WEBHOOKS |
        PERM.EMBED_LINKS |
        PERM.ATTACH_FILES |
        PERM.ADD_REACTIONS
      );
    case 'admin':
      // Full power. Prefer 'moderator' unless you explicitly want Administrator.
      return PERM.ADMINISTRATOR;
  }
}

function parsePerms(permsRaw: string): bigint {
  const v = permsRaw.trim();
  if (!v) throw new Error('Invalid --perms');
  // Allow 0x... or decimal.
  const perms = BigInt(v);
  if (perms < 0n) throw new Error('Invalid --perms');
  return perms;
}

const clientId = requireArg('--client-id', getArgValue('--client-id'));
const permsRaw = getArgValue('--perms');
const profileRaw = getArgValue('--profile');
const guildId = getArgValue('--guild-id');
const disableGuildSelect = getArgValue('--disable-guild-select') === '1';
const appCommands = getArgValue('--app-commands') === '1';
const scopeRaw = getArgValue('--scope');
const noWarn = getArgValue('--no-warn') === '1';

const profile = (profileRaw?.trim() as Profile | undefined) ?? 'minimal';
if (
  profileRaw &&
  profile !== 'minimal' &&
  profile !== 'threads' &&
  profile !== 'moderator' &&
  profile !== 'admin'
) {
  throw new Error('Invalid --profile (use minimal|threads|moderator|admin)');
}

if (!noWarn && !profileRaw && !permsRaw) {
  process.stderr.write(
    [
      'Note: no --profile or --perms provided; defaulting to --profile minimal.',
      'Profiles: minimal | threads | moderator | admin',
      'Tip: pass --profile explicitly to avoid accidental privilege mismatches.',
      '',
    ].join('\n'),
  );
}

const perms = permsRaw ? parsePerms(permsRaw) : profilePerms(profile);

const scopes = (() => {
  if (scopeRaw && scopeRaw.trim()) {
    // Accept comma-separated or space-separated input.
    return scopeRaw
      .split(/[,\s]+/g)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const s = ['bot'];
  if (appCommands) s.push('applications.commands');
  return s;
})();

const params = new URLSearchParams({
  client_id: clientId,
  scope: scopes.join(' '),
  permissions: String(perms),
});
if (guildId) params.set('guild_id', guildId);
if (disableGuildSelect) params.set('disable_guild_select', 'true');

const url = `https://discord.com/oauth2/authorize?${params.toString()}`;
process.stdout.write(url + '\n');
