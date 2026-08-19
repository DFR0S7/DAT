// rosterHandlers.js
// /roster — add, list, edit, remove players for the active dynasty.
// CSV bulk import goes through a modal since Discord command options are
// single-line and can't hold pasted multi-row CSV data.

import {
  ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags, AttachmentBuilder,
} from 'discord.js';
import { supabase } from './db.js';
import { requireActiveDynasty, getActiveDynasty } from './dynastyHandlers.js';

export const NEED_POSITIONS = ["QB","HB","WR","TE","OT","OG","C","DE","DT","OLB","MLB","CB","S","K/P"];
const STATUSES = ["Target","Signed","On Roster","Retained w/ NIL","Transferred Out"];
const RECRUIT_TYPES = ["HS","FP","TP"];
const FLIGHT_RISKS = ["Low","Medium","High"];

// ─────────────────────────────────────────────────────────────────────────────
// CSV IMPORT PARSING — ported from the artifact's parseRosterCSV
// ─────────────────────────────────────────────────────────────────────────────

const CSV_POS_MAP = {
  QB: "QB", HB: "HB", RB: "HB", FB: "HB",
  WR: "WR", TE: "TE",
  LT: "OT", RT: "OT", OT: "OT",
  LG: "OG", RG: "OG", OG: "OG",
  C: "C",
  DE: "DE", RE: "DE", LE: "DE", LEDG: "DE", REDG: "DE", EDGE: "DE",
  DT: "DT",
  OLB: "OLB", ROLB: "OLB", LOLB: "OLB", WILL: "OLB", SAM: "OLB",
  MLB: "MLB", LB: "MLB", MIKE: "MLB",
  CB: "CB",
  FS: "S", SS: "S", S: "S",
  K: "K/P", P: "K/P",
};

function parseClassYear(raw) {
  const s = (raw || "").trim().toUpperCase();
  const rs = s.includes("(RS)");
  const base = s.replace("(RS)", "").trim();
  if (rs) return "RS-" + base;
  return base || "FR";
}

// Canonical column order matching the game's own export — used both to parse
// attribute columns by name (rather than fixed index, since which attributes
// are present varies by position group) and to order them on export.
const ATTR_ORDER = [
  "SPD","ACC","AGI","COD","STR","AWR","CAR","BCV","JMP","STA","INJ","TGH","BTK","TRK","SFA","JKM",
  "CTH","CIT","SPC","SRR","MRR","DRR","RLS","THP","SAC","MAC","DAC","TUP","RUN","PAC","BSK",
  "RBK","PBK","PBP","PBF","RBP","RBF","LBK","IBL","TAK","HPW","PUR","PRC","BSH","PMV","FMV","ZCV","MCV","PRS",
];

const ATTR_LABELS = {
  SPD: 'Speed', ACC: 'Acceleration', AGI: 'Agility', COD: 'Change of Direction', STR: 'Strength',
  AWR: 'Awareness', CAR: 'Carrying', BCV: 'Ball Carrier Vision', JMP: 'Jumping', STA: 'Stamina',
  INJ: 'Injury', TGH: 'Toughness', BTK: 'Break Tackle', TRK: 'Trucking', SFA: 'Spin Move', JKM: 'Juke Move',
  CTH: 'Catching', CIT: 'Catch in Traffic', SPC: 'Spectacular Catch', SRR: 'Short Route Running',
  MRR: 'Med Route Running', DRR: 'Deep Route Running', RLS: 'Release', THP: 'Throw Power',
  SAC: 'Short Accuracy', MAC: 'Medium Accuracy', DAC: 'Deep Accuracy', TUP: 'Throw Under Pressure',
  RUN: 'Run Block', PAC: 'Play Action', BSK: 'Break Sack', RBK: 'Run Block', PBK: 'Pass Block',
  PBP: 'Pass Block Power', PBF: 'Pass Block Finesse', RBP: 'Run Block Power', RBF: 'Run Block Finesse',
  LBK: 'Lead Block', IBL: 'Impact Block', TAK: 'Tackle', HPW: 'Hit Power', PUR: 'Pursuit',
  PRC: 'Play Recognition', BSH: 'Block Shedding', PMV: 'Power Move', FMV: 'Finesse Move',
  ZCV: 'Zone Coverage', MCV: 'Man Coverage', PRS: 'Press',
};

function parseRosterCSV(text) {
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  const players = [];
  let headers = null;

  for (const line of lines) {
    const cols = line.split(",");
    const col1 = (cols[1] || '').trim().toUpperCase();

    // Header row (may repeat mid-paste, e.g. offense/defense sections) —
    // capture it so later rows know which column is which attribute.
    if (col1 === 'NAME') {
      headers = cols.map(h => h.trim().toUpperCase());
      continue;
    }

    const name = (cols[1] || "").trim();
    if (!name) continue;
    const year = (cols[2] || "").trim();
    const posRaw = (cols[3] || "").trim().toUpperCase();
    const ovr = (cols[4] || "").trim();
    if (!posRaw) continue;

    const pos = CSV_POS_MAP[posRaw] || posRaw;
    const overall = Number(ovr) || 0;

    // Everything from column 5 onward is an attribute — named via the header
    // row if we've seen one, otherwise skipped (can't know what it is).
    const attributes = {};
    if (headers) {
      for (let i = 5; i < cols.length; i++) {
        const key = headers[i];
        const raw = (cols[i] || '').trim();
        if (!key || raw === '') continue;
        const num = Number(raw);
        attributes[key] = Number.isNaN(num) ? raw : num;
      }
    }

    players.push({ name, classYear: parseClassYear(year), pos, overall, attributes });
  }
  return players;
}

const EXPORT_HEADERS = ['name', 'pos', 'class_year', 'overall', 'dev_trait', 'flight_risk', 'nil_offered', 'nil_amount', 'status', 'recruit_type', 'notes'];

function toCSVField(val) {
  if (val === null || val === undefined) return '';
  const s = String(val);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function buildRosterCSV(players) {
  const lines = [EXPORT_HEADERS.join(',')];
  for (const p of players) lines.push(EXPORT_HEADERS.map(h => toCSVField(p[h])).join(','));
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

async function findPlayers(userId, dynastyName, name, pos) {
  let q = supabase.from('dynasty_roster').select('*')
    .eq('user_id', userId).eq('dynasty_name', dynastyName)
    .ilike('name', name);
  if (pos) q = q.eq('pos', pos);
  const { data } = await q;
  return data ?? [];
}

// Autocomplete suggestions submit the player's row id as the option value.
// If the person types free text instead of picking a suggestion (or the
// suggestion list was stale), fall back to the old name/pos matching.
async function findPlayerByIdOrName(userId, dynastyName, nameOrId, pos) {
  if (/^\d+$/.test(nameOrId ?? '')) {
    const { data } = await supabase.from('dynasty_roster').select('*')
      .eq('id', nameOrId).eq('user_id', userId).eq('dynasty_name', dynastyName).maybeSingle();
    if (data) return [data];
  }
  return findPlayers(userId, dynastyName, nameOrId, pos);
}

function formatPlayerLine(p) {
  const statusTag = p.status;
  const recruitTag = (p.status === 'Target' || p.status === 'Signed') ? ` · ${p.recruit_type}` : '';
  const nilTag = p.nil_offered && p.nil_amount ? ` · NIL: ${p.nil_amount}` : '';
  let line = `**${p.name}** — ${p.pos} · ${p.class_year} · OVR ${p.overall} · ${statusTag}${recruitTag}${nilTag}`;
  if (p.notes) line += `\n-# ${p.notes}`;
  return line;
}

const RISK_FLAG = { Low: '🟢', Medium: '🟡', High: '🔴' };

// Full-detail card — used by the dashboard's Roster tab, one player at a time
// rather than the compact one-liner /roster list uses.
export function formatPlayerCard(p) {
  const lines = [`**${p.name}** — ${p.pos} · ${p.class_year} · OVR ${p.overall} · ${p.dev_trait} dev`];
  lines.push(`Status: **${p.status}**${(p.status === 'Target' || p.status === 'Signed') ? ` (${p.recruit_type})` : ''}`);
  lines.push(`${RISK_FLAG[p.flight_risk] ?? '⚪'} Portal risk: ${p.flight_risk}`);
  if (p.nil_offered) lines.push(`💰 NIL offered${p.nil_amount ? `: ${p.nil_amount}` : ''}`);
  if (p.notes) lines.push(`-# ${p.notes}`);
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// COMMAND HANDLER
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// AUTOCOMPLETE — populates the `name` field with real players as you type,
// filtered by `pos` if you've already picked one. Only offers suggestions for
// actions that reference an EXISTING player (edit/remove/commit) — `add` is a
// new name, so it gets no suggestions and stays a free-text field.
// ─────────────────────────────────────────────────────────────────────────────

export async function handleRosterAutocomplete(interaction) {
  const focused = interaction.options.getFocused(true);

  if (focused.name === 'attr_key') {
    const typed = (focused.value ?? '').trim().toUpperCase();
    const matches = ATTR_ORDER.filter(k => !typed || k.includes(typed) || (ATTR_LABELS[k] ?? '').toUpperCase().includes(typed));
    return interaction.respond(matches.slice(0, 25).map(k => ({ name: `${k} — ${ATTR_LABELS[k] ?? k}`, value: k })));
  }

  if (focused.name !== 'name') return interaction.respond([]);

  const action = interaction.options.getString('action');
  if (!['edit', 'remove', 'commit'].includes(action)) return interaction.respond([]);

  const userId = interaction.user.id;
  const dynastyName = await getActiveDynasty(userId);
  if (!dynastyName) return interaction.respond([]);

  const pos = interaction.options.getString('pos');
  const typed = (focused.value ?? '').trim();

  let q = supabase.from('dynasty_roster').select('id, name, pos, status')
    .eq('user_id', userId).eq('dynasty_name', dynastyName)
    .neq('status', 'Transferred Out')
    .order('pos').order('name').limit(25);
  if (pos) q = q.eq('pos', pos);
  if (typed) q = q.ilike('name', `%${typed}%`);

  const { data: players } = await q;
  const choices = (players ?? []).map(p => ({
    name: `${p.name} — ${p.pos}${p.status !== 'On Roster' ? ` (${p.status})` : ''}`.slice(0, 100),
    value: String(p.id),
  }));
  return interaction.respond(choices);
}

export async function handleRosterCommand(interaction) {
  const userId = interaction.user.id;

  if (interaction.guild) {
    return interaction.reply({ content: '👋 This is a DM-only bot. Send me a direct message to use it!', flags: MessageFlags.Ephemeral });
  }

  const action = interaction.options.getString('action');

  // Import must showModal as the FIRST response — no defer/reply before it.
  if (action === 'import') {
    const dynastyName = await getActiveDynasty(userId);
    if (!dynastyName) {
      return interaction.reply({ content: `You need an active dynasty first — run \`/dynasty action:New name:<team>\`.`, flags: MessageFlags.Ephemeral });
    }
    const modal = new ModalBuilder().setCustomId('roster_import_modal').setTitle('Import Roster CSV');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('csv_input')
          .setLabel('Paste CSV rows (RS,NAME,YEAR,POS,OVR,...)')
          .setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(4000)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('status_input')
          .setLabel('Default status').setStyle(TextInputStyle.Short).setRequired(false).setValue('On Roster')
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('recruit_type_input')
          .setLabel('Default recruit type (HS/FP/TP)').setStyle(TextInputStyle.Short).setRequired(false).setValue('HS')
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('flight_risk_input')
          .setLabel('Default portal risk (Low/Medium/High)').setStyle(TextInputStyle.Short).setRequired(false).setValue('Low')
      ),
    );
    return interaction.showModal(modal);
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const dynastyName = await requireActiveDynasty(interaction, userId);
  if (!dynastyName) return;

  if (action === 'add') {
    const name = interaction.options.getString('name');
    const pos  = interaction.options.getString('pos');
    if (!name || !pos) return interaction.editReply({ content: 'Please provide **name** and **pos**.' });

    await supabase.from('dynasty_roster').insert({
      user_id: userId, dynasty_name: dynastyName,
      name, pos,
      class_year: interaction.options.getString('class_year') ?? 'FR',
      overall: interaction.options.getInteger('overall') ?? 70,
      dev_trait: interaction.options.getString('dev_trait') ?? 'Normal',
      flight_risk: interaction.options.getString('flight_risk') ?? 'Low',
      nil_offered: interaction.options.getBoolean('nil_offered') ?? false,
      nil_amount: interaction.options.getString('nil_amount') ?? null,
      status: interaction.options.getString('status') ?? 'On Roster',
      recruit_type: interaction.options.getString('recruit_type') ?? 'HS',
      notes: interaction.options.getString('notes') ?? null,
    });

    return interaction.editReply({ content: `✅ Added **${name}** (${pos}) to **${dynastyName}**.` });
  }

  if (action === 'list') {
    const statusFilter = interaction.options.getString('status');
    const posFilter     = interaction.options.getString('pos');

    let q = supabase.from('dynasty_roster').select('*')
      .eq('user_id', userId).eq('dynasty_name', dynastyName)
      .order('pos').order('name');
    if (statusFilter) q = q.eq('status', statusFilter);
    if (posFilter) q = q.eq('pos', posFilter);
    const { data: players } = await q;

    if (!players?.length) {
      return interaction.editReply({ content: `No players found${statusFilter ? ` with status **${statusFilter}**` : ''}${posFilter ? ` at **${posFilter}**` : ''} in **${dynastyName}**.` });
    }

    const header = `👥 **${dynastyName} — Roster** (${players.length})\n\n`;
    let content = header + players.map(formatPlayerLine).join('\n');
    if (content.length > 1900) {
      content = header + players.slice(0, 25).map(formatPlayerLine).join('\n') + `\n\n-# Showing first 25 of ${players.length}. Filter by status or pos to narrow.`;
    }
    return interaction.editReply({ content });
  }

  if (action === 'export') {
    const { data: players } = await supabase
      .from('dynasty_roster').select('*')
      .eq('user_id', userId).eq('dynasty_name', dynastyName)
      .order('pos').order('name');

    if (!players?.length) {
      return interaction.editReply({ content: `No players to export for **${dynastyName}**.` });
    }

    const csv = buildRosterCSV(players);
    const buffer = Buffer.from(csv, 'utf-8');
    const safeName = dynastyName.replace(/[^a-z0-9]+/gi, '_').toLowerCase();
    const attachment = new AttachmentBuilder(buffer, { name: `${safeName}_roster.csv` });

    return interaction.editReply({
      content: `📤 Exported ${players.length} player${players.length === 1 ? '' : 's'} from **${dynastyName}**.`,
      files: [attachment],
    });
  }

  if (action === 'edit') {
    const name = interaction.options.getString('name');
    const pos  = interaction.options.getString('pos');
    if (!name) return interaction.editReply({ content: 'Please provide the **name** of the player to edit.' });

    const matches = await findPlayerByIdOrName(userId, dynastyName, name, pos);
    if (!matches.length) return interaction.editReply({ content: `No player matching **${name}**${pos ? ` at ${pos}` : ''} found.` });
    if (matches.length > 1) {
      return interaction.editReply({ content: `Multiple players match **${name}**: ${matches.map(m => m.pos).join(', ')}. Re-run with **pos** to disambiguate.` });
    }

    const updates = {};
    const maybeSet = (key, val) => { if (val !== null && val !== undefined) updates[key] = val; };
    // pos itself can be changed via a distinct option name to avoid clashing with the disambiguator
    maybeSet('pos', interaction.options.getString('new_pos'));
    maybeSet('class_year', interaction.options.getString('class_year'));
    maybeSet('overall', interaction.options.getInteger('overall'));
    maybeSet('dev_trait', interaction.options.getString('dev_trait'));
    maybeSet('flight_risk', interaction.options.getString('flight_risk'));
    maybeSet('nil_offered', interaction.options.getBoolean('nil_offered'));
    maybeSet('nil_amount', interaction.options.getString('nil_amount'));
    maybeSet('status', interaction.options.getString('status'));
    maybeSet('recruit_type', interaction.options.getString('recruit_type'));
    maybeSet('notes', interaction.options.getString('notes'));

    // Single-attribute correction — merges into the existing JSONB rather than
    // replacing it, since we're only fixing one bad value out of ~50.
    const attrKey = interaction.options.getString('attr_key');
    const attrValue = interaction.options.getInteger('attr_value');
    if (attrKey && attrValue !== null) {
      const key = attrKey.trim().toUpperCase();
      updates.attributes = { ...(matches[0].attributes ?? {}), [key]: attrValue };
    } else if (attrKey && attrValue === null) {
      return interaction.editReply({ content: `Provide **attr_value** along with **attr_key** to set an attribute.` });
    }

    if (!Object.keys(updates).length) return interaction.editReply({ content: 'No fields provided to update.' });

    await supabase.from('dynasty_roster').update(updates).eq('id', matches[0].id);
    const attrNote = attrKey && attrValue !== null ? ` (${attrKey.toUpperCase()} → ${attrValue})` : '';
    return interaction.editReply({ content: `✅ Updated **${matches[0].name}**${attrNote}.` });
  }

  if (action === 'commit') {
    const name = interaction.options.getString('name');
    const pos  = interaction.options.getString('pos');
    if (!name) return interaction.editReply({ content: 'Please provide the **name** of the recruit to commit.' });

    const matches = await findPlayerByIdOrName(userId, dynastyName, name, pos);
    if (!matches.length) return interaction.editReply({ content: `No player matching **${name}**${pos ? ` at ${pos}` : ''} found.` });
    if (matches.length > 1) {
      return interaction.editReply({ content: `Multiple players match **${name}**: ${matches.map(m => m.pos).join(', ')}. Re-run with **pos** to disambiguate.` });
    }

    const player = matches[0];
    if (player.status !== 'Target' && player.status !== 'Signed') {
      return interaction.editReply({ content: `**${player.name}** is already **${player.status}** — nothing to commit.` });
    }

    await supabase.from('dynasty_roster').update({ status: 'On Roster' }).eq('id', player.id);
    return interaction.editReply({ content: `✅ **${player.name}** moved from recruiting to the active roster.` });
  }

  if (action === 'wipe') {
    const confirm = interaction.options.getBoolean('confirm');
    if (confirm !== true) {
      return interaction.editReply({
        content: `⚠️ This deletes **every player** (roster + recruiting) for **${dynastyName}** — can't be undone.\nRe-run with **confirm:True** to actually do it.`,
      });
    }

    const { count } = await supabase.from('dynasty_roster')
      .select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('dynasty_name', dynastyName);

    await supabase.from('dynasty_roster').delete().eq('user_id', userId).eq('dynasty_name', dynastyName);
    return interaction.editReply({ content: `🗑️ Wiped ${count ?? 0} player${count === 1 ? '' : 's'} from **${dynastyName}**. Ready for a fresh import.` });
  }

  if (action === 'remove') {
    const name = interaction.options.getString('name');
    const pos  = interaction.options.getString('pos');
    if (!name) return interaction.editReply({ content: 'Please provide the **name** of the player to remove.' });

    const matches = await findPlayerByIdOrName(userId, dynastyName, name, pos);
    if (!matches.length) return interaction.editReply({ content: `No player matching **${name}**${pos ? ` at ${pos}` : ''} found.` });
    if (matches.length > 1) {
      return interaction.editReply({ content: `Multiple players match **${name}**: ${matches.map(m => m.pos).join(', ')}. Re-run with **pos** to disambiguate.` });
    }

    await supabase.from('dynasty_roster').delete().eq('id', matches[0].id);
    return interaction.editReply({ content: `🗑️ Removed **${matches[0].name}** from **${dynastyName}**.` });
  }

  return interaction.editReply({ content: 'Unknown action.' });
}

// ─────────────────────────────────────────────────────────────────────────────
// MODAL HANDLER — CSV import submit
// ─────────────────────────────────────────────────────────────────────────────

export async function handleRosterModal(interaction) {
  if (interaction.customId !== 'roster_import_modal') return false;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const userId = interaction.user.id;

  const dynastyName = await getActiveDynasty(userId);
  if (!dynastyName) {
    await interaction.editReply({ content: `No active dynasty found — run \`/dynasty action:New name:<team>\` first.` });
    return true;
  }

  const csvText        = interaction.fields.getTextInputValue('csv_input');
  const status          = interaction.fields.getTextInputValue('status_input')?.trim() || 'On Roster';
  const recruitTypeRaw  = interaction.fields.getTextInputValue('recruit_type_input')?.trim().toUpperCase() || 'HS';
  const flightRisk      = interaction.fields.getTextInputValue('flight_risk_input')?.trim() || 'Low';
  const recruitType = RECRUIT_TYPES.includes(recruitTypeRaw) ? recruitTypeRaw : 'HS';

  const parsed = parseRosterCSV(csvText);
  if (!parsed.length) {
    await interaction.editReply({ content: 'No valid rows found — check the format matches `RS,NAME,YEAR,POS,OVR,...`.' });
    return true;
  }

  const rows = parsed.map(p => ({
    user_id: userId, dynasty_name: dynastyName,
    name: p.name, pos: p.pos, class_year: p.classYear, overall: p.overall,
    dev_trait: 'Normal', flight_risk: flightRisk, nil_offered: false, nil_amount: null,
    status, recruit_type: recruitType, notes: null,
    attributes: p.attributes ?? {},
  }));

  const { error } = await supabase.from('dynasty_roster').insert(rows);
  if (error) {
    await interaction.editReply({ content: `Import failed: ${error.message}. Nothing was added — try again.` });
    return true;
  }

  const unmapped = [...new Set(parsed.filter(p => !NEED_POSITIONS.includes(p.pos)).map(p => p.pos))];
  let content = `✅ Imported ${rows.length} player${rows.length === 1 ? '' : 's'} into **${dynastyName}**.`;
  if (unmapped.length) content += `\n⚠️ Unrecognized position code${unmapped.length > 1 ? 's' : ''}: ${unmapped.join(', ')} — added as-is, edit to fix.`;
  await interaction.editReply({ content });
  return true;
}
