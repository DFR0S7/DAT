// index.js
import http from 'http';
import axios from 'axios';
import { Client, GatewayIntentBits, MessageFlags, REST, Routes, SlashCommandBuilder } from 'discord.js';
import { handleCommand, handleButton, handleSelect, handleModal, handleMessage, parseTimeString, nextOccurrence, normalizeTz, postShortlist, getOrSeedShortlistTypes, getShortlistData } from './handlers.js';
import { supabase } from './db.js';
import { handleSeasonCommand } from './seasonHandlers.js';
import { handleRosterCommand, handleRosterModal, handleRosterAutocomplete } from './rosterHandlers.js';
import { handleDynastyCommand } from './dynastyHandlers.js';
import { handleNeedsCommand } from './needsHandlers.js';
import { handleDashboardCommand, handleDashboardButton, handleDashboardSelect } from './dashboardHandlers.js';

// ── Discord client ─────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

// ── Slash command definitions ─────────────────────────────────────────────────
const POS_CHOICES = ["QB","HB","WR","TE","OT","OG","C","DE","DT","OLB","MLB","CB","S","K/P"].map(p => ({ name: p, value: p }));

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

  new SlashCommandBuilder()
    .setName('dynasty')
    .setDescription('Manage and switch between your dynasties')
    .setDMPermission(true)
    .addStringOption(o => o.setName('action').setDescription('What to do').setRequired(true)
      .addChoices(
        { name: 'List dynasties',        value: 'list'   },
        { name: 'Switch active dynasty', value: 'switch' },
        { name: 'Create new dynasty',    value: 'new'    },
        { name: 'Delete dynasty',        value: 'delete' },
      ))
    .addStringOption(o => o.setName('name').setDescription('Dynasty/team name').setRequired(false)),

  new SlashCommandBuilder()
    .setName('season')
    .setDescription('Log and manage season history for your active dynasty')
    .setDMPermission(true)
    .addStringOption(o => o.setName('action').setDescription('What to do').setRequired(true)
      .addChoices(
        { name: 'Log a season',    value: 'log'    },
        { name: 'View history',    value: 'list'   },
        { name: 'Edit a season',   value: 'edit'   },
        { name: 'Delete a season', value: 'delete' },
      ))
    .addIntegerOption(o => o.setName('season_num').setDescription('Season number').setRequired(false))
    .addIntegerOption(o => o.setName('wins').setDescription('Wins').setRequired(false))
    .addIntegerOption(o => o.setName('losses').setDescription('Losses').setRequired(false))
    .addStringOption(o => o.setName('conference').setDescription('Conference (e.g. MAC, SEC East)').setRequired(false))
    .addIntegerOption(o => o.setName('tier').setDescription('Tier, 1 = top (only if your dynasty uses the promotion ladder)').setRequired(false)
      .addChoices(
        { name: 'Tier 1', value: 1 },
        { name: 'Tier 2', value: 2 },
        { name: 'Tier 3', value: 3 },
        { name: 'Tier 4', value: 4 },
        { name: 'Tier 5', value: 5 },
      ))
    .addStringOption(o => o.setName('ccg_result').setDescription('Conference championship result').setRequired(false)
      .addChoices(
        { name: "Didn't make CCG",    value: 'didnt-make' },
        { name: 'Lost CCG',           value: 'lost-ccg'   },
        { name: 'Won CCG — Promoted', value: 'won-ccg'    },
      ))
    .addStringOption(o => o.setName('bowl_result').setDescription('Bowl game result').setRequired(false)
      .addChoices(
        { name: 'Bowl-eligible, not played', value: 'none-eligible' },
        { name: 'Lost Bowl',                 value: 'lost'          },
        { name: 'Won Bowl',                  value: 'won'           },
      ))
    .addIntegerOption(o => o.setName('prestige').setDescription('End-of-season prestige (stars)').setRequired(false)
      .addChoices(
        { name: '1 star', value: 1 }, { name: '2 star', value: 2 }, { name: '3 star', value: 3 },
        { name: '4 star', value: 4 }, { name: '5 star', value: 5 }, { name: '6 star', value: 6 },
      ))
    .addStringOption(o => o.setName('recruiting').setDescription('Recruiting class summary').setRequired(false))
    .addStringOption(o => o.setName('notes').setDescription('Notes').setRequired(false)),

  new SlashCommandBuilder()
    .setName('roster')
    .setDescription('Manage the roster for your active dynasty')
    .setDMPermission(true)
    .addStringOption(o => o.setName('action').setDescription('What to do').setRequired(true)
      .addChoices(
        { name: 'Add player',       value: 'add'    },
        { name: 'View roster',      value: 'list'   },
        { name: 'Commit to roster', value: 'commit' },
        { name: 'Edit player',      value: 'edit'   },
        { name: 'Remove player',    value: 'remove' },
        { name: 'Import CSV',       value: 'import' },
        { name: 'Export CSV',       value: 'export' },
      ))
    .addStringOption(o => o.setName('pos').setDescription('Position — pick this first to filter the name suggestions').setRequired(false)
      .addChoices(...POS_CHOICES))
    .addStringOption(o => o.setName('name').setDescription('Player name (type to search existing players, or a new name for Add)').setRequired(false).setAutocomplete(true))
    .addStringOption(o => o.setName('new_pos').setDescription("New position (edit only — changes the player's position)").setRequired(false)
      .addChoices(...POS_CHOICES))
    .addStringOption(o => o.setName('class_year').setDescription('Class year').setRequired(false)
      .addChoices(...["FR","RS-FR","SO","RS-SO","JR","RS-JR","SR","RS-SR"].map(y => ({ name: y, value: y }))))
    .addIntegerOption(o => o.setName('overall').setDescription('Overall rating').setRequired(false).setMinValue(0).setMaxValue(99))
    .addStringOption(o => o.setName('dev_trait').setDescription('Dev trait').setRequired(false)
      .addChoices({ name: 'Normal', value: 'Normal' }, { name: 'Impact', value: 'Impact' }, { name: 'Star', value: 'Star' }, { name: 'Elite', value: 'Elite' }))
    .addStringOption(o => o.setName('flight_risk').setDescription('Transfer portal risk').setRequired(false)
      .addChoices({ name: 'Low', value: 'Low' }, { name: 'Medium', value: 'Medium' }, { name: 'High', value: 'High' }))
    .addBooleanOption(o => o.setName('nil_offered').setDescription('NIL offered to retain?').setRequired(false))
    .addStringOption(o => o.setName('nil_amount').setDescription('NIL amount / notes').setRequired(false))
    .addStringOption(o => o.setName('status').setDescription('Player status').setRequired(false)
      .addChoices(
        { name: 'Target',          value: 'Target'          },
        { name: 'Signed',          value: 'Signed'          },
        { name: 'On Roster',       value: 'On Roster'       },
        { name: 'Retained w/ NIL', value: 'Retained w/ NIL' },
        { name: 'Transferred Out', value: 'Transferred Out' },
      ))
    .addStringOption(o => o.setName('recruit_type').setDescription('Recruit type — which need this fills').setRequired(false)
      .addChoices(
        { name: 'HS — high school recruit',           value: 'HS' },
        { name: 'FP — portal future player (FR/SO)',   value: 'FP' },
        { name: 'TP — portal immediate starter (JR)',  value: 'TP' },
      ))
    .addStringOption(o => o.setName('notes').setDescription('Notes').setRequired(false)),

  new SlashCommandBuilder()
    .setName('needs')
    .setDescription('View and set positional needs for your active dynasty')
    .setDMPermission(true)
    .addStringOption(o => o.setName('action').setDescription('What to do').setRequired(true)
      .addChoices(
        { name: 'View needs',     value: 'view'         },
        { name: 'Set a position', value: 'set'          },
        { name: 'Mark updated',   value: 'mark-updated' },
      ))
    .addStringOption(o => o.setName('pos').setDescription('Position (for action:set)').setRequired(false)
      .addChoices(...POS_CHOICES))
    .addIntegerOption(o => o.setName('hs_need').setDescription('HS recruits needed').setRequired(false).setMinValue(0))
    .addIntegerOption(o => o.setName('portal_need').setDescription('Portal recruits needed').setRequired(false).setMinValue(0))
    .addStringOption(o => o.setName('portal_type').setDescription('Portal need type').setRequired(false)
      .addChoices(
        { name: 'FP — future player (FR/SO)',   value: 'FP' },
        { name: 'TP — immediate starter (JR)',  value: 'TP' },
      ))
    .addStringOption(o => o.setName('period').setDescription('Recruiting window (for action:mark-updated)').setRequired(false)
      .addChoices(
        { name: 'High school recruiting', value: 'HS' },
        { name: 'Transfer portal',        value: 'TP' },
      )),

].map(c => c.toJSON());

const dashboardCommand = new SlashCommandBuilder()
  .setName('dashboard')
  .setDescription('Open your dynasty dashboard — browse seasons, roster, and needs')
  .setDMPermission(true)
  .toJSON();
commands.push(dashboardCommand);

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

      // DM the user and update their shortlist
      try {
        const user = await client.users.fetch(userId);
        const dm   = await user.createDM();
        await dm.send(`⏱️ **Auto-advance fired for ${leagueName}!**\n\nAll tasks have been reset for the new cycle. Good luck! 🏈`);

        // Re-post the shortlist so it updates automatically
        const freshTypes = await getOrSeedShortlistTypes(userId);
        const { rows: freshRows } = await getShortlistData(userId, freshTypes);
        await postShortlist(dm, freshTypes, freshRows, { step: 'main' }, userId);
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

// ── Supabase keep-alive ping ───────────────────────────────────────────
// Runs once at startup then every 24 hours to prevent Supabase pausing due to inactivity
const pingSupabase = async () => {
  try {
    await supabase.from('todo_config').select('user_id').limit(1);
    console.log('[supabase] Keep-alive ping successful');
  } catch (err) {
    console.error('[supabase] Keep-alive ping failed:', err.message);
  }
};
await pingSupabase();
setInterval(pingSupabase, 24 * 60 * 60 * 1000);

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isAutocomplete()) {
      if (interaction.commandName === 'roster') return handleRosterAutocomplete(interaction);
      return interaction.respond([]);
    }
    if (interaction.isChatInputCommand()) {
      const { commandName } = interaction;
      if (commandName === 'dynasty')   return handleDynastyCommand(interaction);
      if (commandName === 'season')    return handleSeasonCommand(interaction);
      if (commandName === 'roster')    return handleRosterCommand(interaction);
      if (commandName === 'needs')     return handleNeedsCommand(interaction);
      if (commandName === 'dashboard') return handleDashboardCommand(interaction);
      return handleCommand(interaction, client);
    }
    if (interaction.isButton()) {
      const handled = await handleDashboardButton(interaction);
      if (handled) return;
      return handleButton(interaction);
    }
    if (interaction.isStringSelectMenu()) {
      const handled = await handleDashboardSelect(interaction);
      if (handled) return;
      return handleSelect(interaction);
    }
    if (interaction.isModalSubmit()) {
      if (interaction.customId === 'roster_import_modal') return handleRosterModal(interaction);
      return handleModal(interaction);
    }
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
