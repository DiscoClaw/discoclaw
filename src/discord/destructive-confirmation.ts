import crypto from 'node:crypto';

export type DestructiveActionShape = {
  type: string;
  [key: string]: unknown;
};

export type ActionConfirmationContext = {
  mode: 'interactive' | 'automated';
  sessionKey?: string;
  userId?: string;
  bypassDestructive?: boolean;
};

export type PendingDestructiveConfirmation = {
  token: string;
  sessionKey: string;
  userId: string;
  action: DestructiveActionShape;
  actionType: string;
  actionFingerprint: string;
  createdAt: number;
  expiresAt: number;
};

const CONFIRM_TTL_MS = 10 * 60_000;

const DESTRUCTIVE_ACTION_TYPES = new Set<string>([
  'channelDelete',
  'forumTagDelete',
  'deleteMessage',
  'bulkDelete',
  'eventDelete',
  'timeout',
  'kick',
  'ban',
]);

const pendingByToken = new Map<string, PendingDestructiveConfirmation>();
const tokenByKey = new Map<string, string>();

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return '[' + value.map((v) => stableStringify(v)).join(',') + ']';
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => JSON.stringify(k) + ':' + stableStringify(v));
  return '{' + entries.join(',') + '}';
}

function actionFingerprint(action: DestructiveActionShape): string {
  return crypto
    .createHash('sha256')
    .update(stableStringify(action))
    .digest('hex')
    .slice(0, 12);
}

function makeKey(sessionKey: string, userId: string, fingerprint: string): string {
  return `${sessionKey}:${userId}:${fingerprint}`;
}

function randomToken(): string {
  return crypto.randomBytes(4).toString('hex');
}

function uniqueRandomToken(): string {
  let token = randomToken();
  while (pendingByToken.has(token)) token = randomToken();
  return token;
}

function purgeExpired(now = Date.now()): void {
  for (const [token, pending] of pendingByToken) {
    if (pending.expiresAt > now) continue;
    pendingByToken.delete(token);
    tokenByKey.delete(makeKey(pending.sessionKey, pending.userId, pending.actionFingerprint));
  }
}

export function isDestructiveActionType(type: string): boolean {
  return DESTRUCTIVE_ACTION_TYPES.has(type);
}

export function requestDestructiveConfirmation(
  action: DestructiveActionShape,
  sessionKey: string,
  userId: string,
): PendingDestructiveConfirmation {
  purgeExpired();
  const now = Date.now();
  const fingerprint = actionFingerprint(action);
  const key = makeKey(sessionKey, userId, fingerprint);
  const existingToken = tokenByKey.get(key);
  if (existingToken) {
    const existing = pendingByToken.get(existingToken);
    if (existing && existing.expiresAt > now) {
      return existing;
    }
    tokenByKey.delete(key);
    if (existingToken) pendingByToken.delete(existingToken);
  }

  const token = uniqueRandomToken();
  const pending: PendingDestructiveConfirmation = {
    token,
    sessionKey,
    userId,
    action,
    actionType: action.type,
    actionFingerprint: fingerprint,
    createdAt: now,
    expiresAt: now + CONFIRM_TTL_MS,
  };
  pendingByToken.set(token, pending);
  tokenByKey.set(key, token);
  return pending;
}

export function consumeDestructiveConfirmation(
  token: string,
  sessionKey: string,
  userId: string,
): PendingDestructiveConfirmation | null {
  purgeExpired();
  const pending = pendingByToken.get(token);
  if (!pending) return null;
  if (pending.sessionKey !== sessionKey) return null;
  if (pending.userId !== userId) return null;

  pendingByToken.delete(token);
  tokenByKey.delete(makeKey(pending.sessionKey, pending.userId, pending.actionFingerprint));
  return pending;
}

export function describeDestructiveConfirmationRequirement(
  action: DestructiveActionShape,
  confirmation?: ActionConfirmationContext,
): { allow: true } | { allow: false; error: string } {
  if (!isDestructiveActionType(action.type)) return { allow: true };
  if (confirmation?.bypassDestructive) return { allow: true };

  if (confirmation?.mode !== 'interactive') {
    return {
      allow: false,
      error: `Blocked destructive action "${action.type}": destructive actions require interactive user confirmation and are disabled in automated flows.`,
    };
  }

  const sessionKey = confirmation.sessionKey?.trim();
  const userId = confirmation.userId?.trim();
  if (!sessionKey || !userId) {
    return {
      allow: false,
      error: `Blocked destructive action "${action.type}": missing confirmation context.`,
    };
  }

  const pending = requestDestructiveConfirmation(action, sessionKey, userId);
  return {
    allow: false,
    error: `Destructive action "${action.type}" requires confirmation. Run \`!confirm ${pending.token}\` in this channel within 10 minutes to execute.`,
  };
}

export function _resetDestructiveConfirmationForTest(): void {
  pendingByToken.clear();
  tokenByKey.clear();
}
