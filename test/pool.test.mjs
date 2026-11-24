/**
 * The PAT pool: which seats exist, when one is let out, and how a failed
 * request moves to the next seat.
 *
 * These are the rules that decide whether a second PAT is ever used, so they
 * are pinned here rather than left to the upstream behaviour.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  TraePatPool, exclusionOf, mergeProbe, outcomeOfCode, outcomeOfExchangeError, retryDue,
  readProbes, writeProbes, isMemberRef, FAILOVER_CODES, FALLBACK_COOLDOWN_MS, MEMBER_REF_RE,
} from '../lib/testing.mjs'

/**
 * A credential that already looks like a Cloud-IDE JWT, so the pool never
 * exchanges it and no test touches the network. The payload carries the seat's
 * name, which is how a test tells the members apart.
 */
function jwtFor(name) {
  const payload = Buffer.from(JSON.stringify({ exp: 4102444800, data: { email: `${name}@example.com` } })).toString('base64url')
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`
}

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'trae-pool-'))
  return join(dir, '.trae-pat-pool.json')
}

/** A pool over the given seats, with no network and a scratch store file. */
function poolOver(refs, { mode = 'failover', store, maxAttempts = 3 } = {}) {
  return new TraePatPool({
    host: 'https://api.enterprise.trae.cn',
    clientId: 'app_test',
    userAgent: 'test',
    seats: () => refs.map(ref => ({ name: ref, pat: ref, email: '', password: '' })),
    mode: () => mode,
    readSecret: async (ref) => jwtFor(ref),
    singleRef: () => refs[0] ?? '',
    maxAttempts: () => maxAttempts,
    logger: { info() {}, warn() {} },
    storeFile: store ?? tempStore(),
  })
}

test('pool: a roster of one is not a pool', async () => {
  const store = tempStore()
  const pool = poolOver(['TRAE_PAT'], { store })
  // Nowhere else to go: the plugin must behave exactly as it did before the
  // pool existed, so nothing about the request changes.
  assert.equal(pool.active(), false)
  const pick = await pool.prepare([])
  assert.equal(pick.memberId, '')
  assert.match(pick.session.token, /^eyJ/)
  // A failure has nowhere to move to, so the caller keeps the original error.
  assert.equal(await pool.stepAside('TRAE_PAT', 'QUOTA', 'no quota', []), undefined)
  // And it leaves no measurement behind: one PAT is not a pool.
  await pool.get()
  assert.deepEqual(await readProbes(store), {})
})

test('pool: the roster drops unusable names and repeats', () => {
  const pool = poolOver(['TRAE_PAT', 'TRAE_PAT', 'bad name', '', 'TRAE_PAT_2'])
  assert.deepEqual(pool.refs(), ['TRAE_PAT', 'TRAE_PAT_2'])
  assert.equal(pool.active(), true)
  assert.equal(isMemberRef('TRAE_PAT_2'), true)
  assert.equal(isMemberRef('bad name'), false)
  assert.equal(MEMBER_REF_RE.test('TRAE_PAT'), true)
})

test('pool: failover keeps the primary until it is refused', async () => {
  const pool = poolOver(['TRAE_PAT_A', 'TRAE_PAT_B'])
  const first = await pool.prepare([])
  assert.equal(first.memberId, 'TRAE_PAT_A')
  // Same seat again on the next request: the upstream conversation, and the
  // shared prefix cache with it, stay put.
  const second = await pool.prepare([])
  assert.equal(second.memberId, 'TRAE_PAT_A')

  // A seat-scoped refusal moves to the next seat.
  const tried = []
  const next = await pool.stepAside('TRAE_PAT_A', 'QUOTA', 'quota exceeded', tried)
  assert.equal(next.memberId, 'TRAE_PAT_B')
  assert.deepEqual(tried, ['TRAE_PAT_A'])
  // When that seat fails too, there is nobody left to move to.
  assert.equal(await pool.stepAside('TRAE_PAT_B', 'QUOTA', 'quota exceeded', tried), undefined)
  assert.deepEqual(tried, ['TRAE_PAT_A', 'TRAE_PAT_B'])
})

test('pool: a refusal that is not about the seat does not move it', async () => {
  const pool = poolOver(['TRAE_PAT_A', 'TRAE_PAT_B'])
  // The request was wrong, not the seat: replaying it elsewhere would burn
  // the same error twice and teach the pool a false fact.
  assert.equal(await pool.stepAside('TRAE_PAT_A', 'MODEL_NOT_FOUND', '4023', []), undefined)
  assert.equal(await pool.stepAside('TRAE_PAT_A', 'CONTEXT_WINDOW_EXCEEDED', 'too long', []), undefined)
  // A transport fault is nobody's fault.
  assert.equal(await pool.stepAside('TRAE_PAT_A', 'TRANSPORT', 'connection reset', []), undefined)
  // These two are about the seat.
  assert.equal(FAILOVER_CODES.has('AUTH'), true)
  assert.equal(FAILOVER_CODES.has('RATE_LIMIT'), true)
  assert.equal(FAILOVER_CODES.has('QUOTA'), true)
  assert.equal(FAILOVER_CODES.has('SERVER'), true)
})

test('pool: one request walks the seats, then gives up', async () => {
  const pool = poolOver(['TRAE_PAT_A', 'TRAE_PAT_B', 'TRAE_PAT_C'], { maxAttempts: 2 })
  const tried = []
  const first = await pool.stepAside('TRAE_PAT_A', 'QUOTA', 'quota exceeded', tried)
  assert.equal(first.memberId, 'TRAE_PAT_B')
  // The third seat exists, but this request may only try two.
  assert.equal(await pool.stepAside('TRAE_PAT_B', 'QUOTA', 'quota exceeded', tried), undefined)
})

test('pool: rotate starts every request on the next seat', async () => {
  const pool = poolOver(['TRAE_PAT_A', 'TRAE_PAT_B', 'TRAE_PAT_C'], { mode: 'rotate' })
  assert.equal((await pool.prepare([])).memberId, 'TRAE_PAT_A')
  assert.equal((await pool.prepare([])).memberId, 'TRAE_PAT_B')
  assert.equal((await pool.prepare([])).memberId, 'TRAE_PAT_C')
  // And round it back.
  assert.equal((await pool.prepare([])).memberId, 'TRAE_PAT_A')
})

test('pool: a seat that failed stays out until its cooldown is over', async () => {
  const store = tempStore()
  const pool = poolOver(['TRAE_PAT_A', 'TRAE_PAT_B'], { store })
  const tried = []
  await pool.stepAside('TRAE_PAT_A', 'RATE_LIMIT', 'slow down', tried)

  // The next request does not start on the seat that was just throttled.
  const next = await pool.prepare([])
  assert.equal(next.memberId, 'TRAE_PAT_B')

  // The measurement is on disk, and it names no credential.
  const stored = JSON.parse(readFileSync(store, 'utf8'))
  assert.equal(stored.version, 1)
  assert.equal(stored.probes.TRAE_PAT_A.outcome, 'rate-limited')
  assert.equal(typeof stored.probes.TRAE_PAT_A.atMs, 'number')
  assert.equal(JSON.stringify(stored).includes('eyJ'), false)
})

test('pool: a refused PAT stays out until it is edited', async () => {
  const store = tempStore()
  const pool = poolOver(['TRAE_PAT_A', 'TRAE_PAT_B'], { store })
  const tried = []
  await pool.stepAside('TRAE_PAT_A', 'AUTH', 'bad pat', tried)

  // Editing that PAT clears the measurement: the old one was about a secret
  // that no longer exists, and keeping it would keep a fixed PAT out.
  await pool.resetMember('TRAE_PAT_A')
  const probes = await readProbes(store)
  assert.equal(probes.TRAE_PAT_A, undefined)

  const next = await pool.prepare([])
  assert.equal(next.memberId, 'TRAE_PAT_A')
})

test('pool: measurements survive a broken file', async () => {
  const store = tempStore()
  writeFileSync(store, 'not json at all')
  assert.deepEqual(await readProbes(store), {})
  writeFileSync(store, JSON.stringify({ version: 1, probes: { 'TRAE_PAT_A': { outcome: 'ok', atMs: 1 } } }))
  const probes = await readProbes(store)
  assert.equal(probes.TRAE_PAT_A.outcome, 'ok')
})

test('pool: a new measurement inherits the reset point the old one resolved', () => {
  const existing = { outcome: 'rate-limited', atMs: 1000, retryAtMs: 2000, message: 'slow down' }
  // A live failure that states no reset time must not delete the reset point
  // an earlier measurement had resolved, or the seat comes back too early.
  const merged = mergeProbe(existing, { outcome: 'unavailable', atMs: 1500 })
  assert.equal(merged.retryAtMs, 2000)
  assert.equal(merged.message, 'slow down')
  // A measurement that states its own reset time wins.
  const stated = mergeProbe(existing, { outcome: 'unavailable', atMs: 1500, retryAtMs: 9000 })
  assert.equal(stated.retryAtMs, 9000)
  // A measurement with nothing to inherit is just itself.
  assert.equal(mergeProbe(undefined, { outcome: 'ok', atMs: 5 }).atMs, 5)
})

test('pool: the exclusion rules', () => {
  const now = 1_000_000
  assert.equal(exclusionOf(undefined, now), undefined)
  assert.equal(exclusionOf({ outcome: 'ok', atMs: now }, now), undefined)
  // A refused PAT is permanent.
  assert.equal(exclusionOf({ outcome: 'credential-rejected', atMs: now }, now), 'credential-rejected')
  // A cooldown is measured from the reset point, or from the fallback window.
  assert.equal(exclusionOf({ outcome: 'rate-limited', atMs: now }, now), 'rate-limited')
  assert.equal(exclusionOf({ outcome: 'rate-limited', atMs: now, retryAtMs: now - 1 }, now), undefined)
  assert.equal(retryDue({ outcome: 'rate-limited', atMs: now }, now), false)
  assert.equal(retryDue({ outcome: 'rate-limited', atMs: now - FALLBACK_COOLDOWN_MS - 1 }, now), true)
})

test('pool: a failure code says what it leaves behind', () => {
  assert.equal(outcomeOfCode('AUTH'), 'credential-rejected')
  assert.equal(outcomeOfCode('RATE_LIMIT'), 'rate-limited')
  assert.equal(outcomeOfCode('QUOTA'), 'out-of-credit')
  assert.equal(outcomeOfCode('SERVER'), 'unavailable')
  assert.equal(outcomeOfCode('MODEL_NOT_FOUND'), 'unusable')
  // A transport fault during the exchange is not the PAT's fault.
  assert.equal(outcomeOfExchangeError('TRANSPORT'), 'unavailable')
  assert.equal(outcomeOfExchangeError('AUTH'), 'credential-rejected')
})

test('pool: the store merges, it never replaces', async () => {
  const store = tempStore()
  await writeProbes(store, { TRAE_PAT_A: { outcome: 'rate-limited', atMs: 1000, retryAtMs: 5000, message: 'slow down' } })
  // A later measurement for another seat must not erase the first one.
  await writeProbes(store, { TRAE_PAT_B: { outcome: 'ok', atMs: 2000 } })
  const probes = await readProbes(store)
  assert.equal(probes.TRAE_PAT_A.outcome, 'rate-limited')
  assert.equal(probes.TRAE_PAT_B.outcome, 'ok')
  // A measurement with no reset time of its own keeps the resolved one.
  await writeProbes(store, { TRAE_PAT_A: { outcome: 'unavailable', atMs: 3000 } })
  const after = await readProbes(store)
  assert.equal(after.TRAE_PAT_A.retryAtMs, 5000)
})

test('pool: a seat whose PAT cannot be exchanged is skipped, not fatal', async () => {
  const pool = new TraePatPool({
    host: 'https://api.enterprise.trae.cn',
    clientId: 'app_test',
    userAgent: 'test',
    seats: () => [
      { name: 'bad', pat: 'TRAE_PAT_BAD', email: '', password: '' },
      { name: 'good', pat: 'TRAE_PAT_GOOD', email: '', password: '' },
    ],
    mode: () => 'failover',
    // The first seat has no credential at all: the exchange cannot even be
    // attempted, and the pool must still find the second one.
    readSecret: async (ref) => (ref === 'TRAE_PAT_BAD' ? undefined : jwtFor(ref)),
    singleRef: () => 'TRAE_PAT_BAD',
    maxAttempts: () => 3,
    logger: { info() {}, warn() {} },
    storeFile: tempStore(),
  })
  const pick = await pool.prepare([])
  assert.equal(pick.memberId, 'TRAE_PAT_GOOD')
})
