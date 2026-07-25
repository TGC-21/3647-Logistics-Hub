# Partshelf

Inventory manager with a Designer workflow for tracking assembly parts collection, plus a built-in picker for importing BOMs directly from Onshape.

This README reflects the current, shipped architecture. If you have older copies of `IMPLEMENTATION_GUIDE.md`, `CHANGES_SUMMARY.md`, or a `public/onshape-tab.html` file lying around from earlier iterations — discard them. The integration approach changed twice during development (Custom Tab → OAuth App Store app → this) and those described dead ends.

---

## How the Onshape integration actually works

Partshelf does the browsing. Nothing is installed inside Onshape.

```
Designer mode → assembly detail → "Import from Onshape"
    ↓
Search documents (api/onshape-documents.js)
    ↓ pick one
List its assemblies (api/onshape-elements.js)
    ↓ pick one
Preview the BOM (api/onshape-bom-preview.js)
    ↓ confirm
Parts added to the currently-open assembly
```

All three endpoints authenticate to Onshape with a single Access Key / Secret Key pair (server-side only, never exposed to the browser). There is no OAuth, no Onshape Developer Portal app, no App Store listing, and no Custom Tab — which means none of this depends on Onshape plan tier or Custom Tab availability.

**Known limitation:** because it's one shared key pair rather than per-user OAuth, the document picker shows whatever that Onshape account can see — not each individual Partshelf user's own private documents. Fine for a single team/classroom sharing documents in one Onshape org. If you ever need per-user document visibility, that requires OAuth, which is a separate, larger undertaking not part of this build.

---

## File structure

```
partshelf/
├── index.html                    Entry point, all modals (incl. Onshape picker)
├── schema.sql                    Supabase tables + RLS policies
├── package.json
├── vite.config.js
├── .env.example
├── src/
│   ├── main.js                   Inventory mode + mode routing
│   ├── designer.js                Designer mode: assemblies, parts, CSV import, Onshape picker
│   ├── db.js                      Supabase CRUD
│   └── style.css                  Styles for both modes
└── api/
    ├── _lib/
    │   └── onshape.js              Shared Onshape auth + BOM parsing (onshapeGet, fetchBom, parseBomRows)
    ├── onshape-documents.js        GET — search/list Onshape documents
    ├── onshape-elements.js         GET — list assembly elements in a document
    ├── onshape-bom-preview.js      GET — parse a BOM for preview (no DB writes)
    └── onshape-bom.js              POST — create a new assembly from a BOM (used for direct/external imports)
```

---

## Environment variables (6 total, all already in use)

**Local `.env` (client-side, prefixed `VITE_`):**
```
VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-public-key
```

**Vercel (server-side, set in Project Settings → Environment Variables):**
```
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_SERVICE_KEY=your-service-role-key
ONSHAPE_ACCESS_KEY=your-onshape-access-key
ONSHAPE_SECRET_KEY=your-onshape-secret-key
```

Get the Onshape keys from **https://dev.onshape.com/keys** — create an **API key pair**, not an OAuth app. That distinction matters: API keys are what this integration uses; OAuth apps are a different, unused feature here.

---

## Setup

1. **Supabase** — create a project, run `schema.sql` in the SQL Editor, copy the URL + anon key into `.env`.
2. **Onshape** — create an API key pair at the link above, copy Access Key + Secret Key into Vercel env vars.
3. **Local dev:**
   ```bash
   npm install
   npm run dev
   ```
4. **Deploy:** push to GitHub, Vercel auto-builds. The `api/` folder deploys as serverless functions automatically — no separate configuration needed.

---

## Manual test checklist

Run through this after any change to the Onshape integration or before a deploy you care about:

- [ ] `npm run dev` boots with no console errors
- [ ] Inventory mode: add, edit, delete a component (unaffected by any of the Onshape work — should still work exactly as before)
- [ ] Designer mode: create an assembly
- [ ] Designer mode: add a part manually
- [ ] Designer mode: import a BOM via CSV upload
- [ ] Designer mode: click **Import from Onshape** → search returns real documents
- [ ] Selecting a document with zero assemblies shows the "No assemblies in this document" state, not an error
- [ ] Selecting an assembly with an empty BOM shows the warning + "No parts to import" state, not a crash
- [ ] Selecting a real assembly with parts shows an accurate preview table
- [ ] Clicking **Import parts** adds them to the open assembly's parts table with `source: onshape`
- [ ] If the assembly had no Onshape URL before, it now shows an "Onshape" link in the toolbar pointing to the right document/assembly
- [ ] Qty stepper still increments/decrements correctly on Onshape-imported parts (no different from manual/CSV parts)
- [ ] Progress bar and assembly status (draft/active/complete) update correctly after the import
- [ ] Deployed `/api/onshape-documents`, `/api/onshape-elements`, `/api/onshape-bom-preview` all return correctly via `curl` against production, not just localhost

---

## What's NOT built (intentionally out of scope)

- **Per-user OAuth** — would let each Partshelf user browse their own private Onshape documents instead of one shared account's documents. Bigger undertaking, not needed for current single-team use.
- **Mapping BOM parts to existing Inventory components** — imported Onshape/CSV parts currently live only in the assembly's part list; they aren't auto-linked to matching Inventory items. `onshape_reference` (the raw BOM row) is stored on each part for this to be built later.
- **Pagination on document search** — capped at 20 results per search. Fine for typical use; if your Onshape account has hundreds of matching documents, narrow the search query rather than scroll.
- **Stock-level checking on import** — no warning today if an imported BOM needs more of a part than Inventory has on hand.

None of these block current use — they're natural next features if you want to keep building.
