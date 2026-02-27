import {
  joinVoiceChannel,
  VoiceConnectionStatus,
  type VoiceConnection,
  type DiscordGatewayAdapterCreator,
} from '@discordjs/voice';
import type { LoggerLike } from '../logging/logger-like.js';

export type VoiceConnectionState =
  | 'signalling'
  | 'connecting'
  | 'ready'
  | 'disconnected'
  | 'destroyed';

export type VoiceConnectionInfo = {
  channelId: string;
  state: VoiceConnectionState;
  selfMute: boolean;
  selfDeaf: boolean;
};

export type VoiceConnectionManagerOpts = {
  reconnectRetryLimit?: number;
  onReady?: (guildId: string, connection: VoiceConnection) => void;
  onDestroyed?: (guildId: string) => void;
};

export class VoiceConnectionManager {
  private readonly log: LoggerLike;
  private readonly reconnectRetryLimit: number;
  private readonly onReady?: (guildId: string, connection: VoiceConnection) => void;
  private readonly onDestroyed?: (guildId: string) => void;
  private readonly connections = new Map<string, VoiceConnection>();

  constructor(log: LoggerLike, opts: VoiceConnectionManagerOpts = {}) {
    this.log = log;
    this.reconnectRetryLimit = opts.reconnectRetryLimit ?? 5;
    this.onReady = opts.onReady;
    this.onDestroyed = opts.onDestroyed;
  }

  join(opts: {
    channelId: string;
    guildId: string;
    adapterCreator: DiscordGatewayAdapterCreator;
  }): VoiceConnection {
    const existing = this.connections.get(opts.guildId);
    if (existing) {
      this.log.info({ guildId: opts.guildId }, 'destroying existing connection before rejoin');
      existing.destroy();
      this.connections.delete(opts.guildId);
    }

    const connection = joinVoiceChannel({
      channelId: opts.channelId,
      guildId: opts.guildId,
      adapterCreator: opts.adapterCreator,
      selfDeaf: false,
      decryptionFailureTolerance: 999_999,
    });

    this.connections.set(opts.guildId, connection);
    this.subscribe(opts.guildId, connection);

    return connection;
  }

  leave(guildId: string): void {
    const connection = this.connections.get(guildId);
    if (!connection) return;
    connection.destroy();
    this.connections.delete(guildId);
  }

  leaveAll(): void {
    for (const [guildId, connection] of this.connections) {
      connection.destroy();
      this.connections.delete(guildId);
    }
  }

  getConnection(guildId: string): VoiceConnection | undefined {
    return this.connections.get(guildId);
  }

  getState(guildId: string): VoiceConnectionState | undefined {
    const connection = this.connections.get(guildId);
    if (!connection) return undefined;
    return connection.state.status as VoiceConnectionState;
  }

  mute(guildId: string, muted: boolean): void {
    const connection = this.connections.get(guildId);
    if (!connection) return;
    const { channelId, selfDeaf } = connection.joinConfig;
    connection.rejoin({ channelId: channelId!, selfMute: muted, selfDeaf });
  }

  deafen(guildId: string, deafened: boolean): void {
    const connection = this.connections.get(guildId);
    if (!connection) return;
    const { channelId, selfMute } = connection.joinConfig;
    connection.rejoin({ channelId: channelId!, selfMute, selfDeaf: deafened });
  }

  getStatus(guildId: string): VoiceConnectionInfo | undefined {
    const connection = this.connections.get(guildId);
    if (!connection) return undefined;
    const config = connection.joinConfig;
    return {
      channelId: config.channelId ?? '',
      state: connection.state.status as VoiceConnectionState,
      selfMute: config.selfMute,
      selfDeaf: config.selfDeaf,
    };
  }

  listConnections(): Map<string, VoiceConnectionInfo> {
    const result = new Map<string, VoiceConnectionInfo>();
    for (const [guildId] of this.connections) {
      const status = this.getStatus(guildId);
      if (status) result.set(guildId, status);
    }
    return result;
  }

  destroy(): void {
    this.leaveAll();
  }

  private subscribe(guildId: string, connection: VoiceConnection): void {
    connection.on('stateChange', (_oldState, newState) => {
      const status = newState.status;

      if (status === VoiceConnectionStatus.Ready) {
        this.log.info({ guildId }, 'voice connection ready');
        this.onReady?.(guildId, connection);
      }

      if (status === VoiceConnectionStatus.Disconnected) {
        if (connection.rejoinAttempts < this.reconnectRetryLimit) {
          this.log.warn(
            { guildId, attempt: connection.rejoinAttempts + 1, limit: this.reconnectRetryLimit },
            'voice connection disconnected, attempting rejoin',
          );
          connection.rejoin();
        } else {
          this.log.error(
            { guildId, attempts: connection.rejoinAttempts },
            'voice connection exhausted reconnect retries, destroying',
          );
          connection.destroy();
          this.connections.delete(guildId);
        }
      }

      if (status === VoiceConnectionStatus.Destroyed) {
        this.connections.delete(guildId);
        this.onDestroyed?.(guildId);
      }
    });

    // Catch errors from the voice networking layer (e.g. DAVE handshake failures)
    // to prevent them from crashing the process as uncaught exceptions.
    connection.on('error', (err: Error) => {
      if (isDaveDecryptionError(err)) {
        // DAVE decryption errors are transient packet-level failures; dropping the
        // packet is safe and the stream should continue. Do NOT destroy the connection.
        this.log.warn({ guildId, err }, 'voice DAVE decryption error (packet dropped)');
        return;
      }
      this.log.error({ guildId, err }, 'voice connection error');
      try {
        connection.destroy();
      } catch {
        // Already destroyed.
      }
      this.connections.delete(guildId);
    });
  }
}

function isDaveDecryptionError(err: unknown): boolean {
  const msg = (err instanceof Error ? `${err.name} ${err.message}` : String(err));
  return /DecryptionFailed|Unencrypted|DAVE/i.test(msg);
}
