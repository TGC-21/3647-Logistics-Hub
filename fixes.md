# Fixes log — client-side latency pass

## A. Stale-state hygiene on navigation — DONE
`currentChildRecord` (state.js) wasn't cleared on exit paths. Not
exploitable in practice (`renderChildDetail()` always re-fetches and
re-sets it before any `FromState` read), but was a latent trap for future
call paths that might call `renderChildDetailFromState()` directly.

Fixed:
- `selectAssembly` (assemblyDetail.js) now calls `setCurrentChildRecord(null)`
  alongside its other state resets.
- `exitChildAssembly` calls `setCurrentChildRecord(null)` only when
  `parent` is falsy (i.e. actually leaving child view, not moving up one
  subassembly level to another) — moving up re-fetches and overwrites it
  immediately anyway via `renderChildDetail()`, so this is documentation
  of intent, not a functional gate.

## B. Filter/tab handlers still call the fetching render functions — DONE
Split by whether the control changes *which section is shown* (structural
-> needs a `FromState` full render) vs. *which rows are visible in an
already-shown table* (-> needs only a tbody refresh).

Root view (`renderAssemblyDetailFromState`):
- `#tab-btn-parts`, `#tab-btn-subassemblies` -> `renderAssemblyDetailFromState()`
  (structural: swaps parts table <-> subassembly grid)
- `#fab-filter-select`, `#chk-part-number-only` -> `refreshPartsTbody()`
  (row-visibility only -- added section-count update inside this helper too)

Child view (`renderChildDetailFromState`):
- `#tab-btn-parts`, `#tab-btn-subassemblies` -> `renderChildDetailFromState()`
- `#chk-part-number-only` -> `refreshChildPartsTbody()`
  (no `#fab-filter-select` in child view -- that control only renders when
  `assembly.onshapeElementId` is set, a root-only condition)

Same tbody-only pattern already used by the search-input debounce fix.

## C. Import contexts still end in a fetching render — DONE
`registerOnshapePickerContext.onPartsImported` and
`registerBomImportContext.onPartsImported` (assemblyDetail.js) both
already patch `setCurrentParts([...getCurrentParts(), ...saved])` locally
before rendering -- the trailing `renderAssemblyDetail()` fetch was pure
waste. Swapped both to `renderAssemblyDetailFromState()`.

Safe for the same reason `afterPartsChange` is: `syncAssemblyStatus()`
patches `setAssemblies(...)` in place *before* the render call, so
`assemblyById(currentAssemblyId)` already reflects any status change by
the time the `FromState` render reads it.

`onAssemblyCreated` (Onshape "link" mode) is intentionally left calling
`fetchAssemblies()` + `selectAssembly(assemblyId)` -- that path creates a
genuinely new assembly the client has no local copy of, so a real fetch
is correct there, not a leftover inefficiency.

---

## Search-input freeze — DONE (prior session)
Root cause: (1) search handlers called the fetching render function on
every keystroke, (2) the debounce timer was declared with `let` inside
the render function itself, so it was discarded and re-created on every
re-render, breaking `clearTimeout` and allowing overlapping fetches.

Fixed: debounce timer moved to module scope
(`partSearchDebounceTimer`, alongside `fabDetectRunning`), and both root
and child search handlers now call `refreshPartsTbody()` /
`refreshChildPartsTbody()` instead of the fetching render -- zero network
calls per keystroke, tbody-only DOM update, input never loses focus.

---

## Status
All four items (A, B, C, search freeze) resolved. No known outstanding
client-latency issues in assemblyDetail.js as of this pass. Next
candidate areas if further latency turns up: partsTable.js's per-row
history/detail toggles, and the Fabricate tab's job-table re-renders
(fabricate.js already does local `replaceJob` patching in most places,
worth a similar audit pass if that view starts feeling slow).
