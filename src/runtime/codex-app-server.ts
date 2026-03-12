import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createRuntimeErrorEvent } from './runtime-failure.js';
import type { ImageData, EngineEvent, RuntimeInvokeParams } from './types.js';

type Logger = {
  debug?(...args: unknown[]): void;
};

type JsonRpcRequestId = number;

type JsonRpcRequest = {
  id: JsonRpcRequestId;
  method: string;
  params?: unknown;
};

type JsonRpcNotification = {
  method: string;
  params?: unknown;
};

type JsonRpcResponse = {
  id: JsonRpcRequestId;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type NotificationListener = (message: JsonRpcNotification) => void;

type WebSocketLike = Pick<WebSocket, 'on' | 'send' | 'close' | 'readyState'>;

export type CodexAppServerSessionState = {
  threadId: string;
  activeTurnId?: string;
};

export type CodexAppServerClientOpts = {
  baseUrl: string;
  timeoutMs?: number;
  dangerouslyBypassApprovalsAndSandbox?: boolean;
  log?: Logger;
  wsFactory?: (url: string) => WebSocketLike;
};

type TurnSteerResponse = {
  turnId?: string;
};

type SessionStatePatch = {
  threadId?: string;
  activeTurnId?: string;
};

type CodexAppServerThreadCreateOpts = Partial<Pick<RuntimeInvokeParams, 'cwd' | 'model' | 'systemPrompt' | 'addDirs'>> & {
  ephemeral?: boolean;
};

type CodexAppServerStartTurnOpts = Partial<Pick<RuntimeInvokeParams, 'cwd' | 'model' | 'reasoningEffort' | 'addDirs'>> & {
  localImagePaths?: string[];
};

export type CodexAppServerTurnHandle = {
  threadId: string;
  turnId?: string;
  stream: AsyncIterable<EngineEvent>;
};

type TurnStreamEventState = {
  latestAgentMessageText?: string;
  latestUsage?: Extract<EngineEvent, { type: 'usage' }>;
  agentMessageTextByItemId: Map<string, string>;
};

type TurnStreamState = {
  threadId: string;
  turnId?: string;
  queue: Array<EngineEvent | null>;
  waiters: Array<() => void>;
  closed: boolean;
  eventState: TurnStreamEventState;
};

const DEFAULT_TIMEOUT_MS = 5_000;
const APP_SERVER_DISCONNECT_MESSAGE = 'codex app-server websocket closed';
const EPHEMERAL_SESSION_PREFIX = '__codex_app_server_ephemeral__:';
const NATIVE_FALLBACK_ERROR_MESSAGES = new Set([
  'codex app-server websocket failed',
  'codex app-server websocket connect timed out',
  'codex app-server websocket closed before initialize',
  'codex app-server initialize failed',
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function getStringField(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function makeError(message: string, cause?: unknown): Error {
  const error = new Error(message);
  if (cause !== undefined) {
    Object.assign(error, { cause });
  }
  return error;
}

function makeJsonRpcError(
  message: string,
  responseError: NonNullable<JsonRpcResponse['error']>,
): Error {
  const error = new Error(message);
  if (typeof responseError.code === 'number') {
    Object.assign(error, { code: responseError.code });
  }
  if (responseError.data !== undefined) {
    Object.assign(error, { data: responseError.data });
  }
  return error;
}

function makeAbortError(): Error {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.message === 'aborted');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw makeAbortError();
  }
}

function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(makeAbortError());

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(makeAbortError());
    };

    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

function shouldPropagateNativeFallbackError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return NATIVE_FALLBACK_ERROR_MESSAGES.has(message);
}

function getJsonRpcErrorCode(err: unknown): number | undefined {
  if (!err || typeof err !== 'object' || !('code' in err)) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'number' ? code : undefined;
}

function isMethodNotFoundError(err: unknown): boolean {
  const code = getJsonRpcErrorCode(err);
  if (code === -32601) return true;
  const message = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  return message.includes('method not found') || message.includes('unknown method');
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

class JsonRpcSocket {
  private readonly ws: WebSocketLike;
  private readonly timeoutMs: number;
  private readonly log?: Logger;
  private readonly onClose?: () => void;
  private readonly pending = new Map<JsonRpcRequestId, PendingRequest>();
  private readonly notificationListeners = new Set<NotificationListener>();
  private nextRequestId = 1;
  private closed = false;

  constructor(ws: WebSocketLike, timeoutMs: number, log?: Logger, onClose?: () => void) {
    this.ws = ws;
    this.timeoutMs = timeoutMs;
    this.log = log;
    this.onClose = onClose;

    ws.on('message', (data: WebSocket.RawData) => {
      this.handleMessage(data);
    });
    ws.on('error', (err: Error) => {
      this.log?.debug?.({ err }, 'codex-app-server: websocket error');
    });
    ws.on('close', () => {
      this.closed = true;
      this.rejectAll(new Error(APP_SERVER_DISCONNECT_MESSAGE));
      this.onClose?.();
    });
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      clientInfo: {
        name: 'discoclaw',
        title: 'DiscoClaw',
        version: '0.0.0',
      },
      capabilities: null,
    });
    this.notify('initialized');
  }

  request<T>(method: string, params: unknown): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error('codex app-server websocket is closed'));
    }

    const id = this.nextRequestId++;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex app-server request timed out (${method})`));
      }, this.timeoutMs);

      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });

      try {
        this.ws.send(JSON.stringify({ id, method, params } satisfies JsonRpcRequest));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(makeError(`codex app-server send failed (${method})`, err));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;

    try {
      this.ws.send(JSON.stringify(params === undefined ? { method } : { method, params }));
    } catch (err) {
      this.log?.debug?.({ err, method }, 'codex-app-server: notification send failed');
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectAll(new Error(APP_SERVER_DISCONNECT_MESSAGE));
    this.ws.close();
  }

  onNotification(listener: NotificationListener): () => void {
    this.notificationListeners.add(listener);
    return () => {
      this.notificationListeners.delete(listener);
    };
  }

  private handleMessage(data: WebSocket.RawData): void {
    let parsed: JsonRpcNotification | JsonRpcResponse;

    try {
      parsed = JSON.parse(String(data)) as JsonRpcNotification | JsonRpcResponse;
    } catch (err) {
      this.log?.debug?.({ err, data: String(data) }, 'codex-app-server: failed to parse message');
      return;
    }

    if (typeof (parsed as JsonRpcNotification).method === 'string' && (parsed as JsonRpcResponse).id === undefined) {
      for (const listener of this.notificationListeners) {
        try {
          listener(parsed as JsonRpcNotification);
        } catch (err) {
          this.log?.debug?.({ err, method: (parsed as JsonRpcNotification).method }, 'codex-app-server: notification listener failed');
        }
      }
      return;
    }

    const response = parsed as JsonRpcResponse;
    if (response.id === undefined) return;

    const pending = this.pending.get(response.id);
    if (!pending) return;

    this.pending.delete(response.id);
    clearTimeout(pending.timer);

    if (response.error) {
      pending.reject(makeJsonRpcError(
        response.error.message || 'codex app-server request failed',
        response.error,
      ));
      return;
    }

    pending.resolve(response.result);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export class CodexAppServerClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly dangerouslyBypassApprovalsAndSandbox: boolean;
  private readonly log?: Logger;
  private readonly wsFactory: (url: string) => WebSocketLike;
  private readonly sessions = new Map<string, CodexAppServerSessionState>();
  private readonly turnStreams = new Map<string, TurnStreamState>();
  private ephemeralSessionCounter = 1;

  private socket: JsonRpcSocket | null = null;
  private connectPromise: Promise<JsonRpcSocket> | null = null;

  constructor(opts: CodexAppServerClientOpts) {
    this.baseUrl = opts.baseUrl;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.dangerouslyBypassApprovalsAndSandbox = Boolean(opts.dangerouslyBypassApprovalsAndSandbox);
    this.log = opts.log;
    this.wsFactory = opts.wsFactory ?? ((url) => new WebSocket(url));
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
    this.closeTurnStream(sessionKey);
  }

  async createThread(
    sessionKey: string | null | undefined,
    opts: CodexAppServerThreadCreateOpts,
    signal?: AbortSignal,
  ): Promise<string> {
    throwIfAborted(signal);
    const socket = await withAbort(this.getSocket(), signal);
    const params = buildCreateThreadParams(opts, this.dangerouslyBypassApprovalsAndSandbox);
    let result: unknown;

    try {
      result = await withAbort(socket.request<unknown>('thread/start', params), signal);
    } catch (err) {
      if (!isMethodNotFoundError(err)) {
        throw err;
      }
      this.log?.debug?.({ err }, 'codex-app-server: thread/start unavailable; retrying legacy thread/create');
      result = await withAbort(socket.request<unknown>('thread/create', params), signal);
    }
    const threadId = extractThreadId(result);

    if (!threadId) {
      throw new Error('codex app-server thread start response missing threadId');
    }

    if (sessionKey) {
      this.setThread(sessionKey, threadId);
    }

    return threadId;
  }

  async startTurn(
    sessionKey: string,
    prompt: string,
    opts: CodexAppServerStartTurnOpts = {},
    signal?: AbortSignal,
  ): Promise<CodexAppServerTurnHandle> {
    const state = this.sessions.get(sessionKey);
    if (!state?.threadId) {
      throw new Error(`codex app-server session has no threadId (${sessionKey})`);
    }

    throwIfAborted(signal);
    const socket = await withAbort(this.getSocket(), signal);
    const streamState = this.createTurnStream(sessionKey, state.threadId);

    try {
      const result = await withAbort(socket.request<unknown>('turn/start', {
        threadId: state.threadId,
        input: buildTurnInput(prompt, opts.localImagePaths),
        ...buildStartTurnParams(opts, this.dangerouslyBypassApprovalsAndSandbox),
      }), signal);
      const turnId = extractTurnId(result);

      if (turnId) {
        streamState.turnId = turnId;
        if (!streamState.closed) {
          this.setActiveTurn(sessionKey, state.threadId, turnId);
        }
      }

      return {
        threadId: state.threadId,
        turnId,
        stream: this.consumeStream(sessionKey, signal),
      };
    } catch (err) {
      if (isAbortError(err)) {
        if (streamState.turnId || streamState.queue.length > 0 || streamState.closed) {
          return {
            threadId: state.threadId,
            turnId: streamState.turnId,
            stream: this.consumeStream(sessionKey, signal),
          };
        }
        void this.interrupt(sessionKey).catch(() => false);
        this.clearActiveTurn(sessionKey, streamState.turnId);
      }
      this.closeTurnStream(sessionKey, { includeDone: false });
      throw err;
    }
  }

  async *consumeStream(sessionKey: string, signal?: AbortSignal): AsyncIterable<EngineEvent> {
    const streamState = this.turnStreams.get(sessionKey);
    if (!streamState) {
      throw new Error(`codex app-server session has no active stream (${sessionKey})`);
    }

    try {
      while (true) {
        if (streamState.queue.length === 0) {
          await this.waitForTurnStreamEvent(streamState, signal);
          continue;
        }

        const next = streamState.queue.shift();
        if (next === undefined) continue;
        if (next === null) break;
        yield next;
      }
    } catch (err) {
      if (isAbortError(err)) {
        void this.interrupt(sessionKey).catch(() => false);
        this.clearActiveTurn(sessionKey, streamState.turnId);
        this.closeTurnStream(sessionKey, { includeDone: false });
      }
      throw err;
    } finally {
      this.turnStreams.delete(sessionKey);
    }
  }

  async *invokeViaTurn(params: RuntimeInvokeParams): AsyncIterable<EngineEvent> {
    if (params.signal?.aborted) {
      yield createRuntimeErrorEvent('aborted');
      yield { type: 'done' };
      return;
    }

    const sessionKey = params.sessionKey ?? this.allocateEphemeralSessionKey();
    const persistentSessionKey = params.sessionKey ?? null;
    let imageCleanup: (() => Promise<void>) | undefined;

    try {
      const existingThreadId = persistentSessionKey ? this.getSessionState(persistentSessionKey)?.threadId : undefined;
      if (!existingThreadId) {
        await this.createThread(sessionKey, {
          cwd: params.cwd,
          model: params.model,
          systemPrompt: params.systemPrompt,
          addDirs: params.addDirs,
          ephemeral: persistentSessionKey ? undefined : true,
        }, params.signal);
      } else if (sessionKey !== persistentSessionKey) {
        this.setThread(sessionKey, existingThreadId);
      }

      let localImagePaths: string[] | undefined;
      if (params.images && params.images.length > 0) {
        const prepared = await prepareImages(params.images, this.log);
        localImagePaths = prepared.paths;
        imageCleanup = prepared.cleanup;
      }

      const handle = await this.startTurn(sessionKey, params.prompt, {
        cwd: params.cwd,
        model: params.model,
        reasoningEffort: params.reasoningEffort,
        addDirs: params.addDirs,
        localImagePaths,
      }, params.signal);

      for await (const event of handle.stream) {
        yield event;
      }
    } catch (err) {
      if (isAbortError(err) || params.signal?.aborted) {
        yield createRuntimeErrorEvent('aborted');
        yield { type: 'done' };
        return;
      }
      if (shouldPropagateNativeFallbackError(err)) {
        throw err;
      }
      yield {
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      };
      yield { type: 'done' };
    } finally {
      await imageCleanup?.().catch(() => {});
      if (!persistentSessionKey) {
        this.clearSession(sessionKey);
      }
    }
  }

  async steer(sessionKey: string, message: string): Promise<boolean> {
    const state = this.sessions.get(sessionKey);
    if (!state?.threadId || !state.activeTurnId) return false;

    try {
      const socket = await this.getSocket();
      const response = await socket.request<TurnSteerResponse>('turn/steer', {
        threadId: state.threadId,
        input: buildTurnInput(message),
        expectedTurnId: state.activeTurnId,
      });

      if (typeof response?.turnId === 'string' && response.turnId.length > 0) {
        this.setActiveTurn(sessionKey, state.threadId, response.turnId);
        this.updateTurnStreamId(sessionKey, response.turnId);
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
      const socket = await this.getSocket();
      await socket.request<Record<string, never>>('turn/interrupt', {
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

  private async getSocket(): Promise<JsonRpcSocket> {
    if (this.socket) return this.socket;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = this.connect().finally(() => {
      this.connectPromise = null;
    });
    this.socket = await this.connectPromise;
    return this.socket;
  }

  private connect(): Promise<JsonRpcSocket> {
    return new Promise<JsonRpcSocket>((resolve, reject) => {
      let ws: WebSocketLike;
      try {
        ws = this.wsFactory(this.baseUrl);
      } catch (err) {
        reject(makeError('codex app-server websocket failed', err));
        return;
      }

      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('codex app-server websocket connect timed out'));
      }, this.timeoutMs);

      let settled = false;

      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };

      ws.on('open', () => {
        const socket = new JsonRpcSocket(ws, this.timeoutMs, this.log, () => {
          if (this.socket === socket) {
            this.socket = null;
          }
          this.failAllTurnStreams(APP_SERVER_DISCONNECT_MESSAGE);
        });
        socket.onNotification((message) => {
          this.handleNotification(message);
        });
        socket.initialize()
          .then(() => settle(() => resolve(socket)))
          .catch((err) => {
            settle(() => reject(makeError('codex app-server initialize failed', err)));
            socket.close();
          });
      });

      ws.on('error', (err: Error) => {
        settle(() => reject(makeError('codex app-server websocket failed', err)));
      });

      ws.on('close', () => {
        settle(() => reject(new Error('codex app-server websocket closed before initialize')));
      });
    });
  }

  private allocateEphemeralSessionKey(): string {
    return `${EPHEMERAL_SESSION_PREFIX}${this.ephemeralSessionCounter++}`;
  }

  private createTurnStream(sessionKey: string, threadId: string): TurnStreamState {
    this.closeTurnStream(sessionKey);

    const streamState: TurnStreamState = {
      threadId,
      queue: [],
      waiters: [],
      closed: false,
      eventState: {
        agentMessageTextByItemId: new Map(),
      },
    };

    this.turnStreams.set(sessionKey, streamState);
    return streamState;
  }

  private closeTurnStream(sessionKey: string, opts: { includeDone?: boolean } = {}): void {
    const streamState = this.turnStreams.get(sessionKey);
    if (!streamState) return;
    this.finishTurnStream(streamState, opts);
    this.turnStreams.delete(sessionKey);
  }

  private updateTurnStreamId(sessionKey: string, turnId: string): void {
    const streamState = this.turnStreams.get(sessionKey);
    if (!streamState || streamState.closed) return;
    streamState.turnId = turnId;
  }

  private handleNotification(message: JsonRpcNotification): void {
    const streamMatch = this.findTurnStream(message);
    if (!streamMatch) return;

    const [sessionKey, streamState] = streamMatch;

    if (message.method === 'turn/started') {
      const turnId = extractNotificationTurnId(message.params);
      if (turnId) {
        streamState.turnId = turnId;
        this.setActiveTurn(sessionKey, streamState.threadId, turnId);
      }
      return;
    }

    const events = mapNotificationToEngineEvents(message, streamState.eventState);
    for (const event of events) {
      this.enqueueTurnStreamEvent(streamState, event);
    }

    if (isTerminalNotification(message.method)) {
      const turnId = extractNotificationTurnId(message.params);
      this.clearActiveTurn(sessionKey, turnId);
      this.finishTurnStream(streamState, { includeDone: !events.some((event) => event.type === 'done') });
    }
  }

  private findTurnStream(message: JsonRpcNotification): [string, TurnStreamState] | null {
    const params = asRecord(message.params);
    const threadId = extractNotificationThreadId(params);
    const turnId = extractNotificationTurnId(params);

    for (const entry of this.turnStreams.entries()) {
      const [sessionKey, streamState] = entry;
      if (threadId && streamState.threadId !== threadId) continue;
      if (turnId && streamState.turnId && streamState.turnId !== turnId) continue;
      if (turnId && !streamState.turnId) {
        streamState.turnId = turnId;
        const sessionState = this.sessions.get(sessionKey);
        if (sessionState?.threadId) {
          this.setActiveTurn(sessionKey, sessionState.threadId, turnId);
        }
      }
      return entry;
    }

    return null;
  }

  private enqueueTurnStreamEvent(streamState: TurnStreamState, event: EngineEvent): void {
    if (streamState.closed) return;
    streamState.queue.push(event);
    this.wakeTurnStream(streamState);
  }

  private finishTurnStream(
    streamState: TurnStreamState,
    opts: { includeDone?: boolean } = {},
  ): void {
    if (streamState.closed) return;
    streamState.closed = true;
    if (opts.includeDone !== false) {
      streamState.queue.push({ type: 'done' });
    }
    streamState.queue.push(null);
    this.wakeTurnStream(streamState);
  }

  private wakeTurnStream(streamState: TurnStreamState): void {
    while (streamState.waiters.length > 0) {
      const waiter = streamState.waiters.shift();
      waiter?.();
    }
  }

  private waitForTurnStreamEvent(streamState: TurnStreamState, signal?: AbortSignal): Promise<void> {
    if (!signal) {
      return new Promise<void>((resolve) => {
        streamState.waiters.push(resolve);
      });
    }
    if (signal.aborted) {
      return Promise.reject(makeAbortError());
    }

    return new Promise<void>((resolve, reject) => {
      const waiter = () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = () => {
        signal.removeEventListener('abort', onAbort);
        const index = streamState.waiters.indexOf(waiter);
        if (index >= 0) {
          streamState.waiters.splice(index, 1);
        }
        reject(makeAbortError());
      };

      signal.addEventListener('abort', onAbort, { once: true });
      streamState.waiters.push(waiter);
    });
  }

  private failAllTurnStreams(message: string): void {
    for (const [sessionKey, streamState] of this.turnStreams.entries()) {
      this.clearActiveTurn(sessionKey, streamState.turnId);
      if (!streamState.closed) {
        this.enqueueTurnStreamEvent(streamState, { type: 'error', message });
        this.finishTurnStream(streamState);
      }
    }
  }
}

function buildCreateThreadParams(
  opts: CodexAppServerThreadCreateOpts,
  dangerouslyBypassApprovalsAndSandbox: boolean,
): Record<string, unknown> {
  return {
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.systemPrompt ? { developerInstructions: opts.systemPrompt } : {}),
    ...buildSafetyParams(dangerouslyBypassApprovalsAndSandbox, opts.cwd, opts.addDirs),
    ...(opts.ephemeral ? { ephemeral: true } : {}),
  };
}

function buildStartTurnParams(
  opts: CodexAppServerStartTurnOpts,
  dangerouslyBypassApprovalsAndSandbox: boolean,
): Record<string, unknown> {
  return {
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.reasoningEffort ? { effort: opts.reasoningEffort } : {}),
    ...buildSafetyParams(dangerouslyBypassApprovalsAndSandbox, opts.cwd, opts.addDirs),
  };
}

function buildTurnInput(prompt: string, localImagePaths: string[] = []): Array<Record<string, unknown>> {
  return [
    {
      type: 'text',
      text: prompt,
      text_elements: [],
    },
    ...localImagePaths.map((imagePath) => ({
      type: 'localImage',
      path: imagePath,
    })),
  ];
}

function buildSafetyParams(
  dangerouslyBypassApprovalsAndSandbox: boolean,
  cwd?: string,
  addDirs?: string[],
): Record<string, unknown> {
  if (dangerouslyBypassApprovalsAndSandbox) {
    return {
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' },
    };
  }

  const readableRoots = uniquePaths([cwd, ...(addDirs ?? [])]);
  if (readableRoots.length === 0) return {};

  return {
    sandboxPolicy: {
      type: 'readOnly',
      access: {
        type: 'restricted',
        includePlatformDefaults: true,
        readableRoots,
      },
      networkAccess: false,
    },
  };
}

function uniquePaths(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }

  return result;
}

async function prepareImages(
  images: ImageData[],
  log?: Logger,
): Promise<{ paths: string[]; cleanup: () => Promise<void> }> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'discoclaw-codex-app-server-img-'));
  const paths: string[] = [];

  for (let i = 0; i < images.length; i += 1) {
    const image = images[i]!;
    const rawExt = image.mediaType.split('/')[1] || 'bin';
    const ext = rawExt === 'jpeg' ? 'jpg' : rawExt;
    const filePath = path.join(tmpDir, `image-${i}.${ext}`);
    await fs.writeFile(filePath, Buffer.from(image.base64, 'base64'));
    paths.push(filePath);
  }

  log?.debug?.({ count: paths.length, tmpDir }, 'codex-app-server: wrote temp image files');
  return {
    paths,
    cleanup: async () => {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

function extractThreadId(result: unknown): string | undefined {
  const record = asRecord(result);
  if (!record) return undefined;
  return getStringField(record, 'threadId', 'thread_id')
    ?? getStringField(asRecord(record.thread) ?? {}, 'id', 'threadId', 'thread_id');
}

function extractTurnId(result: unknown): string | undefined {
  const record = asRecord(result);
  if (!record) return undefined;
  return getStringField(record, 'turnId', 'turn_id', 'id')
    ?? getStringField(asRecord(record.turn) ?? {}, 'id', 'turnId', 'turn_id');
}

function extractNotificationThreadId(params: Record<string, unknown> | null): string | undefined {
  if (!params) return undefined;
  return getStringField(params, 'threadId', 'thread_id')
    ?? getStringField(asRecord(params.thread) ?? {}, 'id', 'threadId', 'thread_id');
}

function extractNotificationTurnId(params: unknown): string | undefined {
  const record = asRecord(params);
  if (!record) return undefined;
  return getStringField(record, 'turnId', 'turn_id', 'id')
    ?? getStringField(asRecord(record.turn) ?? {}, 'id', 'turnId', 'turn_id');
}

function extractUsage(params: Record<string, unknown> | null): Extract<EngineEvent, { type: 'usage' }> | null {
  if (!params) return null;
  const usage = asRecord(params.usage);
  if (!usage) return null;

  const inputTokens = asFiniteNumber(usage.inputTokens ?? usage.input_tokens);
  const outputTokens = asFiniteNumber(usage.outputTokens ?? usage.output_tokens);
  const totalTokens = asFiniteNumber(usage.totalTokens ?? usage.total_tokens);
  const costUsd = asFiniteNumber(usage.costUsd ?? usage.cost_usd);

  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined && costUsd === undefined) {
    return null;
  }

  return {
    type: 'usage',
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}

function extractFailureMessage(params: Record<string, unknown> | null): string {
  const turn = asRecord(params?.turn);
  return getStringField(params ?? {}, 'message')
    ?? getStringField(asRecord(params?.error) ?? {}, 'message')
    ?? getStringField(asRecord(turn?.error) ?? {}, 'message')
    ?? 'codex app-server turn failed';
}

function selectTerminalUsage(
  params: Record<string, unknown> | null,
  state: TurnStreamEventState,
): Extract<EngineEvent, { type: 'usage' }> | null {
  return extractUsage(params) ?? state.latestUsage ?? null;
}

function extractThreadUsage(params: Record<string, unknown> | null): Extract<EngineEvent, { type: 'usage' }> | null {
  const tokenUsage = asRecord(params?.tokenUsage);
  const last = asRecord(tokenUsage?.last);
  if (!last) return null;

  const inputTokens = asFiniteNumber(last.inputTokens);
  const outputTokens = asFiniteNumber(last.outputTokens);
  const totalTokens = asFiniteNumber(last.totalTokens);

  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) {
    return null;
  }

  return {
    type: 'usage',
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };
}

function extractTextDelta(params: Record<string, unknown> | null): string | undefined {
  if (!params) return undefined;
  return getStringField(params, 'text', 'delta');
}

function extractToolName(params: Record<string, unknown> | null): string | undefined {
  if (!params) return undefined;
  return getStringField(params, 'name', 'tool', 'toolName')
    ?? getStringField(asRecord(params.item) ?? {}, 'name', 'tool', 'toolName');
}

function getItemType(item: Record<string, unknown> | null): string | undefined {
  if (!item) return undefined;
  return getStringField(item, 'type');
}

function mapNotificationToEngineEvents(
  message: JsonRpcNotification,
  state: TurnStreamEventState,
): EngineEvent[] {
  const params = asRecord(message.params);

  switch (message.method) {
    case 'item/agentMessage/delta': {
      const itemId = getStringField(params ?? {}, 'itemId', 'item_id');
      const text = extractTextDelta(params);
      if (!text) return [];

      if (itemId) {
        const next = `${state.agentMessageTextByItemId.get(itemId) ?? ''}${text}`;
        state.agentMessageTextByItemId.set(itemId, next);
        state.latestAgentMessageText = next;
      } else {
        state.latestAgentMessageText = `${state.latestAgentMessageText ?? ''}${text}`;
      }

      return [{ type: 'text_delta', text }];
    }

    case 'thread/tokenUsage/updated': {
      const usage = extractThreadUsage(params);
      if (!usage) return [];
      state.latestUsage = usage;
      return [];
    }

    case 'item/started':
      return mapItemStartedEvent(asRecord(params?.item));

    case 'item/completed':
      return mapItemCompletedEvent(asRecord(params?.item), state);

    case 'turn/text_delta': {
      const text = extractTextDelta(params);
      if (text) {
        state.latestAgentMessageText = `${state.latestAgentMessageText ?? ''}${text}`;
      }
      return text ? [{ type: 'text_delta', text }] : [];
    }

    case 'turn/tool_start': {
      const name = extractToolName(params);
      if (!name) return [];
      return [{
        type: 'tool_start',
        name,
        ...(params?.input !== undefined ? { input: params.input } : {}),
      }];
    }

    case 'turn/tool_end': {
      const name = extractToolName(params);
      if (!name) return [];
      const ok = typeof params?.ok === 'boolean' ? params.ok : true;
      return [{
        type: 'tool_end',
        name,
        ok,
        ...(params?.output !== undefined ? { output: params.output } : {}),
      }];
    }

    case 'turn/completed': {
      const turn = asRecord(params?.turn);
      const status = getStringField(turn ?? {}, 'status');
      const events: EngineEvent[] = [];

      if (status === 'failed') {
        events.push({ type: 'error', message: extractFailureMessage(params) });
      } else if (status === 'completed' && state.latestAgentMessageText) {
        events.push({ type: 'text_final', text: state.latestAgentMessageText });
      }

      const usage = selectTerminalUsage(params, state);
      if (usage) {
        events.push(usage);
      }

      return dedupeUsageEvents(events);
    }

    case 'turn/failed': {
      const events: EngineEvent[] = [{ type: 'error', message: extractFailureMessage(params) }];
      const usage = selectTerminalUsage(params, state);
      if (usage) {
        events.push(usage);
      }
      return dedupeUsageEvents(events);
    }

    default:
      return [];
  }
}

function mapItemStartedEvent(item: Record<string, unknown> | null): EngineEvent[] {
  const toolStart = mapItemToToolStart(item);
  return toolStart ? [toolStart] : [];
}

function mapItemCompletedEvent(
  item: Record<string, unknown> | null,
  state: TurnStreamEventState,
): EngineEvent[] {
  if (!item) return [];

  const itemType = getItemType(item);
  if (itemType === 'agentMessage' || itemType === 'agent_message') {
    const text = getStringField(item, 'text');
    if (!text) return [];

    const itemId = getStringField(item, 'id');
    state.latestAgentMessageText = text;

    if (!itemId) {
      return [{ type: 'text_delta', text }];
    }

    const streamedText = state.agentMessageTextByItemId.get(itemId) ?? '';
    state.agentMessageTextByItemId.set(itemId, text);
    if (text === streamedText) return [];

    return [{
      type: 'text_delta',
      text: text.startsWith(streamedText) ? text.slice(streamedText.length) : text,
    }];
  }

  const toolEnd = mapItemToToolEnd(item);
  return toolEnd ? [toolEnd] : [];
}

function mapItemToToolStart(item: Record<string, unknown> | null): Extract<EngineEvent, { type: 'tool_start' }> | null {
  if (!item) return null;

  switch (getItemType(item)) {
    case 'commandExecution':
    case 'command_execution':
      return {
        type: 'tool_start',
        name: 'command_execution',
        input: {
          ...(getStringField(item, 'command') ? { command: getStringField(item, 'command') } : {}),
          ...(getStringField(item, 'cwd') ? { cwd: getStringField(item, 'cwd') } : {}),
        },
      };

    case 'mcpToolCall':
    case 'mcp_tool_call':
      return {
        type: 'tool_start',
        name: getStringField(item, 'tool') ?? 'mcp_tool_call',
        input: {
          ...(getStringField(item, 'server') ? { server: getStringField(item, 'server') } : {}),
          ...(item.arguments !== undefined ? { arguments: item.arguments } : {}),
        },
      };

    case 'dynamicToolCall':
    case 'dynamic_tool_call':
      return {
        type: 'tool_start',
        name: getStringField(item, 'tool') ?? 'dynamic_tool_call',
        ...(item.arguments !== undefined ? { input: item.arguments } : {}),
      };

    case 'webSearch':
    case 'web_search':
      return {
        type: 'tool_start',
        name: 'web_search',
        ...(getStringField(item, 'query') ? { input: { query: getStringField(item, 'query') } } : {}),
      };

    case 'fileChange':
    case 'file_change':
      return {
        type: 'tool_start',
        name: 'file_change',
        ...(item.changes !== undefined ? { input: { changes: item.changes } } : {}),
      };

    case 'imageGeneration':
    case 'image_generation':
      return {
        type: 'tool_start',
        name: 'image_generation',
      };

    default:
      return null;
  }
}

function mapItemToToolEnd(item: Record<string, unknown> | null): Extract<EngineEvent, { type: 'tool_end' }> | null {
  if (!item) return null;

  switch (getItemType(item)) {
    case 'commandExecution':
    case 'command_execution': {
      const status = getStringField(item, 'status');
      const exitCode = asFiniteNumber(item.exitCode ?? item.exit_code);
      return {
        type: 'tool_end',
        name: 'command_execution',
        ok: status === 'completed' || (status == null && (exitCode == null || exitCode === 0)),
        output: {
          ...(getStringField(item, 'command') ? { command: getStringField(item, 'command') } : {}),
          ...(exitCode !== undefined ? { exitCode } : {}),
          ...(getStringField(item, 'aggregatedOutput', 'aggregated_output') ? { output: getStringField(item, 'aggregatedOutput', 'aggregated_output') } : {}),
        },
      };
    }

    case 'mcpToolCall':
    case 'mcp_tool_call':
      return {
        type: 'tool_end',
        name: getStringField(item, 'tool') ?? 'mcp_tool_call',
        ok: !isToolFailureStatus(getStringField(item, 'status')),
        output: {
          ...(getStringField(item, 'server') ? { server: getStringField(item, 'server') } : {}),
          ...(item.result !== undefined ? { result: item.result } : {}),
          ...(item.error !== undefined ? { error: item.error } : {}),
        },
      };

    case 'dynamicToolCall':
    case 'dynamic_tool_call':
      return {
        type: 'tool_end',
        name: getStringField(item, 'tool') ?? 'dynamic_tool_call',
        ok: typeof item.success === 'boolean' ? item.success : !isToolFailureStatus(getStringField(item, 'status')),
        output: {
          ...(item.contentItems !== undefined ? { contentItems: item.contentItems } : {}),
          ...(item.error !== undefined ? { error: item.error } : {}),
        },
      };

    case 'webSearch':
    case 'web_search':
      return {
        type: 'tool_end',
        name: 'web_search',
        ok: true,
        output: {
          ...(getStringField(item, 'query') ? { query: getStringField(item, 'query') } : {}),
          ...(getStringField(item, 'action') ? { action: getStringField(item, 'action') } : {}),
        },
      };

    case 'fileChange':
    case 'file_change':
      return {
        type: 'tool_end',
        name: 'file_change',
        ok: getStringField(item, 'status') === 'completed',
        output: {
          ...(item.changes !== undefined ? { changes: item.changes } : {}),
          ...(getStringField(item, 'status') ? { status: getStringField(item, 'status') } : {}),
        },
      };

    case 'imageGeneration':
    case 'image_generation':
      return {
        type: 'tool_end',
        name: 'image_generation',
        ok: !isToolFailureStatus(getStringField(item, 'status')),
        output: {
          ...(getStringField(item, 'revisedPrompt', 'revised_prompt') ? { revisedPrompt: getStringField(item, 'revisedPrompt', 'revised_prompt') } : {}),
          ...(getStringField(item, 'result') ? { result: getStringField(item, 'result') } : {}),
        },
      };

    default:
      return null;
  }
}

function dedupeUsageEvents(events: EngineEvent[]): EngineEvent[] {
  let seenUsage = false;
  return events.filter((event) => {
    if (event.type !== 'usage') return true;
    if (seenUsage) return false;
    seenUsage = true;
    return true;
  });
}

function isToolFailureStatus(status: string | undefined): boolean {
  return status === 'failed' || status === 'declined';
}

function isTerminalNotification(method: string): boolean {
  return method === 'turn/completed' || method === 'turn/failed';
}
