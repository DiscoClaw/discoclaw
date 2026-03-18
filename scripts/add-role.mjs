/**
 * Add a role to a guild member by username.
 * Usage: node scripts/add-role.mjs <username> <role-name>
 */
import { Client, GatewayIntentBits } from 'discord.js';
import { config } from 'dotenv';

config();

const [, , username, roleName] = process.argv;
if (!username || !roleName) {
  process.stderr.write('Usage: node scripts/add-role.mjs <username> <role-name>\n');
  process.exit(1);
}

const token = (process.env.DISCORD_TOKEN ?? '').trim();
if (!token) {
  process.stderr.write('Missing DISCORD_TOKEN\n');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

const timeout = setTimeout(() => {
  process.stderr.write('Timed out after 15s\n');
  client.destroy();
  process.exit(1);
}, 15_000);

client.once('ready', async () => {
  clearTimeout(timeout);
  try {
    for (const guild of client.guilds.cache.values()) {
      const results = await guild.members.search({ query: username, limit: 5 });
      const member = results.find(
        (m) => m.user.username.toLowerCase() === username.toLowerCase() ||
               m.user.globalName?.toLowerCase() === username.toLowerCase() ||
               m.displayName.toLowerCase() === username.toLowerCase(),
      );
      if (!member) {
        process.stderr.write(`Member "${username}" not found in ${guild.name}\n`);
        continue;
      }

      const role = guild.roles.cache.find(
        (r) => r.name.toLowerCase() === roleName.toLowerCase(),
      );
      if (!role) {
        process.stderr.write(`Role "${roleName}" not found in ${guild.name}\n`);
        client.destroy();
        process.exit(1);
      }

      await member.roles.add(role);
      process.stdout.write(`Added role "${role.name}" to ${member.user.username} in ${guild.name}\n`);
      client.destroy();
      process.exit(0);
    }

    process.stderr.write(`Member "${username}" not found in any guild\n`);
    client.destroy();
    process.exit(1);
  } catch (err) {
    process.stderr.write(`Error: ${String(err)}\n`);
    client.destroy();
    process.exit(1);
  }
});

client.login(token).catch((err) => {
  clearTimeout(timeout);
  process.stderr.write(`Login failed: ${String(err)}\n`);
  process.exit(1);
});
