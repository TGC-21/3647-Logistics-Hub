export const PROPOSE_INVENTORY_TOOL_NAME = 'propose_inventory_instance'

export const PROPOSE_INVENTORY_TOOL_SCHEMA = {
  type: 'function',
  function: {
    name: PROPOSE_INVENTORY_TOOL_NAME,
    description:
      'Call this after visually examining an attached image of a physical part the member wants added to inventory. ' +
      'Do NOT call InventoryInstanceService.createInstance directly for an image-sourced item — always propose first, ' +
      'so the member can review, correct, or fill in anything you could not confidently identify (e.g. quantity, ' +
      'location, or exact material) before anything is written. Resolve categoryId against CategoryService.list first ' +
      'if you can; omit it if nothing matches so the member can pick or create one. Give your best guess for every ' +
      'field you CAN read from the image (e.g. engraved text, tooth count, size markings) — leave a field blank only ' +
      'if you genuinely cannot infer it, never guess a location or quantity you can\'t see. ' +
      'CRITICAL — never respond with only a text question asking the member to describe the parts themselves. ' +
      'The whole point of this tool is that YOU look at the image and make a best-effort guess per part, and the ' +
      'member corrects it afterward on the review card — that correction step is what handles any uncertainty, ' +
      'not a prior clarifying question from you. If a bin/tray contains multiple ambiguous or partially-obscured ' +
      'items, still call this tool once per part you can visually distinguish, using a generic-but-real name (e.g. ' +
      '"Unidentified gear" or "Small gear, teeth count unclear") and confidence: "low" rather than skipping it or ' +
      'asking the member to enumerate the contents in words first. Only fall back to a plain-text reply, with no ' +
      'tool calls, if the image contains literally nothing identifiable as a physical part at all (e.g. a blank ' +
      'surface, a person, an unrelated document). ' +
      'Before proposing, call CategoryService.list and use the exact returned categoryId and category name whenever the image clearly matches an existing category; never invent a category id. ' +
      'Required characteristics are mandatory category schema: copy every required key exactly into attrs, provide a value when visually supported, and leave only genuinely unreadable values blank for the member to fill in; never replace a required key with a synonym or omit it. ' +
      'IMPORTANT — multiple items in one photo: if the image shows more than one distinct physical part (e.g. several ' +
      'different gears, a mix of bolts and spacers, a tray of assorted parts), call this tool ONCE PER DISTINCT PART, ' +
      'all within this same response, rather than stopping after the first one. Do not wait for the member to ask ' +
      'about the remaining items and do not silently pick only the most obvious one — every distinct part you can ' +
      'identify should get its own call. The member will review and confirm each proposal one at a time on their end; ' +
      'you do not need to do anything further once you have called this for every part you can see.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Best-guess display name, e.g. "40T -20 DP Spur Gear".' },
        categoryId: { type: 'string', description: 'An existing category id from CategoryService.list, if one clearly matches. Omit otherwise.' },
        categoryName: { type: 'string', description: 'Human-readable category label, shown even if categoryId is omitted.' },
        attrs: {
          type: 'object',
          description: 'Flat { key: value } map. When a category is resolved, include EVERY key from its requiredKeysConfig exactly as written (including keys whose value is blank/unknown); add optional image-observed characteristics only afterward. Example: { "Tooth Count": "40", "Pitch": "20 DP", "Bore": "" }.',
        },
        quantity: { type: 'integer', minimum: 0, description: 'Only if visually countable/obvious — otherwise omit and let the member fill it in.' },
        location: { type: 'string', description: 'Only if stated by the member or visible in the image — never invent a bin/shelf.' },
        notes: { type: 'string' },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        reasoning: { type: 'string', description: 'One short sentence on what you read/identified, e.g. "Engraved \'40T -20 DP\' visible on the face."' },
      },
      required: ['name'],
    },
  },
}
