// index.js
import http from 'http';
import axios from 'axios';
import { Client, GatewayIntentBits, MessageFlags, REST, Routes, SlashCommandBuilder } from 'discord.js';
import { handleCommand, handleButton, handleSelect, handleModal, handleMessage } from './handlers.js';

// ── Discord client ─────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

// ── Slash command definitions ─────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName('shortlist')
    .setDescription('View and manage your dynasty cycle tracker')
    .setDMPermission(true),

  new SlashCommandBuilder()
    .setName('shortlist-config')
    .setDescription('Manage shortlist item types (add, remove, rename)')
    .setDMPermission(true)
    .addStringOption(o => o.setName('action').setDescription('What to do').setRequired(true)
      .addChoices(
        { name: 'Add type',    value: 'add'    },
        { name: 'Remove type', value: 'remove' },
        { name: 'Rename type', value: 'rename' },
      ))
    .addStringOption(o => o.setName('name').setDescription('Type name').setRequired(false))
    .addStringOption(o => o.setName('icon').setDescription('Emoji icon (for add)').setRequired(false))
    .addStringOption(o => o.setName('new_name').setDescription('New name (for rename)').setRequired(false)),

  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Add leagues or redo the setup flow')
    .setDMPermission(true),

  new SlashCommandBuilder()
    .setName('help')
    .setDescription('How DAT works')
    .setDMPermission(true),

  new SlashCommandBuilder()
    .setName('feedback')
    .setDescription('Send feedback or a bug report to the developer')
    .setDMPermission(true)
    .addStringOption(o => o.setName('message').setDescription('Your feedback').setRequired(true)),

].map(c => c.toJSON());

// ── Startup: register commands then login ─────────────────────────────────────
async function start() {
  try {
    console.log('Registering slash commands…');
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
    console.log('Commands registered.');
  } catch (err) {
    console.error('Failed to register commands:', err.message);
  }
  client.login(process.env.DISCORD_TOKEN);
}

// ── HTTP server (required for Railway to generate a domain) ──────────────────
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('ok');
}).listen(PORT, () => console.log(`HTTP server listening on port ${PORT}`));

// ── Self-ping (Railway) ───────────────────────────────────────────────────────
if (process.env.SELF_PING_URL) {
  console.log('Self-pinger active:', process.env.SELF_PING_URL);
  setInterval(async () => {
    try { await axios.get(`${process.env.SELF_PING_URL}/ping`, { timeout: 5000 }); }
    catch (err) { console.warn('Self-ping failed:', err.message); }
  }, 3 * 60 * 1000);
}

// ── Discord events ─────────────────────────────────────────────────────────────
client.once('clientReady', () => console.log('DAT online:', client.user.tag));

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) return handleCommand(interaction, client);
    if (interaction.isButton())           return handleButton(interaction);
    if (interaction.isStringSelectMenu()) return handleSelect(interaction);
    if (interaction.isModalSubmit())      return handleModal(interaction);
  } catch (err) {
    console.error('Interaction error:', err);
    const msg = { content: 'Something went wrong. Please try again.', flags: MessageFlags.Ephemeral };
    if (interaction.deferred)      interaction.editReply(msg).catch(() => {});
    else if (!interaction.replied) interaction.reply(msg).catch(() => {});
  }
});

client.on('guildMemberAdd', async (member) => {
  try {
    if (!member?.user) return;
    if (member.user.bot) return;
    const dm = await member.user.createDM().catch(() => null);
    if (!dm) return;
    await dm.send(
      `👋 **Welcome to DAT — Dynasty Advance Tracker!**\n\n` +
      `DAT helps you track where every dynasty league is in its current sim cycle, all from your DMs.\n\n` +
      `To get started, just type anything here and I'll walk you through setup — or run \`/shortlist\` in any server we share.\n\n` +
      `Run \`/help\` any time for a full overview.`
    );
  } catch (err) {
    console.error('guildMemberAdd error:', err.message, err.stack);
  }
});

client.on('messageCreate', async (message) => {
  try { await handleMessage(message); }
  catch (err) { console.error('Message error:', err); }
});

// ── Process error guards ───────────────────────────────────────────────────────
process.on('uncaughtException',  err => console.error('Uncaught exception:', err.message));
process.on('unhandledRejection', err => console.error('Unhandled rejection:', err?.message ?? err));
client.on('error',      err => console.error('Discord client error:', err.message));
client.on('shardError', err => console.error('Shard error:', err.message));

start();
