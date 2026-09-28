// needsHandlers.js
// /needs — view and set positional needs for the active dynasty.
// "Left" counts are computed live from dynasty_roster, same logic as the
// artifact's NeedsPanel: Signed players fill a slot, Target players show as
// "pursuing" but don't reduce the count yet.

import {
  ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder, MessageFlags,
} from 'discord.js';
import { supabase } from './db.js';
import { requireActiveDynasty, getActiveDynasty } from './dynastyHandlers.js';
import { NEED_POSITIONS } from './rosterHandlers.js';

const NEED_PORTAL_TYPES = ['FP', 'IS'];

export async function computeNeeds(userId, dynastyName) {
  const { data: needRows } = await supabase
    .from('dynasty_needs').select('*').eq('user_id', userId).eq('dynasty_name', dynastyName);
  const { data: roster } = await supabase
    .from('dynasty_roster').select('pos, status, recruit_type').eq('user_id', userId).eq('dynasty_name', dynastyName);

  const needsByPos = new Map((needRows ?? []).map(r => [r.pos, r]));
  const counts = new Map();
  NEED_POSITIONS.forEach(pos => counts.set(pos, { hsSigned: 0, hsTargeting: 0, portalSigned: 0, portalTargeting: 0 }));

  (roster ?? []).forEach(p => {
    const c = counts.get(p.pos);
    if (!c) return;
    if (p.status === 'Signed') {
      if (p.recruit_type === 'HS') c.hsSigned += 1; else c.portalSigned += 1;
    } else if (p.status === 'Target') {
      if (p.recruit_type === 'HS') c.hsTargeting += 1; else c.portalTargeting += 1;
    }
  });

  return NEED_POSITIONS.map(pos => {
    const need = needsByPos.get(pos) ?? { hs_need: 0, portal_need: 0, portal_type: 'FP' };
    const c = counts.get(pos);
    return {
      pos,
      hsNeed: need.hs_need, portalNeed: need.portal_need, portalType: need.portal_type,
      hsLeft: Math.max(0, need.hs_need - c.hsSigned),
      portalLeft: Math.max(0, need.portal_need - c.portalSigned),
      hsTargeting: c.hsTargeting, portalTargeting: c.portalTargeting,
    };
  });
}

export function formatNeedLine(n) {
  const parts = [];
  if (n.hsNeed > 0 || n.hsTargeting > 0) {
    parts.push(`HS ${n.hsLeft}/${n.hsNeed} left${n.hsTargeting ? ` (${n.hsTargeting} targeting)` : ''}`);
  }
  if (n.portalNeed > 0 || n.portalTargeting > 0) {
    parts.push(`Portal ${n.portalLeft}/${n.portalNeed} left, ${n.portalType}${n.portalTargeting ? ` (${n.portalTargeting} targeting)` : ''}`);
  }
  if (!parts.length) return null;
  const flag = (n.hsLeft > 0 || n.portalLeft > 0) ? '🟡' : '🟢';
  return `${flag} **${n.pos}** — ${parts.join(' · ')}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERACTIVE SET FLOW
//   /needs action:set → position list (each entry shows its current needs)
//   pick a position   → form prefilled with that position's current numbers
//   save              → list refreshes in place so you can go straight to the next one
// ─────────────────────────────────────────────────────────────────────────────

async function buildPositionPicker(userId, dynastyName, notice = '') {
  const needs = await computeNeeds(userId, dynastyName);
  const options = needs.map(n => {
    const portal = `Portal ${n.portalNeed}${n.portalNeed > 0 ? ` (${n.portalType})` : ''}`;
    return new StringSelectMenuOptionBuilder()
      .setLabel(n.pos).setDescription(`HS ${n.hsNeed} · ${portal}`).setValue(n.pos);
  });

  const content = `📋 **Set needs — ${dynastyName}**\n${notice ? `${notice}\n` : ''}\nPick a position to edit.`;
  const components = [new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('needs_pos_select').setPlaceholder('Choose a position…').addOptions(options)
  )];
  return { content, components };
}

// Position picked → open the form. showModal must be the FIRST response to this
// interaction, so no deferring before it.
export async function handleNeedsSelect(interaction) {
  if (interaction.customId !== 'needs_pos_select') return false;
  const userId = interaction.user.id;

  const dynastyName = await getActiveDynasty(userId);
  if (!dynastyName) {
    await interaction.reply({ content: `No active dynasty found — run \`/dynasty action:Switch\` first.`, flags: MessageFlags.Ephemeral });
    return true;
  }

  const pos = interaction.values[0];
  const { data: row } = await supabase.from('dynasty_needs').select('hs_need, portal_need, portal_type')
    .eq('user_id', userId).eq('dynasty_name', dynastyName).eq('pos', pos).maybeSingle();

  const field = (id, label, value, maxLength) => new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(TextInputStyle.Short)
      .setRequired(true).setValue(String(value)).setMaxLength(maxLength)
  );

  const modal = new ModalBuilder().setCustomId(`needs_set_modal:${pos}`).setTitle(`Needs — ${pos}`);
  modal.addComponents(
    field('hs_need', 'HS recruits needed', row?.hs_need ?? 0, 2),
    field('portal_need', 'Portal recruits needed', row?.portal_need ?? 0, 2),
    field('portal_type', 'Portal type (FP or IS)', row?.portal_type ?? 'FP', 2),
  );
  await interaction.showModal(modal);
  return true;
}

// Form submitted → validate, save, refresh the list in the original message.
export async function handleNeedsModal(interaction) {
  if (!interaction.customId.startsWith('needs_set_modal:')) return false;
  const pos = interaction.customId.slice('needs_set_modal:'.length);
  const userId = interaction.user.id;

  const hs = Number(interaction.fields.getTextInputValue('hs_need').trim());
  const portal = Number(interaction.fields.getTextInputValue('portal_need').trim());
  const type = interaction.fields.getTextInputValue('portal_type').trim().toUpperCase();

  // Validate before deferring so a bad entry gets a private error and the list stays put
  if (!Number.isInteger(hs) || hs < 0 || !Number.isInteger(portal) || portal < 0) {
    await interaction.reply({ content: `Needs must be whole numbers, 0 or higher. Nothing was saved for **${pos}**.`, flags: MessageFlags.Ephemeral });
    return true;
  }
  if (!NEED_PORTAL_TYPES.includes(type)) {
    await interaction.reply({ content: `Portal type must be **FP** (future player) or **IS** (immediate starter). Nothing was saved for **${pos}**.`, flags: MessageFlags.Ephemeral });
    return true;
  }

  const dynastyName = await getActiveDynasty(userId);
  if (!dynastyName) {
    await interaction.reply({ content: `No active dynasty found — run \`/dynasty action:Switch\` first.`, flags: MessageFlags.Ephemeral });
    return true;
  }

  await interaction.deferUpdate();
  const { error } = await supabase.from('dynasty_needs').upsert(
    { user_id: userId, dynasty_name: dynastyName, pos, hs_need: hs, portal_need: portal, portal_type: type },
    { onConflict: 'user_id,dynasty_name,pos' }
  );

  const notice = error
    ? `⚠️ Couldn't save **${pos}**: ${error.message}`
    : `✅ Saved **${pos}** — HS ${hs} · Portal ${portal}${portal > 0 ? ` (${type})` : ''}`;
  await interaction.editReply(await buildPositionPicker(userId, dynastyName, notice));
  return true;
}

export async function handleNeedsCommand(interaction) {
  const userId = interaction.user.id;

  if (interaction.guild) {
    return interaction.reply({ content: '👋 This is a DM-only bot. Send me a direct message to use it!', flags: MessageFlags.Ephemeral });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const dynastyName = await requireActiveDynasty(interaction, userId);
  if (!dynastyName) return;

  const action = interaction.options.getString('action');

  if (action === 'view') {
    const needs = await computeNeeds(userId, dynastyName);
    const lines = needs.map(formatNeedLine).filter(Boolean);

    const { data: dyn } = await supabase
      .from('dynasties').select('needs_updated, needs_period').eq('user_id', userId).eq('dynasty_name', dynastyName).single();
    const updatedLine = dyn?.needs_updated
      ? `Updated ${dyn.needs_updated} · ${dyn.needs_period === 'TP' ? 'Transfer portal window' : 'HS recruiting window'}`
      : 'Not yet marked updated';

    if (!lines.length) {
      return interaction.editReply({ content: `📋 **${dynastyName} — Needs**\n-# ${updatedLine}\n\nNo needs set yet. Use \`/needs action:set\` to add some.` });
    }
    return interaction.editReply({ content: `📋 **${dynastyName} — Needs**\n-# ${updatedLine}\n\n${lines.join('\n')}` });
  }

  if (action === 'set') {
    return interaction.editReply(await buildPositionPicker(userId, dynastyName));
  }

  if (action === 'mark-updated') {
    const period = interaction.options.getString('period');
    const today = new Date().toISOString().slice(0, 10);
    const updates = { needs_updated: today };
    if (period) updates.needs_period = period;
    await supabase.from('dynasties').update(updates).eq('user_id', userId).eq('dynasty_name', dynastyName);
    return interaction.editReply({ content: `✅ Marked needs updated today for **${dynastyName}**.` });
  }

  return interaction.editReply({ content: 'Unknown action.' });
}
