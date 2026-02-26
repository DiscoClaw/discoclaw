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

export type VoiceConnectionManagerOpts = {
  reconnectRetryLimit?: number;
};

export class VoiceConnectionManager {
  private readonly log: LoggerLike;
  private readonly reconnectRetryLimit: number;
  private readonly connections = new Map<string, VoiceConnection>();

  constructor(log: LoggerLike, opts: VoiceConnectionManagerOpts = {}) {
    this.log = log;
    this.reconnectRetryLimit = opts.reconnectRetryLimit ?? 5;
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

  getState(guildId: string): VoiceConnectionState | undefined {
    const connection = this.connections.get(guildId);
    if (!connection) return undefined;
    return connection.state.status as VoiceConnectionState;
  }

  destroy(): void {
    this.leaveAll();
  }

  private subscribe(guildId: string, connection: VoiceConnection): void {
    connection.on('stateChange', (_oldState, newState) => {
      const status = newState.status;

      if (status === VoiceConnectionStatus.Ready) {
        this.log.info({ guildId }, 'voice connection ready');
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
      }
    });
  }
}
