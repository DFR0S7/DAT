// index.js
import 'dotenv/config';
import axios from 'axios';
import { createClient } from '@supabase/supabase-js';
import { Client, GatewayIntentBits, MessageFlags, REST, Routes, SlashCommandBuilder } from 'discord.js';

// ── Supabase client (exported so handlers.js can import it) ───────────────────
export const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// ── Discord client ─────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ── Handlers (imported after supabase export is defined) ──────────────────────
const {
  handleCommand,
  handleButton,
  handleSelect,
  handleModal,
  handleMessage,
} = await import('./handlers.js');

// ── Slash command definitions ─────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName('shortlist')
    .setDescription('View and manage your dynasty cycle tracker'),

  new SlashCommandBuilder()
    .setName('shortlist-config')
    .setDescription('Manage shortlist item types (add, remove, rename)')
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
    .setDescription('Add leagues or redo the setup flow'),

  new SlashCommandBuilder()
    .setName('help')
    .setDescription('How DAT works'),

  new SlashCommandBuilder()
    .setName('feedback')
    .setDescription('Send feedback or a bug report to the developer')
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
