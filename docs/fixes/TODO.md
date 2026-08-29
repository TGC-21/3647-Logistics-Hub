# Critical

(none currently — the centralized OnshapeClient item was removed along with
Onshape import/fabrication/Designer, which are no longer part of this app.)

# High

- Add ESLint, Prettier, and JSDoc type checking.
- Add automated tests (unit, integration, UI) beyond the existing service/
  repository test suites.
- Add performance instrumentation.
- Adopt a database migration strategy (schema currently lives as ad hoc
  SQL files under `random schemas/`).
- Refactor `boot()` in `src/main.js` into a modular initialization pipeline.
- Replace global mutable state in `src/main.js` with feature-specific state
  objects.
- Verify all `bind*Events()` functions are idempotent and cannot register
  duplicate listeners.
- Split `src/db.js` into inventory/categories/instances/images/supabase
  modules.
- Convert inventory rendering to incremental row patching instead of
  rebuilding the entire table.
- Use `Map<id, item>` for constant-time inventory lookups.
- Replace per-row event listeners with event delegation.
- Reduce Supabase queries using explicit column selection instead of
  `select("*")`.

# Medium

- Introduce centralized configuration modules.
- Replace magic numbers with named constants.
- Improve responsive layouts using scalable CSS techniques.
- Add structured logging (backend + Clinker turn logging).
- Audit cleanup of listeners, object URLs, timers, and observers.
- Centralize application error handling.
- Cache filtered inventory instead of recomputing on every render.
- Cache frequently accessed DOM elements.
- Consolidate editing state into a single `editingSession` object.
- Build a composable filter pipeline for inventory search.
- Improve defensive null checking in rendering.
- Remove redundant derived state.
- Normalize API response objects.
- Improve error taxonomy.

# Low

- Add progress reporting for long-running operations (e.g. bulk delete).
- Remove remaining inline styles from `index.html`.
- Add developer architecture diagram to README.
- Improve keyboard accessibility.
- Centralize toast notification helpers.
- Store category expansion state as a `Set`.
- Add feature flags for experimental functionality.

# Clinker-specific

See `docs/development/clinker.md`'s "Open items" section — kept there
rather than duplicated here, since it needs the surrounding context.