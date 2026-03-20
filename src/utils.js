// utils.js

export const SHORTLIST_STARTER_TYPES = [
  { name: 'Advance',    icon: '⏰', is_advance: true  },
  { name: 'Game',       icon: '🏈', is_advance: false },
  { name: 'Recruiting', icon: '🎯', is_advance: false },
  { name: 'Other',      icon: '📋', is_advance: false },
];

// 🟢 advance active + everything else done/paused → ready to push
// 🔵 items still in progress
// ⏸️  all visible items paused
// ''  all clear
export function shortlistRowColor(leagueItems, allTypes) {
  const visible = leagueItems.filter(i => i.state !== 'off');
  if (!visible.length) return '';

  const advDef    = allTypes.find(t => t.is_advance);
  const advItem   = visible.find(i => i.type_id === advDef?.id);
  const advActive = advItem?.state === 'active';

  if (advActive) {
    const othersReady = visible
      .filter(i => i !== advItem)
      .every(i => ['done', 'paused', 'off'].includes(i.state));
    if (othersReady) return '🟢';
  }

  if (visible.some(i => i.state === 'active' || i.state === 'done')) return '🔵';
  if (visible.some(i => i.state === 'paused')) return '⏸️';
  return '';
}

// "1. 🟢 **Big 12 Dynasty**　⏰  ✅🏈  ·  Fri 9pm"
export function shortlistRowText(rank, leagueName, leagueItems, allTypes, advanceTime) {
  const color = shortlistRowColor(leagueItems, allTypes);

  const active  = allTypes.filter(t => leagueItems.find(i => i.type_id === t.id && i.state === 'active')).map(t => t.icon).join(' ');
  const done    = allTypes.filter(t => leagueItems.find(i => i.type_id === t.id && i.state === 'done')).map(t => `${t.icon}✅`).join(' ');
  const paused  = allTypes.filter(t => leagueItems.find(i => i.type_id === t.id && i.state === 'paused')).map(t => `${t.icon}⏸️`).join(' ');

  const parts   = [active, done, paused].filter(Boolean).join('  ');
  const timeTag = advanceTime ? `  ·  ${advanceTime}` : '';
  return `${rank}. ${color ? color + ' ' : ''}**${leagueName}**　${parts}${timeTag}`.trimEnd();
}

// Encode league name for safe use in a Discord customId
export function encodeLeague(name) {
  return name.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 40);
}
