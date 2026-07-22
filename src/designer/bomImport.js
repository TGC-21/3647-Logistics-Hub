// src/designer/bomImport.js
//
// "Import CSV" modal for a root assembly's parts table. Fully
// self-contained CSV parsing/column-detection/preview — the only thing
// it needs from outside is somewhere to put the resulting parts, via a
// registered context (same pattern as the other split-out modules).

import { bulkInsertAssemblyParts } from '../db.js'
import { genId, toast } from './state.js'

/**
 * `ctx` is:
 *   getCurrentAssemblyId()          -> string
 *   onPartsImported(savedParts)      -> append + persist + re-render
 */
let ctx = null
export function registerBomImportContext(c) { ctx = c }

let parsedBomRows = []

export function openBomImportModal() {
  document.getElementById('bom-file-input').value = ''
  document.getElementById('bom-preview').innerHTML = ''
  document.getElementById('bom-preview').style.display = 'none'
  document.getElementById('btn-confirm-bom').style.display = 'none'
  document.getElementById('bom-import-overlay').style.display = 'flex'
}

function closeBomImportModal() {
  document.getElementById('bom-import-overlay').style.display = 'none'
}

function handleBomFile(e) {
  const file = e.target.files[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = ev => {
    parsedBomRows = parseBomCsv(ev.target.result)
    renderBomPreview(parsedBomRows)
  }
  reader.readAsText(file)
}

function parseBomCsv(text) {
  const lines = text.trim().split(/\r?\n/)
  if (lines.length < 2) return []

  const headers = parseCsvLine(lines[0]).map(h => h.toLowerCase().trim())

  const col = key => {
    const ALIASES = {
      name:   ['name', 'part name', 'description', 'item', 'component'],
      number: ['part number', 'part #', 'pn', 'part_number', 'number'],
      qty:    ['qty', 'quantity', 'count', 'amount'],
      notes:  ['notes', 'comment', 'remarks', 'note'],
    }
    const alts = ALIASES[key] || [key]
    return headers.findIndex(h => alts.some(a => h.includes(a)))
  }

  const nameIdx   = col('name')
  const numberIdx = col('number')
  const qtyIdx    = col('qty')
  const notesIdx  = col('notes')

  if (nameIdx < 0) return []

  return lines.slice(1)
    .map(line => {
      const cells = parseCsvLine(line)
      const partName = cells[nameIdx]?.trim()
      if (!partName) return null
      return {
        partName,
        partNumber: numberIdx >= 0 ? (cells[numberIdx]?.trim() || '') : '',
        quantityNeeded: qtyIdx >= 0 ? (parseInt(cells[qtyIdx], 10) || 1) : 1,
        notes: notesIdx >= 0 ? (cells[notesIdx]?.trim() || '') : '',
      }
    })
    .filter(Boolean)
}

function parseCsvLine(line) {
  const result = []
  let current  = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++ }
      else inQuotes = !inQuotes
    } else if (ch === ',' && !inQuotes) {
      result.push(current); current = ''
    } else {
      current += ch
    }
  }
  result.push(current)
  return result
}

function renderBomPreview(rows) {
  const preview = document.getElementById('bom-preview')
  const confirmBtn = document.getElementById('btn-confirm-bom')

  if (!rows.length) {
    preview.innerHTML = `<p class="bom-parse-error">Could not detect columns. Make sure your CSV has a "Name" or "Part name" column.</p>`
    preview.style.display = 'block'
    confirmBtn.style.display = 'none'
    return
  }

  preview.innerHTML = `
    <div class="bom-preview-info">Detected ${rows.length} parts — review before importing:</div>
    <table class="parts-table" style="margin-top:8px">
      <thead><tr><th>Part name</th><th>Part #</th><th style="text-align:center">Qty</th><th>Notes</th></tr></thead>
      <tbody>${rows.map(r => `<tr>
        <td>${r.partName}</td>
        <td><span class="part-number">${r.partNumber || '—'}</span></td>
        <td style="text-align:center">${r.quantityNeeded}</td>
        <td style="color:var(--color-text-tertiary);font-size:12px">${r.notes || ''}</td>
      </tr>`).join('')}</tbody>
    </table>`
  preview.style.display = 'block'
  confirmBtn.style.display = 'inline-flex'
}

async function confirmBomImport() {
  if (!parsedBomRows.length) return
  const confirmBtn = document.getElementById('btn-confirm-bom')
  confirmBtn.disabled = true; confirmBtn.textContent = 'Importing…'

  const parts = parsedBomRows.map(r => ({
    id:                genId(),
    assemblyId:        ctx.getCurrentAssemblyId(),
    partName:          r.partName,
    partNumber:        r.partNumber,
    quantityNeeded:    r.quantityNeeded,
    quantityCollected: 0,
    status:            'pending',
    source:            'csv',
    notes:             r.notes,
    onshapeReference:  null,
  }))

  try {
    const saved = await bulkInsertAssemblyParts(parts)
    await ctx.onPartsImported(saved)
    closeBomImportModal()
    toast(`Imported ${saved.length} parts`)
  } catch (e) {
    console.error(e)
    toast('Error importing BOM')
  } finally {
    confirmBtn.disabled = false
    confirmBtn.innerHTML = '<i class="ti ti-check"></i> Import'
  }
}

// ── Static event bindings ────────────────────────────────────────
export function bindBomImportEvents() {
  document.getElementById('btn-close-bom-modal').addEventListener('click', closeBomImportModal)
  document.getElementById('btn-cancel-bom').addEventListener('click', closeBomImportModal)
  document.getElementById('bom-file-input').addEventListener('change', handleBomFile)
  document.getElementById('btn-confirm-bom').addEventListener('click', confirmBomImport)
  document.getElementById('bom-import-overlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeBomImportModal()
  })
}