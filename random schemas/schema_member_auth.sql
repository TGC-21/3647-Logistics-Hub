-- Phase 3a: harness member auth. Additive only.

create table if not exists pairing_codes (
  id           text primary key,
  code_hash    text not null unique,
  member_id    text not null references members(id) on delete cascade,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  redeemed_at  timestamptz
);
create index if not exists idx_pairing_codes_member on pairing_codes(member_id);

create table if not exists member_sessions (
  id           text primary key,
  member_id    text not null references members(id) on delete cascade,
  token_hash   text not null unique,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  revoked_at   timestamptz
);
create index if not exists idx_member_sessions_member on member_sessions(member_id);

alter table pairing_codes   enable row level security;
alter table member_sessions enable row level security;

-- Same "public, no auth model" policy as every other table — real
-- protection is the token hashing + expiry, not RLS, same posture
-- change_log/members already take.
create policy "Public read pairing_codes"    on pairing_codes for select using (true);
create policy "Public insert pairing_codes"  on pairing_codes for insert with check (true);
create policy "Public update pairing_codes"  on pairing_codes for update using (true);

create policy "Public read member_sessions"   on member_sessions for select using (true);
create policy "Public insert member_sessions" on member_sessions for insert with check (true);
create policy "Public update member_sessions" on member_sessions for update using (true);