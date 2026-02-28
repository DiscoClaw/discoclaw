import type {
  Client,
  Guild,
  GuildBasedChannel,
  GuildMember,
  Role,
  GuildScheduledEvent,
  InternalDiscordGatewayAdapterCreator,
  PresenceStatusData,
  ActivitiesOptions,
  GuildChannelCreateOptions,
} from 'discord.js';

// ---------------------------------------------------------------------------
// TransportClient interface
// ---------------------------------------------------------------------------

/**
 * Abstraction over discord.js Guild + Client APIs used by action executors.
 *
 * Every method maps to an actual call-site found in action executors today.
 * The interface enables future per-executor migration away from raw Guild/Client
 * access without changing executor behaviour.
 */
export interface TransportClient {
  // -- Guild identity --------------------------------------------------------
  readonly guildId: string;

  // -- Channels --------------------------------------------------------------
  /** Get a channel from the cache by ID. */
  getChannel(id: string): GuildBasedChannel | undefined;
  /** Find the first channel matching a predicate. */
  findChannel(predicate: (ch: GuildBasedChannel) => boolean): GuildBasedChannel | undefined;
  /** Iterate all cached channels. */
  listChannels(): IterableIterator<GuildBasedChannel>;
  /** Create a new guild channel. */
  createChannel(options: GuildChannelCreateOptions): Promise<GuildBasedChannel>;
  /** Fetch a channel by ID via the client (not guild cache — resolves threads, DMs, etc.). */
  fetchClientChannel(id: string): Promise<GuildBasedChannel | null>;
  /** Get a channel from the client cache by ID. */
  getClientChannel(id: string): GuildBasedChannel | null;

  // -- Members ---------------------------------------------------------------
  /** Fetch a guild member by user ID. */
  fetchMember(userId: string): Promise<GuildMember | null>;
  /** Get the bot's own guild member (cached). May be null if not yet cached. */
  getBotMember(): GuildMember | null;
  /** Fetch the bot's own guild member from the API. */
  fetchBotMember(): Promise<GuildMember>;

  // -- Bot user --------------------------------------------------------------
  /** The bot user's ID. */
  readonly botUserId: string;
  /** Set the bot's presence status (online, idle, dnd, invisible). */
  setPresenceStatus(status: PresenceStatusData): void;
  /** Set the bot's activity. */
  setPresenceActivity(activity: ActivitiesOptions): void;

  // -- Roles -----------------------------------------------------------------
  /** Get a role from the cache by ID. */
  getRole(id: string): Role | undefined;
  /** Find the first role matching a predicate. */
  findRole(predicate: (role: Role) => boolean): Role | undefined;
  /** Iterate all cached roles. */
  listRoles(): IterableIterator<Role>;

  // -- Scheduled events ------------------------------------------------------
  /** Fetch all scheduled events. */
  fetchScheduledEvents(): Promise<Map<string, GuildScheduledEvent>>;
  /** Create a scheduled event. */
  createScheduledEvent(options: Record<string, unknown>): Promise<GuildScheduledEvent>;
  /** Edit a scheduled event. */
  editScheduledEvent(eventId: string, options: Record<string, unknown>): Promise<GuildScheduledEvent>;
  /** Delete a scheduled event. */
  deleteScheduledEvent(eventId: string): Promise<void>;
  /** Fetch a single scheduled event by ID. */
  fetchScheduledEvent(eventId: string): Promise<GuildScheduledEvent | null>;

  // -- Voice -----------------------------------------------------------------
  /** Get the guild's voice adapter creator for @discordjs/voice. */
  readonly voiceAdapterCreator: InternalDiscordGatewayAdapterCreator;
}

// ---------------------------------------------------------------------------
// DiscordTransportClient — delegates to discord.js Guild + Client
// ---------------------------------------------------------------------------

export class DiscordTransportClient implements TransportClient {
  constructor(
    private readonly guild: Guild,
    private readonly client: Client,
  ) {}

  // -- Guild identity --------------------------------------------------------
  get guildId(): string {
    return this.guild.id;
  }

  // -- Channels --------------------------------------------------------------
  getChannel(id: string): GuildBasedChannel | undefined {
    return this.guild.channels.cache.get(id);
  }

  findChannel(predicate: (ch: GuildBasedChannel) => boolean): GuildBasedChannel | undefined {
    return this.guild.channels.cache.find(predicate);
  }

  listChannels(): IterableIterator<GuildBasedChannel> {
    return this.guild.channels.cache.values();
  }

  async createChannel(options: GuildChannelCreateOptions): Promise<GuildBasedChannel> {
    return this.guild.channels.create(options);
  }

  async fetchClientChannel(id: string): Promise<GuildBasedChannel | null> {
    const channel = await this.client.channels.fetch(id);
    return (channel as GuildBasedChannel) ?? null;
  }

  getClientChannel(id: string): GuildBasedChannel | null {
    const channel = this.client.channels.cache.get(id);
    return (channel as GuildBasedChannel) ?? null;
  }

  // -- Members ---------------------------------------------------------------
  async fetchMember(userId: string): Promise<GuildMember | null> {
    return this.guild.members.fetch(userId).catch(() => null);
  }

  getBotMember(): GuildMember | null {
    return this.guild.members.me ?? null;
  }

  async fetchBotMember(): Promise<GuildMember> {
    return this.guild.members.fetchMe();
  }

  // -- Bot user --------------------------------------------------------------
  get botUserId(): string {
    return this.client.user!.id;
  }

  setPresenceStatus(status: PresenceStatusData): void {
    this.client.user!.setStatus(status);
  }

  setPresenceActivity(activity: ActivitiesOptions): void {
    this.client.user!.setActivity(activity);
  }

  // -- Roles -----------------------------------------------------------------
  getRole(id: string): Role | undefined {
    return this.guild.roles.cache.get(id);
  }

  findRole(predicate: (role: Role) => boolean): Role | undefined {
    return this.guild.roles.cache.find(predicate);
  }

  listRoles(): IterableIterator<Role> {
    return this.guild.roles.cache.values();
  }

  // -- Scheduled events ------------------------------------------------------
  async fetchScheduledEvents(): Promise<Map<string, GuildScheduledEvent>> {
    const events = await this.guild.scheduledEvents.fetch();
    return new Map(events.map((e) => [e.id, e]));
  }

  async createScheduledEvent(options: Record<string, unknown>): Promise<GuildScheduledEvent> {
    return this.guild.scheduledEvents.create(
      options as unknown as Parameters<Guild['scheduledEvents']['create']>[0],
    );
  }

  async editScheduledEvent(eventId: string, options: Record<string, unknown>): Promise<GuildScheduledEvent> {
    return this.guild.scheduledEvents.edit(
      eventId,
      options as unknown as Parameters<Guild['scheduledEvents']['edit']>[1],
    );
  }

  async deleteScheduledEvent(eventId: string): Promise<void> {
    await this.guild.scheduledEvents.delete(eventId);
  }

  async fetchScheduledEvent(eventId: string): Promise<GuildScheduledEvent | null> {
    return this.guild.scheduledEvents.fetch(eventId).catch(() => null);
  }

  // -- Voice -----------------------------------------------------------------
  get voiceAdapterCreator(): InternalDiscordGatewayAdapterCreator {
    return this.guild.voiceAdapterCreator;
  }
}
