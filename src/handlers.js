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
    const options = [
      new StringSelectMenuOptionBuilder().setLabel('Update league').setValue('edit').setEmoji('✏️'),
      new StringSelectMenuOptionBuilder().setLabel('Add league').setValue('add_league').setEmoji('➕'),
      new StringSelectMenuOptionBuilder().setLabel('Rename league').setValue('rename_league').setEmoji('🏷️'),
      new StringSelectMenuOptionBuilder().setLabel('Remove league').setValue('remove_league').setEmoji('🗑️'),
    ];
    if (leagues.length > 1) options.splice(1, 0,
      new StringSelectMenuOptionBuilder().setLabel('Reorder leagues').setValue('reorder').setEmoji('↕️')
    );
    out.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId('sl_action').setPlaceholder('Choose an action…').addOptions(options)
    ));

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

    const itemBtns = types.map(t => {
      const item   = leagueItems.find(r => r.type_id === t.id);
      const iState = item?.state ?? 'off';
      return new ButtonBuilder()
        .setCustomId(`sl_select_${enc}_${t.id}`)
        .setLabel(`${STATE_PREFIX[iState]}${t.icon} ${t.name}`)
        .setStyle(STATE_STYLE[iState]);
    });
    for (let i = 0; i < itemBtns.length; i += 5) out.push(new ActionRowBuilder().addComponents(itemBtns.slice(i, i + 5)));

    const advTimeVal = advItem?.advance_time ?? null;
    out.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`sl_set_time_${enc}`)
        .setLabel(advTimeVal ? `🕐 ${advTimeVal}` : '🕐 Set advance time')
        .setStyle(advTimeVal ? ButtonStyle.Primary : ButtonStyle.Secondary)
    ));

    const actionBtns = [new ButtonBuilder().setCustomId('sl_back').setLabel('← Back').setStyle(ButtonStyle.Primary)];
    if (advItem?.state === 'active') {
      actionBtns.unshift(
        new ButtonBuilder().setCustomId(`sl_advance_complete_${enc}`).setLabel('✅ Complete Advance').setStyle(ButtonStyle.Success)
      );
    }
    out.push(new ActionRowBuilder().addComponents(actionBtns));

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

DAT helps you track where every dynasty league is in its current sim cycle, all from your DMs. No server required.

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
    const channel = interaction.channel;
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
    onboardingSessions.set(userId, { step: 'awaiting_leagues' });
    await interaction.channel.send(
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

  // sl_set_time_ opens a modal — cannot deferUpdate before showModal
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
        .setLabel('Day + time (e.g. Fri 9pm) or leave blank to clear')
        .setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(20)
        .setValue(advRow?.advance_time ?? '')
    ));
    return interaction.showModal(modal);
  }

  await interaction.deferUpdate();
  const types   = await getOrSeedShortlistTypes(userId);
  let { rows }  = await getShortlistData(userId, types);
  const channel = interaction.channel;

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

  if (id.startsWith('sl_advance_complete_')) {
    const enc        = id.replace('sl_advance_complete_', '');
    const leagueName = rows.find(r => encodeLeague(r.league_name) === enc)?.league_name ?? enc;

    await supabase.from('shortlist').update({ state: 'active' })
      .eq('user_id', userId).eq('league_name', leagueName).eq('state', 'done');

    const advType = types.find(t => t.is_advance);
    if (advType) {
      await supabase.from('shortlist').update({ advance_time: null })
        .eq('user_id', userId).eq('league_name', leagueName).eq('type_id', advType.id);
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

  // add_league and sl_rename_pick need to showModal — can't deferUpdate first
  const isModal = (id === 'sl_action' && value === 'add_league') || id === 'sl_rename_pick';
  if (!isModal) await interaction.deferUpdate();

  const types   = await getOrSeedShortlistTypes(userId);
  let { rows }  = await getShortlistData(userId, types);
  const channel = interaction.channel;

  if (id === 'sl_action') {
    if (value === 'edit') {
      activeEdits.set(userId, { type: 'shortlist', step: 'edit_pick' });
      await postShortlist(channel, types, rows, { step: 'edit_pick' }, userId);
    }
    if (value === 'reorder') {
      activeEdits.set(userId, { type: 'shortlist', step: 'reorder_a' });
      await postShortlist(channel, types, rows, { step: 'reorder_a' }, userId);
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
      await postShortlist(channel, types, rows, { step: 'rename_pick' }, userId);
    }
    if (value === 'remove_league') {
      activeEdits.set(userId, { type: 'shortlist', step: 'remove_pick' });
      await postShortlist(channel, types, rows, { step: 'remove_pick' }, userId);
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
    await postShortlist(channel, types, fresh, { step: 'main' }, userId);
    return;
  }

  if (id === 'sl_edit_league') {
    activeEdits.set(userId, { type: 'shortlist', step: 'edit_toggles', leagueName: value });
    await postShortlist(channel, types, rows, { step: 'edit_toggles', leagueName: value }, userId);
    return;
  }

  if (id === 'sl_reorder_a') {
    activeEdits.set(userId, { type: 'shortlist', step: 'reorder_b', leagueNameA: value });
    await postShortlist(channel, types, rows, { step: 'reorder_b', leagueNameA: value }, userId);
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
    await postShortlist(channel, types, fresh, { step: 'main' }, userId);
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
    await postShortlist(interaction.channel, types, fresh, { step: 'main' }, userId);
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
    await postShortlist(interaction.channel, types, fresh, { step: 'main' }, userId);
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
    await postShortlist(interaction.channel, types, fresh, { step: 'edit_toggles', leagueName }, userId);
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
