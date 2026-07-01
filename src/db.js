import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseKey) {
  throw new Error(
    'Missing Supabase credentials.\n' +
    'Copy .env.example to .env and fill in VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.'
  )
}

export const supabase = createClient(supabaseUrl, supabaseKey)

// ── Categories ───────────────────────────────────────────────

export async function fetchCategories() {
  const { data, error } = await supabase
    .from('categories')
    .select('*')
    .order('name')
  if (error) throw error
  return data.map(dbCatToLocal)
}

export async function upsertCategory(cat) {
  const { data, error } = await supabase
    .from('categories')
    .upsert(localCatToDb(cat))
    .select()
    .single()
  if (error) throw error
  return dbCatToLocal(data)
}

export async function deleteCategory(id) {
  const { error } = await supabase.from('categories').delete().eq('id', id)
  if (error) throw error
}

// ── Components ───────────────────────────────────────────────

export async function fetchComponents() {
  const { data, error } = await supabase
    .from('components')
    .select('*')
    .order('created_at', { ascending: false })
  if (error) throw error
  return data.map(dbItemToLocal)
}

export async function upsertComponent(item) {
  const { data, error } = await supabase
    .from('components')
    .upsert(localItemToDb(item))
    .select()
    .single()
  if (error) throw error
  return dbItemToLocal(data)
}

export async function deleteComponent(id) {
  const { error } = await supabase.from('components').delete().eq('id', id)
  if (error) throw error
}

// ── Image storage ─────────────────────────────────────────────

export async function uploadImage(id, file) {
  const ext  = file.name.split('.').pop() || 'jpg'
  const path = `${id}.${ext}`
  await supabase.storage.from('component-images').remove([path])
  const { error } = await supabase.storage
    .from('component-images')
    .upload(path, file, { upsert: true })
  if (error) throw error
  const { data } = supabase.storage.from('component-images').getPublicUrl(path)
  return data.publicUrl
}

export async function deleteImage(id) {
  await supabase.storage
    .from('component-images')
    .remove([`${id}.jpg`, `${id}.jpeg`, `${id}.png`, `${id}.webp`])
}

// ── Assemblies ───────────────────────────────────────────────

export async function fetchAssemblies() {
  const { data, error } = await supabase
    .from('assemblies')
    .select('*')
    .order('created_at', { ascending: false })
  if (error) throw error
  return data.map(dbAssemblyToLocal)
}

export async function upsertAssembly(assembly) {
  const { data, error } = await supabase
    .from('assemblies')
    .upsert(localAssemblyToDb(assembly))
    .select()
    .single()
  if (error) throw error
  return dbAssemblyToLocal(data)
}

export async function deleteAssembly(id) {
  const { error } = await supabase.from('assemblies').delete().eq('id', id)
  if (error) throw error
}

// ── Assembly parts ────────────────────────────────────────────

export async function fetchAssemblyParts(assemblyId) {
  const { data, error } = await supabase
    .from('assembly_parts')
    .select('*')
    .eq('assembly_id', assemblyId)
    .order('created_at', { ascending: true })
  if (error) throw error
  return data.map(dbPartToLocal)
}

export async function upsertAssemblyPart(part) {
  const { data, error } = await supabase
    .from('assembly_parts')
    .upsert(localPartToDb(part))
    .select()
    .single()
  if (error) throw error
  return dbPartToLocal(data)
}

export async function bulkInsertAssemblyParts(parts) {
  const { data, error } = await supabase
    .from('assembly_parts')
    .insert(parts.map(localPartToDb))
    .select()
  if (error) throw error
  return data.map(dbPartToLocal)
}

export async function deleteAssemblyPart(id) {
  const { error } = await supabase.from('assembly_parts').delete().eq('id', id)
  if (error) throw error
}

// ── Assembly children ─────────────────────────────────────────

export async function fetchAssemblyChildren(parentId) {
  const { data, error } = await supabase
    .from('assembly_children')
    .select('*')
    .eq('parent_assembly_id', parentId)
    .order('created_at', { ascending: true })
  if (error) throw error
  return data.map(dbChildToLocal)
}

export async function bulkInsertAssemblyChildren(children) {
  if (!children.length) return []
  const { data, error } = await supabase
    .from('assembly_children')
    .insert(children.map(localChildToDb))
    .select()
  if (error) throw error
  return data.map(dbChildToLocal)
}

export async function deleteAssemblyChildrenByParent(parentId) {
  const { error } = await supabase
    .from('assembly_children')
    .delete()
    .eq('parent_assembly_id', parentId)
  if (error) throw error
}

/** Delete assembly records by ID list (used during re-import cleanup). */
export async function bulkDeleteAssemblies(ids) {
  if (!ids.length) return
  const { error } = await supabase
    .from('assemblies')
    .delete()
    .in('id', ids)
  if (error) throw error
}

// ── Mapping helpers ───────────────────────────────────────────

function dbCatToLocal(row) {
  return { id: row.id, name: row.name, requiredKeys: row.required_keys ?? [] }
}
function localCatToDb(cat) {
  return { id: cat.id, name: cat.name, required_keys: cat.requiredKeys ?? [] }
}

function dbItemToLocal(row) {
  return {
    id:          row.id,
    name:        row.name,
    description: row.description ?? '',
    categoryId:  row.category_id ?? null,
    quantity:    row.quantity ?? '',
    location:    row.location ?? '',
    image:       row.image_url ?? null,
    tags:        row.tags ?? [],
    attributes:  row.attributes ?? [],
    createdAt:   row.created_at,
  }
}
function localItemToDb(item) {
  return {
    id:          item.id,
    name:        item.name,
    description: item.description ?? '',
    category_id: item.categoryId ?? null,
    quantity:    item.quantity ?? '',
    location:    item.location ?? '',
    image_url:   item.image ?? null,
    tags:        item.tags ?? [],
    attributes:  item.attributes ?? [],
  }
}

function dbAssemblyToLocal(row) {
  return {
    id:                 row.id,
    name:               row.name,
    description:        row.description ?? '',
    onshapeUrl:         row.onshape_url ?? '',
    onshapeDocumentId:  row.onshape_document_id ?? '',
    onshapeWorkspaceId: row.onshape_workspace_id ?? '',
    onshapeElementId:   row.onshape_element_id ?? '',
    thumbnail:          row.thumbnail_url ?? null,
    status:             row.status ?? 'draft',
    createdAt:          row.created_at,
  }
}
function localAssemblyToDb(a) {
  return {
    id:                   a.id,
    name:                 a.name,
    description:          a.description ?? '',
    onshape_url:          a.onshapeUrl ?? '',
    onshape_document_id:  a.onshapeDocumentId ?? '',
    onshape_workspace_id: a.onshapeWorkspaceId ?? '',
    onshape_element_id:   a.onshapeElementId ?? '',
    thumbnail_url:        a.thumbnail ?? null,
    status:               a.status ?? 'draft',
  }
}

function dbPartToLocal(row) {
  return {
    id:                row.id,
    assemblyId:        row.assembly_id,
    partName:          row.part_name,
    partNumber:        row.part_number ?? '',
    quantityNeeded:    row.quantity_needed ?? 1,
    quantityCollected: row.quantity_collected ?? 0,
    status:            row.status ?? 'pending',
    source:            row.source ?? 'manual',
    notes:             row.notes ?? '',
    onshapeReference:  row.onshape_reference ?? null,
    createdAt:         row.created_at,
  }
}
function localPartToDb(p) {
  return {
    id:                 p.id,
    assembly_id:        p.assemblyId,
    part_name:          p.partName,
    part_number:        p.partNumber ?? '',
    quantity_needed:    p.quantityNeeded ?? 1,
    quantity_collected: p.quantityCollected ?? 0,
    status:             p.status ?? 'pending',
    source:             p.source ?? 'manual',
    notes:              p.notes ?? '',
    onshape_reference:  p.onshapeReference ?? null,
  }
}

function dbChildToLocal(row) {
  return {
    id:               row.id,
    parentAssemblyId: row.parent_assembly_id,
    childAssemblyId:  row.child_assembly_id,
    quantity:         row.quantity ?? 1,
    createdAt:        row.created_at,
  }
}
function localChildToDb(c) {
  return {
    id:                  c.id,
    parent_assembly_id:  c.parentAssemblyId,
    child_assembly_id:   c.childAssemblyId,
    quantity:            c.quantity ?? 1,
  }
}
