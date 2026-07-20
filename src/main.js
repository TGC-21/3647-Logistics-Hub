import './style.css'
import { renderSegmentEditor } from './segmentEditor.js'
import {
  fetchCategories,
  upsertCategory,  deleteCategory,
  uploadImage,     deleteImage,
  validateAttribute, reconcileOrphanedInstances,
  fetchInventoryInstances, upsertInventoryInstance, deleteInventoryInstance,
  findOrCreateComponent, deleteComponentIfOrphaned, updateComponentFallback,
  attrsArrayToMap,
} from './db.js'
import {
  designerBoot,        setToast,
  renderDesignerSidebar, renderDesignerContent,
  bindDesignerEvents,  openAssemblyModal,
  selectAssembly,      openOnshapeModal,
  bootIsolatedAssembly, bootIsolatedChild,
} from './designer.js'

import {
  fabricateBoot,          setFabricateToast,
  renderFabricateSidebar, renderFabricateContent,
  bindFabricateEvents,    selectBatch,
} from './fabricate.js'

import {
  partOrdersBoot, setPartOrdersToast,
  renderPartOrdersSidebar, renderPartOrdersContent,
  bindPartOrdersEvents, selectCart, openCartModal,
  bindManageVendorsEvents,
} from './partOrders.js'

window.reconcileInventory = reconcileOrphanedInstances

// ── State ─────────────────────────────────────────────────────
let items         = []
let categories    = []
let editingId     = null
let editingTags   = []
let currentImageFile = null
let currentImageUrl  = null
let detailId      = null
let view          = { type: 'all', catId: null, tag: null }
let openCats      = new Set()
let editingCatId  = null
let editingReqKeysConfig = []   // [{ key, type: 'string'|'quantity'|'enum', options?, defaultUnit? }]
let appMode = 'inventory' //'inventory' | 'designer' | 'fabricate'

// ── Boot ──────────────────────────────────────────────────────
async function boot() {
  setToast(showToast)
  setFabricateToast(showToast)
  setPartOrdersToast(showToast)

  // "?asm=<id>" opens a single ROOT assembly full-screen; "?child=<id>"
  // opens a single SUBASSEMBLY node full-screen. Both have no sidebar/other
  // assemblies in reach — used by the subassembly "open in new window" action.
  const params        = new URLSearchParams(location.search)
  const isolatedAsmId = params.get('asm')
  const isolatedChildId = params.get('child')

  if (isolatedChildId) {
    document.body.classList.add('isolated-view')
    appMode = 'designer'
    try {
      await bootIsolatedChild(isolatedChildId)
    } catch (e) {
      console.error(e)
      showToast('Could not load subassembly')
    }
    bindStaticEvents()
    bindDesignerEvents()
    return
  }

  if (isolatedAsmId) {
    document.body.classList.add('isolated-view')
    appMode = 'designer'
    try {
      await bootIsolatedAssembly(isolatedAsmId)
    } catch (e) {
      console.error(e)
      showToast('Could not load assembly')
    }
    bindStaticEvents()
    bindDesignerEvents()
    return
  }

  try {
    [categories, items] = await Promise.all([fetchCategories(), fetchInventoryInstances()])
    await designerBoot()
    await fabricateBoot()
    await partOrdersBoot()

  } catch (e) {
    console.error(e)
    showToast('Could not connect to database — check your .env file')
  }
  render()
  try { bindStaticEvents() }    catch (e) { console.error('[boot] bindStaticEvents failed', e) }
  try { bindDesignerEvents() }  catch (e) { console.error('[boot] bindDesignerEvents failed', e) }
  try { bindFabricateEvents() } catch (e) { console.error('[boot] bindFabricateEvents failed', e) }
  try { bindPartOrdersEvents() } catch (e) { console.error('[boot] bindPartOrdersEvents failed', e) }
  try { bindManageVendorsEvents()} catch (e) { console.error('[boot] bindManageVendorsEvents failed', e)}
  
}

// ── Helpers ───────────────────────────────────────────────────
function genId()         { return Date.now().toString(36) + Math.random().toString(36).slice(2) }
function catById(id)     { return categories.find(c => c.id === id) }
function itemsForCat(id) { return items.filter(it => it.categoryId === id) }
function uncategorized() { return items.filter(it => !it.categoryId || !catById(it.categoryId)) }

function showToast(msg) {
  const t = document.createElement('div')
  t.className = 'toast'
  t.textContent = msg
  document.body.appendChild(t)
  setTimeout(() => t.remove(), 2600)
}

// ── Mode switching ─────────────────────────────────────────────
function setMode(newMode) {
  appMode = newMode // 'inventory' | 'designer' | 'fabricate'

  document.getElementById('btn-mode-inventory').classList.toggle('active', appMode === 'inventory')
  document.getElementById('btn-mode-designer').classList.toggle('active', appMode==='designer')
  document.getElementById('btn-mode-fabricate').classList.toggle('active', appMode === 'fabricate')
  document.getElementById('inventory-actions').computedStyleMap.display = appMode === 'inventory' ? '' : 'none'
  document.getElementById('designer-actions').style.display = appMode === 'designer' ? '' : 'none'
  document.getElementById('fabricate-actions').style.display = appMode === 'fabricate' ? '' : 'none'
  document.getElementById('topbar-search-wrap').style.display = appMode === 'inventory' ? '' : 'none'
  document.getElementById('btn-mode-partorders').classList.toggle('active', appMode === 'partorders')
  document.getElementById('partorders-actions').style.display = appMode === 'partorders' ? '' : 'none'

  // Mobile bottom tab bar + FAB mirror the same mode
  const tabComponents = document.getElementById('tab-btn-components')
  const tabDesigner    = document.getElementById('tab-btn-designer')
  const tabFabricate = document.getElementById('tab-btn-fabricate')
  if (tabComponents && tabDesigner && tabFabricate){
    tabComponents.classList.toggle('active', appMode === 'inventory')
    tabDesigner.classList.toggle('active', appMode ==='designer')
    tabFabricate.classList.toggle('active', appMode === 'fabricate')
  }
  
  // Designer/Fabricate each surface their own create actions elsewhere, so the generic 'add' FAB only makes sense in inventory mode.
  const fab = document.getElementById('mobile-fab')
  if (fab) fab.classList.toggle('fab-hidden', appMode !== 'inventory')

    // Lets mobile CSS reserve extra bottom padding when a mode's pinned action bar (above the tab bar) is visible, so content isn't hidden.
    document.body.classList.toggle('designer-mode', appMode === 'designer')
    document.body.classList.toggle('fabricate-mode', appMode === 'fabricate')

  render()
}

// ── Render ────────────────────────────────────────────────────
function render() {
  if (appMode === 'designer') {
    renderDesignerSidebar()
    renderDesignerContent()
  } else if (appMode === 'fabricate'){
    renderFabricateSidebar()
    renderFabricateContent()
  } else if (appMode === 'partorders') {
  renderPartOrdersSidebar()
  renderPartOrdersContent()
  } else {
    renderSidebar()
    renderContent()
  } 
}

function renderSidebar() {
  // Rebuild nav-all text (may have been overwritten by designer mode)
  const navAll = document.getElementById('nav-all')
  navAll.innerHTML = `<i class="ti ti-layout-grid" aria-hidden="true"></i> All components
    <span class="nav-count">${items.length}</span>`
  navAll.className = 'nav-item' + (view.type === 'all' ? ' active' : '')

  // Restore sidebar label
  const labelEl = document.getElementById('sidebar-label-cats')
  if (labelEl) labelEl.textContent = 'Categories'

  const catNav = document.getElementById('cat-nav')
  catNav.innerHTML = ''
  categories.forEach(cat => {
    const ci     = itemsForCat(cat.id)
    const isOpen = openCats.has(cat.id)
    const active = view.type === 'cat' && view.catId === cat.id

    const tagCounts = {}
    ci.forEach(it => (it.tags || []).forEach(t => { tagCounts[t] = (tagCounts[t] || 0) + 1 }))
    const tagEntries = Object.entries(tagCounts).sort(([a],[b]) => a.localeCompare(b))

    const g = document.createElement('div')
    g.className = 'cat-group'
    g.innerHTML = `
      <div class="cat-header${active ? ' active' : ''}${isOpen ? ' open' : ''}" data-cat-toggle="${cat.id}">
        <i class="ti ti-folder" style="font-size:15px;flex-shrink:0" aria-hidden="true"></i>
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px">${cat.name}</span>
        <span style="font-size:11px;color:var(--color-text-tertiary);margin-right:3px">${ci.length}</span>
        <i class="chev ti ti-chevron-right" aria-hidden="true"></i>
      </div>
      <div class="cat-children${isOpen ? ' open' : ''}">
        <div class="nav-item${active ? ' active' : ''}" style="font-size:12px;padding:3px 8px" data-view-cat="${cat.id}">
          <i class="ti ti-layout-grid" style="font-size:13px" aria-hidden="true"></i> All in category
        </div>
        ${tagEntries.map(([t, c]) => `
          <div class="tag-item${view.type === 'tag' && view.tag === t && view.catId === cat.id ? ' active' : ''}"
               data-view-tag="${t}" data-view-tag-cat="${cat.id}">
            <span class="tag-pill">${t}</span>
            <span style="font-size:10px;color:var(--color-text-tertiary)">${c}</span>
          </div>`).join('')}
      </div>`
    catNav.appendChild(g)
  })

  // Global tags
  const allTagCounts = {}
  items.forEach(it => (it.tags || []).forEach(t => { allTagCounts[t] = (allTagCounts[t] || 0) + 1 }))
  const allTagEntries = Object.entries(allTagCounts).sort(([a],[b]) => a.localeCompare(b))
  const tagsNav     = document.getElementById('tags-nav')
  const tagsDivider = document.getElementById('tags-divider')
  const tagsLabel   = document.getElementById('tags-label')
  if (allTagEntries.length) {
    tagsDivider.style.display = ''
    tagsLabel.style.display   = ''
    tagsNav.innerHTML = allTagEntries.map(([t, c]) => `
      <div class="tag-item${view.type === 'tag' && view.tag === t && !view.catId ? ' active' : ''}"
           style="margin:0 4px" data-view-tag="${t}" data-view-tag-cat="">
        <span class="tag-pill">${t}</span>
        <span style="font-size:10px;color:var(--color-text-tertiary)">${c}</span>
      </div>`).join('')
  } else {
    tagsDivider.style.display = 'none'
    tagsLabel.style.display   = 'none'
    tagsNav.innerHTML = ''
  }
}

function renderContent() {
  const q = (document.getElementById('search-input').value || '').toLowerCase()
  let titleText = 'All components'
  if (view.type === 'cat' && view.catId) titleText = (catById(view.catId) || {}).name || 'Category'
  if (view.type === 'tag') titleText = '#' + view.tag + (view.catId ? ' in ' + (catById(view.catId) || {}).name : '')
  document.getElementById('content-title').textContent = titleText

  const area = document.getElementById('main-area')

  if (items.length === 0) {
    document.getElementById('content-meta').textContent = ''
    area.innerHTML = `<div class="empty">
      <i class="ti ti-box-off" aria-hidden="true"></i>
      <div class="empty-title">No components yet</div>
      <div class="empty-sub">Add your first component to start building your inventory.</div>
      <button class="btn btn-primary" id="empty-add-btn"><i class="ti ti-plus"></i> Add component</button>
    </div>`
    document.getElementById('empty-add-btn').addEventListener('click', () => openAddModal())
    return
  }

  if (view.type === 'all') {
    let html = '', total = 0
    categories.forEach(cat => {
      const ci = itemsForCat(cat.id).filter(it => matchQ(it, q, cat))
      if (!ci.length) return
      total += ci.length
      html += `<div class="section-heading"><i class="ti ti-folder" aria-hidden="true"></i>${cat.name} <span class="section-count">${ci.length}</span></div><div class="grid">${ci.map(cardHTML).join('')}</div>`
    })
    const uncat = uncategorized().filter(it => matchQ(it, q, null))
    if (uncat.length) {
      total += uncat.length
      html += `<div class="section-heading"><i class="ti ti-inbox" aria-hidden="true"></i>Uncategorized <span class="section-count">${uncat.length}</span></div><div class="grid">${uncat.map(cardHTML).join('')}</div>`
    }
    document.getElementById('content-meta').textContent = total === 1 ? '1 component' : total + ' components'
    area.innerHTML = total ? html : `<div class="empty"><i class="ti ti-search-off" aria-hidden="true"></i><div class="empty-title">No results</div><div class="empty-sub">Try a different search term.</div></div>`
    return
  }

  const filtered = items.filter(it => {
    const matchCat = view.type === 'cat'
      ? it.categoryId === view.catId
      : (view.catId ? it.categoryId === view.catId : true) && (it.tags || []).includes(view.tag)
    return matchCat && matchQ(it, q, catById(it.categoryId))
  })
  document.getElementById('content-meta').textContent = filtered.length === 1 ? '1 component' : filtered.length + ' components'
  area.innerHTML = filtered.length
    ? `<div class="grid">${filtered.map(cardHTML).join('')}</div>`
    : `<div class="empty"><i class="ti ti-search-off" aria-hidden="true"></i><div class="empty-title">No results</div><div class="empty-sub">Try a different filter.</div></div>`
}

function matchQ(it, q, cat) {
  if (!q) return true
  return it.name.toLowerCase().includes(q)
    || (it.description || '').toLowerCase().includes(q)
    || (it.tags || []).some(t => t.toLowerCase().includes(q))
    || ((cat || {}).name || '').toLowerCase().includes(q)
    || (it.location || '').toLowerCase().includes(q)
}

function cardHTML(it) {
  const cat    = catById(it.categoryId)
  const hasQty = it.quantity !== null && it.quantity !== undefined && it.quantity !== ''
  return `<div class="card" data-open-detail="${it.id}">
    ${it.image
      ? `<div class="card-img"><img src="${it.image}" alt="${it.name}" loading="lazy"></div>`
      : `<div class="card-img"><i class="ti ti-photo" style="font-size:28px;color:var(--color-text-tertiary)" aria-hidden="true"></i></div>`}
    <div class="card-body">
      <div class="card-name">${it.name}</div>
      ${cat ? `<div class="card-cat"><i class="ti ti-folder" style="font-size:11px" aria-hidden="true"></i>${cat.name}</div>` : ''}
      ${(hasQty || it.location) ? `<div class="card-meta">
        ${hasQty ? `<span class="card-meta-item"><i class="ti ti-stack-2" style="font-size:11px" aria-hidden="true"></i>${it.quantity}</span>` : ''}
        ${it.location ? `<span class="card-meta-item"><i class="ti ti-map-pin" style="font-size:11px" aria-hidden="true"></i>${it.location}</span>` : ''}
      </div>` : ''}
      ${it.description ? `<div class="card-desc">${it.description}</div>` : ''}
      <div class="card-tags">${(it.tags || []).map(t => `<span class="tag">${t}</span>`).join('')}</div>
    </div>
  </div>`
}

// ── Static event bindings ─────────────────────────────────────
function bindStaticEvents() {
  document.getElementById('search-input').addEventListener('input', render)
  document.getElementById('btn-add').addEventListener('click', () => openAddModal())
  document.getElementById('btn-manage-cats').addEventListener('click', openCatModal)
  document.getElementById('btn-mode-partorders').addEventListener('click', () => setMode('partorders'))
  document.getElementById('btn-new-cart-topbar').addEventListener('click', () => openCartModal())


  // Sidebar drawer (mobile)
  const sidebarEl   = document.getElementById('sidebar')
  const backdropEl  = document.getElementById('sidebar-backdrop')
  const toggleBtn   = document.getElementById('btn-sidebar-toggle')

  function openSidebar() {
    sidebarEl.classList.add('open')
    backdropEl.classList.add('visible')
    document.body.style.overflow = 'hidden'
  }
  function closeSidebar() {
    sidebarEl.classList.remove('open')
    backdropEl.classList.remove('visible')
    document.body.style.overflow = ''
  }

  toggleBtn.addEventListener('click', () =>
    sidebarEl.classList.contains('open') ? closeSidebar() : openSidebar()
  )
  backdropEl.addEventListener('click', closeSidebar)

  // Close drawer whenever user picks a category, tag, or assembly
  document.getElementById('sidebar').addEventListener('click', () => {
    if (window.innerWidth <= 640) closeSidebar()
  })

  // Mode toggle
  document.getElementById('btn-mode-inventory').addEventListener('click', () => setMode('inventory'))
  document.getElementById('btn-mode-designer').addEventListener('click', () => setMode('designer'))
  document.getElementById('btn-mode-fabricate').addEventListener('click', () => setMode('fabricate'))
  document.getElementById('btn-new-assembly').addEventListener('click', () => openAssemblyModal())
  document.getElementById('btn-new-from-onshape').addEventListener('click', () => openOnshapeModal('link'))

  // ── Mobile bottom tab bar ──────────────────────────────────
  document.getElementById('tab-btn-components').addEventListener('click', () => setMode('inventory'))
  document.getElementById('tab-btn-designer').addEventListener('click', () => setMode('designer'))
  document.getElementById('tab-btn-fabricate').addEventListener('click', () => setMode('fabricate'))
  document.getElementById('tab-btn-categories').addEventListener('click', () => {
    setMode('inventory')
    openSidebar()
  })

  // ── Mobile floating action button ──────────────────────────
  // Mirrors whichever "primary create" action applies to the current mode.
  // (Hidden outright outside inventory mode - see setMode - but Designer's
  // and Fabricate's own action bars cover their create flows either way.)
  document.getElementById('mobile-fab').addEventListener('click', () => {
    appMode === 'designer' ? openAssemblyModal() : openAddModal()
  })

  // ── Mobile fullscreen search ────────────────────────────────
  const mobileSearchBar   = document.getElementById('mobile-search-bar')
  const mobileSearchInput = document.getElementById('mobile-search-input')
  const desktopSearchInput = document.getElementById('search-input')

  document.getElementById('btn-mobile-search').addEventListener('click', () => {
    mobileSearchBar.classList.add('open')
    mobileSearchInput.value = desktopSearchInput.value
    mobileSearchInput.focus()
  })
  document.getElementById('btn-mobile-search-close').addEventListener('click', () => {
    mobileSearchBar.classList.remove('open')
  })
  // Keep the (hidden) desktop search input in sync so existing render() filtering just works
  mobileSearchInput.addEventListener('input', () => {
    desktopSearchInput.value = mobileSearchInput.value
    render()
  })

  // nav-all: route by mode
  document.getElementById('nav-all').addEventListener('click', () => {
    if (appMode === 'designer') { selectAssembly(null); return }
    if (appMode === 'fabricate') { selectBatch(null); return }
    setView('all', null, null)
  })

  // Sidebar delegation (inventory only — designer/fabricate items bind their own listeners)
  document.getElementById('sidebar').addEventListener('click', e => {
    if (appMode !== 'inventory') return
    const toggle = e.target.closest('[data-cat-toggle]')
    if (toggle) { toggleCat(toggle.dataset.catToggle); return }
    const viewCat = e.target.closest('[data-view-cat]')
    if (viewCat) { e.stopPropagation(); setView('cat', viewCat.dataset.viewCat, null); return }
    const viewTag = e.target.closest('[data-view-tag]')
    if (viewTag) { e.stopPropagation(); setView('tag', viewTag.dataset.viewTagCat || null, viewTag.dataset.viewTag); return }
  })

  // Main area delegation (card clicks — inventory only)
  document.getElementById('main-area').addEventListener('click', e => {
    if (appMode !== 'inventory') return
    const card = e.target.closest('[data-open-detail]')
    if (card) openDetail(card.dataset.openDetail)
  })

  // Component modal
  document.getElementById('btn-close-modal').addEventListener('click', closeModal)
  document.getElementById('btn-cancel-modal').addEventListener('click', closeModal)
  document.getElementById('modal-overlay').addEventListener('click', e => { if (e.target === e.currentTarget) closeModal() })

  // Detail modal
  document.getElementById('btn-close-detail').addEventListener('click', closeDetail)
  document.getElementById('detail-overlay').addEventListener('click', e => { if (e.target === e.currentTarget) closeDetail() })
  document.getElementById('btn-detail-edit').addEventListener('click', openEditFromDetail)
  document.getElementById('btn-detail-delete').addEventListener('click', deleteFromDetail)

  // Manage categories modal
  document.getElementById('btn-close-cat-modal').addEventListener('click', closeCatModal)
  document.getElementById('btn-done-cats').addEventListener('click', closeCatModal)
  document.getElementById('cat-modal-overlay').addEventListener('click', e => { if (e.target === e.currentTarget) closeCatModal() })

  // Edit single category modal
  document.getElementById('btn-close-edit-cat').addEventListener('click', closeEditCat)
  document.getElementById('btn-cancel-edit-cat').addEventListener('click', closeEditCat)
  document.getElementById('btn-save-edit-cat').addEventListener('click', saveEditCat)
  document.getElementById('btn-delete-cat').addEventListener('click', deleteCat)
  document.getElementById('edit-cat-overlay').addEventListener('click', e => { if (e.target === e.currentTarget) closeEditCat() })
  document.getElementById('btn-add-req-key-config').addEventListener('click', addReqKeyConfig)

  // Component form fields
  document.getElementById('field-cat').addEventListener('change', () => onCatChange())
  document.getElementById('field-img').addEventListener('change', handleImageUpload)
  document.getElementById('btn-clear-img').addEventListener('click', clearImage)
  document.getElementById('btn-new-cat').addEventListener('click', showNewCatRow)
  document.getElementById('btn-cancel-new-cat').addEventListener('click', cancelNewCat)
  document.getElementById('btn-confirm-new-cat').addEventListener('click', confirmNewCat)
  document.getElementById('btn-add-attr').addEventListener('click', () => addAttrRow())
  document.getElementById('btn-view-component').addEventListener('click', () => {
    const it = editingId ? items.find(x => x.id === editingId) : null
    if (!it) { showToast('Save this instance once before editing its component defaults'); return }
    openComponentView(it.componentId)
  })
  document.getElementById('btn-close-component-view').addEventListener('click', () =>
    document.getElementById('component-view-overlay').style.display = 'none')
  document.getElementById('btn-cancel-component-view').addEventListener('click', () =>
    document.getElementById('component-view-overlay').style.display = 'none')
  document.getElementById('btn-save-component-view').addEventListener('click', saveComponentFallback)
  document.getElementById('btn-save-item').addEventListener('click', saveItem)

  // Tags input
  document.getElementById('tags-wrap').addEventListener('click', () => document.getElementById('tag-input').focus())
  document.getElementById('tag-input').addEventListener('keydown', handleTagKey)
}

// ── View navigation ───────────────────────────────────────────
function setView(type, catId, tag) {
  view = { type, catId, tag }
  render()
}

function toggleCat(catId) {
  if (openCats.has(catId)) openCats.delete(catId); else openCats.add(catId)
  setView('cat', catId, null)
}

// ── Add / Edit Component Modal ────────────────────────────────
function populateCatSelect(selectedId) {
  const sel = document.getElementById('field-cat')
  sel.innerHTML = '<option value="">— Uncategorized —</option>' +
    categories.map(c => `<option value="${c.id}"${c.id === selectedId ? ' selected' : ''}>${c.name}</option>`).join('')
}

function onCatChange() {
  refreshRequiredAttrs(document.getElementById('field-cat').value)
}

// ── Typed required-attribute rendering ─────────────────────────
//
// Each required characteristic on a category carries a `type`:
//   'string'   → plain text input
//   'quantity' → number input + a (read-only) unit label from the category
//   'enum'     → <select> populated from the category's preset options
//
// The rendered row always stores machine-usable state via data-* attrs
// (data-type, data-config-key) so saveItem() can read values back out
// without re-looking-up the category.

function refreshRequiredAttrs(catId) {
  const cat        = catById(catId)
  const keysConfig = (cat && cat.requiredKeysConfig) || []
  const list       = document.getElementById('attrs-list')

  // Preserve any existing NON-required rows (free-form extras) before wiping.
  const existingExtras = [...list.querySelectorAll('.attr-row:not([data-required])')].map(r => ({
    key: r.querySelector('[data-key-input]')?.value || '',
    val: r.querySelector('[data-val-input]')?.value || '',
  }))
  // Preserve current values of required rows too, in case the user is
  // switching categories back and forth without meaning to lose input.
  const existingRequired = {}
  list.querySelectorAll('.attr-row[data-required]').forEach(row => {
    const key = row.dataset.configKey
    if (!key) return
    existingRequired[key] = readAttrRowValue(row)
  })

  list.innerHTML = ''

  keysConfig.forEach(cfg => {
    const existingVal = existingRequired[cfg.key] ?? ''
    list.appendChild(buildRequiredAttrRow(cfg, existingVal))
  })

  existingExtras
    .filter(e => e.key && !keysConfig.some(c => c.key === e.key))
    .forEach(({ key, val }) => addAttrRow(key, val))
}

/** Reads the current value out of a required attr row, regardless of type. */
function readAttrRowValue(row) {
  const type = row.dataset.type
  if (type === 'quantity') {
    const numInput = row.querySelector('input[data-num-input]')
    return numInput ? numInput.value : ''
  }
  if (type === 'segments') {
    const editorEl = row.querySelector('.attr-segments-editor')
    const segments  = editorEl?._segmentsValue || []
    return { totalLength: segments.reduce((s, seg) => s + (seg.length || 0), 0), segments }
  }
  // enum (<select>) and string (<input>) both expose data-val-input directly
  const input = row.querySelector('[data-val-input]')
  return input ? input.value : ''
}

/** Builds one required-characteristic row for the given type config. */
function buildRequiredAttrRow(cfg, existingVal) {
  const row = document.createElement('div')
  row.className = 'attr-row'
  row.dataset.required  = '1'
  row.dataset.type       = cfg.type || 'string'
  row.dataset.configKey  = cfg.key

  const keyInput = document.createElement('input')
  keyInput.type = 'text'
  keyInput.value = cfg.key
  keyInput.readOnly = true
  keyInput.dataset.keyInput = '1'
  keyInput.style.flex = '1'

  let valueEl

  if (cfg.type === 'enum') {
    const select = document.createElement('select')
    select.dataset.valInput = '1'
    select.className = 'attr-typed-select'
    select.style.flex = '1.5'

    const blank = document.createElement('option')
    blank.value = ''
    blank.textContent = '— Select —'
    select.appendChild(blank)

    ;(cfg.options || []).forEach(opt => {
      const o = document.createElement('option')
      o.value = opt
      o.textContent = opt
      if (opt === existingVal) o.selected = true
      select.appendChild(o)
    })
    valueEl = select

  } else if (cfg.type === 'quantity') {
    const wrap = document.createElement('div')
    wrap.className = 'attr-quantity-wrap'
    wrap.style.flex = '1.5'
    wrap.dataset.valInput = '1'   // marker so generic lookups still find this row

    const numInput = document.createElement('input')
    numInput.type = 'number'
    numInput.step = 'any'
    numInput.placeholder = 'Amount'
    numInput.dataset.numInput = '1'
    // existingVal may be "5 g" (already-saved) or just "5" (mid-edit) — take the numeric part
    numInput.value = String(existingVal).trim().split(/\s+/)[0] || ''

    const unit = document.createElement('span')
    unit.className = 'attr-quantity-unit'
    unit.textContent = cfg.defaultUnit || ''

    wrap.appendChild(numInput)
    wrap.appendChild(unit)
    valueEl = wrap

  } else if (cfg.type === 'segments') {
    const wrap = document.createElement('div')
    wrap.className = 'attr-segments-editor'
    wrap.style.flex = '1.5'
    wrap.dataset.valInput = '1'
    const initial = (existingVal && typeof existingVal === 'object' && Array.isArray(existingVal.segments))
      ? existingVal.segments.map(s => ({ ...s }))
      : []
    wrap._segmentsValue = initial
    renderSegmentEditor(wrap, initial, {
      editable: true,
      unit: cfg.segmentUnit || 'in',
      onChange: segs => { wrap._segmentsValue = segs },
    })
    valueEl = wrap
  } else {
    const input = document.createElement('input')
    input.type = 'text'
    input.placeholder = 'Value'
    input.dataset.valInput = '1'
    input.value = existingVal
    input.style.flex = '1.5'
    valueEl = input
  }

  const badge = document.createElement('span')
  badge.className = 'attr-required-badge'
  badge.textContent = 'required'

  row.append(keyInput, valueEl, badge)
  return row
}

function openAddModal(prefillCatId) {
  editingId = null; editingTags = []; currentImageFile = null; currentImageUrl = null
  document.getElementById('modal-title').textContent = 'Add component'
  document.getElementById('field-name').value = ''
  document.getElementById('field-desc').value = ''
  document.getElementById('field-qty').value  = ''
  document.getElementById('field-loc').value  = ''
  document.getElementById('img-preview').style.display = 'none'
  document.getElementById('btn-clear-img').style.display = 'none'
  document.getElementById('img-upload-inner').style.display = ''
  document.getElementById('field-img').value = ''
  document.getElementById('attrs-list').innerHTML = ''
  const prefill = prefillCatId || (view.type === 'cat' ? view.catId : null)
  populateCatSelect(prefill)
  hideNewCatRow()
  renderTagChips()
  if (prefill) refreshRequiredAttrs(prefill)
  document.getElementById('modal-overlay').style.display = 'flex'
  setTimeout(() => document.getElementById('field-name').focus(), 80)
}

function openEditModal(id) {
  const it = items.find(x => x.id === id); if (!it) return
  editingId = id; editingTags = [...(it.tags || [])]; currentImageFile = null; currentImageUrl = it.image || null
  document.getElementById('modal-title').textContent = 'Edit component'
  document.getElementById('field-name').value = it.name
  document.getElementById('field-desc').value = it.description || ''
  document.getElementById('field-qty').value  = it.quantity !== undefined ? it.quantity : ''
  document.getElementById('field-loc').value  = it.location || ''
  if (it.image) {
    document.getElementById('img-preview').src = it.image
    document.getElementById('img-preview').style.display = 'block'
    document.getElementById('btn-clear-img').style.display = 'inline-flex'
    document.getElementById('img-upload-inner').style.display = 'none'
  } else {
    document.getElementById('img-preview').style.display = 'none'
    document.getElementById('btn-clear-img').style.display = 'none'
    document.getElementById('img-upload-inner').style.display = ''
  }
  populateCatSelect(it.categoryId)
  hideNewCatRow()
  renderTagChips()

  const al        = document.getElementById('attrs-list'); al.innerHTML = ''
  const cat        = catById(it.categoryId)
  const keysConfig = (cat && cat.requiredKeysConfig) || []

  keysConfig.forEach(cfg => {
    const existing = (it.attributes || []).find(a => a.key === cfg.key)
    al.appendChild(buildRequiredAttrRow(cfg, existing ? existing.value : ''))
  })
  ;(it.attributes || [])
    .filter(a => !keysConfig.some(c => c.key === a.key))
    .forEach(a => addAttrRow(a.key, a.value))

  document.getElementById('modal-overlay').style.display = 'flex'
  setTimeout(() => document.getElementById('field-name').focus(), 80)
}

function closeModal() { document.getElementById('modal-overlay').style.display = 'none' }

function showNewCatRow() {
  document.getElementById('new-cat-row').style.display = 'flex'
  document.getElementById('btn-new-cat').style.display = 'none'
  setTimeout(() => document.getElementById('new-cat-input').focus(), 60)
}
function cancelNewCat()  { hideNewCatRow() }
function hideNewCatRow() {
  document.getElementById('new-cat-row').style.display = 'none'
  document.getElementById('btn-new-cat').style.display = 'inline-flex'
  document.getElementById('new-cat-input').value = ''
}
async function confirmNewCat() {
  const name = document.getElementById('new-cat-input').value.trim(); if (!name) return
  const cat = { id: genId(), name, requiredKeysConfig: [] }
  try {
    const saved = await upsertCategory(cat)
    categories.push(saved)
    populateCatSelect(saved.id)
    document.getElementById('field-cat').value = saved.id
    hideNewCatRow()
    refreshRequiredAttrs(saved.id)
    render()
    showToast('Category created')
  } catch (e) { showToast('Error saving category') }
}

// Compresses an image client-side (resize + re-encode as JPEG) before it
// ever reaches uploadImage()/Supabase, so storage isn't full of untouched
// multi-megabyte phone photos.
function compressImage(file, maxWidth = 800, quality = 0.75) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = e => {
      const img = new Image()
      img.onload = () => {
        const scale  = Math.min(1, maxWidth / img.width)
        const canvas = document.createElement('canvas')
        canvas.width  = img.width * scale
        canvas.height = img.height * scale
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height)
        canvas.toBlob(
          blob => resolve(new File([blob], file.name, { type: 'image/jpeg' })),
          'image/jpeg',
          quality
        )
      }
      img.onerror = reject
      img.src = e.target.result
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

async function handleImageUpload(e) {
  const file = e.target.files[0]; if (!file) return
  currentImageFile = await compressImage(file)
  const reader = new FileReader()
  reader.onload = ev => {
    currentImageUrl = ev.target.result
    document.getElementById('img-preview').src = currentImageUrl
    document.getElementById('img-preview').style.display = 'block'
    document.getElementById('btn-clear-img').style.display = 'inline-flex'
    document.getElementById('img-upload-inner').style.display = 'none'
  }
  reader.readAsDataURL(currentImageFile)
}

function clearImage() {
  currentImageFile = null; currentImageUrl = null
  document.getElementById('img-preview').style.display = 'none'
  document.getElementById('btn-clear-img').style.display = 'none'
  document.getElementById('img-upload-inner').style.display = ''
  document.getElementById('field-img').value = ''
}

function handleTagKey(e) {
  if (e.key === 'Enter' || e.key === ',') {
    e.preventDefault()
    const val = e.target.value.trim().replace(/,/g,'').toLowerCase()
    if (val && !editingTags.includes(val)) { editingTags.push(val); renderTagChips() }
    e.target.value = ''
  } else if (e.key === 'Backspace' && !e.target.value && editingTags.length) {
    editingTags.pop(); renderTagChips()
  }
}
function removeTag(tag) { editingTags = editingTags.filter(t => t !== tag); renderTagChips() }
function renderTagChips() {
  document.getElementById('tag-chips').innerHTML = editingTags.map(t =>
    `<span class="tag-chip">${t}<button type="button" data-remove-tag="${t}" aria-label="Remove ${t}">×</button></span>`
  ).join('')
  document.querySelectorAll('[data-remove-tag]').forEach(btn =>
    btn.addEventListener('click', () => removeTag(btn.dataset.removeTag))
  )
}

function addAttrRow(key = '', value = '') {
  const list = document.getElementById('attrs-list')
  const row  = document.createElement('div'); row.className = 'attr-row'
  const ki   = document.createElement('input'); ki.type='text'; ki.placeholder='Key'; ki.value=key; ki.dataset.keyInput='1'; ki.style.flex='1'
  const vi   = document.createElement('input'); vi.type='text'; vi.placeholder='Value'; vi.value=value; vi.dataset.valInput='1'; vi.style.flex='1.5'
  const del  = document.createElement('button'); del.className='btn-icon'; del.type='button'; del.innerHTML='<i class="ti ti-trash" style="font-size:13px" aria-hidden="true"></i>'; del.setAttribute('aria-label','Remove')
  del.addEventListener('click', () => row.remove())
  row.append(ki, vi, del)
  list.appendChild(row)
}

async function saveItem() {
  const name = document.getElementById('field-name').value.trim()
  if (!name) { document.getElementById('field-name').focus(); showToast('Name is required'); return }

  const catId      = document.getElementById('field-cat').value || null
  const cat         = catById(catId)
  const keysConfig  = (cat && cat.requiredKeysConfig) || []

  // ── Validate required rows, type-aware ──────────────────────
  const reqRows = [...document.querySelectorAll('#attrs-list .attr-row[data-required]')]
  let valid = true

  reqRows.forEach(row => {
    const configKey = row.dataset.configKey
    const config    = keysConfig.find(c => c.key === configKey)

    if (row.dataset.type === 'segments') {
      // Structural value — never route through the trim/stringify path
      // below, which would collapse the segment array into "[object
      // Object]" and always fail validation.
      const segmentsVal = readAttrRowValue(row)
      const errorTarget = row.querySelector('.attr-segments-editor')
      const result = validateAttribute(segmentsVal, config)
      if (!result.valid) { errorTarget?.classList.add('error'); valid = false }
      else { errorTarget?.classList.remove('error') }
      return
    }

    const rawValue  = readAttrRowValue(row)
    const trimmed   = String(rawValue ?? '').trim()

    // The element we toggle .error on: number input for quantity, else the
    // element itself (select or input) carrying data-val-input.
    const errorTarget = row.dataset.type === 'quantity'
      ? row.querySelector('input[data-num-input]')
      : row.querySelector('[data-val-input]')

    if (!trimmed) {
      errorTarget?.classList.add('error')
      valid = false
      return
    }

    const result = validateAttribute(trimmed, config)
    if (!result.valid) {
      errorTarget?.classList.add('error')
      valid = false
      return
    }

    errorTarget?.classList.remove('error')
  })

  if (!valid) { showToast('Fill in all required characteristics correctly'); return }

  const desc  = document.getElementById('field-desc').value.trim()
  const qty   = document.getElementById('field-qty').value
  const loc   = document.getElementById('field-loc').value.trim()

  // ── Collect all attribute rows (required + free-form extras) ──
  const attrs = [...document.querySelectorAll('#attrs-list .attr-row')].reduce((acc, row) => {
    const keyInput = row.querySelector('[data-key-input]')
    if (!keyInput) return acc
    const key = keyInput.value.trim()
    if (!key) return acc

    const isRequired = !!row.dataset.required
    const type        = row.dataset.type || 'string'

    let value
    if (isRequired) {
      if (type === 'segments') {
        value = readAttrRowValue(row)   // structured { totalLength, segments } object, kept as-is
      } else {
        value = String(readAttrRowValue(row) ?? '').trim()
        // Append the category's default unit for quantity types, e.g. "5" → "5 g"
        if (type === 'quantity') {
          const config = keysConfig.find(c => c.key === key)
          if (config?.defaultUnit && value) value = `${value} ${config.defaultUnit}`
        }
      }
    } else {
      const vi = row.querySelector('[data-val-input]')
      value = vi ? vi.value.trim() : ''
    }

    acc.push({ key, value, type, required: isRequired })
    return acc
  }, [])

  const id = editingId || genId()
  let imageUrl = currentImageFile ? null : currentImageUrl

  const saveBtn = document.getElementById('btn-save-item')
  saveBtn.disabled = true; saveBtn.textContent = 'Saving…'

  try {
    if (currentImageFile) {
      imageUrl = await uploadImage(id, currentImageFile)
    } else if (!currentImageUrl && editingId) {
      await deleteImage(id)
    }

    const priorComponentId = editingId ? items.find(x => x.id === editingId)?.componentId : null

    // Resolve or fork the (category, attributes) config this instance now
    // belongs to. On first creation of a config, seed its fallback display
    // info from this instance — later instances of the same config can
    // rely on that fallback unless they set their own name/desc/image.
    const component = await findOrCreateComponent({
      categoryId: catId,
      fields:     keysConfig,
      attrs:      attrsArrayToMap(attrs),
      fallback:   { name, description: desc, image: imageUrl },
      genId,
    })

    const saved = await upsertInventoryInstance({
      id, componentId: component.id, name, description: desc,
      image: imageUrl, location: loc, quantity: parseInt(qty, 10) || 0,
      tags: [...editingTags], component,
    })

    // If editing re-parented this instance to a different (forked or
    // pre-existing) component, clean up the old one if now unreferenced.
    if (priorComponentId && priorComponentId !== component.id) {
      await deleteComponentIfOrphaned(priorComponentId)
    }
   
    if (editingId) {
      const idx = items.findIndex(x => x.id === editingId)
      if (idx > -1) items[idx] = saved
    } else {
      items.unshift(saved)
    }

    closeModal(); render(); showToast(editingId ? 'Component updated' : 'Component added')
  } catch (e) {
    console.error(e)
    showToast('Error saving component')
  } finally {
    saveBtn.disabled = false
    saveBtn.innerHTML = '<i class="ti ti-check" aria-hidden="true"></i> Save'
  }
}

// ── Detail modal ──────────────────────────────────────────────
function openDetail(id) {
  const it = items.find(x => x.id === id); if (!it) return
  detailId = id
  document.getElementById('detail-name').textContent = it.name
  const cat    = catById(it.categoryId)
  const hasQty = it.quantity !== null && it.quantity !== undefined && it.quantity !== ''
  document.getElementById('detail-body').innerHTML = `
    ${it.image
      ? `<div class="detail-img"><img src="${it.image}" alt="${it.name}"></div>`
      : `<div class="detail-img" style="height:120px;display:flex;align-items:center;justify-content:center"><i class="ti ti-photo" style="font-size:32px;color:var(--color-text-tertiary)" aria-hidden="true"></i></div>`}
    ${cat ? `<div><span class="cat-badge"><i class="ti ti-folder" aria-hidden="true"></i>${cat.name}</span></div>` : ''}
    ${(hasQty || it.location) ? `<div class="detail-meta-row">
      ${hasQty ? `<div class="detail-meta-item"><i class="ti ti-stack-2" aria-hidden="true"></i>Qty: <strong>${it.quantity}</strong></div>` : ''}
      ${it.location ? `<div class="detail-meta-item"><i class="ti ti-map-pin" aria-hidden="true"></i>Location: <strong>${it.location}</strong></div>` : ''}
    </div>` : ''}
    ${it.description ? `<p style="font-size:13px;line-height:1.7">${it.description}</p>` : ''}
    ${(it.tags || []).length ? `<div style="display:flex;flex-wrap:wrap;gap:4px">${it.tags.map(t => `<span class="tag">${t}</span>`).join('')}</div>` : ''}
    ${(it.attributes || []).length ? `<div>
      <div style="font-size:11px;font-weight:500;color:var(--color-text-tertiary);margin-bottom:6px;text-transform:uppercase;letter-spacing:.05em">Characteristics</div>
      <table class="attrs-table">
        ${it.attributes.map(a => `<tr>
          <td>${a.key}${a.required ? ' <span style="font-size:10px;color:#A32D2D">●</span>' : ''}</td>
          <td style="text-align:right;color:var(--color-text-primary)">${a.value || '—'}</td>
        </tr>`).join('')}
      </table>
    </div>` : ''}`
  document.getElementById('detail-overlay').style.display = 'flex'
}

function closeDetail() { document.getElementById('detail-overlay').style.display = 'none'; detailId = null }
function openEditFromDetail() { const id = detailId; closeDetail(); openEditModal(id) }
async function deleteFromDetail() {
  if (!detailId) return
  const it = items.find(x => x.id === detailId)
  if (!it || !confirm(`Delete "${it.name}"? This cannot be undone.`)) return
  try {
    await deleteInventoryInstance(detailId)
    await deleteComponentIfOrphaned(it.componentId)
    if (it.image) await deleteImage(detailId)
    items = items.filter(x => x.id !== detailId)
    closeDetail(); render(); showToast('Component deleted')
  } catch (e) { showToast('Error deleting component') }
}

// ── Manage categories modal ───────────────────────────────────
function openCatModal() { renderCatModal(); document.getElementById('cat-modal-overlay').style.display = 'flex' }
function closeCatModal() { document.getElementById('cat-modal-overlay').style.display = 'none'; render() }

function renderCatModal() {
  const body   = document.getElementById('cat-modal-body')
  const addRow = `<div style="display:flex;gap:6px;margin-top:8px">
    <input type="text" id="quick-cat-input" placeholder="New category name…"
      style="flex:1;padding:7px 9px;border:0.5px solid var(--color-border-secondary);border-radius:var(--border-radius-md);font-size:13px;background:var(--color-background-primary);color:var(--color-text-primary)">
    <button class="btn btn-primary" id="btn-quick-create-cat"><i class="ti ti-plus"></i> Create</button>
  </div>`

  if (!categories.length) {
    body.innerHTML = `<div class="empty" style="padding:24px 0"><i class="ti ti-folder-off" aria-hidden="true"></i><div class="empty-title">No categories yet</div><div class="empty-sub">Create one below.</div></div>${addRow}`
  } else {
    body.innerHTML = categories.map(c => {
      const configs = c.requiredKeysConfig || []
      const reqSummary = configs.length
        ? configs.map(cfg => `${cfg.key} <span class="cat-manage-type-tag">${typeLabel(cfg.type)}</span>`).join(', ')
        : 'No required characteristics'
      return `
      <div class="cat-manage-row">
        <div>
          <div class="cat-manage-name"><i class="ti ti-folder" style="font-size:13px;margin-right:4px" aria-hidden="true"></i>${c.name}</div>
          <div class="cat-manage-reqs">${configs.length ? 'Required: ' : ''}${reqSummary}</div>
        </div>
        <button class="btn btn-sm" data-edit-cat="${c.id}"><i class="ti ti-edit" aria-hidden="true"></i> Edit</button>
      </div>`
    }).join('') + addRow
  }
  document.getElementById('btn-quick-create-cat').addEventListener('click', quickCreateCat)
  body.querySelectorAll('[data-edit-cat]').forEach(btn =>
    btn.addEventListener('click', () => openEditCat(btn.dataset.editCat))
  )
}

function typeLabel(type) {
  if (type === 'quantity') return 'Quantity'
  if (type === 'enum') return 'Preset'
  return 'Text'
}

async function quickCreateCat() {
  const name = (document.getElementById('quick-cat-input').value || '').trim(); if (!name) return
  try {
    const saved = await upsertCategory({ id: genId(), name, requiredKeysConfig: [] })
    categories.push(saved)
    renderCatModal()
    showToast('Category created')
  } catch (e) { showToast('Error creating category') }
}

// ── Edit single category modal ────────────────────────────────
//
// editingReqKeysConfig holds the working copy of the category's typed
// characteristic list while the modal is open:
//   { key: string, type: 'string'|'quantity'|'enum', options?: string[], defaultUnit?: string }

function openEditCat(id) {
  const cat = catById(id); if (!cat) return
  editingCatId = id
  editingReqKeysConfig = JSON.parse(JSON.stringify(cat.requiredKeysConfig || []))
  document.getElementById('edit-cat-title').textContent = 'Edit: ' + cat.name
  document.getElementById('edit-cat-name').value = cat.name
  renderReqKeysConfig()
  document.getElementById('edit-cat-overlay').style.display = 'flex'
}
function closeEditCat() {
  document.getElementById('edit-cat-overlay').style.display = 'none'
  editingCatId = null
  editingReqKeysConfig = []
}

function renderReqKeysConfig() {
  const list = document.getElementById('req-keys-config-list')

  if (!editingReqKeysConfig.length) {
    list.innerHTML = `<div class="req-keys-empty">No required characteristics yet. Add one below.</div>`
  } else {
    list.innerHTML = editingReqKeysConfig.map((cfg, idx) => `
      <div class="req-key-config-row" data-config-idx="${idx}">
        <div class="req-key-config-main">
          <input type="text" class="req-key-input" data-idx="${idx}"
                 value="${cfg.key}" placeholder="e.g. Inner Diameter">
          <select class="req-type-select" data-idx="${idx}">
            <option value="string"   ${cfg.type === 'string'   ? 'selected' : ''}>Text</option>
            <option value="quantity" ${cfg.type === 'quantity' ? 'selected' : ''}>Quantity</option>
            <option value="enum"     ${cfg.type === 'enum'     ? 'selected' : ''}>Preset list</option>
            <option value="segments" ${cfg.type === 'segments' ? 'selected' : ''}>Shaft profile (segments)</option>
          </select>
          <button type="button" class="btn-icon" data-remove-idx="${idx}" aria-label="Remove">
            <i class="ti ti-trash" style="font-size:13px" aria-hidden="true"></i>
          </button>
        </div>
        ${cfg.type === 'enum' ? `
          <div class="req-type-panel">
            <label>Preset options <span style="font-weight:400;color:var(--color-text-tertiary)">(one per line)</span></label>
            <textarea class="enum-options-input" data-idx="${idx}"
                      placeholder="0.25&#10;0.5">${(cfg.options || []).join('\n')}</textarea>
          </div>` : ''}
        ${cfg.type === 'quantity' ? `
          <div class="req-type-panel">
            <label>Default unit <span style="font-weight:400;color:var(--color-text-tertiary)">(optional, e.g. mm, g, in)</span></label>
            <input type="text" class="quantity-unit-input" data-idx="${idx}"
                   value="${cfg.defaultUnit || ''}" placeholder="e.g. mm">
          </div>` : ''}
        ${cfg.type === 'segments' ? `
          <div class="req-type-panel">
            <label>Segment length unit <span style="font-weight:400;color:var(--color-text-tertiary)">(e.g. in, mm)</span></label>
            <input type="text" class="segment-unit-input" data-idx="${idx}"
                   value="${cfg.segmentUnit || 'in'}" placeholder="in">
          </div>` : ''}
      </div>
    `).join('')
  }

  list.querySelectorAll('.req-key-input').forEach(input =>
    input.addEventListener('input', () => {
      editingReqKeysConfig[parseInt(input.dataset.idx, 10)].key = input.value
    })
  )
  list.querySelectorAll('.req-type-select').forEach(select =>
    select.addEventListener('change', () => {
      const idx = parseInt(select.dataset.idx, 10)
      const cfg = editingReqKeysConfig[idx]
      cfg.type = select.value
      if (select.value === 'enum') {
        cfg.options = cfg.options || []
        delete cfg.defaultUnit
        delete cfg.segmentUnit
      } else if (select.value === 'quantity') {
        cfg.defaultUnit = cfg.defaultUnit || ''
        delete cfg.options
        delete cfg.segmentUnit
      } else if (select.value === 'segments') {
        cfg.segmentUnit = cfg.segmentUnit || 'in'
        delete cfg.options
        delete cfg.defaultUnit
      } else {
        delete cfg.options
        delete cfg.defaultUnit
        delete cfg.segmentUnit
      }
      renderReqKeysConfig()
    })
  )
  list.querySelectorAll('.segment-unit-input').forEach(input =>
    input.addEventListener('input', () => {
      editingReqKeysConfig[parseInt(input.dataset.idx, 10)].segmentUnit = input.value.trim()
    })
  )
  list.querySelectorAll('.enum-options-input').forEach(ta =>
    ta.addEventListener('input', () => {
      editingReqKeysConfig[parseInt(ta.dataset.idx, 10)].options =
        ta.value.split('\n').map(s => s.trim()).filter(Boolean)
    })
  )
  list.querySelectorAll('.quantity-unit-input').forEach(input =>
    input.addEventListener('input', () => {
      editingReqKeysConfig[parseInt(input.dataset.idx, 10)].defaultUnit = input.value.trim()
    })
  )
  list.querySelectorAll('[data-remove-idx]').forEach(btn =>
    btn.addEventListener('click', () => {
      editingReqKeysConfig.splice(parseInt(btn.dataset.removeIdx, 10), 1)
      renderReqKeysConfig()
    })
  )
}

function addReqKeyConfig() {
  editingReqKeysConfig.push({ key: '', type: 'string' })
  renderReqKeysConfig()
  const inputs = document.querySelectorAll('.req-key-input')
  inputs[inputs.length - 1]?.focus()
}

async function saveEditCat() {
  const name = document.getElementById('edit-cat-name').value.trim(); if (!name) return
  const idx  = categories.findIndex(c => c.id === editingCatId); if (idx < 0) return

  // Drop any rows the user left blank rather than blocking save on them
  const cleanConfigs = editingReqKeysConfig
    .map(cfg => ({ ...cfg, key: cfg.key.trim() }))
    .filter(cfg => cfg.key)

  const updated = { ...categories[idx], name, requiredKeysConfig: cleanConfigs }
  try {
    const saved = await upsertCategory(updated)
    categories[idx] = saved
    closeEditCat(); renderCatModal(); render(); showToast('Category saved')
  } catch (e) { showToast('Error saving category') }
}
async function deleteCat() {
  if (!editingCatId) return
  const cat = catById(editingCatId)
  if (!cat || !confirm(`Delete category "${cat.name}"? Components won't be deleted, just uncategorized.`)) return
  try {
    await deleteCategory(editingCatId)
    items = items.map(it => it.categoryId === editingCatId ? { ...it, categoryId: null } : it)
    categories = categories.filter(c => c.id !== editingCatId)
    closeEditCat(); renderCatModal(); render(); showToast('Category deleted')
  } catch (e) { showToast('Error deleting category') }
}

// ── Component view (edit shared fallback name/description/image) ──
let viewingComponentId = null

function openComponentView(componentId) {
  if (!componentId) return
  viewingComponentId = componentId
  const anyInstance = items.find(i => i.componentId === componentId)
  document.getElementById('component-view-name').value = anyInstance?.name || ''
  document.getElementById('component-view-desc').value = anyInstance?.description || ''
  const preview = document.getElementById('component-view-image-preview')
  preview.src = anyInstance?.image || ''
  preview.style.display = anyInstance?.image ? 'block' : 'none'
  document.getElementById('component-view-overlay').style.display = 'flex'
}

async function saveComponentFallback() {
  const name  = document.getElementById('component-view-name').value.trim()
  const desc  = document.getElementById('component-view-desc').value.trim()
  const image = document.getElementById('component-view-image-preview').src || null
  try {
    await updateComponentFallback(viewingComponentId, { name, description: desc, image })
    items = await fetchInventoryInstances()
    document.getElementById('component-view-overlay').style.display = 'none'
    render()
    showToast('Component defaults updated')
  } catch (e) { showToast('Error updating component defaults') }
}

// ── Start ─────────────────────────────────────────────────────
boot()
