// dashboardHandlers.js
// /dashboard — one persistent message, edited in place, with tab buttons
// (Seasons / Roster / Needs) and a Switch Dynasty select menu — the Discord
// equivalent of the web artifact's tab navigation.

import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder, MessageFlags,
} from 'discord.js';
import { supabase } from './db.js';
import { getDynasties, getActiveDynasty, setActiveDynasty } from './dynastyHandlers.js';
import { formatSeasonLine } from './seasonHandlers.js';
import { formatPlayerCard } from './rosterHandlers.js';
import { computeNeeds, formatNeedLine } from './needsHandlers.js';

// Per-user in-memory nav state — same pattern as the existing activeEdits Map
// in handlers.js. Lost on process restart, which is fine: /dashboard re-renders
// fresh from the DB either way.
const dashState = new Map();

function getState(userId) {
  if (!dashState.has(userId)) dashState.set(userId, { tab: 'seasons', seasonPage: 0, rosterPage: 0, recruitingPage: 0 });
  return dashState.get(userId);
}

const SEASONS_PER_PAGE = 5;
const PLAYERS_PER_PAGE = 3; // full-detail cards, so keep pages short

// ─────────────────────────────────────────────────────────────────────────────
// CONTENT BUILDERS
// ─────────────────────────────────────────────────────────────────────────────

async function buildSeasonsContent(userId, dynastyName, state) {
  const { data: seasons } = await supabase
    .from('dynasty_seasons').select('*')
    .eq('user_id', userId).eq('dynasty_name', dynastyName).order('season_num');

  if (!seasons?.length) {
    return { text: 'No seasons logged yet. Use `/season action:Log` to add one.', maxPage: 0 };
  }

  const maxPage = Math.max(0, Math.ceil(seasons.length / SEASONS_PER_PAGE) - 1);
  const page = Math.min(state.seasonPage, maxPage);
  state.seasonPage = page;

  // Most recent seasons first
  const ordered = [...seasons].reverse();
  const slice = ordered.slice(page * SEASONS_PER_PAGE, (page + 1) * SEASONS_PER_PAGE);
  const text = slice.map(formatSeasonLine).join('\n\n');
  return { text, maxPage, page, total: seasons.length };
}

async function buildRosterContent(userId, dynastyName, state) {
  const { data: players } = await supabase
    .from('dynasty_roster').select('*')
    .eq('user_id', userId).eq('dynasty_name', dynastyName)
    .not('status', 'in', '("Transferred Out","Target","Signed")')
    .order('pos').order('name');

  if (!players?.length) {
    return { text: 'No players tracked yet. Use `/roster action:Add` or `/roster action:Import`.', maxPage: 0 };
  }

  const maxPage = Math.max(0, Math.ceil(players.length / PLAYERS_PER_PAGE) - 1);
  const page = Math.min(state.rosterPage, maxPage);
  state.rosterPage = page;

  const slice = players.slice(page * PLAYERS_PER_PAGE, (page + 1) * PLAYERS_PER_PAGE);
  const text = slice.map(formatPlayerCard).join('\n\n');
  return { text, maxPage, page, total: players.length, slice };
}

async function buildRecruitingContent(userId, dynastyName, state) {
  const { data: players } = await supabase
    .from('dynasty_roster').select('*')
    .eq('user_id', userId).eq('dynasty_name', dynastyName)
    .in('status', ['Target', 'Signed'])
    .order('pos').order('name');

  if (!players?.length) {
    return { text: 'No recruiting targets tracked yet. Use `/roster action:Add` with status Target or Signed.', maxPage: 0, slice: [] };
  }

  const maxPage = Math.max(0, Math.ceil(players.length / PLAYERS_PER_PAGE) - 1);
  const page = Math.min(state.recruitingPage, maxPage);
  state.recruitingPage = page;

  const slice = players.slice(page * PLAYERS_PER_PAGE, (page + 1) * PLAYERS_PER_PAGE);
  const text = slice.map(formatPlayerCard).join('\n\n');
  return { text, maxPage, page, total: players.length, slice };
}

async function buildNeedsContent(userId, dynastyName) {
  const needs = await computeNeeds(userId, dynastyName);
  const lines = needs.map(formatNeedLine).filter(Boolean);

  const { data: dyn } = await supabase
    .from('dynasties').select('needs_updated, needs_period').eq('user_id', userId).eq('dynasty_name', dynastyName).single();
  const updatedLine = dyn?.needs_updated
    ? `-# Updated ${dyn.needs_updated} · ${dyn.needs_period === 'TP' ? 'Transfer portal window' : 'HS recruiting window'}`
    : '-# Not yet marked updated';

  const text = lines.length ? lines.join('\n') : 'No needs set yet. Use `/needs action:Set` to add some.';
  return { text: `${updatedLine}\n\n${text}` };
}

// ─────────────────────────────────────────────────────────────────────────────
// PAYLOAD ASSEMBLY
// ─────────────────────────────────────────────────────────────────────────────

async function buildDashboardPayload(userId) {
  const dynastyName = await getActiveDynasty(userId);
  if (!dynastyName) {
    const dynasties = await getDynasties(userId);
    const msg = dynasties.length
      ? `You don't have an active dynasty selected. Run \`/dynasty action:Switch name:<team>\` to pick one, then \`/dashboard\` again.`
      : `You don't have any dynasties yet. Run \`/dynasty action:New name:<team>\` to create your first one, then \`/dashboard\` again.`;
    return { content: msg, components: [] };
  }

  const state = getState(userId);
  const { data: latestSeason } = await supabase
    .from('dynasty_seasons').select('prestige, tier_num')
    .eq('user_id', userId).eq('dynasty_name', dynastyName)
    .order('season_num', { ascending: false }).limit(1).maybeSingle();

  const { data: dynRow } = await supabase
    .from('dynasties').select('show_tier_ladder').eq('user_id', userId).eq('dynasty_name', dynastyName).single();

  const prestigeLine = latestSeason?.prestige
    ? `Prestige: ${'★'.repeat(latestSeason.prestige)}${'☆'.repeat(Math.max(0, 6 - latestSeason.prestige))}` : null;
  const tierLine = (dynRow?.show_tier_ladder && latestSeason?.tier_num) ? `Tier ${latestSeason.tier_num}` : null;
  const subtitle = [prestigeLine, tierLine].filter(Boolean).join(' · ');

  let body, footer = '', pageSlice = [];
  if (state.tab === 'seasons') {
    const r = await buildSeasonsContent(userId, dynastyName, state);
    body = `🏆 **Season Ledger**\n\n${r.text}`;
    if (r.total) footer = `\n\n-# Page ${r.page + 1} of ${r.maxPage + 1} · ${r.total} season${r.total === 1 ? '' : 's'}`;
  } else if (state.tab === 'roster') {
    const r = await buildRosterContent(userId, dynastyName, state);
    body = `👥 **Roster**\n\n${r.text}`;
    if (r.total) footer = `\n\n-# Page ${r.page + 1} of ${r.maxPage + 1} · ${r.total} player${r.total === 1 ? '' : 's'}`;
  } else if (state.tab === 'recruiting') {
    const r = await buildRecruitingContent(userId, dynastyName, state);
    body = `🎯 **Recruiting Targets**\n\n${r.text}`;
    if (r.total) footer = `\n\n-# Page ${r.page + 1} of ${r.maxPage + 1} · ${r.total} target${r.total === 1 ? '' : 's'} · pick one below to commit to the roster`;
    pageSlice = r.slice ?? [];
  } else if (state.tab === 'needs') {
    const r = await buildNeedsContent(userId, dynastyName);
    body = `📋 **Roster Needs**\n\n${r.text}`;
  } else if (state.tab === 'switch') {
    const dynasties = await getDynasties(userId);
    body = dynasties.length
      ? `🔁 **Switch Dynasty**\n\nPick one from the menu below.`
      : `You don't have any other dynasties yet. Use \`/dynasty action:New\` to create one.`;
  }

  const header = `**${dynastyName}**${subtitle ? `\n-# ${subtitle}` : ''}`;
  const content = `${header}\n\n${body}${footer}`;

  return { content, components: await buildComponents(userId, state, pageSlice) };
}

async function buildComponents(userId, state, pageSlice = []) {
  const rows = [];

  // Pagination row (only where relevant)
  if (state.tab === 'seasons' || state.tab === 'roster' || state.tab === 'recruiting') {
    const pageKey = state.tab === 'seasons' ? 'seasonPage' : state.tab === 'roster' ? 'rosterPage' : 'recruitingPage';
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`dash_page_${state.tab}_prev`).setLabel('◀ Prev').setStyle(ButtonStyle.Secondary)
        .setDisabled(state[pageKey] === 0),
      new ButtonBuilder().setCustomId(`dash_page_${state.tab}_next`).setLabel('Next ▶').setStyle(ButtonStyle.Secondary),
    ));
  }

  // Commit-to-roster select menu — only on the Recruiting tab, only if this page has targets
  if (state.tab === 'recruiting' && pageSlice.length) {
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId('dash_commit_select').setPlaceholder('Commit a recruit to the roster…')
        .addOptions(pageSlice.map(p => new StringSelectMenuOptionBuilder()
          .setLabel(`${p.name} — ${p.pos}`).setDescription(`${p.status} · ${p.recruit_type}`).setValue(String(p.id))))
    ));
  }

  // Switch dynasty select menu (only on the switch tab)
  if (state.tab === 'switch') {
    const dynasties = await getDynasties(userId);
    if (dynasties.length) {
      rows.push(new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder().setCustomId('dash_switch_select').setPlaceholder('Choose a dynasty…')
          .addOptions(dynasties.map(d => new StringSelectMenuOptionBuilder().setLabel(d.dynasty_name).setValue(d.dynasty_name)))
      ));
    }
  }

  // Tab row
  const mk = (id, label, tab) => new ButtonBuilder().setCustomId(id).setLabel(label)
    .setStyle(state.tab === tab ? ButtonStyle.Success : ButtonStyle.Secondary);
  rows.push(new ActionRowBuilder().addComponents(
    mk('dash_tab_seasons', '🏆 Seasons', 'seasons'),
    mk('dash_tab_roster', '👥 Roster', 'roster'),
    mk('dash_tab_recruiting', '🎯 Recruiting', 'recruiting'),
    mk('dash_tab_needs', '📋 Needs', 'needs'),
    mk('dash_tab_switch', '🔁 Switch', 'switch'),
  ));

  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// COMMAND + COMPONENT HANDLERS
// ─────────────────────────────────────────────────────────────────────────────

export async function handleDashboardCommand(interaction) {
  const userId = interaction.user.id;
  if (interaction.guild) {
    return interaction.reply({ content: '👋 This is a DM-only bot. Send me a direct message to use it!', flags: MessageFlags.Ephemeral });
  }

  await interaction.deferReply();
  getState(userId).tab = 'seasons'; // always open fresh on Seasons
  const payload = await buildDashboardPayload(userId);

  // Edit the existing dashboard message in place if one exists in this channel
  const { data: cfg } = await supabase.from('dashboard_config').select('message_id, channel_id').eq('user_id', userId).single();
  if (cfg?.message_id && cfg.channel_id === interaction.channelId) {
    const existing = await interaction.channel.messages.fetch(cfg.message_id).catch(() => null);
    if (existing) {
      await existing.edit(payload);
      await interaction.deleteReply().catch(() => {});
      return;
    }
  }

  const sent = await interaction.editReply(payload);
  await supabase.from('dashboard_config')
    .upsert({ user_id: userId, message_id: sent.id, channel_id: interaction.channelId }, { onConflict: 'user_id' });
}

export async function handleDashboardButton(interaction) {
  if (!interaction.customId.startsWith('dash_')) return false;
  const userId = interaction.user.id;
  await interaction.deferUpdate();

  const state = getState(userId);

  if (interaction.customId === 'dash_tab_seasons') state.tab = 'seasons';
  else if (interaction.customId === 'dash_tab_roster') state.tab = 'roster';
  else if (interaction.customId === 'dash_tab_recruiting') state.tab = 'recruiting';
  else if (interaction.customId === 'dash_tab_needs') state.tab = 'needs';
  else if (interaction.customId === 'dash_tab_switch') state.tab = 'switch';
  else if (interaction.customId === 'dash_page_seasons_prev') state.seasonPage = Math.max(0, state.seasonPage - 1);
  else if (interaction.customId === 'dash_page_seasons_next') state.seasonPage += 1;
  else if (interaction.customId === 'dash_page_roster_prev') state.rosterPage = Math.max(0, state.rosterPage - 1);
  else if (interaction.customId === 'dash_page_roster_next') state.rosterPage += 1;
  else if (interaction.customId === 'dash_page_recruiting_prev') state.recruitingPage = Math.max(0, state.recruitingPage - 1);
  else if (interaction.customId === 'dash_page_recruiting_next') state.recruitingPage += 1;

  const payload = await buildDashboardPayload(userId);
  await interaction.editReply(payload);
  return true;
}

export async function handleDashboardSelect(interaction) {
  const userId = interaction.user.id;

  if (interaction.customId === 'dash_commit_select') {
    await interaction.deferUpdate();
    const rowId = interaction.values[0];
    await supabase.from('dynasty_roster').update({ status: 'On Roster' }).eq('id', rowId);

    const state = getState(userId);
    // Stay on Recruiting tab; if this was the last one on the page, back up a page
    const dynastyName = await getActiveDynasty(userId);
    const { data: remaining } = await supabase
      .from('dynasty_roster').select('id', { count: 'exact', head: true })
      .eq('user_id', userId).eq('dynasty_name', dynastyName).in('status', ['Target', 'Signed']);
    if (remaining !== null && state.recruitingPage > 0 && state.recruitingPage * PLAYERS_PER_PAGE >= (remaining ?? 0)) {
      state.recruitingPage -= 1;
    }

    const payload = await buildDashboardPayload(userId);
    await interaction.editReply(payload);
    return true;
  }

  if (interaction.customId !== 'dash_switch_select') return false;
  await interaction.deferUpdate();

  const chosen = interaction.values[0];
  await setActiveDynasty(userId, chosen);

  const state = getState(userId);
  state.tab = 'seasons'; // land on Seasons for the newly-active dynasty
  state.seasonPage = 0;
  state.rosterPage = 0;
  state.recruitingPage = 0;

  const payload = await buildDashboardPayload(userId);
  await interaction.editReply(payload);
  return true;
}
