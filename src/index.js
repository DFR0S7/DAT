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

// ── Auto-advance polling loop (every 5 minutes) ──────────────────────────────
async function runAutoAdvanceCheck() {
  try {
    // Find all advance rows with an expired due time
    const { data: dueRows } = await supabase
      .from('shortlist')
      .select('*, shortlist_types!inner(is_advance, user_id)')
      .eq('shortlist_types.is_advance', true)
      .eq('state', 'active')
      .not('advance_due', 'is', null)
      .lte('advance_due', new Date().toISOString());

    if (!dueRows?.length) return;

    for (const advRow of dueRows) {
      const userId     = advRow.user_id;
      const leagueName = advRow.league_name;

      // Get all types for this user
      const { data: types } = await supabase
        .from('shortlist_types').select('*').eq('user_id', userId).order('sort_order');
      if (!types?.length) continue;

      // Reset all non-Advance active/done items back to active
      const nonAdvTypeIds = types.filter(t => !t.is_advance).map(t => t.id);
      if (nonAdvTypeIds.length) {
        await supabase.from('shortlist').update({ state: 'active' })
          .eq('user_id', userId).eq('league_name', leagueName)
          .in('type_id', nonAdvTypeIds).in('state', ['active', 'done']);
      }

      // Reset Advance itself — keep advance_time, clear advance_due
      await supabase.from('shortlist')
        .update({ state: 'active', advance_due: null })
        .eq('id', advRow.id);

      // DM the user
      try {
        const user = await client.users.fetch(userId);
        const dm   = await user.createDM();
        await dm.send(`⏱️ **Auto-advance fired for ${leagueName}!**

All tasks have been reset for the new cycle. Good luck! 🏈`);
      } catch (err) {
        console.error(`Failed to DM user ${userId} for auto-advance:`, err.message);
      }

      console.log(`Auto-advance fired: ${leagueName} for user ${userId}`);
    }
  } catch (err) {
    console.error('Auto-advance poll error:', err.message);
  }
}

setInterval(runAutoAdvanceCheck, 5 * 60 * 1000); // every 5 minutes
runAutoAdvanceCheck(); // run once on startup to catch anything missed

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
client.on('error',      err => console.error('Discord client error:', err.stack ?? err.message));
client.on('shardError', err => console.error('Shard error:', err.stack ?? err.message));

start();
