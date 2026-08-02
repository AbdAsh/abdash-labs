import { describe, it, expect } from 'vitest'
import { anonUser } from './helpers'

/**
 * RAG Lab isolation and the no-vectors guarantee, against the live project.
 *
 * Run with:
 *   SUPABASE_URL=... SUPABASE_ANON_KEY=... npx vitest run tests/rls/raglab.test.ts
 *
 * Permalinks make reads public by design, so the interesting assertions here are
 * about *writes* — one visitor must never be able to edit or delete another's
 * benchmark — and about the payload budget that keeps embeddings out of a 500 MB
 * database shared by seven apps.
 */

const experiment = (slug: string) => ({
  slug,
  doc_name: 'Constitution of the United States — Selected Provisions',
  doc_fingerprint: 'a'.repeat(64),
  questions: [
    { id: 'q1', text: 'What is the minimum voting age?', gold: { start: 100, end: 240 } },
  ],
})

const results = [
  {
    config: { chunker: 'fixed', size: 800, overlap: 160, model: 'text-embedding-3-small', k: 5 },
    hitRate: 0.8,
    mrr: 0.72,
    chunkCount: 24,
    perQuestion: [{ questionId: 'q1', hit: true, rr: 1, retrieved: ['an excerpt'], spans: [[0, 10]] }],
  },
]

const slug = () => `t-${Math.random().toString(36).slice(2, 10)}`

describe('raglab RLS', () => {
  it('lets a visitor create an experiment and a run', async () => {
    const { db, userId } = await anonUser()
    const raglab = db.schema('raglab')

    const { data: created, error } = await raglab
      .from('experiments').insert(experiment(slug())).select('id, owner_id').single()
    expect(error).toBeNull()
    expect(created?.owner_id).toBe(userId)

    const { error: runError } = await raglab
      .from('runs').insert({ experiment_id: created!.id, results })
    expect(runError).toBeNull()
  })

  it('defaults owner_id to the caller and refuses a forged one', async () => {
    const a = await anonUser()
    const b = await anonUser()
    const { error } = await a.db.schema('raglab')
      .from('experiments').insert({ ...experiment(slug()), owner_id: b.userId })
    // `with check (owner_id = auth.uid())` must reject writing on someone else's behalf.
    expect(error).not.toBeNull()
  })

  // Public read is the feature: a permalink has to work for a stranger.
  it('lets a different visitor read a shared experiment and its run', async () => {
    const owner = await anonUser()
    const s = slug()
    const { data: created } = await owner.db.schema('raglab')
      .from('experiments').insert(experiment(s)).select('id').single()
    await owner.db.schema('raglab')
      .from('runs').insert({ experiment_id: created!.id, results })

    const stranger = await anonUser()
    const { data: shared } = await stranger.db.schema('raglab')
      .from('experiments').select('id, doc_name').eq('slug', s).single()
    expect(shared?.doc_name).toBe(experiment(s).doc_name)

    const { data: sharedRuns } = await stranger.db.schema('raglab')
      .from('runs').select('id').eq('experiment_id', created!.id)
    expect(sharedRuns?.length).toBe(1)
  })

  it('does not let one visitor modify another visitor\'s experiment', async () => {
    const owner = await anonUser()
    const s = slug()
    await owner.db.schema('raglab').from('experiments').insert(experiment(s))

    const attacker = await anonUser()
    const { data: updated } = await attacker.db.schema('raglab')
      .from('experiments').update({ doc_name: 'hijacked' }).eq('slug', s).select('id')
    expect(updated ?? []).toEqual([])

    const { data: after } = await owner.db.schema('raglab')
      .from('experiments').select('doc_name').eq('slug', s).single()
    expect(after?.doc_name).not.toBe('hijacked')
  })

  it('does not let one visitor delete another visitor\'s run', async () => {
    const owner = await anonUser()
    const { data: created } = await owner.db.schema('raglab')
      .from('experiments').insert(experiment(slug())).select('id').single()
    const { data: run } = await owner.db.schema('raglab')
      .from('runs').insert({ experiment_id: created!.id, results }).select('id').single()

    const attacker = await anonUser()
    const { data: deleted } = await attacker.db.schema('raglab')
      .from('runs').delete().eq('id', run!.id).select('id')
    expect(deleted ?? []).toEqual([])

    const { data: still } = await owner.db.schema('raglab')
      .from('runs').select('id').eq('id', run!.id).maybeSingle()
    expect(still?.id).toBe(run!.id)
  })

  it('rejects a duplicate slug rather than shadowing an existing permalink', async () => {
    const s = slug()
    const a = await anonUser()
    await a.db.schema('raglab').from('experiments').insert(experiment(s))
    const b = await anonUser()
    const { error } = await b.db.schema('raglab').from('experiments').insert(experiment(s))
    expect(error).not.toBeNull()
  })

  // ------------------------------------------------------------------------
  // The constraint the entire app is shaped around
  // ------------------------------------------------------------------------

  it('stores metrics without embeddings', async () => {
    const { db } = await anonUser()
    const { data: created } = await db.schema('raglab')
      .from('experiments').insert(experiment(slug())).select('id').single()
    await db.schema('raglab').from('runs').insert({ experiment_id: created!.id, results })

    const { data } = await db.schema('raglab')
      .from('runs').select('results').eq('experiment_id', created!.id).single()

    const json = JSON.stringify(data?.results ?? {})
    expect(json.length).toBeLessThan(200_000)
    // A 1536-float array would be unmistakable.
    expect(/\[(-?\d+\.\d+,){100,}/.test(json)).toBe(false)
  })

  it('refuses a run payload big enough to be an embedding', async () => {
    const { db } = await anonUser()
    const { data: created } = await db.schema('raglab')
      .from('experiments').insert(experiment(slug())).select('id').single()

    // One 1536-dimension vector serialises to well over the 256 KB cap once a
    // realistic run's worth is attached; this is the trigger's whole purpose.
    const fat = [{
      ...results[0],
      vectors: Array.from({ length: 20 }, () =>
        Array.from({ length: 1536 }, (_, i) => (i % 997) / 1000 + 0.000123)),
    }]
    const { error } = await db.schema('raglab')
      .from('runs').insert({ experiment_id: created!.id, results: fat })
    expect(error).not.toBeNull()
    expect(error?.message ?? '').toMatch(/cap|byte|IndexedDB/i)
  })

  it('has no vector column anywhere in the schema', async () => {
    // If a later change adds one, this fails before it can consume the budget.
    const { db } = await anonUser()
    const { data: created } = await db.schema('raglab')
      .from('experiments').insert(experiment(slug())).select('*').single()
    const columns = Object.keys(created ?? {})
    expect(columns.some((c) => /embed|vector|halfvec/i.test(c))).toBe(false)
  })

  it('cascades runs away with their experiment', async () => {
    const { db } = await anonUser()
    const { data: created } = await db.schema('raglab')
      .from('experiments').insert(experiment(slug())).select('id').single()
    await db.schema('raglab').from('runs').insert({ experiment_id: created!.id, results })

    await db.schema('raglab').from('experiments').delete().eq('id', created!.id)
    const { data: orphans } = await db.schema('raglab')
      .from('runs').select('id').eq('experiment_id', created!.id)
    expect(orphans ?? []).toEqual([])
  })
})
