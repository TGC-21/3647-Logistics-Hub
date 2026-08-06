-- ============================================================
-- Partshelf – Member Auth + Trust Level Migration
-- Run this in: Supabase Dashboard → SQL Editor → New query
-- Safe to run on an existing database — additive only.
-- ============================================================

-- ── Trust level (per-member, capped by a hardcoded ceiling in code) ──
-- Governs how much the harness can do on this member's behalf without
-- pausing for confirmation. See AGENTIC_HARNESS.md Phase 3.
--   0 — everything requires confirmation, including reads
--   1 — reads auto-execute; low-risk writes require confirmation
--   2 — reads + low-risk writes auto-execute; destructive actions require confirmation
--   3 — everything auto-executes (still logged, still act-as-member)
-- Effective trust = min(members.trust_level, MAX_TRUST_LEVEL) where
-- MAX_TRUST_LEVEL is a hardcoded constant in application code, not stored
-- here — per product decision, members/admins can only ever LOWER their
-- own ceiling, never exceed the developer-set maximum.
alter table members
  add column if not exists trust_level integer not null default 0,
  add constraint members_trust_level_valid check (trust_level between 0 and 3);

-- ── Supabase Auth linkage ────────────────────────────────────
-- Supabase Auth (auth.users) becomes the real credential store —
-- password hashing, session/JWT issuance, all handled by Supabase, not
-- reimplemented here. auth_user_id links a members row to its
-- auth.users row. Nullable during the migration window (see backfill
-- note below): an existing member who hasn't yet set a password has
-- auth_user_id = null and must complete one-time password setup on
-- next login before receiving a session.
alter table members
  add column if not exists auth_user_id uuid references auth.users(id) on delete set null;

create unique index if not exists idx_members_auth_user
  on members(auth_user_id) where auth_user_id is not null;

-- ── is_agent tag on change_log ───────────────────────────────
-- Distinguishes "the member did this" from "the harness did this on
-- the member's behalf" without needing a second actor identity system —
-- actor_id stays the member either way (per product decision: harness
-- acts AS the member, not as a separate system actor).
alter table change_log
  add column if not exists is_agent boolean not null default false;

comment on column members.trust_level is
  'Per-member ceiling on harness autonomy (0-3). Effective trust = min(trust_level, hardcoded MAX_TRUST_LEVEL in app code). See AGENTIC_HARNESS.md Phase 3.';
comment on column members.auth_user_id is
  'Links to auth.users(id) once this member has set a password via Supabase Auth. Null = still on legacy ID-only login, must set a password to get a real session.';
comment on column change_log.is_agent is
  'True when this change was made by the harness acting on behalf of actor_id, rather than actor_id acting directly.';

-- ── Pending actions (confirmation-required harness writes) ──────
-- A service throws ConfirmationRequiredError; the harness's executor
-- catches it and writes one of these instead of failing outright, then
-- SUSPENDS (not terminates) its current plan step. Resuming means
-- re-invoking action_name/action_args with confirmed=true once status
-- flips to 'approved'.
create table if not exists pending_actions (
  id            text primary key,
  member_id     text not null references members(id) on delete cascade,
  is_agent      boolean not null default true,
  action_name   text not null,        -- e.g. 'AssemblyService.deleteAssemblyWithCascade'
  action_args   jsonb not null,       -- exact args to replay on approval
  severity      text not null,        -- 'read' | 'write' | 'destructive'
  status        text not null default 'awaiting_confirmation',
  reason        text,                 -- optional human-readable context from the harness
  created_at    timestamptz not null default now(),
  resolved_at   timestamptz,
  resolved_by   text references members(id) on delete set null,
  constraint pending_actions_status_valid check (
    status in ('awaiting_confirmation', 'approved', 'denied', 'expired')
  ),
  constraint pending_actions_severity_valid check (
    severity in ('read', 'write', 'destructive')
  )
);
create index if not exists idx_pending_actions_member on pending_actions(member_id, status);

alter table pending_actions enable row level security;
create policy "Public read pending_actions"   on pending_actions for select using (true);
create policy "Public insert pending_actions" on pending_actions for insert with check (true);
create policy "Public update pending_actions" on pending_actions for update using (true);

comment on table pending_actions is
  'Suspended harness actions awaiting member approve/deny — the resumability mechanism for ConfirmationRequiredError. See AGENTIC_HARNESS.md Phase 3.';