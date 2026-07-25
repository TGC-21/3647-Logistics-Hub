# Axial Shaft (Rounded-Hex) Detection Roadmap

## Goal

Extend the fabrication-detection pipeline (see `SPACER_AUTO_DETECTION_ROADMAP.md`) with a second detector that identifies axially-dominant lathe stock — starting with rounded-hex shafts — directly from B-rep geometry (`partstudios/.../bodydetails`) rather than FeatureScript parameters.

Unlike the spacer detector, this one does **not** attempt to correlate a BOM row's `partId` back to a specific FeatureScript feature. That correlation isn't reliably exposed by `features`/`featurescript`, and the part is vendor stock modeled by a FeatureScript we don't control anyway — geometry is the more honest source of truth here, matching the philosophy in `Axial_Geometry_Recognition.md`.

This is a bigger, multi-session effort. The plan below is intentionally cut into small, independently-shippable phases so no phase leaves the app in a half-working state. Each phase should be built, tested, and merged before starting the next.

## Explicit Non-Goals (v1)

- **No taper detection.** Real lathe parts in scope for this project are never modeled with conical transitions. Any taper-shaped segment can be classified `unknown` and flagged `needs_review` rather than measured.
- **No 2D dimensioned drawing / DXF export.** A segment list (ordered dimensions) is sufficient fabrication data. A geometry *preview* (see Phase 6) is wanted, but it's a visualization aid, not a drawing deliverable.
- **No FeatureScript parameter matching for shafts.** Detection is 100% geometry-driven.
- **No partId-to-feature correlation.** We don't need to know which FeatureScript feature produced the part — only its final geometry.

## Product Direction (mirrors the spacer flow)

1. User clicks "Detect fabrication candidates" (existing button, existing endpoint) on an assembly.
2. Candidate rows are prefiltered cheaply (name/part-number/known-vendor-SKU heuristics), same as spacer.
3. For genuine geometry candidates, `bodydetails` is fetched once per unique (Part Studio, partId) and axis/segment reconstruction runs in JS — no repeated Onshape calls.
4. Results are written to `assembly_parts.fabrication_metadata`, same envelope shape the spacer detector already uses, with `kind: 'axial-shaft'` and a richer `dimensions.segments` array instead of a flat `{od, id, length}`.
5. User opens the confirmation overlay: reviews the reconstructed segment list (and, once Phase 6 lands, a rendered preview of the shaft), edits/confirms, and sends to Fabricate — identical downstream mechanics to spacer (component find-or-create, `fabrication_jobs` row, etc).

## Data Access

`POST /partstudios/d/{did}/{wvm}/{wvmid}/e/{eid}/bodydetails` with `partIds` scoped to just the candidate part(s) in that Part Studio — one call per unique (Part Studio, configuration), grouped and deduped exactly like the spacer detector groups by source Part Studio for its `features` call (`partStudioCacheKey` in `onshape-partstudio-features.js`). No FeatureScript eval needed for this detector at all — everything comes back as analytic geometry (`PLANE`, `CYLINDER`, and per the doc, potentially `TORUS`/`CONE` for other parts, though not needed for hex stock) in a single response.

Sample response shape (see body inspected during planning): `bodies[].faces[]`, each with a `surface` (`type: PLANE` → `origin`/`normal`; `type: CYLINDER` → `origin`/`axis`/`radius`) and a `box` (bounding box) — plus `bodies[].vertices[]` and `bodies[].edges[]` for cases the face list alone doesn't disambiguate. `bodies[].type` (`SOLID`) and `properties.name`/`properties.material` are also present and worth logging for confidence heuristics (e.g. "7075 Aluminum" + small OD → lathe part, matching the doc's confidence factors).

## Recognition Pipeline (scoped down from the general doc)

Given tapers are out of scope, the pipeline simplifies to:

1. **Determine the dominant axis.** Group `CYLINDER` faces by (rounded) `axis` direction; the direction shared by the most/largest-area cylindrical faces wins. Fall back to PCA over vertex positions if no cylinder majority exists (rare for hex stock, since the fillet cylinders alone should agree).
2. **Project every face's bounding box onto that axis** to get each face's `[min, max]` extent along the shaft's length.
3. **Sweep-line over those extents** to find the ordered set of length bands where the *active face set* changes — this directly gives segment boundaries without literal cross-section sampling/slicing (no need to intersect the body with planes at synthetic sample points — the face list already encodes this).
4. **Classify each band:**
   - One dominant `CYLINDER`, no `PLANE`s active → `round` segment (dims: diameter).
   - One dominant `CYLINDER` + N≥3 `PLANE`s that are (a) parallel to the axis and (b) symmetric around it → `hex` segment. Record across-flats from the plane-to-axis distances and across-corners from vertex distances.
   - Small-radius `CYLINDER`(s) bridging two `PLANE`s or bridging a `PLANE` and the main round cylinder → **not their own segment** — folded into the adjacent hex/round segment as a `filletRadius` callout (per your call: a phantom tiny round segment is noise, not information).
   - **Resolved during Phase 2 implementation, against the Shaft Generator FeatureScript source:** a smaller concentric cylinder is not automatically a fillet. Hollow shaft types (REVHEX/THUNDERHEX) cut a `centerHole` — a real through-bore, concentric with the axis, spanning nearly the entire part — which is geometrically distinct from the corner-relief cut (`th_dia/2`, the "Thunderhex" annular groove localized to the hex-profile length only). The two are told apart by comparing each active cylinder's radius to the local apothem/OD reference: **radius larger than the apothem → corner relief** (`filletRadius`); **radius smaller than the apothem → internal bore** (`innerDiameter`, a new segment field, since a radius can never be both). A round segment can carry `innerDiameter` too (a hollow round section), independent of any hex segment nearby.
   - N `PLANE`s alone (no cylinder) → `square`/`prism` segment (dims: width, or width per side if not square).
   - Anything else (including any face pattern consistent with a taper/cone) → `unknown`, `needs_review`, with a warning naming what didn't classify.
5. **Merge adjacent segments** of the same classification whose dimensions match within tolerance. Tolerance is "just enough to avoid float/geometry noise," not machinist tolerance — suggest `max(0.0005 in, 0.1% of the relevant dimension)` as a starting constant, tunable once real parts are tested against it.
6. **Emit the ordered segment list** — this is the `dimensions.segments` payload.

## Confidence Rules (adapted from the spacer detector + the doc's Use Case 1)

High confidence:
- Every band classifies as `round`, `hex`, or `square` (nothing falls to `unknown`).
- The dominant axis was determined from cylinder-axis majority (not the PCA fallback).
- OD falls within a small set of common vendor sizes (0.375", 0.5", etc — start with a short hard-coded list, extend later).

Medium confidence:
- Axis came from the PCA fallback, or one segment's dimensions are borderline/ambiguous but still classifiable.

Needs review:
- Any segment classifies as `unknown`.
- Material/name signals conflict (e.g. name suggests "shaft" but material isn't a typical lathe stock alloy).

Ignored:
- Same rule as spacer: source document differs from the imported assembly's root document → vendor/COTS from outside this project, excluded from auto-detection.

## fabrication_metadata Shape

Reuses the existing column/envelope. New pieces only:

```json
{
  "autoDetected": true,
  "kind": "axial-shaft",
  "status": "detected",
  "confidence": "high",
  "source": "onshape-bodydetails",
  "axis": { "origin": [x, y, z], "direction": [x, y, z], "confidence": "cylinder-majority" },
  "dimensions": {
    "totalLength": { "value": 2.0, "unit": "in" },
    "segments": [
      { "type": "round", "length": { "value": 0.5, "unit": "in" }, "diameter": { "value": 0.5, "unit": "in" }, "innerDiameter": { "value": 0.157, "unit": "in" } },
      { "type": "hex",   "length": { "value": 1.0, "unit": "in" }, "acrossFlats": { "value": 0.5, "unit": "in" }, "filletRadius": { "value": 0.27, "unit": "in" }, "innerDiameter": { "value": 0.157, "unit": "in" } },
      { "type": "round", "length": { "value": 0.5, "unit": "in" }, "diameter": { "value": 0.5, "unit": "in" }, "innerDiameter": { "value": 0.157, "unit": "in" } }
    ]
  },
  "overrides": null,
  "onshape": { "documentId": "...", "wvmType": "w", "wvmId": "...", "elementId": "...", "partId": "..." },
  "warnings": []
}
```

**Segment identity (resolved):** plain array index is not enough to key overrides — inserting or deleting a segment silently shifts every later index, and a re-detect (reimport) can regenerate the array in a different order. Each segment gets a stable `id` (e.g. `seg-0`, `seg-1`) assigned once at detection time, independent of array position. Overrides key by that `id`:

```json
"overrides": {
  "seg-1": { "acrossFlats": { "value": 0.51, "unit": "in", "reason": "User confirmation edit" } }
}
```

A segment the user adds manually (not detected) gets a fresh id (e.g. `seg-user-1`) and is flagged `userAdded: true` on the segment itself, so a later re-detect knows not to silently drop it. Display order is still just array order (top-to-bottom along the shaft) — `id` exists only for override/edit-history addressing, never for rendering order.

## Component Typing: a New `'segments'` Characteristic Type (resolved)

Rather than serializing the segment list into a `string`-typed characteristic (which would break `canonicalizeValue`'s trim/case-fold comparison and `validateAttribute`'s type-specific logic, and misrepresents structured data as text), `requiredKeysConfig`'s type union (`'string' | 'quantity' | 'enum'`) gains a fourth type: `'segments'`. This is the cleaner design — a segment list is structurally different data, not a formatted string — chosen without regard for how the existing three types happen to be modeled.

**Category config shape** (on `requiredKeysConfig`, alongside the existing types):
```json
{ "key": "Profile", "type": "segments", "segmentUnit": "in" }
```
No `options`/`defaultUnit` — `segmentUnit` plays `defaultUnit`'s role but applies uniformly to every dimension in every segment (shafts don't mix units per-segment).

**Stored attribute value shape** (on a component's `attributes` array, as the `value` for a `segments`-typed key):
```json
{
  "totalLength": 2.0,
  "segments": [
    { "id": "seg-0", "type": "round", "length": 0.5, "diameter": 0.5 },
    { "id": "seg-1", "type": "hex",   "length": 1.0, "acrossFlats": 0.5, "filletRadius": 0.02 },
    { "id": "seg-2", "type": "round", "length": 0.5, "diameter": 0.5 }
  ]
}
```
Numbers are unit-less here since the config's `segmentUnit` already fixes the unit — avoids repeating `{value, unit}` on every field of every segment.

**Touch points this new type requires** (all shared files — scope changes carefully so spacer/other categories can't regress):
- `src/componentMatch.js` — `canonicalizeValue` needs a `'segments'` case: round every numeric field to a fixed precision and serialize the segment list positionally (ignoring `id`, so two shafts with identical geometry dedupe to the same component regardless of `id` values) into the signature string. This is new logic, not reuse of the `quantity` case.
- `src/db.js` — `validateAttribute` needs a `'segments'` case: valid iff ≥1 segment exists and every segment's required numeric fields for its `type` are finite numbers (structural validation, not a single-value check).
- `src/main.js` / `src/designer.js` — `buildRequiredAttrRow` (and its fab-flow twin `fabBuildRequiredAttrRow`) need a fourth branch. This is effectively Phase 4's segment-editor table, not separate new work — just wiring the `segments` config type into the same row-builder switch those functions already branch on.



Each phase should ship independently — no phase should leave detection half-wired into the UI or the schema in a partial state.

### Phase 1 — `bodydetails` client + fixtures only
- Add `api/_lib/onshape-bodydetails.js`: thin wrapper POSTing to `partstudios/.../bodydetails` with `partIds`, mirroring `onshape-partstudio-features.js`'s shape/conventions (cache key by Part Studio, capped concurrency reuse of `MAX_ONSHAPE_CONCURRENCY`).
- No detector, no UI, no schema changes. Just prove the fetch works against a couple of real rounded-hex parts and save fixture JSON responses for offline testing of Phase 2/3.

### Phase 2 — Axis + segment reconstruction (pure function, unit-testable, no API/DB involvement)
- Add `api/_lib/detectors/axial-shaft.js` with the classification pipeline above, operating purely on an already-fetched `bodydetails` response (same separation-of-concerns as `spacer.js`'s `inspectPartStudioFeatures`).
- Test against Phase 1's saved fixtures until segment lists come out correct for known real parts (start with the sample rounded-hex already inspected).
- Still no candidateFilter/registry wiring, no persistence, no UI.

### Phase 3 — Candidate prefilter + registry wiring (implemented)
- `candidateFilter`: name/part-number keyword match (`hex`, `shaft`, `rod`) + `isFromRootDocument` exclusion, same shape as spacer's.
- Registered in `DETECTORS` (`fabrication-detectors.js`).
- **Dispatch mechanism:** each detector now carries a `dataSource` tag (`'features'` for spacer, `'bodydetails'` for axial-shaft). `onshape-detect-fabrication.js`'s shared candidate/ignored-row bookkeeping is unchanged; only the per-detector "fetch geometry and classify" step branches on `dataSource` — spacer's original fetch/eval logic moved verbatim into `runFeatureBasedDetection`, and axial-shaft's new `runBodyDetailsBasedDetection` groups candidates by source Part Studio (via `bodyDetailsCacheKey`, mirroring `partStudioCacheKey`'s shape), fetches `bodydetails` once per group scoped to that group's `partIds`, resolves each row's body via `findBodyByPartId`, and runs Phase 2's `reconstructAxialSegments`. This keeps the two detectors' very different fetch strategies (parameter-reading + eval vs. pure geometry) from having to share one code path that fits neither well.
- Rows whose `onshape_reference` has no `partId` on record (e.g. imported before `pickOnshapeReference` started retaining it) are written `needs_review` with an explanatory warning rather than silently skipped.
- Verify purely via SQL/console for now, same as the spacer roadmap's Phase 4: confirm axial-shaft candidates get marked, non-candidates don't, COTS/outside-document rows are `ignored`, and no `fabrication_jobs` rows are created — no UI yet.

### Phase 4 — Confirm-overlay UI (list-only, no geometry preview yet)
- New modal (or a mode of the existing `fab-detect-confirm-overlay`) showing the ordered segment list as editable rows: type badge, length, primary dimension, fillet radius where applicable.
- Nail down the `overrides` keying scheme here (segment index + field) before writing the diff logic.
- "Confirm & send to Fabricate" creates/reuses a component (likely a new `Axial Shaft` category, mirroring `SPACER_CATEGORY_NAME`/`SPACER_REQUIRED_KEYS_CONFIG`, shaped for a segment list rather than fixed OD/ID/Length) and a `fabrication_jobs` row, same mechanics as spacer confirmation.
- "Not a shaft" ignore path, same as spacer.

### Phase 5 — Row markers + review filters in Designer
- Same as the spacer roadmap's Phases 6/8: compact `Detected`/`Review`/`Queued`/`Ignored` marker on part rows (`fabDetectionBadgeHTML` already generalizes across `kind`, should need no changes), plus filtering to find all axial-shaft candidates after a big import.

### Phase 6 — Geometry preview in the confirm overlay
- Deferred, explicitly wanted eventually: render the reconstructed segment list as a simple stacked-profile visualization (length-proportional bands, each labeled with its dimensions) inside the confirmation modal — not a dimensioned drawing, just a visual sanity check that axis reconstruction got the right part. This is a natural fit for the Visualizer/SVG approach once the segment data model from Phase 2 is stable, since the reconstructed segment array already has everything (type, length, primary dimension) an inline diagram needs.
- Because this only consumes Phase 2's output shape, it can be built and iterated on independently of Phases 3–5 being fully done, but shouldn't ship before Phase 4 exists to embed it in.

### Phase 7 (future, unscoped) — Reimport behavior, second axial profile types
- Mirrors spacer roadmap's Phase 5 (reconfirmation-on-reimport policy).
- Square/prism and other axial profile types beyond round/hex, if real parts turn up needing them.

## Open Questions Carried Forward

- Exact tolerance constants for segment merging and hex-flat symmetry detection — start loose, tune against real fixtures in Phase 2, not guessed in advance.
- Whether `Axial Shaft` should be one category with a `segments` JSON attribute, or whether the existing typed-characteristic system (flat key/value pairs) needs a new attribute type to represent a segment list cleanly. Worth deciding at the start of Phase 4, not deferred into it.
