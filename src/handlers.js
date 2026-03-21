// handlers.js
// DB helpers, display builders, and all interaction handlers.

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';

import { supabase } from './db.js';
import { SHORTLIST_STARTER_TYPES, shortlistRowColor, shortlistRowText, encodeLeague } from './utils.js';

export const activeEdits = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// TIME / SCHEDULE HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const TZ_OFFSETS = { ET: -5, CT: -6, MT: -7, PT: -8, GMT: 0 };

// Normalize timezone input → canonical abbreviation
export function normalizeTz(input) {
  const s = input.trim().toUpperCase().replace(/\s+/g, '');
  const map = {
    // Eastern
    ET: 'ET', EST: 'ET', EDT: 'ET', EASTERN: 'ET', EASTERNTIME: 'ET',
    // Central
    CT: 'CT', CST: 'CT', CDT: 'CT', CENTRAL: 'CT', CENTRALTIME: 'CT',
    // Mountain
    MT: 'MT', MST: 'MT', MDT: 'MT', MOUNTAIN: 'MT', MOUNTAINTIME: 'MT',
    // Pacific
    PT: 'PT', PST: 'PT', PDT: 'PT', PACIFIC: 'PT', PACIFICTIME: 'PT',
    // GMT / UTC
    GMT: 'GMT', UTC: 'GMT', Z: 'GMT',
  };
  return map[s] ?? null;
}

// Parse "9pm", "8:30pm", "21:00" → { hours, minutes } in 24h
export function parseTimeString(str) {
  str = str.trim().toLowerCase();
  const ampm = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/.exec(str);
  if (ampm) {
    let h = parseInt(ampm[1]);
    const m = parseInt(ampm[2] ?? '0');
    if (ampm[3] === 'pm' && h !== 12) h += 12;
    if (ampm[3] === 'am' && h === 12) h = 0;
    if (h < 0 || h > 23 || m < 0 || m > 59) return null;
    return { hours: h, minutes: m };
  }
  const mil = /^(\d{1,2}):(\d{2})$/.exec(str);
  if (mil) {
    const h = parseInt(mil[1]), m = parseInt(mil[2]);
    if (h < 0 || h > 23 || m < 0 || m > 59) return null;
    return { hours: h, minutes: m };
  }
  return null;
}

// Returns the next UTC Date for a given weekday + local time + tz abbreviation
export function nextOccurrence(dayOfWeek, hours, minutes, tzAbbr) {
  const canonical = normalizeTz(tzAbbr);
  if (!canonical) return null;
  const offset = TZ_OFFSETS[canonical];

  const now = new Date();
  // Work in UTC, shifting for the timezone offset
  const localNow = new Date(now.getTime() + offset * 3600 * 1000);

  // Build a candidate date: this week's dayOfWeek at the given local time
  const candidate = new Date(localNow);
  candidate.setUTCHours(hours, minutes, 0, 0);
  const diff = (dayOfWeek - localNow.getUTCDay() + 7) % 7;
  candidate.setUTCDate(candidate.getUTCDate() + diff);

  // If the candidate is in the past (or within 60s), push to next week
  if (candidate.getTime() <= now.getTime() + 60000) {
    candidate.setUTCDate(candidate.getUTCDate() + 7);
  }

  // Convert back to UTC by subtracting the offset
  return new Date(candidate.getTime() - offset * 3600 * 1000);
}

// ─────────────────────────────────────────────────────────────────────────────
// DB HELPERS
// ─────────────────────────────────────────────────────────────────────────────

export async function getOrSeedShortlistTypes(userId) {
  const { data: existing } = await supabase
    .from('shortlist_types').select('*').eq('user_id', userId).order('sort_order');
  if (existing?.length) return existing;

  const rows = SHORTLIST_STARTER_TYPES.map((t, i) => ({
    user_id: userId, name: t.name, icon: t.icon, is_advance: t.is_advance ?? false, sort_order: i + 1,
  }));
  const { data: seeded } = await supabase.from('shortlist_types').insert(rows).select();
  return seeded ?? [];
}

export async function getShortlistData(userId, types) {
  const { data: rows } = await supabase
    .from('shortlist').select('*').eq('user_id', userId).order('priority_order');

  // Fill gaps for any league missing rows for newer types
  const leagues = [...new Set((rows ?? []).map(r => r.league_name))];
  for (const name of leagues) await seedLeagueRows(userId, name, types, rows ?? []);

  const { data: fresh } = await supabase
    .from('shortlist').select('*').eq('user_id', userId).order('priority_order');
  const normalized = fresh ?? [];

  // Ensure all rows per league share the same priority_order (min value)
  const leagueMap = new Map();
  for (const row of normalized) {
    const cur = leagueMap.get(row.league_name);
    if (cur === undefined || row.priority_order < cur) leagueMap.set(row.league_name, row.priority_order);
  }
  const toFix = normalized.filter(r => r.priority_order !== leagueMap.get(r.league_name));
  for (const row of toFix) {
    await supabase.from('shortlist').update({ priority_order: leagueMap.get(row.league_name) }).eq('id', row.id);
  }
  if (toFix.length) {
    const { data: renorm } = await supabase
      .from('shortlist').select('*').eq('user_id', userId).order('priority_order');
    return { rows: renorm ?? [] };
  }

  return { rows: normalized };
}

export async function seedLeagueRows(userId, leagueName, types, existingRows = []) {
  const missing = types.filter(t => !existingRows.find(r => r.league_name === leagueName && r.type_id === t.id));
  if (!missing.length) return;

  const existingLeagues = new Set(existingRows.map(r => r.league_name));
  existingLeagues.delete(leagueName);
  const leagueOrder = existingLeagues.size + 1;

  await supabase.from('shortlist').insert(
    missing.map(t => ({ user_id: userId, league_name: leagueName, type_id: t.id, state: 'off', priority_order: leagueOrder }))
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SHORTLIST POST (edit-in-place or send new)
// ─────────────────────────────────────────────────────────────────────────────

export async function postShortlist(channel, types, rows, activeState, userId) {
  const { content } = buildShortlistContent(types, rows, activeState);
  const components  = buildShortlistComponents(types, rows, activeState ?? { step: 'main' });
  const payload     = { content, components };

  if (userId) {
    const { data: cfg } = await supabase
      .from('shortlist_config').select('message_id, channel_id').eq('user_id', userId).single();
    if (cfg?.message_id && cfg.channel_id === channel.id) {
      const existing = await channel.messages.fetch(cfg.message_id).catch(() => null);
      if (existing) { await existing.edit(payload); return existing; }
    }
  }

  const newMsg = await channel.send(payload);
  if (userId) {
    await supabase.from('shortlist_config')
      .upsert({ user_id: userId, message_id: newMsg.id, channel_id: channel.id }, { onConflict: 'user_id' });
  }
  return newMsg;
}

// ─────────────────────────────────────────────────────────────────────────────
// DISPLAY BUILDERS
// ─────────────────────────────────────────────────────────────────────────────

function buildShortlistContent(types, rows, activeState) {
  const leagueNames = [...new Set(rows.map(r => r.league_name))];
  if (!leagueNames.length) {
    return { content: '📋 **Your Shortlist**\n\nNo leagues yet — use **Add league** to get started.' };
  }

  const leagueData = leagueNames.map(name => {
    const items = rows.filter(r => r.league_name === name);
    return { name, items, order: Math.min(...items.map(r => r.priority_order ?? 999)) };
  }).sort((a, b) => a.order - b.order);

  const advType = types.find(t => t.is_advance);
  const lines   = leagueData.map((g, i) => {
    const advRow = advType && g.items.find(r => r.type_id === advType.id);
    return shortlistRowText(i + 1, g.name, g.items, types, advRow?.advance_time ?? null);
  });

  const isEditing = activeState && ['edit_toggles', 'item_state_pick'].includes(activeState.step);
  const editingLine = isEditing ? `\n\n✏️ Updating **${activeState.leagueName}**` : '';
  const header = `📋 **Your Shortlist** — ${leagueNames.length} league${leagueNames.length !== 1 ? 's' : ''}`;
  return { content: header + '\n\n' + lines.join('\n') + editingLine };
}

function buildShortlistComponents(types, rows, state) {
  const leagues = [...new Set(rows.map(r => r.league_name))];
  const out = [];

  if (state.step === 'main') {
    // Row 1: Update + Advance
    out.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('sl_btn_edit').setLabel('✏️ Update').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('sl_btn_advance').setLabel('✅ Advance').setStyle(ButtonStyle.Success),
    ));
    // Row 2: Add, Rename, Remove (+ Reorder if multiple leagues)
    const row2 = [
      new ButtonBuilder().setCustomId('sl_btn_add').setLabel('➕ Add').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('sl_btn_rename').setLabel('🏷️ Rename').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('sl_btn_remove').setLabel('🗑️ Remove').setStyle(ButtonStyle.Danger),
    ];
    if (leagues.length > 1) {
      row2.push(new ButtonBuilder().setCustomId('sl_btn_reorder').setLabel('↕️ Reorder').setStyle(ButtonStyle.Secondary));
    }
    out.push(new ActionRowBuilder().addComponents(row2));

  } else if (state.step === 'advance_pick') {
    out.push(leaguePicker('sl_advance_league', leagues, 'Complete Advance for which league?'));
    out.push(backRow());


  } else if (state.step === 'edit_pick') {
    out.push(leaguePicker('sl_edit_league', leagues, 'Pick a league to update…'));
    out.push(backRow());

  } else if (state.step === 'rename_pick') {
    out.push(leaguePicker('sl_rename_pick', leagues, 'Pick a league to rename…'));
    out.push(backRow());

  } else if (state.step === 'remove_pick') {
    out.push(leaguePicker('sl_remove_pick', leagues, 'Pick a league to remove…'));
    out.push(backRow());

  } else if (state.step === 'reorder_a') {
    out.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('sl_reorder_a').setPlaceholder('Move which league?')
        .addOptions(leagues.map((name, i) =>
          new StringSelectMenuOptionBuilder().setLabel(`${i + 1}. ${name}`).setValue(name)
        ))
    ));
    out.push(backRow());

  } else if (state.step === 'reorder_b') {
    const currentPos = leagues.indexOf(state.leagueNameA) + 1;
    out.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`sl_reorder_b_${encodeLeague(state.leagueNameA)}`)
        .setPlaceholder(`Move to which position? (currently #${currentPos})`)
        .addOptions(
          leagues
            .map((name, i) => ({ name, pos: i + 1 }))
            .filter(({ name }) => name !== state.leagueNameA)
            .map(({ name, pos }) =>
              new StringSelectMenuOptionBuilder().setLabel(`Position ${pos} — ${name}`).setValue(String(pos))
            )
        )
    ));
    out.push(backRow());

  } else if (state.step === 'edit_toggles') {
    const leagueItems = rows.filter(r => r.league_name === state.leagueName);
    const advType     = types.find(t => t.is_advance);
    const advItem     = advType && leagueItems.find(r => r.type_id === advType.id);
    const enc         = encodeLeague(state.leagueName);

    const STATE_STYLE  = { off: ButtonStyle.Secondary, active: ButtonStyle.Success, done: ButtonStyle.Success, paused: ButtonStyle.Primary };
    const STATE_PREFIX = { off: '⬜ ', active: '🟢 ', done: '✅ ', paused: '⏸️ ' };

    // Item toggle buttons (row per 5)
    const itemBtns = types.map(t => {
      const item   = leagueItems.find(r => r.type_id === t.id);
      const iState = item?.state ?? 'off';
      return new ButtonBuilder()
        .setCustomId(`sl_select_${enc}_${t.id}`)
        .setLabel(`${STATE_PREFIX[iState]}${t.icon} ${t.name}`)
        .setStyle(STATE_STYLE[iState]);
    });
    for (let i = 0; i < itemBtns.length; i += 5) out.push(new ActionRowBuilder().addComponents(itemBtns.slice(i, i + 5)));

    // Timer button — shows active timer label if set
    const advDueVal  = advItem?.advance_due ?? null;
    const advTimeVal = advItem?.advance_time ?? null;
    const dueMs      = advDueVal ? new Date(advDueVal).getTime() : null;
    const hoursLeft  = dueMs ? Math.max(0, Math.round((dueMs - Date.now()) / 3600000)) : null;
    const timerLbl   = hoursLeft !== null ? `⏱️ ${hoursLeft}h left` : (advTimeVal ? `⏱️ ${advTimeVal}` : '⏱️ Set timer');
    const timerStyle = dueMs && dueMs > Date.now() ? ButtonStyle.Success : (advTimeVal ? ButtonStyle.Primary : ButtonStyle.Secondary);

    out.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`sl_timer_menu_${enc}`).setLabel(timerLbl).setStyle(timerStyle),
      new ButtonBuilder().setCustomId('sl_back').setLabel('← Back').setStyle(ButtonStyle.Primary),
    ));

  } else if (state.step === 'timer_pick') {
    // Sub-step: one-shot timers + day picker + back
    const enc = encodeLeague(state.leagueName);
    const advItem = rows.find(r => r.league_name === state.leagueName && types.find(t => t.is_advance && t.id === r.type_id));
    const advDueVal = advItem?.advance_due ?? null;
    const dueMs     = advDueVal ? new Date(advDueVal).getTime() : null;
    const nowMs     = Date.now();
    const hoursLeft = dueMs ? Math.max(0, Math.round((dueMs - nowMs) / 3600000)) : null;
    const timerLabel = hoursLeft !== null ? `⏱️ ${hoursLeft}h left` : null;

    // One-shot timers + clear
    out.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`sl_timer_${enc}_24`)
        .setLabel(timerLabel && hoursLeft <= 24 ? timerLabel : '⏱️ 24h')
        .setStyle(dueMs && (dueMs - nowMs) <= 24*3600000 && dueMs > nowMs ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`sl_timer_${enc}_48`)
        .setLabel(timerLabel && hoursLeft > 24 && hoursLeft <= 48 ? timerLabel : '⏱️ 48h')
        .setStyle(dueMs && (dueMs - nowMs) > 24*3600000 && (dueMs - nowMs) <= 48*3600000 ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`sl_timer_${enc}_72`)
        .setLabel(timerLabel && hoursLeft > 48 ? timerLabel : '⏱️ 72h')
        .setStyle(dueMs && (dueMs - nowMs) > 48*3600000 ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`sl_timer_${enc}_clear`)
        .setLabel('⏱️ Clear')
        .setStyle(ButtonStyle.Danger),
    ));

    // Weekly schedule day picker (Sun–Thu)
    out.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`sl_sched_${enc}_0`).setLabel('Sun').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`sl_sched_${enc}_1`).setLabel('Mon').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`sl_sched_${enc}_2`).setLabel('Tue').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`sl_sched_${enc}_3`).setLabel('Wed').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`sl_sched_${enc}_4`).setLabel('Thu').setStyle(ButtonStyle.Secondary),
    ));
    // Fri–Sat + back
    out.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`sl_sched_${enc}_5`).setLabel('Fri').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`sl_sched_${enc}_6`).setLabel('Sat').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`sl_back_to_toggles_${enc}`).setLabel('← Back').setStyle(ButtonStyle.Primary),
    ));

  } else if (state.step === 'item_state_pick') {
    const item = rows.find(r => r.league_name === state.leagueName && r.type_id === state.typeId);
    const cur  = item?.state ?? 'off';
    const enc  = encodeLeague(state.leagueName);
    const mk   = (label, value, style) => new ButtonBuilder()
      .setCustomId(`sl_setstate_${enc}_${state.typeId}_${value}`)
      .setLabel(label).setStyle(cur === value ? ButtonStyle.Danger : style);
    out.push(new ActionRowBuilder().addComponents(
      mk('🟢 Active', 'active', ButtonStyle.Success),
      mk('✅ Done',   'done',   ButtonStyle.Success),
      mk('⏸️ Paused','paused', ButtonStyle.Primary),
      mk('⬜ Off',    'off',    ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`sl_cancel_pick_${enc}`).setLabel('← Cancel').setStyle(ButtonStyle.Secondary),
    ));
  }

  return out;
}

// small helpers
function leaguePicker(customId, leagues, placeholder) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder(placeholder)
      .addOptions(leagues.map(name => new StringSelectMenuOptionBuilder().setLabel(name).setValue(name)))
  );
}
function backRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('sl_back').setLabel('← Back').setStyle(ButtonStyle.Primary)
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ONBOARDING
// ─────────────────────────────────────────────────────────────────────────────

export const onboardingSessions = new Map();

const WELCOME_MSG = `👋 **Welcome to DAT — Dynasty Advance Tracker!**

DAT helps you track your tasks in every dynasty league with an easy reset button when a league advances, all from your DMs. No server required.

**How it works**
→ Each league has item types: **Advance ⏰**, **Game 🏈**, **Recruiting 🎯**, **Other 📋**
→ Mark items active, done, paused, or off as your cycle progresses
→ When everything except Advance is done, you'll see 🟢 — ready to push!

**Setup takes about 30 seconds.** Let's start!

📝 **What are your league names?**
Type them separated by commas (e.g. \`Big 12 Dynasty, SEC Rebuild, FCS Grind\`) or one at a time.`;

export async function startOnboarding(dmChannel, userId) {
  await supabase.from('shortlist_config')
    .upsert({ user_id: userId, onboarding: true }, { onConflict: 'user_id' });
  onboardingSessions.set(userId, { step: 'awaiting_leagues' });
  await dmChannel.send(WELCOME_MSG);
}

// Returns true if the message was consumed by onboarding
export async function handleOnboardingMessage(message) {
  const userId  = message.author.id;
  const session = onboardingSessions.get(userId);
  if (!session) return false;

  const text = message.content.trim();
  if (!text) return true;

  if (session.step === 'awaiting_leagues') {
    const names = text.split(',').map(s => s.trim()).filter(Boolean).slice(0, 20);
    if (!names.length) { await message.reply('Please enter at least one league name.'); return true; }

    const types = await getOrSeedShortlistTypes(userId);
    for (const name of names) {
      const { rows: existing } = await getShortlistData(userId, types);
      if (!existing.find(r => r.league_name.toLowerCase() === name.toLowerCase())) {
        await seedLeagueRows(userId, name, types, existing);
      }
    }

    onboardingSessions.delete(userId);
    const { rows } = await getShortlistData(userId, types);

    await message.reply(
      `✅ Added **${names.length}** league${names.length !== 1 ? 's' : ''}. Here's your shortlist!\n\n` +
      `Use the menu below to update items as your cycle progresses. Run \`/help\` any time for a quick overview.`
    );
    await postShortlist(message.channel, types, rows, { step: 'main' }, userId);
    return true;
  }

  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// COMMAND HANDLER
// ─────────────────────────────────────────────────────────────────────────────

const HELP_TEXT = `📋 **DAT — Dynasty Advance Tracker**

**Item types** (per league)
⏰ **Advance** — protected cycle-reset trigger
🏈 **Game** · 🎯 **Recruiting** · 📋 **Other**

**States:** 🟢 Active → ✅ Done → ⏸️ Paused → ⬜ Off

**Colour key**
🟢  Ready to push (Advance active, everything else done/paused)
🔵  Items still in progress
⏸️  All visible items paused

**Commands**
\`/shortlist\` — open the tracker
\`/shortlist-config\` — add, remove, or rename item types
\`/setup\` — add more leagues
\`/help\` — this message
\`/feedback\` — send a note to the developer`;

export async function handleCommand(interaction, client) {
  const { commandName } = interaction;
  const userId = interaction.user.id;

  if (interaction.guild) {
    return interaction.reply({ content: '👋 DAT is a DM-only bot. Send me a direct message to use it!', flags: MessageFlags.Ephemeral });
  }

  // /shortlist
  if (commandName === 'shortlist') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const channel = await interaction.user.createDM();
    const types   = await getOrSeedShortlistTypes(userId);
    const { rows } = await getShortlistData(userId, types);

    if (!rows.length) {
      return interaction.editReply({ content: "You don't have any leagues yet. Run `/setup` to add some!" });
    }

    activeEdits.set(userId, { type: 'shortlist', step: 'main' });
    await postShortlist(channel, types, rows, { step: 'main' }, userId);
    return interaction.editReply({ content: '✅ Shortlist posted.' });
  }

  // /shortlist-config
  if (commandName === 'shortlist-config') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const action  = interaction.options.getString('action');
    const name    = interaction.options.getString('name')?.trim();
    const icon    = interaction.options.getString('icon')?.trim();
    const newName = interaction.options.getString('new_name')?.trim();
    const types   = await getOrSeedShortlistTypes(userId);

    if (action === 'add') {
      if (!name || !icon) return interaction.editReply({ content: 'Please provide both a **name** and an **icon** emoji.' });
      if (types.find(t => t.name.toLowerCase() === name.toLowerCase())) return interaction.editReply({ content: `A type named **${name}** already exists.` });
      const maxOrder = types.reduce((m, t) => Math.max(m, t.sort_order), 0);
      await supabase.from('shortlist_types').insert({ user_id: userId, name, icon, is_advance: false, sort_order: maxOrder + 1 });
      return interaction.editReply({ content: `✅ Added **${icon} ${name}** to your item types.` });
    }
    if (action === 'remove') {
      if (!name) return interaction.editReply({ content: 'Please provide the **name** of the type to remove.' });
      const match = types.find(t => t.name.toLowerCase() === name.toLowerCase());
      if (!match) return interaction.editReply({ content: `No type named **${name}** found.` });
      if (match.is_advance) return interaction.editReply({ content: '⏰ **Advance** cannot be removed.' });
      await supabase.from('shortlist').delete().eq('type_id', match.id);
      await supabase.from('shortlist_types').delete().eq('id', match.id);
      return interaction.editReply({ content: `🗑️ Removed **${match.icon} ${match.name}**.` });
    }
    if (action === 'rename') {
      if (!name || !newName) return interaction.editReply({ content: 'Please provide the **current name** and a **new name**.' });
      const match = types.find(t => t.name.toLowerCase() === name.toLowerCase());
      if (!match) return interaction.editReply({ content: `No type named **${name}** found.` });
      if (match.is_advance) return interaction.editReply({ content: '⏰ **Advance** cannot be renamed.' });
      await supabase.from('shortlist_types').update({ name: newName }).eq('id', match.id);
      return interaction.editReply({ content: `✅ Renamed **${match.name}** → **${newName}**.` });
    }
    return interaction.editReply({ content: 'Unknown action.' });
  }

  // /setup
  if (commandName === 'setup') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const dmChannel = await interaction.user.createDM();
    onboardingSessions.set(userId, { step: 'awaiting_leagues' });
    await dmChannel.send(
      `➕ **Add leagues to your shortlist**\n\n` +
      `Type your league names separated by commas, or one at a time.\n` +
      `Already-existing leagues will be skipped automatically.`
    );
    return interaction.editReply({ content: '👍 Go ahead and type your league names below.' });
  }

  // /help
  if (commandName === 'help') {
    return interaction.reply({ content: HELP_TEXT, flags: MessageFlags.Ephemeral });
  }

  // /feedback
  if (commandName === 'feedback') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const text = interaction.options.getString('message');
    await supabase.from('feedback').insert({ user_id: userId, username: interaction.user.username, message: text, created_at: new Date().toISOString() });
    if (process.env.FEEDBACK_USER_ID && client) {
      try {
        const dev = await client.users.fetch(process.env.FEEDBACK_USER_ID);
        const dm  = await dev.createDM();
        await dm.send(`📬 **Feedback from ${interaction.user.username}** (\`${userId}\`)\n\n${text}`);
      } catch { /* non-fatal */ }
    }
    return interaction.editReply({ content: '✅ Thanks! Your feedback has been sent.' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// BUTTON HANDLER
// ─────────────────────────────────────────────────────────────────────────────

export async function handleButton(interaction) {
  const id     = interaction.customId;
  const userId = interaction.user.id;
  if (!id.startsWith('sl_')) return;

  // sl_set_time_, sl_btn_add, sl_sched_ open modals — cannot deferUpdate before showModal

  // sl_timer_menu_{enc} — open timer sub-step (needs deferUpdate, so placed before modal block)
  if (id.startsWith('sl_timer_menu_')) {
    await interaction.deferUpdate();
    const typesT   = await getOrSeedShortlistTypes(userId);
    const { rows: rowsT } = await getShortlistData(userId, typesT);
    const channelT = await interaction.user.createDM();
    const enc        = id.replace('sl_timer_menu_', '');
    const leagueName = rowsT.find(r => encodeLeague(r.league_name) === enc)?.league_name ?? enc;
    activeEdits.set(userId, { type: 'shortlist', step: 'timer_pick', leagueName });
    await postShortlist(channelT, typesT, rowsT, { step: 'timer_pick', leagueName }, userId);
    return;
  }

  // sl_back_to_toggles_{enc} — back from timer_pick to edit_toggles
  if (id.startsWith('sl_back_to_toggles_')) {
    await interaction.deferUpdate();
    const typesT   = await getOrSeedShortlistTypes(userId);
    const { rows: rowsT } = await getShortlistData(userId, typesT);
    const channelT = await interaction.user.createDM();
    const enc        = id.replace('sl_back_to_toggles_', '');
    const leagueName = rowsT.find(r => encodeLeague(r.league_name) === enc)?.league_name ?? enc;
    activeEdits.set(userId, { type: 'shortlist', step: 'edit_toggles', leagueName });
    await postShortlist(channelT, typesT, rowsT, { step: 'edit_toggles', leagueName }, userId);
    return;
  }

  if (id.startsWith('sl_sched_')) {
    const parts    = id.replace('sl_sched_', '').split('_');
    const dayIndex = parts[parts.length - 1];
    const enc      = parts.slice(0, parts.length - 1).join('_');
    const leagueName = rows.find(r => encodeLeague(r.league_name) === enc)?.league_name ?? enc;
    const days     = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const dayName  = days[parseInt(dayIndex)];
    const titleName = leagueName.length > 20 ? leagueName.slice(0, 17) + '...' : leagueName;

    const modal = new ModalBuilder()
      .setCustomId(`sl_sched_modal_${enc}_${dayIndex}`)
      .setTitle(`Schedule — ${titleName}`);
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('sched_time_input')
          .setLabel(`Next advance time on ${dayName} (e.g. 9pm)`)
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(10)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('sched_tz_input')
          .setLabel('Timezone (ET, CT, MT, PT, GMT)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(5)
          .setValue('ET')
      )
    );
    return interaction.showModal(modal);
  }

  if (id === 'sl_btn_add') {
    const modal = new ModalBuilder().setCustomId('sl_add_league_modal').setTitle('Add League');
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('league_name_input').setLabel('League name')
        .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(50)
    ));
    return interaction.showModal(modal);
  }

  if (id.startsWith('sl_set_time_')) {
    const types = await getOrSeedShortlistTypes(userId);
    const { rows } = await getShortlistData(userId, types);
    const enc        = id.replace('sl_set_time_', '');
    const leagueName = rows.find(r => encodeLeague(r.league_name) === enc)?.league_name ?? enc;
    const advType    = types.find(t => t.is_advance);
    const advRow     = advType && rows.find(r => r.league_name === leagueName && r.type_id === advType.id);
    const titleName  = leagueName.length > 30 ? leagueName.slice(0, 27) + '...' : leagueName;

    const modal = new ModalBuilder().setCustomId(`sl_time_modal_${enc}`).setTitle(`Advance time — ${titleName}`);
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('advance_time_input')
        .setLabel('Day + time (e.g. Fri 9pm) or blank')
        .setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(20)
        .setValue(advRow?.advance_time ?? '')
    ));
    return interaction.showModal(modal);
  }

  await interaction.deferUpdate();
  const types   = await getOrSeedShortlistTypes(userId);
  let { rows }  = await getShortlistData(userId, types);
  const channel = await interaction.user.createDM();

  // ── Main menu icon buttons ──
  if (id === 'sl_btn_edit') {
    activeEdits.set(userId, { type: 'shortlist', step: 'edit_pick' });
    await postShortlist(channel, types, rows, { step: 'edit_pick' }, userId);
    return;
  }
  if (id === 'sl_btn_rename') {
    activeEdits.set(userId, { type: 'shortlist', step: 'rename_pick' });
    await postShortlist(channel, types, rows, { step: 'rename_pick' }, userId);
    return;
  }
  if (id === 'sl_btn_remove') {
    activeEdits.set(userId, { type: 'shortlist', step: 'remove_pick' });
    await postShortlist(channel, types, rows, { step: 'remove_pick' }, userId);
    return;
  }
  if (id === 'sl_btn_reorder') {
    activeEdits.set(userId, { type: 'shortlist', step: 'reorder_a' });
    await postShortlist(channel, types, rows, { step: 'reorder_a' }, userId);
    return;
  }
  if (id === 'sl_btn_advance') {
    activeEdits.set(userId, { type: 'shortlist', step: 'advance_pick' });
    await postShortlist(channel, types, rows, { step: 'advance_pick' }, userId);
    return;
  }

  if (id === 'sl_back') {
    activeEdits.set(userId, { type: 'shortlist', step: 'main' });
    const { content } = buildShortlistContent(types, rows);
    return interaction.editReply({ content, components: buildShortlistComponents(types, rows, { step: 'main' }) });
  }

  if (id.startsWith('sl_select_')) {
    const parts      = id.replace('sl_select_', '').split('_');
    const typeId     = parseInt(parts[parts.length - 1]);
    const enc        = parts.slice(0, parts.length - 1).join('_');
    const leagueName = rows.find(r => encodeLeague(r.league_name) === enc)?.league_name ?? enc;
    activeEdits.set(userId, { type: 'shortlist', step: 'item_state_pick', leagueName, typeId });
    await postShortlist(channel, types, rows, { step: 'item_state_pick', leagueName, typeId }, userId);
    return;
  }

  if (id.startsWith('sl_setstate_')) {
    const without = id.replace('sl_setstate_', '');
    const lastUs2 = without.lastIndexOf('_');
    const newState = without.slice(lastUs2 + 1);
    const rem      = without.slice(0, lastUs2);
    const lastUs1  = rem.lastIndexOf('_');
    const typeId   = parseInt(rem.slice(lastUs1 + 1));
    const enc      = rem.slice(0, lastUs1);
    const leagueName = rows.find(r => encodeLeague(r.league_name) === enc)?.league_name ?? enc;

    const row = rows.find(r => r.league_name === leagueName && r.type_id === typeId);
    if (row) await supabase.from('shortlist').update({ state: newState }).eq('id', row.id);

    const { rows: fresh } = await getShortlistData(userId, types);
    activeEdits.set(userId, { type: 'shortlist', step: 'edit_toggles', leagueName });
    await postShortlist(channel, types, fresh, { step: 'edit_toggles', leagueName }, userId);
    return;
  }

  if (id.startsWith('sl_cancel_pick_')) {
    const enc        = id.replace('sl_cancel_pick_', '');
    const leagueName = rows.find(r => encodeLeague(r.league_name) === enc)?.league_name ?? enc;
    activeEdits.set(userId, { type: 'shortlist', step: 'edit_toggles', leagueName });
    await postShortlist(channel, types, rows, { step: 'edit_toggles', leagueName }, userId);
    return;
  }

  // sl_timer_{enc}_{hours|clear} — set or clear auto-advance timer
  if (id.startsWith('sl_timer_')) {
    const parts      = id.replace('sl_timer_', '').split('_');
    const hoursOrCmd = parts[parts.length - 1];
    const enc        = parts.slice(0, parts.length - 1).join('_');
    const leagueName = rows.find(r => encodeLeague(r.league_name) === enc)?.league_name ?? enc;
    const advType    = types.find(t => t.is_advance);
    const advRow     = advType && rows.find(r => r.league_name === leagueName && r.type_id === advType.id);

    if (advRow) {
      if (hoursOrCmd === 'clear') {
        await supabase.from('shortlist').update({ advance_due: null }).eq('id', advRow.id);
      } else {
        const hours   = parseInt(hoursOrCmd);
        const dueDate = new Date(Date.now() + hours * 3600 * 1000).toISOString();
        await supabase.from('shortlist').update({ advance_due: dueDate }).eq('id', advRow.id);
      }
    }

    const { rows: fresh } = await getShortlistData(userId, types);
    activeEdits.set(userId, { type: 'shortlist', step: 'timer_pick', leagueName });
    await postShortlist(channel, types, fresh, { step: 'timer_pick', leagueName }, userId);
    return;
  }

  if (id.startsWith('sl_advance_complete_')) {
    const enc        = id.replace('sl_advance_complete_', '');
    const leagueName = rows.find(r => encodeLeague(r.league_name) === enc)?.league_name ?? enc;
    const advType    = types.find(t => t.is_advance);

    // Reset all non-Advance active/done items back to active
    const nonAdvTypeIds = types.filter(t => !t.is_advance).map(t => t.id);
    if (nonAdvTypeIds.length) {
      await supabase.from('shortlist')
        .update({ state: 'active' })
        .eq('user_id', userId)
        .eq('league_name', leagueName)
        .in('type_id', nonAdvTypeIds)
        .in('state', ['active', 'done']);
    }

    // Reset Advance itself to active (keep the time)
    if (advType) {
      await supabase.from('shortlist')
        .update({ state: 'active' })
        .eq('user_id', userId)
        .eq('league_name', leagueName)
        .eq('type_id', advType.id);
    }

    const { rows: fresh } = await getShortlistData(userId, types);
    activeEdits.set(userId, { type: 'shortlist', step: 'main' });
    await postShortlist(channel, types, fresh, { step: 'main' }, userId);
    return;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SELECT HANDLER
// ─────────────────────────────────────────────────────────────────────────────

export async function handleSelect(interaction) {
  const userId = interaction.user.id;
  const id     = interaction.customId;
  const value  = interaction.values[0];
  if (!id.startsWith('sl_')) return;

  // sl_rename_pick needs to showModal — can't deferUpdate first
  const isModal = id === 'sl_rename_pick';
  if (!isModal) await interaction.deferUpdate();

  const types   = await getOrSeedShortlistTypes(userId);
  let { rows }  = await getShortlistData(userId, types);
  const channel = await interaction.user.createDM();

  // Helper: update the shortlist message via the interaction
  const reply = (state, r = rows) => {
    const { content } = buildShortlistContent(types, r, state);
    const components  = buildShortlistComponents(types, r, state);
    return interaction.editReply({ content, components });
  };

  if (id === 'sl_action') {
    if (value === 'edit') {
      activeEdits.set(userId, { type: 'shortlist', step: 'edit_pick' });
      await reply({ step: 'edit_pick' });
    }
    if (value === 'reorder') {
      activeEdits.set(userId, { type: 'shortlist', step: 'reorder_a' });
      await reply({ step: 'reorder_a' });
    }
    if (value === 'add_league') {
      const modal = new ModalBuilder().setCustomId('sl_add_league_modal').setTitle('Add League');
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('league_name_input').setLabel('League name')
          .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(50)
      ));
      return interaction.showModal(modal);
    }
    if (value === 'rename_league') {
      activeEdits.set(userId, { type: 'shortlist', step: 'rename_pick' });
      await reply({ step: 'rename_pick' });
    }
    if (value === 'remove_league') {
      activeEdits.set(userId, { type: 'shortlist', step: 'remove_pick' });
      await reply({ step: 'remove_pick' });
    }
    return;
  }

  if (id === 'sl_rename_pick') {
    const enc   = encodeLeague(value);
    const modal = new ModalBuilder().setCustomId(`sl_rename_modal_${enc}`).setTitle('Rename League');
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('new_league_name_input').setLabel('New league name')
        .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(50).setValue(value)
    ));
    return interaction.showModal(modal);
  }

  if (id === 'sl_remove_pick') {
    await supabase.from('shortlist').delete().eq('user_id', userId).eq('league_name', value);
    const { rows: fresh } = await getShortlistData(userId, types);
    activeEdits.set(userId, { type: 'shortlist', step: 'main' });
    await reply({ step: 'main' }, fresh);
    return;
  }

  if (id === 'sl_advance_league') {
    const leagueName = value;
    const advType    = types.find(t => t.is_advance);
    const nonAdvTypeIds = types.filter(t => !t.is_advance).map(t => t.id);
    if (nonAdvTypeIds.length) {
      await supabase.from('shortlist').update({ state: 'active' })
        .eq('user_id', userId).eq('league_name', leagueName)
        .in('type_id', nonAdvTypeIds).in('state', ['active', 'done']);
    }
    if (advType) {
      await supabase.from('shortlist').update({ state: 'active' })
        .eq('user_id', userId).eq('league_name', leagueName).eq('type_id', advType.id);
    }
    const { rows: fresh } = await getShortlistData(userId, types);
    activeEdits.set(userId, { type: 'shortlist', step: 'main' });
    await reply({ step: 'main' }, fresh);
    return;
  }

  if (id === 'sl_edit_league') {
    const leagueName = value;
    activeEdits.set(userId, { type: 'shortlist', step: 'edit_toggles', leagueName });
    await reply({ step: 'edit_toggles', leagueName });
    return;
  }

  if (id === 'sl_reorder_a') {
    activeEdits.set(userId, { type: 'shortlist', step: 'reorder_b', leagueNameA: value });
    await reply({ step: 'reorder_b', leagueNameA: value });
    return;
  }

  if (id.startsWith('sl_reorder_b_')) {
    const leagueNameA = activeEdits.get(userId)?.leagueNameA ?? '';
    const destPos     = parseInt(value);
    const leagueNames = [...new Set(rows.map(r => r.league_name))].sort((a, b) => {
      const oA = Math.min(...rows.filter(r => r.league_name === a).map(r => r.priority_order ?? 999));
      const oB = Math.min(...rows.filter(r => r.league_name === b).map(r => r.priority_order ?? 999));
      return oA - oB;
    });
    const fromPos = leagueNames.indexOf(leagueNameA) + 1;
    if (fromPos > 0 && fromPos !== destPos) {
      const reordered = [...leagueNames];
      reordered.splice(fromPos - 1, 1);
      reordered.splice(destPos - 1, 0, leagueNameA);
      for (let i = 0; i < reordered.length; i++) {
        const ids = rows.filter(r => r.league_name === reordered[i]).map(r => r.id);
        if (ids.length) await supabase.from('shortlist').update({ priority_order: i + 1 }).in('id', ids);
      }
    }
    const { rows: fresh } = await getShortlistData(userId, types);
    activeEdits.set(userId, { type: 'shortlist', step: 'main' });
    await reply({ step: 'main' }, fresh);
    return;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MODAL HANDLER
// ─────────────────────────────────────────────────────────────────────────────

export async function handleModal(interaction) {
  const id     = interaction.customId;
  const userId = interaction.user.id;

  // Add league
  if (id === 'sl_add_league_modal') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const leagueName = interaction.fields.getTextInputValue('league_name_input').trim();
    if (!leagueName) return interaction.editReply({ content: 'League name cannot be empty.' });

    const types = await getOrSeedShortlistTypes(userId);
    const { rows } = await getShortlistData(userId, types);
    if (rows.find(r => r.league_name.toLowerCase() === leagueName.toLowerCase())) {
      return interaction.editReply({ content: `**${leagueName}** is already on your shortlist.` });
    }

    await seedLeagueRows(userId, leagueName, types, rows);
    const { rows: fresh } = await getShortlistData(userId, types);
    activeEdits.set(userId, { type: 'shortlist', step: 'main' });
    await postShortlist(await interaction.user.createDM(), types, fresh, { step: 'main' }, userId);
    return interaction.editReply({ content: `✅ **${leagueName}** added.` });
  }

  // Rename league
  if (id.startsWith('sl_rename_modal_')) {
    await interaction.deferUpdate();
    const enc      = id.replace('sl_rename_modal_', '');
    const newName  = interaction.fields.getTextInputValue('new_league_name_input').trim();
    if (!newName) return;

    const types = await getOrSeedShortlistTypes(userId);
    const { rows } = await getShortlistData(userId, types);
    const oldName = rows.find(r => encodeLeague(r.league_name) === enc)?.league_name ?? enc;
    if (rows.find(r => r.league_name.toLowerCase() === newName.toLowerCase() && r.league_name !== oldName)) return;

    await supabase.from('shortlist').update({ league_name: newName }).eq('user_id', userId).eq('league_name', oldName);
    const { rows: fresh } = await getShortlistData(userId, types);
    activeEdits.set(userId, { type: 'shortlist', step: 'main' });
    await postShortlist(await interaction.user.createDM(), types, fresh, { step: 'main' }, userId);
    return;
  }

  // Weekly schedule modal — parse day + time + tz, compute next occurrence
  if (id.startsWith('sl_sched_modal_')) {
    await interaction.deferUpdate();
    const rest     = id.replace('sl_sched_modal_', '');
    const dayIndex = parseInt(rest[rest.length - 1]);
    const enc      = rest.slice(0, rest.length - 2); // strip _{dayIndex}
    const timeStr  = interaction.fields.getTextInputValue('sched_time_input').trim();
    const tzRaw    = interaction.fields.getTextInputValue('sched_tz_input').trim();
    const tzStr    = normalizeTz(tzRaw) ?? tzRaw.toUpperCase();

    const types = await getOrSeedShortlistTypes(userId);
    const { rows } = await getShortlistData(userId, types);
    const leagueName = rows.find(r => encodeLeague(r.league_name) === enc)?.league_name ?? enc;
    const advType    = types.find(t => t.is_advance);
    const advRow     = advType && rows.find(r => r.league_name === leagueName && r.type_id === advType.id);
    if (!advRow) return;

    // Parse time string → { hours, minutes }
    const parsedTime = parseTimeString(timeStr);
    if (!parsedTime) {
      await interaction.followUp({ content: `❌ Couldn't parse time **${timeStr}** — try something like \`9pm\` or \`8:30pm\`.`, flags: 64 });
      return;
    }

    // Compute next occurrence of dayIndex at parsedTime in tzStr
    const dueDate = nextOccurrence(dayIndex, parsedTime.hours, parsedTime.minutes, tzStr);
    if (!dueDate) {
      await interaction.followUp({ content: `❌ Unknown timezone **${tzRaw}** — try ET, CT, MT, PT, EST, CST, PST, or UTC.`, flags: 64 });
      return;
    }

    const days  = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const label = `${days[dayIndex]} ${timeStr} ${tzStr}`; // tzStr is already canonical

    await supabase.from('shortlist').update({
      advance_due:  dueDate.toISOString(),
      advance_time: label,
    }).eq('id', advRow.id);

    const { rows: fresh } = await getShortlistData(userId, types);
    activeEdits.set(userId, { type: 'shortlist', step: 'edit_toggles', leagueName });
    await postShortlist(interaction.channel ?? await interaction.user.createDM(), types, fresh, { step: 'edit_toggles', leagueName }, userId);
    return;
  }

  // Set advance time
  if (id.startsWith('sl_time_modal_')) {
    await interaction.deferUpdate();
    const enc        = id.replace('sl_time_modal_', '');
    const rawVal     = interaction.fields.getTextInputValue('advance_time_input').trim();
    const newTime    = rawVal || null;

    const types = await getOrSeedShortlistTypes(userId);
    const { rows } = await getShortlistData(userId, types);
    const leagueName = rows.find(r => encodeLeague(r.league_name) === enc)?.league_name ?? enc;
    const advType    = types.find(t => t.is_advance);
    const advRow     = advType && rows.find(r => r.league_name === leagueName && r.type_id === advType.id);
    if (advRow) await supabase.from('shortlist').update({ advance_time: newTime }).eq('id', advRow.id);

    const { rows: fresh } = await getShortlistData(userId, types);
    activeEdits.set(userId, { type: 'shortlist', step: 'edit_toggles', leagueName });
    await postShortlist(await interaction.user.createDM(), types, fresh, { step: 'edit_toggles', leagueName }, userId);
    return;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MESSAGE HANDLER (onboarding DM replies)
// ─────────────────────────────────────────────────────────────────────────────

export async function handleMessage(message) {
  if (message.author.bot) return;
  if (message.guild) return; // DMs only

  const userId = message.author.id;

  // Onboarding takes priority
  if (await handleOnboardingMessage(message)) return;

  // First-ever DM from a user with no data → start onboarding
  const { data: existing } = await supabase
    .from('shortlist').select('id').eq('user_id', userId).limit(1);
  if (!existing?.length && !onboardingSessions.has(userId)) {
    await startOnboarding(message.channel, userId);
    return;
  }

  // Returning user sent a message — nudge them to use the commands
  await message.reply('Use `/shortlist` to open your tracker, or `/help\` for a full overview.');
}
