/**
 * The PAT pool, end to end through the plugin: the adapter must move to
 * another seat when one seat is refused, and must NOT move when the refusal
 * was about the request rather than the seat.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as plugin from '../lib/index.js'

/** A credential that already looks like a Cloud-IDE JWT, so no exchange happens. */
function jwtFor(name) {
  const payload = Buffer.from(JSON.stringify({ exp: 4102444800, data: { email: `${name}@example.com` } })).toString('base64url')
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`
}

const SECRETS = {
  TRAE_PAT: jwtFor('seat-a'),
  TRAE_PAT_B: jwtFor('seat-b'),
  TRAE_PAT_C: jwtFor('seat-c'),
}

/**
 * The plugin, with two seats and a fake upstream that refuses the seat named
 * by `refuse`. The upstream answers on every other seat.
 */
function setup({ refuse = 'TRAE_PAT', status = 402, detail = 'insufficient quota for this seat', config = {} } = {}) {
  const adapters = {}
  const ctx = {
    logger: { info() {}, warn() {} },
    effect() {},
    on() {},
    get: (name) => (name === 'credentials' ? { resolve: async (ref) => ({ value: SECRETS[ref] }) } : undefined),
    inject: (deps, cb) => {
      if (deps.includes('connection')) cb({ connection: { fetch: { register() {} } } })
    },
    fiber: { entry: { options: { id: 'trae-pat-pool' } } },
    llm: { registerAdapter: (routes, adapter) => { for (const key of routes) adapters[key] = adapter }, registerConfigurableProviders() {} },
  }
  plugin.apply(ctx, plugin.Config({ catalogSource: 'builtin', suggestions: false, ...config }))
  const seen = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const authorization = String(init?.headers?.authorization ?? init?.headers?.Authorization ?? '')
    const seat = Object.keys(SECRETS).find((ref) => authorization.includes(SECRETS[ref])) ?? 'unknown'
    seen.push({ url: String(url), seat })
    if (String(url).endsWith('/llm_raw_chat')) {
      if (seat === refuse) return new Response(detail, { status })
      return new Response(`event: output\ndata: ${JSON.stringify({ response: 'Done.' })}\n\nevent: done\ndata: ${JSON.stringify({ finish_reason: 'stop' })}\n\n`, { status: 200 })
    }
    return Response.json({ code: 0 })
  }
  return { adapters, seen, restore: () => { globalThis.fetch = original } }
}

async function turn(adapters) {
  const out = []
  for await (const chunk of adapters.trae.stream({
    model: 'GLM-5.3', sessionId: 's1', tools: [{ name: 'bash', description: '', parameters: {} }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  })) out.push(chunk)
  return out
}

test('pool: a seat that is out of quota hands the turn to the next seat', async () => {
  const home = mkdtempSync(join(tmpdir(), 'trae-home-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const { adapters, seen, restore } = setup({ config: { seats: [
    { name: 'A', pat: 'TRAE_PAT', email: '', password: '' },
    { name: 'B', pat: 'TRAE_PAT_B', email: '', password: '' },
  ] } })
  try {
    const chunks = await turn(adapters)
    const chats = seen.filter((s) => s.url.endsWith('/llm_raw_chat'))
    // Two requests: the refused seat, then the next one.
    assert.equal(chats.length, 2)
    assert.equal(chats[0].seat, 'TRAE_PAT')
    assert.equal(chats[1].seat, 'TRAE_PAT_B')
    // And the turn still answered.
    const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
    assert.equal(text, 'Done.')
  } finally {
    restore()
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('pool: without a roster the refusal reaches the caller', async () => {
  const home = mkdtempSync(join(tmpdir(), 'trae-home-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const { adapters, seen, restore } = setup({})
  try {
    await assert.rejects(() => turn(adapters), (error) => {
      assert.equal(error.code, 'QUOTA')
      return true
    })
    // One request only: there was nowhere else to go.
    assert.equal(seen.filter((s) => s.url.endsWith('/llm_raw_chat')).length, 1)
  } finally {
    restore()
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('pool: a refusal that is about the request does not move the seat', async () => {
  const home = mkdtempSync(join(tmpdir(), 'trae-home-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  // 4023: the upstream does not know this model. Another seat would answer
  // exactly the same, so the pool must not spend a request on it.
  const { adapters, seen, restore } = setup({ status: 400, detail: 'the model is unknown' })
  try {
    await assert.rejects(() => turn(adapters))
    assert.equal(seen.filter((s) => s.url.endsWith('/llm_raw_chat')).length, 1)
  } finally {
    restore()
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})
