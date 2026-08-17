// needsHandlers.js
// /needs — view and set positional needs for the active dynasty.
// "Left" counts are computed live from dynasty_roster, same logic as the
// artifact's NeedsPanel: Signed players fill a slot, Target players show as
// "pursuing" but don't reduce the count yet.

import { MessageFlags } from 'discord.js';
import { supabase } from './db.js';
import { requireActiveDynasty } from './dynastyHandlers.js';
import { NEED_POSITIONS } from './rosterHandlers.js';

async function computeNeeds(userId, dynastyName) {
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

function formatNeedLine(n) {
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
    const pos = interaction.options.getString('pos');
    if (!pos) return interaction.editReply({ content: 'Please provide a **pos**.' });

    const updates = { user_id: userId, dynasty_name: dynastyName, pos };
    const hsNeed = interaction.options.getInteger('hs_need');
    const portalNeed = interaction.options.getInteger('portal_need');
    const portalType = interaction.options.getString('portal_type');
    if (hsNeed !== null) updates.hs_need = hsNeed;
    if (portalNeed !== null) updates.portal_need = portalNeed;
    if (portalType !== null) updates.portal_type = portalType;

    if (Object.keys(updates).length <= 3) {
      return interaction.editReply({ content: 'Provide at least one of **hs_need**, **portal_need**, or **portal_type** to set.' });
    }

    await supabase.from('dynasty_needs').upsert(updates, { onConflict: 'user_id,dynasty_name,pos' });
    return interaction.editReply({ content: `✅ Updated needs for **${pos}** in **${dynastyName}**.` });
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
