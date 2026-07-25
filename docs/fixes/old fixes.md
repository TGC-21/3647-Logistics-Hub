 # Goal
create a centralized logistics hub for tracking inventory parts, Onshape assemblies, fabrication jobs, and part orders. The user base is pretty small, at around 25 people, and parts are limited in scope; either COTS parts or custom machined parts, which fall under the categories of custom spacers, custom shafts, and custom plates. The app is designed to bridge the gap between designing and actual assembly, making it as easy as possible for users to adopt and use. 

# Strategic Engineering Priorities

These are the highest-impact improvements for Partshelf. Unlike bug fixes,
these are architectural investments intended to support the long-term goal
of Partshelf as a centralized logistics hub connecting inventory, CAD,
fabrication, purchasing, and assembly.

The target audience is approximately 25 users managing a moderate inventory
of COTS parts and custom manufactured components (plates, shafts, spacers).
While the scale does not require enterprise-grade distributed systems,
maintaining fast interactions, simple workflows, and easily maintainable code
is critical for encouraging adoption within the robotics team.

Each improvement below was prioritized according to:

1. User experience
2. Maintainability
3. Reliability
4. Development velocity
5. Performance



#fixes
# Critical

- Introduce a centralized OnshapeClient responsible for authentication, retries, timeouts, logging, and rate limiting.

# High

- Build shared utility modules (DOM, validation, async, formatting).
- Standardize reusable UI component styles.
- Add ESLint, Prettier, and JSDoc type checking.
- Add automated tests (unit, integration, UI).
- Add performance instrumentation.
- Implement subsystem error boundaries.
- Adopt a database migration strategy.
- Refactor boot() into modular initialization pipeline.
- Replace global mutable state in main.js with feature-specific state objects.
- Verify all bind*Events() functions are idempotent and cannot register duplicate listeners.
- Lazy-load Designer, Fabricate, and Part Orders modules to reduce initial bundle size.
- Split db.js into inventory, categories, instances, images, and supabase modules.
- Replace global inventory state with dedicated state objects.
- Convert inventory rendering to incremental row patching instead of rebuilding the entire table.
- Use Map<id, item> for constant-time inventory lookups.
- Replace per-row event listeners with event delegation.
- Reduce Supabase queries using explicit column selection instead of select("*").
- Consolidate Designer state into a single designerState object.
- Introduce walkAssembly() as the canonical traversal helper.
- Maintain Map<ComponentId, Component> for constant-time lookups.
- Patch modified tree branches instead of rerendering the full assembly tree.
- Add validateAssembly() for cycle detection, missing references, duplicate IDs, and invalid quantities.
- Replace per-node event listeners with delegated tree events.
- Separate Onshape synchronization into fetch → diff → apply stages.
- Deduplicate Onshape requests during imports.
- Add request timeouts and exponential backoff retries.
- Limit concurrent API requests with a request queue.
- Make synchronization diff-based instead of overwrite-based.
- Batch database writes during imports.
- Wrap imports in database transactions.
- Validate imported assemblies before persistence.
- Translate Onshape responses into internal models.
- Cache immutable metadata (part properties, document metadata).

# Medium

- Introduce centralized configuration modules.
- Replace magic numbers with named constants.
- Improve responsive layouts using scalable CSS techniques.
- Add structured logging.
- Audit cleanup of listeners, object URLs, timers, and observers.
- Convert fixes.md from completed-work log into prioritized engineering backlog.
- Centralize application error handling.
- Introduce a mode registry instead of appMode conditionals.
- Move URL routing logic into a dedicated router module.
- Cache filtered inventory instead of recomputing on every render.
- Cache frequently accessed DOM elements.
- Consolidate editing state into a single editingSession object.
- Build a composable filter pipeline.
- Cache repeated inventory fetches between modules.
- Improve defensive null checking in rendering.
- Cache generated BOMs until assembly changes.
- Cache subtree calculations.
- Remove redundant derived state.
- Separate rendering logic from Designer state management.
- Prepare command-based architecture for future undo/redo support.
- Track expanded nodes using a Set.
- Normalize API response objects.
- Detect unchanged imports using deterministic assembly hashes.
- Separate immutable CAD data from mutable inventory data.
- Add structured logging.
- Improve error taxonomy.

# Low

- Add progress reporting for long-running imports.
- Remove remaining inline styles from index.html.
- Add developer architecture diagram to README.
- Move roadmap markdown files into a docs/ directory.# Fixes log — client-side latency pass
- Normalize searchable strings during initial load.
- Improve keyboard accessibility.
- Centralize toast notification helpers.
- Store category expansion state as a Set.
- Store only component IDs in assembly nodes; resolve metadata lazily.
- Ensure immutable node IDs independent of array ordering.
- Expand documentation under docs/.
- Add feature flags for experimental functionality.
- Design a future plugin architecture.
