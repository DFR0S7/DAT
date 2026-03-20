-- DAT — Dynasty Advance Tracker
-- Run this in the SQL editor of your fresh Supabase project.

-- Item type definitions (per user)
-- Seeded automatically on first use with: Advance ⏰, Game 🏈, Recruiting 🎯, Other 📋
create table if not exists shortlist_types (
  id          bigint  generated always as identity primary key,
  user_id     text    not null,
  name        text    not null,
  icon        text    not null,
  is_advance  boolean not null default false,
  sort_order  int     not null default 0
);

-- Per-user per-league state rows (one row per league × type)
-- state: 'off' | 'active' | 'done' | 'paused'
create table if not exists shortlist (
  id              bigint  generated always as identity primary key,
  user_id         text    not null,
  league_name     text    not null,
  type_id         bigint  references shortlist_types(id) on delete cascade,
  state           text    not null default 'off',
  priority_order  int     not null default 0,
  advance_time    text    default null
);

-- Stores the Discord message ID of the live shortlist post per user
-- so the bot can edit it in place instead of sending a new message each time.
create table if not exists shortlist_config (
  user_id    text primary key,
  message_id text,
  channel_id text,
  onboarding boolean default false
);

-- Feedback submissions
create table if not exists feedback (
  id         bigint  generated always as identity primary key,
  user_id    text    not null,
  username   text,
  message    text    not null,
  created_at text
);

-- Indexes
create index if not exists shortlist_user_id_idx        on shortlist (user_id);
create index if not exists shortlist_user_league_idx    on shortlist (user_id, league_name);
create index if not exists shortlist_types_user_id_idx  on shortlist_types (user_id);
