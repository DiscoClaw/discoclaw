import type {
  AnyThreadChannel,
  Client,
  ForumChannel,
  Guild,
  ThreadChannel,
} from 'discord.js';
import { ChannelType, GatewayIntentBits, Client as DiscordClient } from 'discord.js';

export type TaskDiscordClient = Client;
export type TaskDiscordGuild = Guild;
export type TaskDiscordForumChannel = ForumChannel;
export type TaskDiscordThreadChannel = ThreadChannel;
export type TaskDiscordAnyThreadChannel = AnyThreadChannel;

export const TaskDiscordChannelType = ChannelType;
export const TaskDiscordGatewayIntentBits = GatewayIntentBits;
export const TaskDiscordClientCtor = DiscordClient;
