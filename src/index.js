// index.js
import http from 'http';
import axios from 'axios';
import { Client, GatewayIntentBits, MessageFlags, REST, Routes, SlashCommandBuilder } from 'discord.js';
import { handleCommand, handleButton, handleSelect, handleModal, handleMessage, parseTimeString, nextOccurrence, normalizeTz } from './handlers.js';
import { supabase } from './db.js';

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
    const now = new Date().toISOString();

    // Step 1: get all advance type IDs
    const { data: advTypes } = await supabase
      .from('shortlist_types').select('id, user_id').eq('is_advance', true);
    if (!advTypes?.length) return;

    const advTypeIds = advTypes.map(t => t.id);

    // Step 2: find expired advance rows
    const { data: dueRows } = await supabase
      .from('shortlist')
      .select('*')
      .in('type_id', advTypeIds)
      .eq('state', 'active')
      .not('advance_due', 'is', null)
      .lte('advance_due', now);

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

      // Reset Advance itself — keep advance_time, reschedule if it was a weekly timer
      let nextDue = null;
      if (advRow.advance_schedule) {
        const parts = advRow.advance_schedule.trim().split(/\s+/);
        if (parts.length === 3) {
          const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
          const dayIdx = days.indexOf(parts[0]);
          const parsed = parseTimeString(parts[1]);
          const tz     = normalizeTz(parts[2]) ?? parts[2];
          if (dayIdx !== -1 && parsed) {
            const next = nextOccurrence(dayIdx, parsed.hours, parsed.minutes, tz);
            if (next) nextDue = next.toISOString();
          }
        }
      }
      await supabase.from('shortlist')
        .update({ state: 'active', advance_due: nextDue })
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

// ── Daily ping loop (9am ET = 14:00 UTC, checks every 5 min) ─────────────────
const PING_HOUR_UTC = 14; // 9am ET (UTC-5)

async function runDailyPing() {
  try {
    const now   = new Date();
    const hour  = now.getUTCHours();
    const min   = now.getUTCMinutes();
    if (hour !== PING_HOUR_UTC || min >= 5) return; // only fire in the 9:00–9:04 ET window

    const today = now.toISOString().slice(0, 10); // YYYY-MM-DD

    // Fetch all users who haven't been pinged today
    const { data: configs } = await supabase
      .from('shortlist_config')
      .select('user_id, last_ping')
      .or(`last_ping.is.null,last_ping.neq.${today}`);

    if (!configs?.length) return;

    for (const cfg of configs) {
      try {
        // Skip users who have an active advance_due timer — auto-advance already bumps them
        const { data: activeTimers } = await supabase
          .from('shortlist')
          .select('id')
          .eq('user_id', cfg.user_id)
          .not('advance_due', 'is', null)
          .gt('advance_due', new Date().toISOString())
          .limit(1);

        if (activeTimers?.length) continue;

        const user = await client.users.fetch(cfg.user_id);
        const dm   = await user.createDM();
        const msg  = await dm.send('\u200b'); // zero-width space — invisible ping
        await msg.delete().catch(() => {});   // delete immediately

        await supabase.from('shortlist_config')
          .update({ last_ping: today })
          .eq('user_id', cfg.user_id);

        console.log(`Daily ping sent to ${cfg.user_id}`);
      } catch (err) {
        console.error(`Daily ping failed for ${cfg.user_id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('Daily ping loop error:', err.message);
  }
}

setInterval(runDailyPing, 5 * 60 * 1000);

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
