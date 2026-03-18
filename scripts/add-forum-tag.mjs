/**
 * One-off script: add a forum tag to a named forum channel.
 * Usage: node scripts/add-forum-tag.mjs <channel-name> <tag-name> [emoji]
 * Example: node scripts/add-forum-tag.mjs help-forum bug 🐛
 */
import { Client, GatewayIntentBits, ChannelType } from 'discord.js';
import { config } from 'dotenv';

config();

const [, , channelArg = 'help-forum', tagName = 'bug', emojiName] = process.argv;

const token = process.env.DISCORD_TOKEN;
if (!token) throw new Error('DISCORD_TOKEN not set');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', async () => {
  try {
    const guild = client.guilds.cache.first();
    if (!guild) throw new Error('Bot is not in any guild');

    const channel = guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildForum && c.name.toLowerCase() === channelArg.toLowerCase(),
    );
    if (!channel) throw new Error(`Forum channel '${channelArg}' not found`);

    const existing = channel.availableTags ?? [];
    if (existing.some((t) => t.name.toLowerCase() === tagName.toLowerCase())) {
      console.log(`Tag '${tagName}' already exists on #${channel.name} — nothing to do.`);
      return;
    }

    const newTag = { name: tagName, moderated: false };
    if (emojiName) newTag.emoji = { name: emojiName };

    await channel.edit({ availableTags: [...existing, newTag] });
    console.log(`Added tag '${tagName}' to #${channel.name} (${channel.id})`);
  } finally {
    client.destroy();
  }
});

client.login(token);
