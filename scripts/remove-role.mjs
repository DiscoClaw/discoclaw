/**
 * Remove a role from a guild member by username or display name.
 * Usage: node scripts/remove-role.mjs <username> <role-name>
 * Example: node scripts/remove-role.mjs charlie Tester
 */
import { Client, GatewayIntentBits } from 'discord.js';
import { config } from 'dotenv';

config();

const [, , targetUsername, roleName] = process.argv;
if (!targetUsername || !roleName) {
  process.stderr.write('Usage: node scripts/remove-role.mjs <username> <role-name>\n');
  process.exit(1);
}

const token = (process.env.DISCORD_TOKEN ?? '').trim();
if (!token) {
  process.stderr.write('Missing DISCORD_TOKEN\n');
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const timeout = setTimeout(() => {
  process.stderr.write('Timed out after 15s\n');
  client.destroy();
  process.exit(1);
}, 15_000);

client.once('ready', async () => {
  clearTimeout(timeout);
  try {
    const name = targetUsername.replace(/^@/, '').toLowerCase();
    let removed = false;

    for (const guild of client.guilds.cache.values()) {
      const role = guild.roles.cache.find((r) => r.name.toLowerCase() === roleName.toLowerCase());
      if (!role) {
        process.stderr.write(`Role "${roleName}" not found in guild "${guild.name}"\n`);
        continue;
      }

      // guild.members.search works without the privileged GuildMembers intent
      const results = await guild.members.search({ query: name, limit: 10 });
      const member = results.find(
        (m) =>
          m.user.username.toLowerCase() === name ||
          m.user.globalName?.toLowerCase() === name ||
          m.displayName.toLowerCase() === name,
      );

      if (!member) {
        process.stderr.write(`Member "${name}" not found in guild "${guild.name}"\n`);
        continue;
      }

      if (!member.roles.cache.has(role.id)) {
        process.stdout.write(`${member.user.username} does not have the "${roleName}" role in "${guild.name}" — nothing to do\n`);
        removed = true;
        continue;
      }

      await member.roles.remove(role);
      process.stdout.write(`Removed role "${roleName}" from ${member.user.username} in "${guild.name}"\n`);
      removed = true;
    }

    client.destroy();
    process.exit(removed ? 0 : 1);
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
