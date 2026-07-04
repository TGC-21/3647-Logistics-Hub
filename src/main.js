import './style.css'
import {
  fetchCategories, fetchComponents,
  upsertCategory,  deleteCategory,
  upsertComponent, deleteComponent,
  uploadImage,     deleteImage,
} from './db.js'
import {
  designerBoot,        setToast,
  renderDesignerSidebar, renderDesignerContent,
  bindDesignerEvents,  openAssemblyModal,
  selectAssembly,      openOnshapeModal,
  bootIsolatedAssembly, bootIsolatedChild,
} from './designer.js'

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
let editingReqKeys = []
let designerMode  = false

// ── Boot ──────────────────────────────────────────────────────
async function boot() {
  setToast(showToast)

  // "?asm=<id>" opens a single ROOT assembly full-screen; "?child=<id>"
  // opens a single SUBASSEMBLY node full-screen. Both have no sidebar/other
  // assemblies in reach — used by the subassembly "open in new window" action.
  const params        = new URLSearchParams(location.search)
  const isolatedAsmId = params.get('asm')
  const isolatedChildId = params.get('child')

  if (isolatedChildId) {
    document.body.classList.add('isolated-view')
    designerMode = true
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
    designerMode = true
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
    [categories, items] = await Promise.all([fetchCategories(), fetchComponents()])
    await designerBoot()
  } catch (e) {
    console.error(e)
    showToast('Could not connect to database — check your .env file')
  }
  render()
  bindStaticEvents()
  bindDesignerEvents()
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
function setMode(mode) {
  designerMode = mode === 'designer'
  document.getElementById('btn-mode-inventory').classList.toggle('active', !designerMode)
  document.getElementById('btn-mode-designer').classList.toggle('active', designerMode)
  document.getElementById('inventory-actions').style.display  = designerMode ? 'none' : ''
  document.getElementById('designer-actions').style.display   = designerMode ? '' : 'none'
  document.getElementById('topbar-search-wrap').style.display = designerMode ? 'none' : ''

  // Mobile bottom tab bar + FAB mirror the same mode
  const tabComponents = document.getElementById('tab-btn-components')
  const tabDesigner    = document.getElementById('tab-btn-designer')
  if (tabComponents && tabDesigner) {
    tabComponents.classList.toggle('active', !designerMode)
    tabDesigner.classList.toggle('active', designerMode)
  }
  // Designer mode has its own two actions (New assembly / New from Onshape) surfaced
  // elsewhere, so the generic "add" FAB only makes sense in inventory mode.
  const fab = document.getElementById('mobile-fab')
  if (fab) fab.classList.toggle('fab-hidden', designerMode)

  // Lets mobile CSS reserve extra bottom padding when the designer action
  // bar (pinned above the tab bar) is visible, so content isn't hidden behind it.
  document.body.classList.toggle('designer-mode', designerMode)

  render()
}

// ── Render ────────────────────────────────────────────────────
function render() {
  if (designerMode) {
    renderDesignerSidebar()
    renderDesignerContent()
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
  document.getElementById('btn-new-assembly').addEventListener('click', () => openAssemblyModal())
  document.getElementById('btn-new-from-onshape').addEventListener('click', () => openOnshapeModal('link'))

  // ── Mobile bottom tab bar ──────────────────────────────────
  document.getElementById('tab-btn-components').addEventListener('click', () => setMode('inventory'))
  document.getElementById('tab-btn-designer').addEventListener('click', () => setMode('designer'))
  document.getElementById('tab-btn-categories').addEventListener('click', () => {
    setMode('inventory')
    openSidebar()
  })

  // ── Mobile floating action button ──────────────────────────
  // Mirrors whichever "primary create" action applies to the current mode.
  document.getElementById('mobile-fab').addEventListener('click', () => {
    designerMode ? openAssemblyModal() : openAddModal()
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
    if (designerMode) { selectAssembly(null); return }
    setView('all', null, null)
  })

  // Sidebar delegation (inventory only — designer items bind their own listeners)
  document.getElementById('sidebar').addEventListener('click', e => {
    if (designerMode) return
    const toggle = e.target.closest('[data-cat-toggle]')
    if (toggle) { toggleCat(toggle.dataset.catToggle); return }
    const viewCat = e.target.closest('[data-view-cat]')
    if (viewCat) { e.stopPropagation(); setView('cat', viewCat.dataset.viewCat, null); return }
    const viewTag = e.target.closest('[data-view-tag]')
    if (viewTag) { e.stopPropagation(); setView('tag', viewTag.dataset.viewTagCat || null, viewTag.dataset.viewTag); return }
  })

  // Main area delegation (card clicks — inventory only)
  document.getElementById('main-area').addEventListener('click', e => {
    if (designerMode) return
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

  // Component form fields
  document.getElementById('field-cat').addEventListener('change', () => onCatChange())
  document.getElementById('field-img').addEventListener('change', handleImageUpload)
  document.getElementById('btn-clear-img').addEventListener('click', clearImage)
  document.getElementById('btn-new-cat').addEventListener('click', showNewCatRow)
  document.getElementById('btn-cancel-new-cat').addEventListener('click', cancelNewCat)
  document.getElementById('btn-confirm-new-cat').addEventListener('click', confirmNewCat)
  document.getElementById('btn-add-attr').addEventListener('click', () => addAttrRow())
  document.getElementById('btn-save-item').addEventListener('click', saveItem)

  // Tags input
  document.getElementById('tags-wrap').addEventListener('click', () => document.getElementById('tag-input').focus())
  document.getElementById('tag-input').addEventListener('keydown', handleTagKey)

  // Required key input
  document.getElementById('req-key-input').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addReqKey() } })
  document.getElementById('btn-add-req-key').addEventListener('click', addReqKey)
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

function refreshRequiredAttrs(catId) {
  const cat      = catById(catId)
  const reqKeys  = (cat && cat.requiredKeys) || []
  const list     = document.getElementById('attrs-list')
  const existing = [...list.querySelectorAll('.attr-row:not([data-required])')].map(r => ({
    key: r.querySelector('[data-key-input]').value,
    val: r.querySelector('[data-val-input]').value,
  }))
  const existingReq = [...list.querySelectorAll('.attr-row[data-required]')].reduce((m, r) => {
    m[r.querySelector('[data-key-input]').value] = r.querySelector('[data-val-input]').value
    return m
  }, {})
  list.innerHTML = ''
  reqKeys.forEach(key => {
    const row = document.createElement('div')
    row.className = 'attr-row'
    row.dataset.required = '1'
    const valInput = document.createElement('input')
    valInput.type = 'text'; valInput.placeholder = 'Value'; valInput.dataset.valInput = '1'
    valInput.value = existingReq[key] || ''; valInput.style.flex = '1.5'
    const keyInput = document.createElement('input')
    keyInput.type = 'text'; keyInput.value = key; keyInput.readOnly = true; keyInput.dataset.keyInput = '1'; keyInput.style.flex = '1'
    const badge = document.createElement('span'); badge.className = 'attr-required-badge'; badge.textContent = 'required'
    row.append(keyInput, valInput, badge)
    list.appendChild(row)
  })
  existing.forEach(({ key, val }) => addAttrRow(key, val))
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
  const al      = document.getElementById('attrs-list'); al.innerHTML = ''
  const cat     = catById(it.categoryId)
  const reqKeys = (cat && cat.requiredKeys) || []
  reqKeys.forEach(key => {
    const existing = (it.attributes || []).find(a => a.key === key)
    const row = document.createElement('div'); row.className = 'attr-row'; row.dataset.required = '1'
    const keyInput = document.createElement('input'); keyInput.type='text'; keyInput.value=key; keyInput.readOnly=true; keyInput.dataset.keyInput='1'; keyInput.style.flex='1'
    const valInput = document.createElement('input'); valInput.type='text'; valInput.placeholder='Value'; valInput.value=existing?existing.value:''; valInput.dataset.valInput='1'; valInput.style.flex='1.5'
    const badge = document.createElement('span'); badge.className='attr-required-badge'; badge.textContent='required'
    row.append(keyInput, valInput, badge)
    al.appendChild(row)
  })
  ;(it.attributes || []).filter(a => !reqKeys.includes(a.key)).forEach(a => addAttrRow(a.key, a.value))
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
  const cat = { id: genId(), name, requiredKeys: [] }
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

  const reqRows = [...document.querySelectorAll('#attrs-list .attr-row[data-required]')]
  let valid = true
  reqRows.forEach(row => {
    const vi = row.querySelector('[data-val-input]')
    if (!vi.value.trim()) { vi.classList.add('error'); valid = false } else vi.classList.remove('error')
  })
  if (!valid) { showToast('Fill in all required characteristics'); return }

  const catId = document.getElementById('field-cat').value || null
  const desc  = document.getElementById('field-desc').value.trim()
  const qty   = document.getElementById('field-qty').value
  const loc   = document.getElementById('field-loc').value.trim()
  const attrs = [...document.querySelectorAll('#attrs-list .attr-row')].reduce((acc, row) => {
    const k = row.querySelector('[data-key-input]').value.trim()
    const v = row.querySelector('[data-val-input]').value.trim()
    if (k) acc.push({ key: k, value: v, required: !!row.dataset.required })
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

    const item = { id, name, description: desc, categoryId: catId, quantity: qty, location: loc,
                   image: imageUrl, tags: [...editingTags], attributes: attrs }
    const saved = await upsertComponent(item)

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
    await deleteComponent(detailId)
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
    body.innerHTML = categories.map(c => `
      <div class="cat-manage-row">
        <div>
          <div class="cat-manage-name"><i class="ti ti-folder" style="font-size:13px;margin-right:4px" aria-hidden="true"></i>${c.name}</div>
          <div class="cat-manage-reqs">${(c.requiredKeys || []).length ? 'Required: ' + c.requiredKeys.join(', ') : 'No required characteristics'}</div>
        </div>
        <button class="btn btn-sm" data-edit-cat="${c.id}"><i class="ti ti-edit" aria-hidden="true"></i> Edit</button>
      </div>`).join('') + addRow
  }
  document.getElementById('btn-quick-create-cat').addEventListener('click', quickCreateCat)
  body.querySelectorAll('[data-edit-cat]').forEach(btn =>
    btn.addEventListener('click', () => openEditCat(btn.dataset.editCat))
  )
}

async function quickCreateCat() {
  const name = (document.getElementById('quick-cat-input').value || '').trim(); if (!name) return
  try {
    const saved = await upsertCategory({ id: genId(), name, requiredKeys: [] })
    categories.push(saved)
    renderCatModal()
    showToast('Category created')
  } catch (e) { showToast('Error creating category') }
}

// ── Edit single category modal ────────────────────────────────
function openEditCat(id) {
  const cat = catById(id); if (!cat) return
  editingCatId = id; editingReqKeys = [...(cat.requiredKeys || [])]
  document.getElementById('edit-cat-title').textContent = 'Edit: ' + cat.name
  document.getElementById('edit-cat-name').value = cat.name
  renderReqChips()
  document.getElementById('edit-cat-overlay').style.display = 'flex'
}
function closeEditCat() { document.getElementById('edit-cat-overlay').style.display = 'none'; editingCatId = null }
function addReqKey() {
  const val = (document.getElementById('req-key-input').value || '').trim()
  if (val && !editingReqKeys.includes(val)) { editingReqKeys.push(val); renderReqChips() }
  document.getElementById('req-key-input').value = ''
}
function removeReqKey(key) { editingReqKeys = editingReqKeys.filter(k => k !== key); renderReqChips() }
function renderReqChips() {
  document.getElementById('req-chips').innerHTML = editingReqKeys.map(k =>
    `<span class="req-chip">${k}<button type="button" data-remove-req="${k}" aria-label="Remove">×</button></span>`
  ).join('')
  document.querySelectorAll('[data-remove-req]').forEach(btn =>
    btn.addEventListener('click', () => removeReqKey(btn.dataset.removeReq))
  )
}
async function saveEditCat() {
  const name = document.getElementById('edit-cat-name').value.trim(); if (!name) return
  const idx  = categories.findIndex(c => c.id === editingCatId); if (idx < 0) return
  const updated = { ...categories[idx], name, requiredKeys: [...editingReqKeys] }
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

// ── Start ─────────────────────────────────────────────────────
boot()
