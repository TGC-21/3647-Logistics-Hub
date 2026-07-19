# Plate Detection Roadmap

## Goal

Extend the fabrication-detection pipeline (see `SPACER_AUTO_DETECTION_ROADMAP.md` and `AXIAL_SHAFT_DETECTION_ROADMAP.md`) with a third detector that identifies custom flat-stock plates — aluminum or polycarbonate sheet parts with holes and cut geometry — directly from B-rep geometry (`partstudios/.../bodydetails`), the same data source and general approach as the axial-shaft detector.

Like axial-shaft, this detector does **not** attempt to correlate a BOM row's `partId` back to a specific FeatureScript feature — plates are typically built from sketches/extrudes, not a shared third-party generator, so there's no parameter signature to key off even if we wanted one. Geometry is the source of truth.

## Explicit Non-Goals (v1)

- **Sheet metal is out of scope.** No bend detection, no flat-pattern/unfold logic, no sheet-metal-specific FeatureScript or FlatPattern feature awareness. A part authored as Onshape "sheet metal" is not a target of this detector, even if it happens to look plate-like.
- **No bent tabs, stiffening ribs, or multi-offset stepped geometry in v1.** Per product direction, these are uncommon enough in practice to defer — a body that resolves to more than one *pair* of large dominant parallel planes (i.e. more than one distinct thickness/offset region) is flagged `needs_review`, not classified.
- **No curved/bent outlines.** A plate's perimeter is assumed to be a straight-walled prismatic outline (possibly with filleted corners) extruded through the thickness — not a curved/formed surface.
- **No per-hole dimensional schedule.** Resolved: this detector classifies *plates*, not holes. Counterbores/countersinks still need to be tolerated during classification (see below) so they don't break the dominant-plane-pair signal or get misread as a second thickness offset, but their dimensions are not extracted, recorded, or surfaced anywhere. A hole census beyond "does this look like normal hole geometry, not a modeling anomaly" is out of scope.
- **No DXF/flat-pattern export.** Same non-goal as the shaft roadmap's stance on 2D drawings.

## Product Direction (mirrors spacer/shaft)

1. User clicks "Detect fabrication candidates" (existing button, existing endpoint) on an assembly.
2. Candidate rows are prefiltered cheaply: name/part-number contains "plate" (mirrors spacer's/axial-shaft's keyword prefilter), excluding COTS/standard-content and non-root-document rows via the existing shared rules.
3. For genuine candidates, `bodydetails` is fetched once per unique (Part Studio, partId) — shared with the other two detectors' grouping/caching convention (`bodyDetailsCacheKey`) — and plate reconstruction runs in JS.
4. Results are written to `assembly_parts.fabrication_metadata`, same envelope shape the other two detectors use, with `kind: 'plate'` and a dimensions shape covering thickness, footprint, and a hole schedule (including counterbores where present).
5. User opens the confirmation overlay, reviews the reconstructed dimensions/hole schedule, edits/confirms, and sends to Fabricate — same downstream mechanics as spacer/axial-shaft (component find-or-create, `fabrication_jobs` row, etc).

## Detection Signal

### Primary: dominant parallel plane pair

1. Group `PLANE` faces by (sign-agnostic) normal direction — same clustering approach `resolveDominantAxis` already uses for cylinder axes in the shaft detector, just applied to plane normals instead of cylinder axes.
2. Within the winning normal-direction cluster, select the **top faces by area** (not by raw count) as the candidate top/bottom pair. This area-first selection is what keeps small incidental planar faces (see counterbore handling below) from ever being mistaken for a primary plate face.
3. The two selected faces must:
   - Together account for a large majority of the body's total face area (this is what says "sheet stock," not "block with two flat sides").
   - Be separated along the shared normal by a small, roughly constant offset — this offset is the plate's **thickness**.
4. Thickness must fall within the stated stock range (v1 assumption: up to 0.5", commonly 1/8", 3/16", 1/4" — see open question on the exact bucket list).

### Aspect ratio check

The dominant pair's in-plane bounding-box footprint should be large relative to thickness (e.g. thickness under some fraction of the smaller in-plane dimension). This is the check that separates "plate" from "block" or "thick washer" — territory that would otherwise overlap with the spacer detector for a small, square, thin part.

### Common-thickness confidence bump

Same trick as axial-shaft's common-OD bump: a measured thickness landing within tolerance of a named stock thickness is a high-confidence signal on its own. Resolved: the stock-thickness list is **configurable**, not hard-coded like axial-shaft's OD list — see Implementation Phases below for where that config lives.

### Hole tolerance (classification-only, not extraction)

Every remaining cylindrical/conical face cluster with axis parallel to the plate normal is treated as "hole-shaped geometry" purely so it doesn't get misclassified as a second thickness offset or an unknown region. Resolved: no dimensions are extracted or recorded per hole — a hole cluster only needs to resolve to one of a small set of recognized shapes (through-hole, counterbore, countersink) to *not* count against confidence. See Counterbore & Countersink Handling below.

A plate with zero holes (blank stock) is still a plate.

## Counterbore & Countersink Handling

Resolved: when a plate has multiple counterbores, they all sit on the same face — so the per-hole check never needs to search both ends of a cluster for a shoulder, only the one face the whole part's counterbores are known to share (or, more precisely, whichever face a given cluster's large-radius/wide-angle region touches — see below).

Both counterbores (cylindrical) and countersinks (conical) are handled the same way, and — per the "classification-only" resolution above — the goal is purely to **recognize and tolerate** this geometry so it doesn't corrupt the dominant-plane-pair signal, not to record its dimensions:

1. For each hole-shaped face cluster (cylindrical or conical faces with axis parallel to the plate normal), project its faces' extents onto that normal — the same sweep-line banding technique the shaft detector already implements (`reconstructAxialSegments`'s approach), applied per-cluster instead of whole-body.
2. One band, constant radius → simple through-hole. Recognized, ignored beyond that.
3. Two bands — a shallow region adjacent to one dominant face (either constant larger radius = counterbore, or a `CONE` surface = countersink) followed by a smaller-radius region for the remaining depth, separated by a small shoulder (planar for a counterbore, absent/degenerate for a countersink since the cone tapers directly to the bore diameter) → recognized as counterbore/countersink. Still not recorded — just confirmed as "expected hole variant," not `unknown`.
4. Any hole cluster that doesn't resolve to one of these shapes (through-hole, counterbore, countersink) is what actually costs confidence — that's the real signal that something is a genuine anomaly worth a human look, not a normal manufacturing feature.
5. The counterbore/countersink shoulder or cone tip is exactly the kind of small-area, non-planar-or-tiny-planar face that must **never** compete with the top/bottom dominant-plane selection — this is why that selection is area-gated rather than "find exactly 2 planes and stop." A `CONE` face in particular should never be eligible for the dominant-pair role in the first place, since that selection only ever considers `PLANE` faces.

This reuses the existing shaft-detector sweep/band/classify pipeline rather than introducing new geometric machinery — same technique, different axis, per-hole-cluster scope, and (per the resolution above) a much smaller output: a boolean-ish "did this classify as a recognized hole shape" rather than a stored schedule.

## Confidence Rules (adapted from spacer/shaft)

**High confidence:**
- Dominant plane pair found via area-gated selection with no ambiguity (one clear winning normal-direction cluster).
- Thickness matches a common stock size within tolerance.
- Aspect ratio clearly reads as sheet stock, not block.
- Every hole cluster resolves cleanly to either a through-hole or a single-shoulder counterbore — no `unknown` hole bands.

**Medium confidence:**
- Thickness is plausible but doesn't match a named stock size.
- One or more holes have ambiguous banding (e.g. a shoulder plane that doesn't cleanly separate two constant-radius bands).

**Needs review:**
- More than one distinct dominant-plane-pair offset found (stepped/ribbed geometry) — explicitly out of scope for auto-classification per product direction, but should surface rather than silently misclassify.
- Any hole band resolves to `unknown`.
- Conical (countersink) faces present, if out of scope per the open question below.

**Ignored:**
- Same rule as spacer/shaft: source document differs from the imported assembly's root document → vendor/COTS, excluded from auto-detection.
- Body appears to be Onshape sheet-metal (if detectable from body/feature metadata) — explicitly out of scope.

## fabrication_metadata Shape (proposed)

Reuses the existing column/envelope, same pattern as spacer/axial-shaft:

```json
{
  "autoDetected": true,
  "kind": "plate",
  "status": "detected",
  "confidence": "high",
  "source": "onshape-bodydetails",
  "normal": { "origin": [x, y, z], "direction": [x, y, z], "confidence": "plane-majority" },
  "dimensions": {
    "thickness": { "value": 0.25, "unit": "in" },
    "footprint": { "length": { "value": 6.0, "unit": "in" }, "width": { "value": 3.5, "unit": "in" } }
  },
  "holeCensus": { "recognized": 8, "unrecognized": 0 },
  "overrides": null,
  "onshape": { "documentId": "...", "wvmType": "w", "wvmId": "...", "elementId": "...", "partId": "..." },
  "warnings": []
}
```

Resolved: no per-hole schedule is persisted. `dimensions` is intentionally just thickness + a coarse length/width bounding box (matching the resolution that a plate's identity is thickness + material + bounding box "at most"). `footprint` is derived from the dominant planes' own bounding box, not a true outline trace — an actual outline (for possible future cut-file export) remains out of scope. `holeCensus` is optional, purely informational counts (not a structured schedule) that can back the `warnings` array when `unrecognized > 0` — worth including or dropping based on whether it's useful in the confirm overlay, not load-bearing for classification.

## Implementation Phases (mirrors the shaft roadmap's structure)

### Phase 1 — Plate reconstruction as a pure function
- Add `api/_lib/detectors/plate.js` with the dominant-plane-pair + per-hole band-sweep logic above, operating purely on an already-fetched `bodydetails` response.
- Factor the axial band-sweep primitives (project-onto-axis, build-bands, classify-band-by-active-faces) out of `axial-shaft.js` into a shared helper if practical, since plate's per-hole counterbore reconstruction is the same sweep technique applied at a different scope/axis. Worth deciding whether this refactor happens now or plate just duplicates the pattern initially and gets unified later — see open question.
- Test against saved fixture responses (need at least one plain plate, one plate with counterbores, one thin-but-not-plate part to confirm the aspect-ratio gate rejects it).

### Phase 2 — Candidate prefilter + registry wiring
- `candidateFilter`: name/part-number contains "plate" + `isFromRootDocument` exclusion, same shape as the other two.
- Register in `DETECTORS` (`fabrication-detectors.js`) **last** — resolved: spacer and axial-shaft both get first claim over any row, same `claimedBy` mechanism `onshape-detect-fabrication.js` already uses between spacer and axial-shaft, extended to a third detector. Plate only runs against rows neither of the other two claimed.
- `dataSource: 'bodydetails'`, reusing `runBodyDetailsBasedDetection` in `onshape-detect-fabrication.js` — no endpoint changes needed if plate's `classifyGeometry(body, opts)` matches the shared interface.
- Stock-thickness bucket list lives as detector-local config (module-level array, easy to edit) rather than hard-coded inline like axial-shaft's OD list — resolved as "configurable," doesn't need a full settings UI in v1 unless later wanted.
- Verify via SQL/console only, same as the other two roadmaps' early phases: confirm plate candidates get marked, non-candidates don't, COTS/outside-document rows are `ignored`, no `fabrication_jobs` created yet.

### Phase 3 — Confirm-overlay UI
- New modal mode (or extend `fab-detect-confirm-overlay`) showing thickness, footprint (length × width), and material — no hole schedule table, per the resolved scope.
- No per-field override-keying scheme needed beyond what a flat `{ thickness, length, width }` edit already implies (simpler than axial-shaft's per-segment `id` scheme, since there's no list to diff).
- "Confirm & send to Fabricate" creates/reuses a component in a new `Plate` category shaped as flat quantity fields: thickness, length, width, plus material (likely an `enum` characteristic, e.g. Aluminum/Polycarbonate/Acrylic) — resolved: no structural/segments-style field needed, since hole geometry is explicitly excluded from a plate's identity. Mirrors `SPACER_REQUIRED_KEYS_CONFIG`'s flat shape, not axial-shaft's `segments` type.
- "Not a plate" ignore path, same as the other two detectors.

### Phase 4 — Row markers + review filters
- Same as spacer/shaft: `fabDetectionBadgeHTML` already generalizes across `kind` and should need no changes; add plate to the noun-lookup map (`spacer`/`shaft`/`plate`).

### Phase 5 (future, unscoped)
- Reimport/reconfirmation policy, mirroring the other two roadmaps' deferred Phase 5/7.
- Revisit sheet-metal and countersink scope if real parts turn up needing them.

## Resolved Questions (for reference)

1. **Counterbore access** — always the same face across a given plate; no need to search both ends of every cluster.
2. **Countersinks** — in scope, handled alongside counterbores via the same per-cluster band-sweep, with `CONE` faces recognized rather than excluded from consideration.
3. **Hole-schedule granularity** — none. This detector classifies plates only; hole geometry is tolerated/recognized during classification but never extracted or stored.
4. **Stock thickness list** — configurable (detector-local config, not hard-coded inline).
5. **Plate component identity** — thickness + material + coarse length × width bounding box, as flat quantity/enum fields. No structural hole data in the component's identity. Explicitly noted as extensible later if ever needed, but not for v1.
6. **Detector priority** — Spacer and Axial-Shaft both claim first; Plate registers last and only runs on rows neither claimed.

## Still Open

1. **Material field values:** what should the Plate category's material `enum` options be — a fixed list (e.g. Aluminum, Polycarbonate, Acrylic) matching `properties.material` string-matching from Onshape, or free text the user fills in manually since `bodydetails` material names may not map cleanly to a short preset list?
2. **Sheet-metal exclusion mechanics:** is there a reliable signal at the `bodydetails`/BOM-row level to positively identify (and skip) an Onshape sheet-metal part, or should this detector rely purely on geometry (a sheet-metal body's flat, prismatic geometry may well satisfy the plane-pair test) and treat "sheet metal" as a modeling-convention concern rather than a hard exclusion in code? If there's no clean signal, sheet-metal parts may need to be excluded by convention (e.g. don't name them "plate") rather than detected against.
3. **Multi-offset / stepped plates:** confirmed out of scope for classification — should these still be logged as `needs_review` with a plate-shaped hint (in case it's a plate that just needs a human look), or should stepped geometry be indistinguishable from any other `needs_review` non-match? This only affects how useful the review queue is, not the detection logic itself.
