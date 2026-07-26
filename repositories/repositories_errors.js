// repositories/errors.js
//
// Typed errors that SERVICES throw and ROUTES translate into HTTP
// status codes. This is what lets api/*.js files stay "thin" (see
// api/fabrication-jobs.js) — a route never needs an if/else chain
// deciding "was this a bad request, a conflict, or a real server
// error," it just calls statusForError(err) once.
//
// Repositories should only ever throw DatabaseError (wrapping whatever
// Postgres/Supabase actually said) — deciding what a failure MEANS to
// the business ("this part already has an active job," "that job was
// already claimed") is a service's job, not a repository's. A
// repository doesn't know what a "conflict" is in business terms; it
// only knows a query returned zero rows or Postgres returned an error.

export class ValidationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ValidationError'
    this.statusCode = 400
  }
}

export class NotFoundError extends Error {
  constructor(message) {
    super(message)
    this.name = 'NotFoundError'
    this.statusCode = 404
  }
}

export class ConflictError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ConflictError'
    this.statusCode = 409
  }
}

export class UnauthorizedError extends Error {
  constructor(message) {
    super(message)
    this.name = 'UnauthorizedError'
    this.statusCode = 401
  }
}

export class DatabaseError extends Error {
  constructor(message, cause) {
    super(message)
    this.name = 'DatabaseError'
    this.statusCode = 500
    this.cause = cause
  }
}

/** Routes call this once, at the end of a try/catch, instead of each
 *  route re-inventing its own error→status mapping (compare to how
 *  api/onshape-bom.js today does `/Onshape API 404/.test(err.message)`
 *  string-sniffing to decide the status code — typed errors replace
 *  that pattern for the service layer). */
export function statusForError(err) {
  return err?.statusCode || 500
}