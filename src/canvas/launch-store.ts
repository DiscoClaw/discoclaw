import crypto from 'node:crypto';
import { createSignedTokenSigner, type SignedTokenSigner } from './tokens.js';

export type CanvasLaunchContext = {
  userId: string;
  channelId: string;
  guildId?: string | null;
};

export type CanvasLaunchTarget =
  | { type: 'artifact'; artifactId: string }
  | { type: 'app'; appName: string };

export type PendingLaunchEntry = {
  target: CanvasLaunchTarget;
  createdAt: number;
  expiresAt: number;
};

type BoundSessionClaims = {
  kind: 'bound-session';
  userId: string;
  channelId: string;
  guildId: string | null;
  targetType: CanvasLaunchTarget['type'];
  targetId: string;
  iat: number;
  exp: number;
};

export type BoundCanvasSession = CanvasLaunchContext & {
  target: CanvasLaunchTarget;
  iat: number;
  exp: number;
};

export type LaunchResolution =
  | { target: CanvasLaunchTarget; boundSessionToken: string; source: 'pending' | 'bound-session' };

export type LaunchStoreOptions = {
  pendingTtlMs: number;
  boundSessionTtlMs: number;
  now?: () => number;
  signer?: SignedTokenSigner;
  launchRefSecret?: string | Buffer;
};

export class LaunchStore {
  private readonly pending = new Map<string, PendingLaunchEntry>();
  private readonly pendingTtlMs: number;
  private readonly boundSessionTtlMs: number;
  private readonly now: () => number;
  private readonly signer: SignedTokenSigner;
  private readonly launchRefSecret: Buffer;
  private readonly instanceTagValue: string;

  constructor(opts: LaunchStoreOptions) {
    this.pendingTtlMs = opts.pendingTtlMs;
    this.boundSessionTtlMs = opts.boundSessionTtlMs;
    this.now = opts.now ?? (() => Date.now());
    this.signer = opts.signer ?? createSignedTokenSigner();
    this.launchRefSecret = Buffer.isBuffer(opts.launchRefSecret)
      ? opts.launchRefSecret
      : Buffer.from(opts.launchRefSecret ?? crypto.randomBytes(32).toString('hex'), 'utf8');
    this.instanceTagValue = crypto.createHash('sha256')
      .update(this.launchRefSecret)
      .digest('base64url')
      .slice(0, 10);
  }

  instanceTag(): string {
    return this.instanceTagValue;
  }

  createArtifactLaunchRef(artifactId: string): string {
    return this.createLaunchRef('a', artifactId);
  }

  createAppLaunchRef(appName: string): string {
    return this.createLaunchRef('p', appName);
  }

  parseLaunchRef(token: string): CanvasLaunchTarget | null {
    const [kind, targetId, signature, extra] = String(token ?? '').split('.');
    if (!kind || !targetId || !signature || extra) return null;
    const expected = crypto.createHmac('sha256', this.launchRefSecret)
      .update(`${kind}:${targetId}`)
      .digest('base64url')
      .slice(0, 12);
    if (signature !== expected) return null;
    if (kind === 'a') return { type: 'artifact', artifactId: targetId };
    if (kind === 'p') return { type: 'app', appName: targetId };
    return null;
  }

  parseArtifactLaunchRef(token: string): { artifactId: string } | null {
    const parsed = this.parseLaunchRef(token);
    return parsed?.type === 'artifact' ? { artifactId: parsed.artifactId } : null;
  }

  registerPending(context: CanvasLaunchContext, target: CanvasLaunchTarget | string): PendingLaunchEntry {
    this.purgeExpiredPending();
    const now = this.now();
    const normalizedTarget = this.normalizeTarget(target);
    const entry: PendingLaunchEntry = {
      target: normalizedTarget,
      createdAt: now,
      expiresAt: now + this.pendingTtlMs,
    };
    this.pending.set(this.contextKey(context), entry);
    return entry;
  }

  resolveCurrent(context: CanvasLaunchContext, boundSessionToken?: string | null): LaunchResolution | null {
    this.purgeExpiredPending();
    const key = this.contextKey(context);
    const pending = this.pending.get(key);
    if (pending) {
      // Do NOT delete the pending entry here. Pop-out and embedded modes may
      // each call resolveCurrent independently, so the entry must survive for
      // its full TTL. Natural expiry via purgeExpiredPending() handles cleanup.
      const nextToken = this.createBoundSessionToken(context, pending.target);
      return {
        target: pending.target,
        boundSessionToken: nextToken,
        source: 'pending',
      };
    }

    const bound = boundSessionToken ? this.verifyBoundSession(boundSessionToken, context) : null;
    if (!bound) return null;
    return {
      target: bound.target,
      boundSessionToken: this.createBoundSessionToken(bound, bound.target),
      source: 'bound-session',
    };
  }

  peekByActivity(channelId: string, guildId: string | null): { userId: string } | null {
    this.purgeExpiredPending();
    const normalizedGuildId = guildId ?? '';
    for (const [key] of this.pending.entries()) {
      const parts = key.split(':');
      const keyChannelId = parts[1];
      const keyGuildId = parts[2] ?? '';
      if (keyChannelId === channelId && keyGuildId === normalizedGuildId) {
        return { userId: parts[0] };
      }
    }
    return null;
  }

  resolveByActivity(channelId: string, guildId: string | null): (LaunchResolution & { userId: string }) | null {
    this.purgeExpiredPending();
    const normalizedGuildId = guildId ?? '';
    for (const [key, entry] of this.pending.entries()) {
      // Key format: "userId:channelId:guildId"
      const parts = key.split(':');
      const keyChannelId = parts[1];
      const keyGuildId = parts[2] ?? '';
      if (keyChannelId === channelId && keyGuildId === normalizedGuildId) {
        const keyUserId = parts[0];
        // Keep the pending entry alive for its full TTL (see resolveCurrent).
        const context: CanvasLaunchContext = { userId: keyUserId, channelId, guildId };
        const boundSessionToken = this.createBoundSessionToken(context, entry.target);
        return {
          target: entry.target,
          boundSessionToken,
          source: 'pending',
          userId: keyUserId,
        };
      }
    }
    return null;
  }

  refreshBoundSession(boundSessionToken: string, context?: CanvasLaunchContext): LaunchResolution | null {
    const bound = this.verifyBoundSession(boundSessionToken, context);
    if (!bound) return null;
    return {
      target: bound.target,
      boundSessionToken: this.createBoundSessionToken(bound, bound.target),
      source: 'bound-session',
    };
  }

  verifyBoundSession(token: string, context?: CanvasLaunchContext): BoundCanvasSession | null {
    const claims = this.signer.verify<BoundSessionClaims>(token);
    if (
      !claims
      || claims.kind !== 'bound-session'
      || typeof claims.userId !== 'string'
      || typeof claims.channelId !== 'string'
      || (claims.targetType !== 'artifact' && claims.targetType !== 'app')
      || typeof claims.targetId !== 'string'
      || typeof claims.iat !== 'number'
      || typeof claims.exp !== 'number'
    ) {
      return null;
    }
    if (claims.exp <= this.now()) return null;

    if (context) {
      const guildId = context.guildId ?? null;
      if (
        claims.userId !== context.userId
        || claims.channelId !== context.channelId
        || claims.guildId !== guildId
      ) {
        return null;
      }
    }

    return {
      userId: claims.userId,
      channelId: claims.channelId,
      guildId: claims.guildId,
      target: claims.targetType === 'artifact'
        ? { type: 'artifact', artifactId: claims.targetId }
        : { type: 'app', appName: claims.targetId },
      iat: claims.iat,
      exp: claims.exp,
    };
  }

  hasPending(context: CanvasLaunchContext): boolean {
    this.purgeExpiredPending();
    return this.pending.has(this.contextKey(context));
  }

  private createBoundSessionToken(context: CanvasLaunchContext, target: CanvasLaunchTarget): string {
    const now = this.now();
    return this.signer.sign<BoundSessionClaims>({
      kind: 'bound-session',
      userId: context.userId,
      channelId: context.channelId,
      guildId: context.guildId ?? null,
      targetType: target.type,
      targetId: target.type === 'artifact' ? target.artifactId : target.appName,
      iat: now,
      exp: now + this.boundSessionTtlMs,
    });
  }

  private createLaunchRef(kind: 'a' | 'p', targetId: string): string {
    const signature = crypto.createHmac('sha256', this.launchRefSecret)
      .update(`${kind}:${targetId}`)
      .digest('base64url')
      .slice(0, 12);
    return `${kind}.${targetId}.${signature}`;
  }

  private normalizeTarget(target: CanvasLaunchTarget | string): CanvasLaunchTarget {
    return typeof target === 'string'
      ? { type: 'artifact', artifactId: target }
      : target;
  }

  private purgeExpiredPending(): void {
    const now = this.now();
    for (const [key, entry] of this.pending.entries()) {
      if (entry.expiresAt <= now) this.pending.delete(key);
    }
  }

  private contextKey(context: CanvasLaunchContext): string {
    return `${context.userId}:${context.channelId}:${context.guildId ?? ''}`;
  }
}
