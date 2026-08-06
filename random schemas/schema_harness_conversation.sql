-- ============================================================
-- Partshelf – Harness Conversations Migration
-- Run this in: Supabase Dashboard → SQL Editor → New query
-- Safe to run on an existing database — additive only.
--
-- Persists agent conversations so a harness restart (or a pause on
-- ConfirmationRequiredError) doesn't lose in-progress state. See
-- AGENTIC_HARNESS_PHASE3_EXECUTION.md.
-- ============================================================

create table if not exists harness_conversations (
  id                 text primary key,
  member_id          text not null references members(id) on delete cascade,
  status             text not null default 'active',
  messages           jsonb not null default '[]',
    -- OpenAI-shaped message history: [{ role, content, tool_calls?, tool_call_id? }, ...]
  pending_action_id  text references pending_actions(id) on delete set null,
    -- set only while status = 'awaiting_confirmation' — the exact
    -- blocked tool call to replay once that pending_actions row resolves
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint harness_conversations_status_valid check (
    status in ('active', 'awaiting_confirmation', 'completed', 'abandoned')
  )
);
create index if not exists idx_harness_conversations_member on harness_conversations(member_id, status);
create index if not exists idx_harness_conversations_pending on harness_conversations(pending_action_id) where pending_action_id is not null;

alter table harness_conversations enable row level security;
create policy "Public read harness_conversations"   on harness_conversations for select using (true);
create policy "Public insert harness_conversations" on harness_conversations for insert with check (true);
create policy "Public update harness_conversations" on harness_conversations for update using (true);

comment on table harness_conversations is
  'Persistent state for agent chat conversations — survives a harness process restart, and is what a ConfirmationRequiredError pause suspends into. See AGENTIC_HARNESS_PHASE3_EXECUTION.md.';