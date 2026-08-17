// seasonHandlers.js
// /season — log, list, edit, delete season history for the active dynasty.

import { MessageFlags } from 'discord.js';
import { supabase } from './db.js';
import { requireActiveDynasty } from './dynastyHandlers.js';

const CCG_LABEL = {
  'none': '—',
  'didnt-make': "Didn't make CCG",
  'lost-ccg': 'Lost CCG',
  'won-ccg': 'Won CCG — Promoted',
};
const BOWL_LABEL = {
  'none': '—',
  'none-eligible': 'Bowl-eligible, not played',
  'lost': 'Lost Bowl',
  'won': 'Won Bowl',
};
const STARS = n => '★'.repeat(n) + '☆'.repeat(Math.max(0, 6 - n));

function formatSeasonLine(s) {
  const bits = [`${s.wins}-${s.losses}`];
  if (s.conference) bits.push(s.conference);
  if (s.tier_num) bits.push(`Tier ${s.tier_num}`);
  bits.push(CCG_LABEL[s.ccg_result] ?? '—');
  bits.push(BOWL_LABEL[s.bowl_result] ?? '—');
  bits.push(STARS(s.prestige));

  let line = `**Season ${s.season_num}** — ${bits.join(' · ')}`;
  if (s.recruiting) line += `\n-# Recruiting: ${s.recruiting}`;
  if (s.notes) line += `\n-# Notes: ${s.notes}`;
  return line;
}

export async function handleSeasonCommand(interaction) {
  const userId = interaction.user.id;

  if (interaction.guild) {
    return interaction.reply({ content: '👋 This is a DM-only bot. Send me a direct message to use it!', flags: MessageFlags.Ephemeral });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const dynastyName = await requireActiveDynasty(interaction, userId);
  if (!dynastyName) return; // requireActiveDynasty already replied

  const action = interaction.options.getString('action');

  if (action === 'log') {
    const seasonNum = interaction.options.getInteger('season_num');
    const wins      = interaction.options.getInteger('wins');
    const losses    = interaction.options.getInteger('losses');
    if (seasonNum == null || wins == null || losses == null) {
      return interaction.editReply({ content: 'Please provide **season_num**, **wins**, and **losses**.' });
    }

    const { data: existing } = await supabase
      .from('dynasty_seasons').select('id')
      .eq('user_id', userId).eq('dynasty_name', dynastyName).eq('season_num', seasonNum).maybeSingle();
    if (existing) {
      return interaction.editReply({ content: `Season ${seasonNum} already exists for **${dynastyName}**. Use \`/season action:Edit\` to update it.` });
    }

    await supabase.from('dynasty_seasons').insert({
      user_id: userId,
      dynasty_name: dynastyName,
      season_num: seasonNum,
      wins, losses,
      conference: interaction.options.getString('conference') ?? null,
      tier_num: interaction.options.getInteger('tier') ?? null,
      ccg_result: interaction.options.getString('ccg_result') ?? 'none',
      bowl_result: interaction.options.getString('bowl_result') ?? 'none',
      prestige: interaction.options.getInteger('prestige') ?? 1,
      recruiting: interaction.options.getString('recruiting') ?? null,
      notes: interaction.options.getString('notes') ?? null,
    });

    return interaction.editReply({ content: `✅ Logged **Season ${seasonNum}** for **${dynastyName}**.` });
  }

  if (action === 'list') {
    const { data: seasons } = await supabase
      .from('dynasty_seasons').select('*')
      .eq('user_id', userId).eq('dynasty_name', dynastyName).order('season_num');

    if (!seasons?.length) {
      return interaction.editReply({ content: `No seasons logged yet for **${dynastyName}**. Use \`/season action:Log\` to add one.` });
    }

    const header = `📖 **${dynastyName} — Season Ledger**\n\n`;
    const body = seasons.map(formatSeasonLine).join('\n\n');
    // Discord message cap is 2000 chars for a plain reply — trim oldest seasons if needed
    let content = header + body;
    if (content.length > 1900) {
      content = header + seasons.slice(-8).map(formatSeasonLine).join('\n\n') + '\n\n-# Showing most recent 8 seasons.';
    }
    return interaction.editReply({ content });
  }

  if (action === 'edit') {
    const seasonNum = interaction.options.getInteger('season_num');
    if (seasonNum == null) return interaction.editReply({ content: 'Please provide the **season_num** to edit.' });

    const { data: existing } = await supabase
      .from('dynasty_seasons').select('id')
      .eq('user_id', userId).eq('dynasty_name', dynastyName).eq('season_num', seasonNum).maybeSingle();
    if (!existing) return interaction.editReply({ content: `No Season ${seasonNum} found for **${dynastyName}**.` });

    const updates = {};
    const maybeSet = (key, val) => { if (val !== null && val !== undefined) updates[key] = val; };
    maybeSet('wins', interaction.options.getInteger('wins'));
    maybeSet('losses', interaction.options.getInteger('losses'));
    maybeSet('conference', interaction.options.getString('conference'));
    maybeSet('tier_num', interaction.options.getInteger('tier'));
    maybeSet('ccg_result', interaction.options.getString('ccg_result'));
    maybeSet('bowl_result', interaction.options.getString('bowl_result'));
    maybeSet('prestige', interaction.options.getInteger('prestige'));
    maybeSet('recruiting', interaction.options.getString('recruiting'));
    maybeSet('notes', interaction.options.getString('notes'));

    if (!Object.keys(updates).length) {
      return interaction.editReply({ content: 'No fields provided to update.' });
    }

    await supabase.from('dynasty_seasons').update(updates).eq('id', existing.id);
    return interaction.editReply({ content: `✅ Updated **Season ${seasonNum}** for **${dynastyName}**.` });
  }

  if (action === 'delete') {
    const seasonNum = interaction.options.getInteger('season_num');
    if (seasonNum == null) return interaction.editReply({ content: 'Please provide the **season_num** to delete.' });

    const { data: existing } = await supabase
      .from('dynasty_seasons').select('id')
      .eq('user_id', userId).eq('dynasty_name', dynastyName).eq('season_num', seasonNum).maybeSingle();
    if (!existing) return interaction.editReply({ content: `No Season ${seasonNum} found for **${dynastyName}**.` });

    await supabase.from('dynasty_seasons').delete().eq('id', existing.id);
    return interaction.editReply({ content: `🗑️ Deleted Season ${seasonNum} from **${dynastyName}**.` });
  }

  return interaction.editReply({ content: 'Unknown action.' });
}
