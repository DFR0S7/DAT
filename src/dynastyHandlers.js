// dynastyHandlers.js
// Dynasty context: list / switch / new / delete active dynasty.
// Everything else (season, roster, needs) depends on getActiveDynasty()
// resolving to a real dynasty_name for the user.

import { MessageFlags } from 'discord.js';
import { supabase } from './db.js';

// ─────────────────────────────────────────────────────────────────────────────
// DB HELPERS
// ─────────────────────────────────────────────────────────────────────────────

export async function getDynasties(userId) {
  const { data } = await supabase
    .from('dynasties').select('*').eq('user_id', userId).order('created_at');
  return data ?? [];
}

export async function getActiveDynasty(userId) {
  const { data } = await supabase
    .from('dynasty_config').select('active_dynasty').eq('user_id', userId).single();
  return data?.active_dynasty ?? null;
}

async function setActiveDynasty(userId, dynastyName) {
  await supabase.from('dynasty_config')
    .upsert({ user_id: userId, active_dynasty: dynastyName }, { onConflict: 'user_id' });
}

// Case-insensitive match against a user's existing dynasties — mirrors the
// league_name.toLowerCase() comparisons used throughout shortlist handling.
function findDynasty(dynasties, name) {
  return dynasties.find(d => d.dynasty_name.toLowerCase() === name.toLowerCase());
}

// Shared guard other command handlers (season/roster/needs) can call first.
// Returns the active dynasty name, or null + sends a reply telling the user
// what to do next.
export async function requireActiveDynasty(interaction, userId) {
  const active = await getActiveDynasty(userId);
  if (active) return active;

  const dynasties = await getDynasties(userId);
  const msg = dynasties.length
    ? `You don't have an active dynasty selected. Run \`/dynasty action:Switch name:<team>\` to pick one.`
    : `You don't have any dynasties yet. Run \`/dynasty action:New name:<team>\` to create your first one.`;

  const payload = { content: msg, flags: MessageFlags.Ephemeral };
  if (interaction.deferred) await interaction.editReply(payload);
  else await interaction.reply(payload);
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// COMMAND HANDLER
// ─────────────────────────────────────────────────────────────────────────────

export async function handleDynastyCommand(interaction) {
  const userId = interaction.user.id;

  if (interaction.guild) {
    return interaction.reply({ content: '👋 This is a DM-only bot. Send me a direct message to use it!', flags: MessageFlags.Ephemeral });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const action = interaction.options.getString('action');
  const name   = interaction.options.getString('name')?.trim();

  if (action === 'list') {
    const dynasties = await getDynasties(userId);
    if (!dynasties.length) {
      return interaction.editReply({ content: `You don't have any dynasties yet. Run \`/dynasty action:New name:<team>\` to create one.` });
    }
    const active = await getActiveDynasty(userId);
    const lines = dynasties.map(d => `${d.dynasty_name.toLowerCase() === active?.toLowerCase() ? '🟢' : '⚪'} ${d.dynasty_name}`);
    return interaction.editReply({ content: `📋 **Your Dynasties**\n\n${lines.join('\n')}` });
  }

  if (action === 'new') {
    if (!name) return interaction.editReply({ content: 'Please provide a **name** for the new dynasty.' });
    const dynasties = await getDynasties(userId);
    if (findDynasty(dynasties, name)) {
      return interaction.editReply({ content: `**${name}** already exists. Use \`/dynasty action:Switch\` to select it.` });
    }
    await supabase.from('dynasties').insert({ user_id: userId, dynasty_name: name });
    // First dynasty for this user — make it active automatically
    if (!dynasties.length) await setActiveDynasty(userId, name);
    return interaction.editReply({ content: `✅ **${name}** created${!dynasties.length ? ' and set as your active dynasty' : ''}.` });
  }

  if (action === 'switch') {
    if (!name) return interaction.editReply({ content: 'Please provide the **name** of the dynasty to switch to.' });
    const dynasties = await getDynasties(userId);
    const match = findDynasty(dynasties, name);
    if (!match) return interaction.editReply({ content: `No dynasty named **${name}** found. Run \`/dynasty action:List\` to see your options.` });
    await setActiveDynasty(userId, match.dynasty_name);
    return interaction.editReply({ content: `🔁 Switched to **${match.dynasty_name}**.` });
  }

  if (action === 'delete') {
    if (!name) return interaction.editReply({ content: 'Please provide the **name** of the dynasty to delete.' });
    const dynasties = await getDynasties(userId);
    const match = findDynasty(dynasties, name);
    if (!match) return interaction.editReply({ content: `No dynasty named **${name}** found.` });

    await supabase.from('dynasty_seasons').delete().eq('user_id', userId).eq('dynasty_name', match.dynasty_name);
    await supabase.from('dynasty_roster').delete().eq('user_id', userId).eq('dynasty_name', match.dynasty_name);
    await supabase.from('dynasty_needs').delete().eq('user_id', userId).eq('dynasty_name', match.dynasty_name);
    await supabase.from('dynasties').delete().eq('id', match.id);

    const active = await getActiveDynasty(userId);
    if (active?.toLowerCase() === match.dynasty_name.toLowerCase()) {
      await setActiveDynasty(userId, null);
    }

    return interaction.editReply({ content: `🗑️ Deleted **${match.dynasty_name}** and all its season/roster/needs data.` });
  }

  return interaction.editReply({ content: 'Unknown action.' });
}
