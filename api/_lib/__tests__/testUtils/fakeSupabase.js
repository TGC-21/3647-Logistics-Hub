// repositories/__tests__/testUtils/fakeSupabase.js
//
// Phase 0, item 3 of MIGRATION_PLAN.md: the repository test convention.
//
// Repositories build a CHAIN of query-builder calls
// (.from('table').select('*').eq('id', x).maybeSingle()) that resolves
// to { data, error } once awaited. Rather than hand-mock every method
// supabase-js happens to expose, this fake returns a "chain" object
// from every chain method — so it doesn't matter which order or subset
// of methods a given repository call uses, only:
//   (a) what { data, error } it should resolve to, and
//   (b) which calls were made, for assertions.
//
// This is intentionally a FAKE, not a full mock of supabase-js's
// PostgrestFilterBuilder — it does not validate query correctness
// (e.g. it won't catch "you filtered on a column that doesn't exist").
// That's a deliberate scope line: repository tests exist to verify
// "does this repository method call the right table/columns and map
// the response correctly," not to re-test Supabase itself. Anything
// that needs real query semantics belongs in a manual/integration
// check against a real (or local) Supabase project, not a unit test.
//
// Usage:
//   const supabase = createFakeSupabase({ data: { id: 'job1' }, error: null })
//   const repo = new FabricationJobRepository(supabase)
//   const result = await repo.findById('job1')
//   expect(supabase.calledWith({ table: 'fabrication_jobs', method: 'eq', args: ['id', 'job1'] })).toBe(true)

const CHAIN_METHODS = [
  'select', 'insert', 'update', 'delete', 'upsert',
  'eq', 'neq', 'in', 'order', 'limit', 'single', 'maybeSingle',
]

export function createFakeSupabase(resolveWith = { data: null, error: null }) {
  const calls = []

  function makeChain(table) {
    const chain = {
      // Chains in supabase-js are themselves "thenable" — you can
      // `await` at any point in the chain, not just after a terminal
      // method like .single(). Implementing .then() here (rather than
      // returning a real Promise from each method) is what lets a
      // repository method chain as many or as few calls as it wants
      // and still resolve correctly when awaited.
      then(resolve, reject) {
        return Promise.resolve(resolveWith).then(resolve, reject)
      },
    }
    CHAIN_METHODS.forEach(name => {
      chain[name] = (...args) => {
        calls.push({ table, method: name, args })
        return chain
      }
    })
    return chain
  }

  return {
    from(table) {
      calls.push({ table, method: 'from', args: [] })
      return makeChain(table)
    },
    rpc(fnName, args) {
      calls.push({ table: null, method: 'rpc', args: [fnName, args] })
      return Promise.resolve(resolveWith)
    },
    // Raw call log, for tests that want to assert something this
    // helper's `calledWith` shorthand doesn't cover.
    __calls: calls,
    /** Shorthand for "was a call matching this shape made" — checks
     *  only the fields provided, so a test can assert on just
     *  { table, method } without also pinning down every arg. */
    calledWith(partial) {
      return calls.some(c =>
        (partial.table === undefined  || c.table === partial.table) &&
        (partial.method === undefined || c.method === partial.method) &&
        (partial.args === undefined   || JSON.stringify(c.args) === JSON.stringify(partial.args))
      )
    },
  }
}