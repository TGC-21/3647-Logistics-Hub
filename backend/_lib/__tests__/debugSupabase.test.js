import { describe, it } from 'vitest'

import { getSupabase } from '../../../src/repositories/supabaseClient.js'

describe('Supabase harness diagnostic', () => {
  it('checks assembly_parts visibility', async () => {
    console.log('SUPABASE_URL:', process.env.SUPABASE_URL)

    const db = getSupabase()

    const { data, error } = await db
      .from('assembly_parts')
      .select('*')
      .limit(5)

    console.log('ROWS:', data)
    console.log('ERROR:', error)
  })
})