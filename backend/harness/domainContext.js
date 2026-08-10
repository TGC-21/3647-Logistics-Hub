// backend/harness/domainContext.js
//
// Per-domain instruction snippets — the "context" half of dynamic
// context loading (see agent_dynamic_context.md). Keyed by the same
// domain keys toolSelection.js's DOMAIN_PATTERNS uses, so tool
// selection and context selection can never point at different domain
// vocabularies.
//
// Deliberately narrow on this first pass (roadmap step 1: "ship narrow,
// verify the mechanism, then backfill"). Only 'fabrication' and
// 'assemblies' are authored — the two domains that were actually
// causing tool-call mistakes per the product conversation. Every other
// key in DOMAIN_PATTERNS (inventory, cart, agenda) intentionally has no
// entry yet; domainSnippetsFor() below treats a missing key as "no
// extra context for this domain" rather than an error, so partial
// authoring never breaks anything — remaining domains get backfilled
// once this mechanism is proven.
//
// Snippet budget: keep each entry roughly 150-300 tokens (a paragraph
// or two). The entire point of this system is freeing up context
// budget for DEEPER per-domain guidance than CLINKER_RESPONSE_INSTRUCTIONS
// could afford to carry for every domain at once — a snippet that grows
// back into an everything-blob defeats that. See the soft ceiling check
// below.

export const DOMAIN_CONTEXT = {
  fabrication: `Fabrication domain notes:
- A part's fabrication_metadata.status walks through: none -> detected -> needs_review -> queued -> ignored/failed. Only 'detected'/'needs_review' rows are open for FabricationDetectionService.confirmDetection or ignoreDetection — a 'queued' row already has an active job.
- DetectionService.detectFabricationCandidates must run on an assembly before any part in it can be confirmed/ignored — if no candidates are showing up, check whether detection has been run yet before concluding there's nothing to fabricate.
- A fabrication job's assemblyPartId points at one specific part. To find "jobs for assembly X," resolve the assembly's parts first (or use FabricationJobService.resolveAssemblyForJobs if you only have job ids) — jobs do not carry an assembly id directly.
- At most one ACTIVE (non-archived) job may exist per part — creating a second one throws, this is not a scheduling conflict to route around; a second request for the same part means either recording progress on the existing job or waiting for it to complete/archive.
- Detection kind is one of 'spacer' | 'axial-shaft' | 'plate', each with its own attrs shape: spacer needs Spacer Type/OD/ID-or-across-flats/Length; axial-shaft needs a Profile segment list; plate needs Material/Thickness. Don't invent attrs for a kind that don't match its category's requiredKeysConfig — check CategoryService.getById if unsure.
- Confidence on a detected row ('high'/'medium'/'low') is informational, not a gate — confirmDetection works regardless of confidence, but a low-confidence row is worth flagging to the user rather than silently confirming.
- Job lifecycle: queued -> committed (claimed) -> in_progress -> complete -> archived. Only a queued job can be deleted; recordMachinedUnits refuses more than the remaining (requested - machined) quantity and refuses archived jobs outright.
- Batches are an optional grouping of jobs onto one machine run — a part's fabrication status doesn't depend on whether its job is batched.`,

  assemblies: `Assembly/subassembly domain notes:
- assemblyId identifies a root assembly. assemblyChildId identifies one specific subassembly INSTANCE inside a tree — these are different id spaces and are never interchangeable. A part, job, or cart item never carries an assemblyChildId and an assemblyId at once.
- "Parts in X" means the parts directly owned by X, not parts in X's nested subassemblies, unless the user explicitly asks for the complete/recursive BOM (in which case use listTreeForAssembly, which already walks the whole tree in one call).
- When the user names a subassembly by name, first call AssemblyService.listChildren (or listWholeTree for deeper nesting) against the parent assembly to resolve its assemblyChildId, THEN use a child-specific parts tool with that id. Do not guess an id from a part or job id — they are never interchangeable, and there is no way to derive one from the other without a lookup.
- An empty result from a broad tool (search, checkAvailability, listWholeTree) does not prove an assembly/subassembly has no parts — confirm with the most specific listing tool for that exact owner before concluding "none."
- checkAvailability cross-references an assembly's whole tree against inventory in one call (including a best-effort guess for parts with no linked component) — prefer it over manually listing parts and inventory and comparing yourself; matchConfidence: 'guessed' or 'unmatched' rows should be reported as uncertain, not stated as fact.
- Assembly status (draft/active/complete) is DERIVED from part collection progress, not something to set directly except via updateAssembly's own status field for a manual override — computeOwnerStatus tells you what it SHOULD be right now, which may differ from the stored value.
- Reimporting an assembly from Onshape (OnshapeReimportService.reimportAssembly) rebuilds the whole part tree and can silently drop inventory links/fabrication jobs/cart earmarks for parts that no longer match by Onshape identity — this is destructive and should not be suggested casually.`,

  inventory: `Inventory/component domain notes:
- A Component describes WHAT a part is (category + attributes); an Inventory Instance describes WHERE and HOW MANY exist physically. Never confuse the two — "do we have 5 of X" is an instance/quantity question, "what X do we make" is a component/category question.
- Two components are the "same" component only if they share a category AND every required attribute value matches exactly (per the category's requiredKeysConfig types) — a component is never identified by its name alone. Don't assume two similarly-named components are interchangeable without checking attributes.
- ComponentService.search is a free-text match over name/description/attribute values — prefer it over listAll when looking for something specific (e.g. "24T gear"). If results are ambiguous or you get an unexpected match (e.g. a search for a gear pulling in an unrelated pulley), consider narrowing by category via CategoryService.list first.
- InventoryInstanceService.listForComponent(s) gives location + quantity for a component id — always resolve the component first via search/listAll, then fetch instances; don't try to search instances directly by name.
- Creating a new inventory instance (createInstance) resolves/creates its component from categoryId + attrs first — if categoryId is omitted it falls back to "Uncategorized," which is usually not what a user wants for a real part; ask for or infer a category when creating something new rather than defaulting silently.
- Deleting an instance also unreserves it from every assembly part currently linking it and may delete its component if that was the last instance — this has knock-on effects on any assembly currently relying on that stock, worth flagging before doing it.
- Quantity/location edits on an EXISTING instance may re-resolve (and change) its underlying component if the category or attributes changed — this can re-parent the instance onto a different component identity, not just edit a number.`,

  cart: `Cart / Part Orders domain notes:
- A cart is scoped to exactly one vendor — "add to cart" always means finding or creating that vendor's open cart first (findOrCreateCartForVendor), never a generic cart.
- Cart item status only ever advances forward: pending -> ordered -> received, one step at a time. There is no "un-advance," and advancing an already-received item throws rather than no-op'ing.
- A received cart item represents a completed purchase and cannot be deleted outright — deleteItem refuses it. Only pending/ordered items can be removed.
- A cart item's assemblyPartId (if set) earmarks it toward satisfying one specific assembly part's remaining need — but unlike fabrication jobs, cart_items has no one-active-per-part constraint; a part's gap can legitimately be split across multiple cart items (different vendors, a reorder after cancellation, etc.), so don't treat a second cart item for the same part as an error.
- Vendor listings/part numbers are a separate concern from cart items themselves — a part number can have zero, one, or several vendor listings (different vendors selling the same SKU); resolving "which listing" is a separate step from "add to cart" if more than one exists.`,

  agenda: `Agenda / tasks domain notes:
- A task's completedAt is derived automatically from status changes (AgendaService owns this) — never pass completedAt directly; setting status to 'complete' stamps it, reopening (any non-complete/non-archived status) clears it, and archiving preserves whatever it already was.
- Status values are exactly: not_started, in_progress, complete, archived — there is no "draft" state for tasks (unlike assemblies).
- executors is who actually committed to doing the task; assignerId is who created/requested it — these are different people and neither is required to equal the other.
- Task links (addTaskLink) reference another Partshelf entity (assembly, assembly_part, inventory_instance, fabrication_job, or cart_item) by type + id — resolve the target's real id first via that domain's own lookup tool rather than guessing one.
- "What's on the agenda" or "what should I be doing" is a listTasks call, not a search across other domains — the Agenda is a distinct system from Designer/Fabricate/Inventory and doesn't automatically surface fabrication jobs or cart items unless a task was explicitly linked to them.`,
}

// Soft budget guard — logs, never throws. A canary for snippet creep,
// not a hard limit; see this file's own doc comment above.
const SNIPPET_WARN_CHARS = 1200      // ~300 tokens, per-domain rough ceiling
const TOTAL_WARN_CHARS   = 4000      // rough ceiling across all currently-selected snippets

for (const [domain, text] of Object.entries(DOMAIN_CONTEXT)) {
  if (text.length > SNIPPET_WARN_CHARS) {
    console.warn(`[domainContext] "${domain}" snippet is ${text.length} chars — over the ~${SNIPPET_WARN_CHARS} soft budget. Consider trimming.`)
  }
}

export function domainContextKeys() {
  return Object.keys(DOMAIN_CONTEXT)
}

/**
 * Joins the context snippets for a set of domain keys into one block,
 * each under its own small header. Unknown/unauthored domain keys are
 * silently skipped (see file doc comment — partial authoring is
 * expected, not an error). Returns '' if nothing matched, so callers
 * can cheaply no-op when there's nothing to add.
 */
export function domainSnippetsFor(domains) {
  const keys = [...(domains instanceof Set ? domains : new Set(domains))].filter(d => DOMAIN_CONTEXT[d])
  if (!keys.length) return ''

  const joined = keys
    .map(key => `### ${key[0].toUpperCase()}${key.slice(1)}\n${DOMAIN_CONTEXT[key]}`)
    .join('\n\n')

  if (joined.length > TOTAL_WARN_CHARS) {
    console.warn(`[domainContext] Combined snippet total is ${joined.length} chars (domains: ${keys.join(', ')}) — over the ~${TOTAL_WARN_CHARS} soft budget.`)
  }

  return joined
}

/** All authored snippets joined — the fallback for the same "ambiguous
 *  -> full registry" case toolSelection.js already applies to tools,
 *  so context and tools never diverge (never offer a tool whose usage
 *  notes weren't included, or vice versa). */
export function allDomainSnippets() {
  return domainSnippetsFor(domainContextKeys())
}