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
  
  inventory: `Inventory/component domain notes:
- A Component describes WHAT a part is (category + attributes); an Inventory Instance describes WHERE and HOW MANY exist physically. Never confuse the two — "do we have 5 of X" is an instance/quantity question, "what X do we make" is a component/category question.
- Two components are the "same" component only if they share a category AND every required attribute value matches exactly (per the category's requiredKeysConfig types) — a component is never identified by its name alone. Don't assume two similarly-named components are interchangeable without checking attributes.
- CREATING A NEW INVENTORY INSTANCE (the user describes a part and wants it added, e.g. "add a 14T sprocket, 1/2\" hex bore, #25 chain, qty 2, in bin A"): do NOT search for an existing matching component first — InventoryInstanceService.createInstance ALREADY resolves-or-creates the component for you as part of the call (it wraps ComponentService.findOrCreate internally). Searching first and stopping when nothing matches is wrong and unnecessary; it just makes you refuse a normal create request. The correct sequence is:
  1. Call CategoryService.list (or getById if you already know the id) and pick the category whose name best matches what the user described (e.g. "sprocket" -> the "Sprocket" category). Category names in this catalog are typically singular/plural-loose and case-insensitive-ish — match on meaning, not exact string equality.
  2. Build attrs as a flat { key: value } map using that category's requiredKeysConfig keys EXACTLY as spelled (character-for-character, including spaces/capitalization — never rename, abbreviate, or snake_case a key), filling in every value you can infer from the user's message.
  3. Call InventoryInstanceService.createInstance ONCE with categoryId, attrs, name, quantity, location, etc. Do not call ComponentService.findOrCreate or ComponentService.search as a pre-check first — createInstance already handles component resolution as part of the same call.
  4. Only ask the user to pick/create a category yourself if NO category in CategoryService.list's results is a plausible match at all (e.g. the part is a totally new kind of thing) — a category existing with a name that loosely matches the part type (like "Sprocket" for a sprocket) is enough to proceed without asking.
- ComponentService.search is a free-text match over name/description/attribute values — prefer it over listAll when looking for something specific (e.g. "24T gear"). If results are ambiguous or you get an unexpected match (e.g. a search for a gear pulling in an unrelated pulley), consider narrowing by category via CategoryService.list first.
- If the user asks for the contents of a named category (for example, "what sprockets do we have"), first call CategoryService.list or CategoryService.getById to resolve the exact category, then call ComponentService.listForCategory with that categoryId. Do not use free-text search as the authoritative category listing: search can match unrelated component names, descriptions, or attribute keys/values.
- ComponentService.listForCategory returns component identities, not physical stock. For quantity/location questions, pass the returned component ids to InventoryInstanceService.listForComponents; report zero or missing instances explicitly, and do not treat a component match as proof that stock exists.
- A chat attachment is inert until the user asks about it. If the user explicitly asks to attach/link the current image to an inventory instance, use InventoryInstanceService.linkImage with the exact attached image URL and target instance id; never replace an existing image implicitly.
- InventoryInstanceService.listForComponent(s) gives location + quantity for a component id — always resolve the component first via listForCategory/search/listAll, then fetch instances; don't try to search instances directly by name.
- Creating a new inventory instance (createInstance) resolves/creates its component from categoryId + attrs first — if categoryId is omitted it falls back to "Uncategorized," which is usually not what a user wants for a real part; ask for or infer a category when creating something new rather than defaulting silently.
- Deleting an instance also unreserves it from every assembly part currently linking it and may delete its component if that was the last instance — this has knock-on effects on any assembly currently relying on that stock, worth flagging before doing it.
- Quantity/location edits on an EXISTING instance may re-resolve (and change) its underlying component if the category or attributes changed — this can re-parent the instance onto a different component identity, not just edit a number.`,

  
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
