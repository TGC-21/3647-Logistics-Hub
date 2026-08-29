-- ============================================================
-- Partshelf – Harness Proposal Queue Migration
-- Run this in: Supabase Dashboard → SQL Editor → New query
-- Safe to run on an existing database — additive only.
--
-- Backs the image→inventory confirmation-card flow
-- (propose_inventory_instance tool, conversationLoop.js). Previously
-- a proposal only ever lived in the single HTTP response returned to
-- whichever browser tab sent the message — reloading, or opening the
-- same conversation from a different session/device, could never see
-- it again. This column makes a proposal (or a QUEUE of them, when one
-- photo contains multiple distinct parts) part of the conversation's
-- durable state, same as pending_action_id already is for the
-- confirmation-required-write flow.
-- ============================================================

alter table harness_conversations
  add column if not exists pending_proposals jsonb not null default '[]';

comment on column harness_conversations.pending_proposals is
  'Queue of image-sourced inventory-instance proposals awaiting member review, most-recent-batch-last. Each entry: { id, status: pending|confirmed|discarded, name, categoryId?, categoryName?, attrs?, quantity?, location?, notes?, confidence?, reasoning?, attachmentUrl?, createdAt, resolvedAt?, instanceId? }. Any session opening this conversation renders the first entry with status = "pending" as the confirmation card — this is what makes the modal identical across sessions/devices rather than living only in one browser tab''s in-memory state.';
