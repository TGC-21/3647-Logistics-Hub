// src/versionedMutations.js
//
// Version-tracked wrappers around db.js's existing CRUD functions. Each
// wrapper does the real mutation via the existing db.js function, then
// writes the corresponding change_log row(s) under one commitId — so
// callers don't have to remember the diff-and-log dance every time.
//
// deleteAssemblyWithHistory is the main deliverable here: it snapshots
// the ENTIRE part tree (the assembly, every nested assembly_child, every
// assembly_part anywhere in that tree) BEFORE deleting anything, then
// cascade-logs a DELETE row for every one of those rows under a single
// commit, tagged caused_by_entity_type/caused_by_entity_id pointing back
// at the assembly — so "what did deleting this assembly take down with
// it" is answerable later via fetchCascadeChildren('assembly', id).
//
// This mirrors the snapshot-before-mutate pattern api/onshape-bom.js
// already uses for reimport (walkAssemblyPartsTree → wipe → reseed) and
// for release-on-delete (fetchAllLinkedInstanceIdsForAssembly) — nothing
// here invents a new traversal strategy, it reuses the same shape.

import { supabase } from '../db.js'
import {
  fetchAllLinkedInstanceIdsForAssembly, fetchAllAssemblyPartIdsForAssembly,
  releaseInstances, deletePendingCartItemsForAssemblyPartIds, deleteAssembly,
  upsertInventoryInstance, upsertAssemblyPart, upsertAssembly, upsertCategory,
  findOrCreateComponent,
} from '../db.js'
import { genCommitId, recordChange, recordUpdateDiff } from '../changeLog.js'

function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2) }

// ── Small versioned wrappers for the highest-value mutators ────────
// Same shape for all of these: fetch "before" (if updating), do the real
// write, diff/record under one commitId, return the saved row untouched
// so call sites don't need to change how they consume the result.

export async function upsertInventoryInstanceVersioned(instance, actorId) {
  const isUpdate = !!instance.id
  const before = isUpdate
    ? (await supabase.from('inventory_instances').select('*').eq('id', instance.id).maybeSingle()).data
    : null

  const saved = await upsertInventoryInstance(instance)
  const commitId = genCommitId()

  if (!before) {
    await recordChange({ entityType: 'inventory_instance', entityId: saved.id, action: 'create', newValue: saved, actorId, commitId })
  } else {
    await recordUpdateDiff({
      entityType: 'inventory_instance', entityId: saved.id, before, after: saved,
      keys: ['name', 'description', 'location', 'quantity', 'status', 'notes', 'tags'],
      actorId, commitId,
    })
  }
  return saved
}

export async function upsertAssemblyPartVersioned(part, actorId) {
  const isUpdate = !!part.id
  const before = isUpdate
    ? (await supabase.from('assembly_parts').select('*').eq('id', part.id).maybeSingle()).data
    : null

  const saved = await upsertAssemblyPart(part)
  const commitId = genCommitId()

  if (!before) {
    await recordChange({ entityType: 'assembly_part', entityId: saved.id, action: 'create', newValue: saved, actorId, commitId })
  } else {
    await recordUpdateDiff({
      entityType: 'assembly_part', entityId: saved.id, before, after: saved,
      keys: [
        'partName', 'partNumber', 'quantityNeeded', 'quantityCollected', 'status',
        'notes', 'componentId', 'linkedInstanceIds', 'fabricationMetadata',
      ],
      actorId, commitId,
    })
  }
  return saved
}

export async function upsertAssemblyVersioned(assembly, actorId) {
  const isUpdate = !!assembly.id
  const before = isUpdate
    ? (await supabase.from('assemblies').select('*').eq('id', assembly.id).maybeSingle()).data
    : null

  const saved = await upsertAssembly(assembly)
  const commitId = genCommitId()

  if (!before) {
    await recordChange({ entityType: 'assembly', entityId: saved.id, action: 'create', newValue: saved, actorId, commitId })
  } else {
    await recordUpdateDiff({
      entityType: 'assembly', entityId: saved.id, before, after: saved,
      keys: ['name', 'description', 'onshapeUrl', 'status', 'thumbnail'],
      actorId, commitId,
    })
  }
  return saved
}

export async function upsertCategoryVersioned(cat, actorId) {
  const isUpdate = !!cat.id
  const before = isUpdate
    ? (await supabase.from('categories').select('*').eq('id', cat.id).maybeSingle()).data
    : null

  const saved = await upsertCategory(cat)
  const commitId = genCommitId()

  if (!before) {
    await recordChange({ entityType: 'category', entityId: saved.id, action: 'create', newValue: saved, actorId, commitId })
  } else {
    await recordUpdateDiff({
      entityType: 'category', entityId: saved.id, before, after: saved,
      keys: ['name', 'requiredKeysConfig'],
      actorId, commitId,
    })
  }
  return saved
}

export async function findOrCreateComponentVersioned(args, actorId) {
  // findOrCreateComponent returns an EXISTING component silently when one
  // already matches — only log a 'create' when this call actually
  // inserted a new row. We detect that by checking createdAt against
  // "just now" would be fragile; instead re-check existence before the
  // call, same before/after pattern as everything else here.
  const { data: candidatesBefore } = await supabase
    .from('components').select('id').eq('category_id', args.categoryId)
  const idsBefore = new Set((candidatesBefore || []).map(c => c.id))

  const component = await findOrCreateComponent(args)

  if (!idsBefore.has(component.id)) {
    await recordChange({
      entityType: 'component', entityId: component.id, action: 'create',
      newValue: component, actorId, commitId: genCommitId(),
    })
  }
  return component
}

// ── deleteAssemblyPart with history ─────────────────────────────
export async function deleteAssemblyPartVersioned(partId, actorId) {
  const { data: row } = await supabase.from('assembly_parts').select('*').eq('id', partId).maybeSingle()
  const { error } = await supabase.from('assembly_parts').delete().eq('id', partId)
  if (error) throw error
  if (row) {
    await recordChange({
      entityType: 'assembly_part', entityId: partId, action: 'delete',
      oldValue: row, actorId, commitId: genCommitId(),
    })
  }
}

// ── The main deliverable: cascade-snapshot assembly deletion ───────
//
// Walks the ENTIRE tree under a root assembly — the assembly row itself,
// every nested assembly_children row (any depth), and every
// assembly_parts row anywhere in that tree (root-owned or owned by any
// nested child) — and snapshots all of it BEFORE any delete happens.
// Only after every row is captured does it release linked inventory,
// clear pending cart items, and perform the actual delete (same
// release-before-delete order deleteCurrentAssembly already used).
//
// Every row in the snapshot gets its own DELETE change_log entry, all
// sharing one commitId (this whole operation is "one commit") and all
// tagged caused_by_entity_type: 'assembly', caused_by_entity_id: the
// root assembly's id — so fetchCascadeChildren('assembly', assemblyId)
// later answers "what did deleting this assembly take down with it",
// while fetchEntityHistory('assembly', assemblyId) still shows just the
// assembly's own lifecycle (create/update/delete), uncluttered by its
// children's rows.
export async function deleteAssemblyWithHistory(assemblyId, actorId) {
  const { data: assembly, error: asmFetchErr } = await supabase
    .from('assemblies').select('*').eq('id', assemblyId).single()
  if (asmFetchErr || !assembly) throw new Error('Assembly not found.')

  // ── 1. Snapshot the whole tree BEFORE anything is deleted ────────
  const childSnapshots = []   // assembly_children rows, any depth
  const partSnapshots  = []   // assembly_parts rows, root + every nested child

  const { data: rootParts, error: rootPartsErr } = await supabase
    .from('assembly_parts').select('*').eq('assembly_id', assemblyId)
  if (rootPartsErr) throw rootPartsErr
  partSnapshots.push(...(rootParts || []))

  const { data: directChildren, error: dcErr } = await supabase
    .from('assembly_children').select('*').eq('parent_assembly_id', assemblyId)
  if (dcErr) throw dcErr
  childSnapshots.push(...(directChildren || []))

  const queue = (directChildren || []).map(c => c.id)
  while (queue.length) {
    const childId = queue.pop()

    const { data: childParts, error: cpErr } = await supabase
      .from('assembly_parts').select('*').eq('assembly_child_id', childId)
    if (cpErr) throw cpErr
    partSnapshots.push(...(childParts || []))

    const { data: grandchildren, error: gcErr } = await supabase
      .from('assembly_children').select('*').eq('parent_child_id', childId)
    if (gcErr) throw gcErr
    childSnapshots.push(...(grandchildren || []))
    queue.push(...(grandchildren || []).map(c => c.id))
  }

  // ── 2. Do the existing pre-delete cleanup (release inventory, clear
  //        pending cart items) — unchanged behavior, just reusing the
  //        already-fetched db.js helpers rather than re-deriving ids
  //        from the snapshot above (linked_instance_ids/pending cart
  //        item scoping rules already live there; no need to duplicate). ─
  const linkedIds = await fetchAllLinkedInstanceIdsForAssembly(assemblyId)
  if (linkedIds.length) await releaseInstances(linkedIds)

  const partIds = await fetchAllAssemblyPartIdsForAssembly(assemblyId)
  if (partIds.length) await deletePendingCartItemsForAssemblyPartIds(partIds)

  // ── 3. Perform the actual delete (cascades assembly_children +
  //        assembly_parts via their FKs, same as before). ─────────────
  await deleteAssembly(assemblyId)

  // ── 4. Log everything, now that we know the delete succeeded ───────
  const commitId = genCommitId()

  await recordChange({
    entityType: 'assembly', entityId: assemblyId, action: 'delete',
    oldValue: assembly, actorId, commitId,
  })

  for (const child of childSnapshots) {
    await recordChange({
      entityType: 'assembly_child', entityId: child.id, action: 'delete',
      oldValue: child, actorId, commitId,
      causedByEntityType: 'assembly', causedByEntityId: assemblyId,
    })
  }

  for (const part of partSnapshots) {
    await recordChange({
      entityType: 'assembly_part', entityId: part.id, action: 'delete',
      oldValue: part, actorId, commitId,
      causedByEntityType: 'assembly', causedByEntityId: assemblyId,
    })
  }

  return {
    deletedChildCount: childSnapshots.length,
    deletedPartCount:  partSnapshots.length,
    commitId,
  }
}