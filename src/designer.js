// src/designer.js
//
// Compatibility shim. Everything actually lives in src/designer/*.js now
// (see designer/index.js for the module map) — this file exists purely
// so main.js's `from './designer.js'` and fabricate.js's
// `from './designer.js'` keep working without touching either file.
// Safe to delete once those two imports are updated to point at
// './designer/index.js' directly.
export * from './designer/index.js'