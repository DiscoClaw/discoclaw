import os from 'node:os';
import path from 'node:path';
import {
  createChatGptTokenProvider,
  type ChatGptTokenProvider,
} from './openai-auth.js';

type Logger = {
  debug?(...args: unknown[]): void;
};

export type CodexAppServerSessionState = {
  threadId: string;
  activeTurnId?: string;
};

export type CodexAppServerClientOpts = {
  baseUrl: string;
  authFilePath?: string;
  tokenProvider?: ChatGptTokenProvider;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  log?: Logger;
};

type TurnSteerResponse = {
  turnId?: string;
};

type SessionStatePatch = {
  threadId?: string;
  activeTurnId?: string;
};

const DEFAULT_TIMEOUT_MS = 5_000;

export function resolveCodexAuthFilePath(): string {
  return path.join(
    process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
    'auth.json',
  );
}

export class CodexAppServerClient {
  readonly authFilePath: string;

  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly log?: Logger;
  private readonly tokenProvider: ChatGptTokenProvider;
  private readonly sessions = new Map<string, CodexAppServerSessionState>();

  constructor(opts: CodexAppServerClientOpts) {
    this.baseUrl = opts.baseUrl.endsWith('/') ? opts.baseUrl : `${opts.baseUrl}/`;
    this.authFilePath = opts.authFilePath ?? resolveCodexAuthFilePath();
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.log = opts.log;
    this.tokenProvider = opts.tokenProvider ?? createChatGptTokenProvider({
      authFilePath: this.authFilePath,
      log: {
        debug: (...args: unknown[]) => this.log?.debug?.(...args),
        warn: () => {},
        error: () => {},
      },
    });
  }

  getSessionState(sessionKey: string): CodexAppServerSessionState | undefined {
    const state = this.sessions.get(sessionKey);
    return state ? { ...state } : undefined;
  }

  setThread(sessionKey: string, threadId: string): void {
    this.mergeSessionState(sessionKey, { threadId });
  }

  noteThreadStarted(sessionKey: string, threadId: string): void {
    this.setThread(sessionKey, threadId);
  }

  setActiveTurn(sessionKey: string, threadId: string, turnId: string): void {
    this.mergeSessionState(sessionKey, { threadId, activeTurnId: turnId });
  }

  noteTurnStarted(sessionKey: string, threadId: string, turnId: string): void {
    this.setActiveTurn(sessionKey, threadId, turnId);
  }

  clearActiveTurn(sessionKey: string, turnId?: string): void {
    const state = this.sessions.get(sessionKey);
    if (!state) return;
    if (turnId && state.activeTurnId !== turnId) return;
    this.sessions.set(sessionKey, { threadId: state.threadId });
  }

  noteTurnCompleted(sessionKey: string, turnId?: string): void {
    this.clearActiveTurn(sessionKey, turnId);
  }

  clearSession(sessionKey: string): void {
    this.sessions.delete(sessionKey);
  }

  async steer(sessionKey: string, message: string): Promise<boolean> {
    const state = this.sessions.get(sessionKey);
    if (!state?.threadId || !state.activeTurnId) return false;

    try {
      const response = await this.postWithAuth<TurnSteerResponse>('turn/steer', {
        threadId: state.threadId,
        input: [{
          type: 'text',
          text: message,
          text_elements: [],
        }],
        expectedTurnId: state.activeTurnId,
      });

      if (typeof response.turnId === 'string' && response.turnId.length > 0) {
        this.setActiveTurn(sessionKey, state.threadId, response.turnId);
      }

      return true;
    } catch (err) {
      this.log?.debug?.({ err, sessionKey }, 'codex-app-server: steer failed');
      return false;
    }
  }

  async interrupt(sessionKey: string): Promise<boolean> {
    const state = this.sessions.get(sessionKey);
    if (!state?.threadId || !state.activeTurnId) return false;

    try {
      await this.postWithAuth<Record<string, never>>('turn/interrupt', {
        threadId: state.threadId,
        turnId: state.activeTurnId,
      });
      this.clearActiveTurn(sessionKey, state.activeTurnId);
      return true;
    } catch (err) {
      this.log?.debug?.({ err, sessionKey }, 'codex-app-server: interrupt failed');
      return false;
    }
  }

  private mergeSessionState(sessionKey: string, patch: SessionStatePatch): void {
    const existing = this.sessions.get(sessionKey);
    const nextThreadId = patch.threadId ?? existing?.threadId;
    if (!nextThreadId) return;

    const threadChanged = existing?.threadId && patch.threadId && existing.threadId !== patch.threadId;
    this.sessions.set(sessionKey, {
      threadId: nextThreadId,
      ...(patch.activeTurnId !== undefined
        ? { activeTurnId: patch.activeTurnId }
        : (threadChanged ? {} : existing?.activeTurnId ? { activeTurnId: existing.activeTurnId } : {})),
    });
  }

  private async postWithAuth<T>(pathname: string, body: unknown): Promise<T> {
    let token = await this.tokenProvider.getAccessToken();
    let response = await this.fetchJson(pathname, token, body);

    if (response.status === 401) {
      this.log?.debug?.('codex-app-server: 401 received, force-refreshing OAuth token');
      token = await this.tokenProvider.getAccessToken(true);
      response = await this.fetchJson(pathname, token, body);
    }

    if (!response.ok) {
      throw new Error(`codex-app-server request failed (${response.status})`);
    }

    const raw = await response.text();
    return (raw ? JSON.parse(raw) : {}) as T;
  }

  private async fetchJson(
    pathname: string,
    token: string,
    body: unknown,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      return await this.fetchImpl(this.buildUrl(pathname), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private buildUrl(pathname: string): string {
    return new URL(pathname.replace(/^\/+/, ''), this.baseUrl).toString();
  }
}
