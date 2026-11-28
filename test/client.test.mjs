// The browser half against a stub host: loads lib/client.js the way the
// module loader does and checks every slot registration the way the real
// slot registry (dsh-client-ui-slots) validates it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/** Slot kinds as the host declares them (dsh-client-ui-conversation / settings). */
const LIST_SLOTS = new Set(['conversation.input.right', 'conversation.input.dock', 'conversation.composer.dock', 'conversation.chat.turnTail', 'deliverables.file.actions', 'settings.section', 'settings.section.icon'])
const KEYED_SLOTS = new Set(['plugins.bundle.config', 'settings.models.provider-card'])

function loadClient(react = { createElement: () => null }, forms = []) {
  let module
  globalThis.window = { __ModuleLoader__: { load: (m) => { module = m } } }
  globalThis.document = { head: { appendChild() {} }, createElement: () => ({ dataset: {}, remove() {} }) }
  new Function(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'))()
  const stubs = {
    react,
    '@deepseek-ai/dsh-client-ui-primitives': {
      SettingsFormModel: class {
        constructor(...args) { forms.push(args) }
        bind(project) { return { getSnapshot: project, subscribe: () => () => {}, set() {} } }
        actions() { return {} }
        shell() { return {} }
        field() { return { text: '' } }
        dispose() {}
      },
    },
    'react-dom': { createPortal: () => null },
  }
  return module.factory((name) => stubs[name] ?? {})
}

/**
 * A stub host context carrying the services this client injects. `inject`
 * hands back the context itself, so a nested injection — the sidebar tab
 * inside the model-directory scope — reaches the same recorders.
 */
function hostCtx({ register = () => {}, locale = () => {}, configScope } = {}) {
  const cleanups = []
  const remoteEvents = new Map()
  const registered = []
  // A registration the client disposed again, so a test can see the View tab
  // leave the row as well as arrive.
  const live = new Set()
  let dictionaries
  const slots = {
    inject: (_name, fn) => {
      const dispose = fn()
      return () => { if (typeof dispose === 'function') dispose() }
    },
    register: (options, component) => {
      registered.push(options)
      live.add(options)
      register(options, component)
      return () => { live.delete(options) }
    },
  }
  const ctx = {
    slots,
    locale: {
      register: (_ns, dicts) => { dictionaries = dicts; locale(dicts); return () => {} },
      bind: () => key => dictionaries?.zh?.[key] ?? key,
    },
    remote: { $on: (name, fn) => { remoteEvents.set(name, fn); return () => remoteEvents.delete(name) }, credentials: { describe: async () => ({ ok: false }) } },
    configForms: {
      get: () => configScope ?? { getSnapshot: () => ({}), subscribe: () => () => {} },
      whileServed: (_ns, fn) => fn(),
    },
    effect: (fn) => { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup) },
    modelDirectories: {},
    inject: (_deps, cb) => { cb(ctx) },
  }
  return {
    emit: (name, value) => remoteEvents.get(name)?.(value),
    dispose: () => { for (const cleanup of cleanups.reverse()) cleanup() },
    ctx,
    registered,
    /** Entries the client has registered and not disposed. */
    liveIds: name => [...live].filter(options => options.name === name).map(options => options.id),
    entry: (name, id) => registered.find(options => options.name === name && (id === undefined || options.id === id)),
  }
}

test('client: every slot registration passes the host registry rules', () => {
  const plugin = loadClient()
  const { ctx, registered, liveIds, entry } = hostCtx({
    register: (options) => {
      if (LIST_SLOTS.has(options.name) && !options.id) throw new Error(`list slot "${options.name}" requires options.id`)
      if (KEYED_SLOTS.has(options.name) && !options.key) throw new Error(`keyed slot "${options.name}" requires options.key`)
    },
  })
  plugin.apply(ctx)
  const byName = Object.fromEntries(registered.map(r => [r.name, r]))
  const ids = name => registered.filter(r => r.name === name).map(r => r.id)
  assert.equal(byName['conversation.input.dock'].id, 'trae-choices')
  // Share buttons ride the host's own file cards: one entry after the turn's
  // cards, one in the delivered-file card's action slot.
  assert.equal(byName['conversation.chat.turnTail'].id, 'trae-file-share')
  assert.equal(byName['deliverables.file.actions'].id, 'trae-file-share')
  assert.equal(byName['conversation.input.overlay'], undefined, 'no Tab ghost text any more')
  // The Trae page is a top-level row of the settings shell, beside WorkBuddy's.
  assert.equal(byName['settings.section'].id, 'dsh-trae-pat-pool')
  assert.equal(byName['settings.section.icon'].id, 'dsh-trae-pat-pool')
  assert.equal(byName['settings.section'].label(), 'Trae')
  // Three entries beside the model picker: the quota chip, the "switching
  // reopens the upstream conversation" notice, and the invisible watcher that
  // reports which sessions are on screen.
  assert.deepEqual(ids('conversation.input.right'), ['trae-quota', 'trae-session-watch', 'trae-switch'])
  // The session ids are a tab of their own, not a composer reading.
  assert.equal(byName['conversation.composer.dock'], undefined)
  // One Trae View tab holding both the session ids and the share links, and
  // it is not on the row until a session on screen says it is on Trae — the
  // share links included, they are Trae-only too.
  assert.deepEqual(liveIds('conversation.view'), [])
  assert.equal(entry('conversation.view', 'trae-share'), undefined, 'no separate share tab')
  const watch = entry('conversation.input.right', 'trae-session-watch').inject('s1')
  watch.watch(true)
  assert.deepEqual(liveIds('conversation.view'), ['trae-session'])
  const tab = entry('conversation.view', 'trae-session')
  // After the shipped views, with a label that follows the active locale.
  assert.equal(tab.order, 100)
  assert.equal(tab.label(), 'Trae')
  // A second Trae session does not register it twice, and the tab stays while
  // either of them is still on screen.
  entry('conversation.input.right', 'trae-session-watch').inject('s2').watch(true)
  assert.deepEqual(liveIds('conversation.view'), ['trae-session'])
  watch.unwatch()
  assert.deepEqual(liveIds('conversation.view'), ['trae-session'])
  // Switching the last one to another provider takes the tab off the row.
  entry('conversation.input.right', 'trae-session-watch').inject('s2').watch(false)
  assert.deepEqual(liveIds('conversation.view'), [])
  // Nothing in the right sidebar or the session header any more.
  assert.equal(byName['sidebar.right.pane.tab'], undefined)
  assert.equal(byName['conversation.session.header.utilities'], undefined)
  assert.ok(byName['plugins.bundle.config'] && byName['settings.models.provider-card'])
})

/**
 * The seat fields are controlled inputs, and the page used to write through
 * to the host on every keystroke: a config write, a credential write, a config
 * reload and a re-render per character, which is what made the page feel
 * stuck. A keystroke must now only touch the local draft.
 */
test('client: a seat field stages locally and is written once, not per keystroke', async () => {
  const writes = []
  const listeners = []
  const scope = {
    value: {
      seats: [{ name: '', pat: 'TRAE_PAT', email: 'TRAE_CONSOLE_EMAIL', password: 'TRAE_CONSOLE_PASSWORD' }],
      patPoolMode: 'failover',
      patPoolMaxAttempts: 3,
    },
    getSnapshot: () => ({ value: scope.value, writable: true, status: 'ready' }),
    subscribe: (fn) => { listeners.push(fn); return () => {} },
    set: async (field, value) => {
      writes.push({ field, value })
      scope.value = { ...scope.value, [field]: value }
      for (const fn of listeners) fn()
      return true
    },
  }
  const plugin = loadClient()
  const { ctx, entry } = hostCtx({ configScope: scope })
  plugin.apply(ctx)
  const page = entry('settings.section', 'dsh-trae-pat-pool')
  assert.ok(page, 'the Trae page is registered')
  const props = page.inject()
  const seat = { name: '', pat: 'TRAE_PAT', email: 'TRAE_CONSOLE_EMAIL', password: 'TRAE_CONSOLE_PASSWORD' }

  // A keystroke: staged locally, and NOTHING reaches the host.
  props.onStage(seat, 'name', '席')
  assert.equal(props.staged(seat, 'name'), '席')
  props.onStage(seat, 'name', '席位 A')
  assert.equal(props.staged(seat, 'name'), '席位 A')
  assert.deepEqual(writes, [], 'a keystroke must not write to the host')

  // The pause commits it: ONE write, carrying the whole name.
  await new Promise(resolve => setTimeout(resolve, 700))
  assert.equal(writes.length, 1)
  assert.equal(writes[0].field, 'seats')
  assert.equal(writes[0].value[0].name, '席位 A')
  // And the draft is gone: the saved name now answers for it.
  assert.equal(props.staged(seat, 'name'), undefined)
})

const flushAsync = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const SEAT_A = { name: 'Alpha', pat: 'PAT_A', email: 'EMAIL_A', password: 'PASSWORD_A' }
const SEAT_B = { name: 'Beta', pat: 'PAT_B', email: 'EMAIL_B', password: 'PASSWORD_B' }
const poolRow = (seat, extra = {}) => ({ seatId: seat.pat, name: seat.name, priority: 1, configured: true, writable: true, credentialVersion: 'credential-v1', validation: 'valid', identity: 'actual@example.com', ...extra })
const poolValue = (rows = [poolRow(SEAT_A)]) => ({ mode: 'failover', attempts: 3, summary: { total: rows.length, configured: rows.length, usable: rows.length, attention: 0, pending: 0 }, seats: rows, latestRequest: null })
function browserHarness({ setSecret = async () => ({ ok: true }), describe, fetcher, seats = [SEAT_A, SEAT_B], reactOverride } = {}) {
  const writes = []
  const listeners = new Set()
  const scope = {
    value: { seats, patPoolMode: 'failover', patPoolMaxAttempts: 3 },
    getSnapshot: () => ({ value: scope.value, writable: true, status: 'ready' }),
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn) },
    set: async (field, value) => { scope.value = { ...scope.value, [field]: value }; for (const fn of listeners) fn(); return true },
  }
  const react = reactOverride ?? { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }), useEffect() {}, useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}], useRef: value => ({ current: value }) }
  const components = new Map()
  let dictionaries
  const plugin = loadClient(react)
  const host = hostCtx({ configScope: scope, locale: value => { dictionaries = value }, register: (options, component) => { if (options.name !== 'settings.section.icon') components.set(options.id ?? options.name, component) } })
  host.ctx.remote.credentials = {
    describe: describe ?? (async refs => ({ ok: true, value: Object.fromEntries(refs.map(ref => [ref, { configured: true, writable: true }])) })),
    set: async (ref, value) => { writes.push({ ref, value }); return setSecret(ref, value) },
  }
  const originalFetch = globalThis.fetch
  const asked = []
  globalThis.fetch = async (url, init) => {
    asked.push([String(url), init])
    return fetcher ? fetcher(String(url), init) : Response.json({ ok: true, value: String(url).includes('/validate') ? poolRow(SEAT_A) : poolValue() })
  }
  plugin.apply(host.ctx)
  return { ...host, scope, writes, asked, components, dictionaries, props: host.entry('settings.section').inject(), restore: () => { host.dispose(); globalThis.fetch = originalFetch } }
}

test('pool: PAT and console drafts never auto-save or flush on add/reorder/remove', async () => {
  const h = browserHarness()
  try {
    h.props.onStage(SEAT_A, 'pat', 'draft-pat')
    h.props.onStage(SEAT_A, 'email', 'draft@example.com')
    h.props.onStage(SEAT_A, 'password', 'draft-password')
    await new Promise(resolve => setTimeout(resolve, 650))
    assert.equal(h.writes.length, 0, 'secret typing and the debounce interval must not write credentials')
    await h.props.addSeat()
    await h.props.moveSeat(0, 1)
    await h.props.removeSeat(2)
    assert.equal(h.writes.length, 0, 'structural changes must not submit secret drafts')
    assert.equal(h.props.staged(SEAT_A, 'pat'), 'draft-pat')
  } finally { h.restore() }
})

test('pool: write failure retains draft and explicit retry saves then validates', async () => {
  let reject = true
  const h = browserHarness({ setSecret: async () => ({ ok: !reject }) })
  try {
    h.props.onStage(SEAT_A, 'pat', 'first-draft')
    await h.props.onSave(SEAT_A, 'pat')
    assert.equal(h.props.staged(SEAT_A, 'pat'), 'first-draft')
    assert.equal(h.props.fieldState(SEAT_A, 'pat').phase, 'error')
    reject = false
    await h.props.onSave(SEAT_A, 'pat')
    assert.equal(h.props.staged(SEAT_A, 'pat'), undefined)
    assert.equal(h.props.fieldState(SEAT_A, 'pat').phase, 'saved')
    assert.equal(h.writes.length, 2)
    const validation = h.asked.find(([url]) => url.endsWith('/pool/validate'))
    assert.deepEqual(JSON.parse(validation[1].body), { seatId: 'PAT_A' })
    assert.equal(validation[1].body.includes('first-draft'), false)
  } finally { h.restore() }
})

test('pool: stale save never clears a newer draft or validates it', async () => {
  const old = deferred()
  const h = browserHarness({ setSecret: () => old.promise })
  try {
    h.props.onStage(SEAT_A, 'pat', 'old-input')
    const pending = h.props.onSave(SEAT_A, 'pat')
    await flushAsync()
    h.props.onStage(SEAT_A, 'pat', 'new-input')
    old.resolve({ ok: true })
    await pending
    assert.equal(h.props.staged(SEAT_A, 'pat'), 'new-input')
    assert.equal(h.props.fieldState(SEAT_A, 'pat').phase, 'dirty')
    assert.equal(h.asked.filter(([url]) => url.endsWith('/validate')).length, 0)
  } finally { h.restore() }
})

test('pool: removed seat ignores late save and clears only that seat drafts', async () => {
  const old = deferred()
  const h = browserHarness({ setSecret: () => old.promise })
  try {
    h.props.onStage(SEAT_A, 'pat', 'old-input')
    h.props.onStage(SEAT_B, 'password', 'keep-me')
    const pending = h.props.onSave(SEAT_A, 'pat')
    await h.props.removeSeat(0)
    old.resolve({ ok: true })
    await pending
    assert.equal(h.props.staged(SEAT_A, 'pat'), undefined)
    assert.equal(h.props.staged(SEAT_B, 'password'), 'keep-me')
    assert.equal(h.asked.filter(([url]) => url.endsWith('/validate')).length, 0)
  } finally { h.restore() }
})

test('pool: confirmed write with unknown metadata retries describe without repeating secret write', async () => {
  let fail = false
  const h = browserHarness({ describe: async refs => fail ? { ok: false } : { ok: true, value: Object.fromEntries(refs.map(ref => [ref, { configured: true, writable: true }])) } })
  try {
    await flushAsync()
    fail = true
    h.props.onStage(SEAT_A, 'pat', 'submitted')
    await h.props.onSave(SEAT_A, 'pat')
    assert.equal(h.props.staged(SEAT_A, 'pat'), undefined)
    assert.equal(h.props.fieldState(SEAT_A, 'pat').phase, 'confirmedUnknown')
    fail = false
    await h.props.onSave(SEAT_A, 'pat')
    assert.equal(h.writes.length, 1)
    assert.equal(h.props.fieldState(SEAT_A, 'pat').phase, 'saved')
  } finally { h.restore() }
})

test('pool: validation rejection preserves configured saved credential and cancel never writes', async () => {
  const h = browserHarness({ fetcher: async url => Response.json({ ok: true, value: url.endsWith('/validate') ? poolRow(SEAT_A, { validation: 'invalid', reasonCode: 'auth_rejected' }) : poolValue([poolRow(SEAT_A, { validation: 'invalid' })]) }) })
  try {
    h.props.onStage(SEAT_A, 'pat', 'submitted')
    await h.props.onSave(SEAT_A, 'pat')
    assert.equal(h.props.fieldState(SEAT_A, 'pat').phase, 'saved')
    assert.equal(h.props.hooks.traePool.getSnapshot().status.value.seats[0].configured, true)
    assert.equal(h.props.hooks.traePool.getSnapshot().status.value.seats[0].validation, 'invalid')
    h.props.onStage(SEAT_A, 'pat', 'cancelled')
    h.props.onCancel(SEAT_A, 'pat')
    assert.equal(h.props.staged(SEAT_A, 'pat'), undefined)
    assert.equal(h.writes.length, 1)
  } finally { h.restore() }
})

const usage = (session, seatId = 'PAT_A', phase = 'running') => ({ requestId: `r-${session}`, credentialVersion: 'credential-v1', session, phase, seatId, seatName: seatId === 'PAT_A' ? 'Alpha' : 'Beta', model: 'test-model', startedAt: 1, switches: [] })
const quotaValue = percent => ({ credentialVersion: 'credential-v1', packs: [{ name: 'plan', used: 100 - percent, remaining: percent, limit: 100 }], used: 100 - percent, remaining: percent, limit: 100 })
test('usage: slots bind actual session and shared stores stay isolated', async () => {
  const h = browserHarness({ fetcher: async url => Response.json({ ok: true, value: url.includes('view=usage') ? { request: usage(url.includes('session=one') ? 'one' : 'two', url.includes('session=one') ? 'PAT_A' : 'PAT_B') } : quotaValue(80) }) })
  try {
    const a = h.entry('conversation.input.right', 'trae-quota').inject('one')
    const same = h.entry('conversation.input.right', 'trae-quota').inject('one')
    const b = h.entry('conversation.input.right', 'trae-quota').inject('two')
    assert.equal(a.sessionId, 'one')
    assert.equal(a.hooks.traeUsage, same.hooks.traeUsage)
    assert.notEqual(a.hooks.traeUsage, b.hooks.traeUsage)
    await Promise.all([a.refreshUsage(), b.refreshUsage()])
    assert.equal(a.hooks.traeUsage.getSnapshot().request.seatName, 'Alpha')
    assert.equal(b.hooks.traeUsage.getSnapshot().request.seatName, 'Beta')
    assert.ok(h.asked.some(([url]) => url.includes('quota?seat=PAT_A')))
    assert.ok(h.asked.every(([url]) => !url.includes('scope=primary')))
  } finally { h.restore() }
})

test('usage: account switch clears quota immediately and late quota cannot restore old seat', async () => {
  const oldQuota = deferred()
  let selected = 'PAT_A'
  const h = browserHarness({ fetcher: async url => url.includes('view=usage') ? Response.json({ ok: true, value: { request: usage('one', selected) } }) : url.includes('seat=PAT_A') ? oldQuota.promise : Response.json({ ok: true, value: quotaValue(20) }) })
  try {
    const a = h.entry('conversation.input.right', 'trae-quota').inject('one')
    await a.refreshUsage()
    selected = 'PAT_B'
    const second = a.refreshUsage()
    await flushAsync()
    assert.equal(a.hooks.traeQuota.getSnapshot().seatId, 'PAT_B')
    await second
    oldQuota.resolve(Response.json({ ok: true, value: quotaValue(95) }))
    await flushAsync()
    assert.equal(a.hooks.traeQuota.getSnapshot().seatId, 'PAT_B')
    assert.equal(a.hooks.traeQuota.getSnapshot().value.remaining, 20)
  } finally { h.restore() }
})

function textOf(node) { return node == null || node === false ? '' : typeof node === 'string' || typeof node === 'number' ? String(node) : Array.isArray(node) ? node.map(textOf).join(' ') : textOf(node.children) }
test('usage: no request and completed/failed/cancelled phases read as session history even quota fails', () => {
  const h = browserHarness()
  try {
    const Chip = h.components.get('trae-quota')
    const render = request => textOf(Chip({ t: h.props.t, sessionId: 'one', useTraeModel: select => select({ current: { provider: 'trae' } }), useTraeUsage: select => select({ phase: 'ready', request }), useTraeQuota: select => select({ phase: 'error', value: null }), watchUsage: () => () => {}, refresh: () => {} }))
    assert.match(render(null), /尚未使用账号/)
    for (const phase of ['completed', 'failed', 'cancelled']) {
      assert.match(render(usage('one', 'PAT_A', phase)), /本会话.*上次使用.*Alpha/)
      assert.doesNotMatch(render(usage('one', 'PAT_A', phase)), /使用中/)
    }
    assert.match(render(usage('one')), /本会话.*Alpha.*使用中/)
    assert.match(render(usage('one', null, 'selecting')), /正在选择/)
  } finally { h.restore() }
})

test('usage: a newly captured credential version fetches compatible quota without a credential event', async () => {
  let requestVersion = 'v1'
  let quotaCalls = 0
  const h = browserHarness({ fetcher: async url => {
    if (url.includes('view=usage')) return Response.json({ ok: true, value: { request: { ...usage('one'), credentialVersion: requestVersion } } })
    quotaCalls++
    return Response.json({ ok: true, value: { ...quotaValue(requestVersion === 'v1' ? 80 : 15), credentialVersion: requestVersion } })
  } })
  try {
    const props = h.entry('conversation.input.right', 'trae-quota').inject('one')
    await props.refreshUsage(); await flushAsync()
    assert.equal(props.hooks.traeQuota.getSnapshot().value.remaining, 80)
    requestVersion = 'v2'
    await props.refreshUsage(); await flushAsync()
    assert.equal(quotaCalls, 2, 'newly captured version needs a fresh compatible quota read')
    assert.equal(props.hooks.traeQuota.getSnapshot().value.remaining, 15)
    for (let i = 0; i < 3; i++) { await props.refreshUsage(); await flushAsync() }
    assert.equal(quotaCalls, 2, 'successful quota remains low-frequency cached')
  } finally { h.restore() }
})

test('usage: historical and current request versions do not evict each other or trigger quota polling storms', async () => {
  let quotaCalls = 0
  const h = browserHarness({ fetcher: async url => {
    if (url.includes('view=usage')) { const old = url.includes('session=old'); return Response.json({ ok: true, value: { request: { ...usage(old ? 'old' : 'current'), credentialVersion: old ? 'v1' : 'v2' } } }) }
    quotaCalls++
    return Response.json({ ok: true, value: { ...quotaValue(15), credentialVersion: 'v2' } })
  } })
  try {
    const old = h.entry('conversation.input.right', 'trae-quota').inject('old')
    const current = h.entry('conversation.input.right', 'trae-quota').inject('current')
    for (let i = 0; i < 3; i++) { await old.refreshUsage(); await current.refreshUsage(); await flushAsync() }
    assert.equal(old.hooks.traeQuota.getSnapshot().value, null)
    assert.equal(current.hooks.traeQuota.getSnapshot().value.remaining, 15)
    assert.equal(quotaCalls, 2, 'each expected version has a separate stable cached outcome')
  } finally { h.restore() }
})

test('usage: missing quota version is unavailable and an explicit refresh can recover the same request', async () => {
  let quotaVersion = null
  let quotaCalls = 0
  const h = browserHarness({ fetcher: async url => {
    if (url.includes('view=usage')) return Response.json({ ok: true, value: { request: usage('one') } })
    quotaCalls++
    return Response.json({ ok: true, value: { ...quotaValue(25), credentialVersion: quotaVersion } })
  } })
  try {
    const props = h.entry('conversation.input.right', 'trae-quota').inject('one')
    await props.refreshUsage(); await flushAsync()
    assert.equal(props.hooks.traeQuota.getSnapshot().value, null)
    const tree = h.components.get('trae-quota')({ t: h.props.t, ...props, useTraeModel: select => select({ current: { provider: 'trae' } }), useTraeUsage: select => select(props.hooks.traeUsage.getSnapshot()), useTraeQuota: select => select(props.hooks.traeQuota.getSnapshot()) })
    const retry = nodesOf(tree).find(node => node.type === 'button' && typeof node.props.onClick === 'function')
    assert.ok(retry, 'unknown quota needs an explicit retry control')
    quotaVersion = 'credential-v1'
    await retry.props.onClick(); await flushAsync()
    assert.equal(quotaCalls, 2)
    assert.equal(props.hooks.traeQuota.getSnapshot().value.remaining, 25)
  } finally { h.restore() }
})

test('usage: quota credential version must match the captured request after reload', async () => {
  const h = browserHarness({ fetcher: async url => Response.json({ ok: true, value: url.includes('view=usage') ? { request: usage('one', 'PAT_A', 'completed') } : { ...quotaValue(80), credentialVersion: 'replacement-v2' } }) })
  try {
    const props = h.entry('conversation.input.right', 'trae-quota').inject('one')
    await props.refreshUsage(); await flushAsync()
    assert.equal(props.hooks.traeQuota.getSnapshot().value, null, 'new account quota cannot appear beside old request identity')
    assert.equal(props.hooks.traeQuota.getSnapshot().credentialChanged, true)
    assert.equal(props.hooks.traeUsage.getSnapshot().request.seatName, 'Alpha')
  } finally { h.restore() }
})

test('usage: first read failure is unavailable, while successful null explicitly means no account used', () => {
  const h = browserHarness()
  try {
    const render = phase => textOf(h.components.get('trae-quota')({ t: h.props.t, sessionId: 'one', useTraeModel: select => select({ current: { provider: 'trae' } }), useTraeUsage: select => select({ phase, request: null }), useTraeQuota: select => select({ phase: 'idle', value: null }), watchUsage: () => () => {} }))
    assert.match(render('error'), /状态暂不可用/)
    assert.doesNotMatch(render('error'), /尚未使用账号/)
    assert.match(render('idle'), /正在读取状态/)
    assert.match(render('ready'), /尚未使用账号/)
  } finally { h.restore() }
})

test('request history: current pool identity never rewrites a completed request account', () => {
  const h = browserHarness()
  try {
    const request = usage('one', 'PAT_A', 'completed')
    const replacement = poolValue([poolRow(SEAT_A, { name: 'Replacement Beta', identity: 'beta@example.com' })])
    const state = { seats: [SEAT_A], credentials: {}, status: { phase: 'ready', value: { ...replacement, latestRequest: request } } }
    const chip = textOf(h.components.get('trae-quota')({ t: h.props.t, sessionId: 'one', useTraeModel: select => select({ current: { provider: 'trae' } }), useTraeUsage: select => select({ phase: 'ready', request }), useTraeQuota: select => select({ phase: 'error', value: null }), useTraePool: select => select(state), watchUsage: () => () => {} }))
    assert.match(chip, /Alpha/)
    assert.doesNotMatch(chip, /Replacement Beta|beta@example/)
    const page = h.components.get('dsh-trae-pat-pool')({ ...h.props, useTraePool: select => select(state), useTraeSeatQuota: select => select({ seats: [] }), useTraeCard: select => select({ status: { phase: 'ready', models: [] } }) })
    const history = textOf(nodesOf(page).find(node => node.props.className === 'trae-pool-request'))
    assert.match(history, /Alpha/)
    assert.doesNotMatch(history, /Replacement Beta|beta@example/)
  } finally { h.restore() }
})

test('usage: queued lifecycle wake cannot restart or publish after last mount unmounts', async () => {
  const pending = deferred()
  let usageReads = 0
  const h = browserHarness({ fetcher: async url => {
    if (url.includes('view=usage')) return ++usageReads === 1 ? pending.promise : Response.json({ ok: true, value: { request: usage('one') } })
    return Response.json({ ok: true, value: quotaValue(80) })
  } })
  try {
    const props = h.entry('conversation.input.right', 'trae-quota').inject('one')
    const stop = props.watchUsage()
    const wake = props.onRunning(true)
    stop()
    pending.resolve(Response.json({ ok: true, value: { request: usage('one') } }))
    await wake; await flushAsync()
    assert.equal(usageReads, 1, 'queued wake must not issue another request after final unmount')
    assert.equal(props.hooks.traeUsage.getSnapshot().request, null)
    assert.equal(h.asked.filter(([url]) => url.includes('/quota')).length, 0)
  } finally { pending.resolve(Response.json({ ok: true, value: { request: null } })); h.restore() }
})

test('usage: DSH running start/end wakes idle usage without waiting 30 seconds', async () => {
  let current = null
  const h = browserHarness({ fetcher: async url => Response.json({ ok: true, value: url.includes('view=usage') ? { request: current } : quotaValue(80) }) })
  try {
    const props = h.entry('conversation.input.right', 'trae-quota').inject('one')
    await props.refreshUsage()
    current = usage('one')
    await props.onRunning(true)
    assert.equal(props.hooks.traeUsage.getSnapshot().request.phase, 'running')
    current = usage('one', 'PAT_A', 'completed')
    await props.onRunning(false)
    assert.equal(props.hooks.traeUsage.getSnapshot().request.phase, 'completed')
    assert.equal(h.asked.filter(([url]) => url.includes('view=usage')).length, 3)
  } finally { h.restore() }
})

test('settings quota: saved and external console changes discard old seat quota and refresh the affected seat only', async () => {
  let remaining = 95
  const h = browserHarness({ fetcher: async url => {
    if (url.includes('/quota')) return Response.json({ ok: true, value: url.includes('?seat=') ? { ...quotaValue(remaining), seatId: 'PAT_A', consoleEmail: `source-${remaining}@example.com` } : { seats: [{ ...quotaValue(remaining), seatId: 'PAT_A', consoleEmail: `source-${remaining}@example.com` }] } })
    return Response.json({ ok: true, value: url.endsWith('/validate') ? poolRow(SEAT_A) : poolValue() })
  } })
  try {
    const stop = h.props.mountPool()
    h.props.loadSeatQuota(false)
    await flushAsync()
    assert.equal(h.props.hooks.traeSeatQuota.getSnapshot().seats[0].remaining, 95)
    remaining = 15
    h.props.onStage(SEAT_A, 'password', 'new-console')
    await h.props.onSave(SEAT_A, 'password'); await flushAsync()
    assert.equal(h.props.hooks.traeSeatQuota.getSnapshot().seats[0].remaining, 15)
    remaining = 35
    h.emit('credentials/reference-updated', SEAT_A.email)
    await flushAsync()
    assert.equal(h.props.hooks.traeSeatQuota.getSnapshot().seats[0].remaining, 35)
    assert.equal(h.props.hooks.traeSeatQuota.getSnapshot().seats[0].consoleEmail, 'source-35@example.com')
    assert.equal(h.asked.filter(([url]) => url.endsWith('/quota')).length, 1, 'mutations must refresh just the affected seat')
    stop()
  } finally { h.restore() }
})

test('usage: plugin disposal aborts quota fetch and discards late snapshots', async () => {
  const pending = deferred()
  let signal
  const h = browserHarness({ fetcher: async (url, init) => {
    if (url.includes('view=usage')) return Response.json({ ok: true, value: { request: usage('one') } })
    signal = init.signal
    return pending.promise
  } })
  try {
    const props = h.entry('conversation.input.right', 'trae-quota').inject('one')
    await props.refreshUsage()
    h.dispose()
    assert.equal(signal?.aborted, true)
    pending.resolve(Response.json({ ok: true, value: quotaValue(99) }))
    await flushAsync()
    assert.equal(props.hooks.traeQuota.getSnapshot().value, null)
  } finally { pending.resolve(Response.json({ ok: true, value: quotaValue(99) })); h.restore() }
})

test('usage: replacing PAT under the same reference invalidates old quota and ignores its late response', async () => {
  const oldQuota = deferred()
  let calls = 0
  const h = browserHarness({ fetcher: async url => {
    if (url.includes('view=usage')) return Response.json({ ok: true, value: { request: usage('one') } })
    if (url.includes('/quota')) return ++calls === 1 ? oldQuota.promise : Response.json({ ok: true, value: quotaValue(15) })
    return Response.json({ ok: true, value: url.endsWith('/validate') ? poolRow(SEAT_A) : poolValue() })
  } })
  try {
    const a = h.entry('conversation.input.right', 'trae-quota').inject('one')
    await a.refreshUsage()
    h.props.onStage(SEAT_A, 'pat', 'replacement-account')
    await h.props.onSave(SEAT_A, 'pat')
    await a.refreshUsage(); await flushAsync()
    oldQuota.resolve(Response.json({ ok: true, value: quotaValue(95) }))
    await flushAsync()
    assert.equal(a.hooks.traeQuota.getSnapshot().value.remaining, 15)
    assert.equal(calls, 2)
  } finally { oldQuota.resolve(Response.json({ ok: true, value: quotaValue(95) })); h.restore() }
})

test('pool: writes of successive drafts serialize per field while other seats remain editable', async () => {
  const old = deferred()
  let count = 0
  const h = browserHarness({ setSecret: () => ++count === 1 ? old.promise : Promise.resolve({ ok: true }) })
  try {
    h.props.onStage(SEAT_A, 'pat', 'first')
    const first = h.props.onSave(SEAT_A, 'pat')
    h.props.onStage(SEAT_A, 'pat', 'second')
    const second = h.props.onSave(SEAT_A, 'pat')
    await flushAsync()
    assert.equal(h.writes.length, 1, 'the same credential must not have out-of-order writes in flight')
    h.props.onStage(SEAT_B, 'pat', 'other-seat')
    await h.props.onSave(SEAT_B, 'pat')
    assert.equal(h.writes.length, 2, 'another seat is not globally blocked')
    old.resolve({ ok: true })
    await Promise.all([first, second])
    assert.equal(h.writes.at(-1).value, 'second')
  } finally { old.resolve({ ok: true }); h.restore() }
})

test('pool: settings unmount discards secrets without writes and read-only rows refuse staging', async () => {
  const h = browserHarness({ fetcher: async () => Response.json({ ok: true, value: poolValue([poolRow(SEAT_A, { writable: false })]) }) })
  try {
    await h.props.refreshPool()
    h.props.onStage(SEAT_A, 'pat', 'must-not-stage')
    assert.equal(h.props.staged(SEAT_A, 'pat'), undefined)
    const stop = h.props.mountPool()
    h.props.onStage(SEAT_B, 'password', 'lifetime-draft')
    stop()
    assert.equal(h.props.staged(SEAT_B, 'password'), undefined)
    assert.equal(h.writes.length, 0)
  } finally { h.restore() }
})

test('pool: final settings unmount clears pending local validation before remount and ignores its late response', async () => {
  const validation = deferred()
  const h = browserHarness({ fetcher: async url => url.endsWith('/validate') ? validation.promise : Response.json({ ok: true, value: poolValue() }) })
  let stopAgain
  try {
    const stopFirst = h.props.mountPool()
    const stopLast = h.props.mountPool()
    await h.props.refreshPool()
    const checking = h.props.validateSeat(SEAT_A)
    assert.equal(h.props.fieldState(SEAT_A, 'validate').phase, 'checking')
    stopFirst()
    assert.equal(h.props.fieldState(SEAT_A, 'validate').phase, 'checking', 'a second mounted settings surface still owns the validation')
    stopLast()
    assert.equal(h.props.fieldState(SEAT_A, 'validate').phase, 'idle', 'last unmount must clear abandoned local verification progress')
    stopAgain = h.props.mountPool()
    await h.props.refreshPool()
    validation.resolve(Response.json({ ok: true, value: poolRow(SEAT_A, { validation: 'invalid' }) }))
    await checking
    assert.equal(h.props.fieldState(SEAT_A, 'validate').phase, 'idle')
    assert.equal(h.props.hooks.traePool.getSnapshot().status.value.seats[0].validation, 'valid')
  } finally { stopAgain?.(); validation.resolve(Response.json({ ok: true, value: poolRow(SEAT_A) })); h.restore() }
})

test('pool: removed seat clears pending local validation state and ignores its late response', async () => {
  const validation = deferred()
  const h = browserHarness({ fetcher: async url => url.endsWith('/validate') ? validation.promise : Response.json({ ok: true, value: poolValue() }) })
  try {
    const checking = h.props.validateSeat(SEAT_A)
    assert.equal(h.props.fieldState(SEAT_A, 'validate').phase, 'checking')
    await h.props.removeSeat(0)
    assert.equal(h.props.fieldState(SEAT_A, 'validate').phase, 'idle')
    validation.resolve(Response.json({ ok: true, value: poolRow(SEAT_A, { validation: 'invalid' }) }))
    await checking
    assert.equal(h.props.fieldState(SEAT_A, 'validate').phase, 'idle')
  } finally { validation.resolve(Response.json({ ok: true, value: poolRow(SEAT_A) })); h.restore() }
})

test('pool: new edit cancels obsolete verification progress and older result cannot publish', async () => {
  const validation = deferred()
  const h = browserHarness({ fetcher: async url => url.endsWith('/validate') ? validation.promise : Response.json({ ok: true, value: poolValue() }) })
  try {
    await h.props.refreshPool()
    const checking = h.props.validateSeat(SEAT_A)
    await flushAsync()
    h.props.onStage(SEAT_A, 'pat', 'new-version')
    validation.resolve(Response.json({ ok: true, value: poolRow(SEAT_A, { validation: 'invalid' }) }))
    await checking
    assert.notEqual(h.props.fieldState(SEAT_A, 'validate').phase, 'checking', 'an obsolete validation cannot leave the new edit stuck checking')
    assert.equal(h.props.staged(SEAT_A, 'pat'), 'new-version')
    assert.equal(h.props.hooks.traePool.getSnapshot().status.value.seats[0].validation, 'valid')
  } finally { h.restore() }
})

test('usage: leaving and returning to Trae keeps injected stores connected and discards unmounted reads', async () => {
  let selected = 'PAT_A'
  const delayed = deferred()
  let useDelayed = false
  const h = browserHarness({ fetcher: async url => url.includes('view=usage') ? useDelayed ? delayed.promise : Response.json({ ok: true, value: { request: usage('one', selected) } }) : Response.json({ ok: true, value: quotaValue(50) }) })
  try {
    const props = h.entry('conversation.input.right', 'trae-quota').inject('one')
    const stop = props.watchUsage()
    await props.refreshUsage()
    stop()
    selected = 'PAT_B'
    const stopAgain = props.watchUsage()
    await flushAsync()
    assert.equal(props.hooks.traeUsage.getSnapshot().request.seatId, 'PAT_B')
    useDelayed = true
    const late = props.refreshUsage()
    stopAgain()
    delayed.resolve(Response.json({ ok: true, value: { request: usage('one', 'PAT_A') } }))
    await late
    assert.equal(props.hooks.traeUsage.getSnapshot().request.seatId, 'PAT_B')
  } finally { h.restore() }
})

test('pool and usage polling: running 2s, idle 30s, error backoff 5/15/30s; quota stays cached', async () => {
  let phase = 'running'
  let fail = false
  const h = browserHarness({ fetcher: async url => {
    if (url.includes('view=usage')) { if (fail) throw new Error('offline'); return Response.json({ ok: true, value: { request: usage('one', 'PAT_A', phase) } }) }
    return Response.json({ ok: true, value: quotaValue(80) })
  } })
  const timers = new Map()
  const realSet = globalThis.setTimeout
  const realClear = globalThis.clearTimeout
  let seq = 0
  globalThis.setTimeout = (fn, delay) => { const id = ++seq; timers.set(id, { fn, delay }); return id }
  globalThis.clearTimeout = id => timers.delete(id)
  try {
    const props = h.entry('conversation.input.right', 'trae-quota').inject('one')
    const stop = props.watchUsage()
    await props.refreshUsage(); await flushAsync()
    assert.equal([...timers.values()][0].delay, 2000)
    phase = 'completed'
    await props.refreshUsage(); await flushAsync()
    assert.equal([...timers.values()][0].delay, 30000)
    assert.equal(h.asked.filter(([url]) => url.includes('/quota')).length, 1)
    fail = true
    for (const delay of [5000, 15000, 30000]) { await props.refreshUsage(); assert.equal([...timers.values()][0].delay, delay) }
    stop()
    assert.equal(timers.size, 0)
  } finally { h.restore(); globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear }
})

function deepText(node) {
  if (Array.isArray(node)) return node.map(deepText).join(' ')
  if (!node || typeof node !== 'object') return textOf(node)
  if (typeof node.type === 'function') return deepText(node.type(node.props))
  return deepText(node.children)
}
test('pool page: five counters, global session context, safe identity and quota source stay separate', () => {
  const h = browserHarness()
  try {
    const Page = h.components.get('dsh-trae-pat-pool')
    const state = { seats: [SEAT_A], credentials: { PAT_A: { configured: true } }, fields: {}, status: { phase: 'ready', value: { ...poolValue(), latestRequest: usage('other-session') } } }
    const text = deepText(Page({ ...h.props, useTraePool: select => select(state), useTraeSeatQuota: select => select({ seats: [] }), useTraeCard: select => select({ status: { phase: 'ready', models: [] } }) }))
    for (const label of ['PAT 号池', '账号总数', '已配置 PAT', '已验证可用', '冷却 / 异常', '待配置 / 待验证', '最近请求使用', 'other-session', 'actual@example.com', '额度来源']) assert.ok(text.includes(label), label)
    assert.equal(text.includes('EMAIL_A'), false, 'credential reference must never be displayed as identity')
    assert.equal(text.includes('本会话'), false, 'settings latest request must explicitly identify its global session')
    state.status.value = { ...poolValue([]), latestRequest: usage('other-session', 'PAT_A', 'completed') }
    const removed = deepText(Page({ ...h.props, useTraePool: select => select(state), useTraeSeatQuota: select => select({ seats: [] }), useTraeCard: select => select({ status: { phase: 'ready', models: [] } }) }))
    assert.match(removed, /Alpha.*已移除/)
    state.status = { phase: 'error', value: null }
    const failed = deepText(Page({ ...h.props, useTraePool: select => select(state), useTraeSeatQuota: select => select({ seats: [] }), useTraeCard: select => select({ status: { phase: 'ready', models: [] } }) }))
    assert.match(failed, /状态暂不可用/)
    assert.doesNotMatch(failed, /账号总数 0/)
  } finally { h.restore() }
})

function nodesOf(node) { return !node || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(nodesOf) : [node, ...nodesOf(node.children)] }
test('pool page: configured cards collapse after metadata arrives; unconfigured cards remain expanded', () => {
  let cursor = 0
  const states = []
  const reactOverride = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }), useEffect() {}, useState: initial => { const i = cursor++; if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial; return [states[i], value => { states[i] = value }] } }
  const h = browserHarness({ reactOverride })
  try {
    const state = { seats: [SEAT_A], credentials: {}, status: { phase: 'idle', value: null } }
    const render = () => {
      cursor = 0
      const tree = h.components.get('dsh-trae-pat-pool')({ ...h.props, useTraePool: select => select(state), useTraeSeatQuota: select => select({ seats: [] }), useTraeCard: select => select({ status: { phase: 'ready', models: [] } }) })
      const seat = nodesOf(tree).find(node => node.type?.name === 'SeatRow')
      return seat.type(seat.props)
    }
    assert.ok(nodesOf(render()).some(node => node.props.id === 'trae-seat-detail-PAT_A'))
    state.status = { phase: 'ready', value: poolValue() }
    assert.equal(nodesOf(render()).some(node => node.props.id === 'trae-seat-detail-PAT_A'), false)
    state.status.value = poolValue([poolRow(SEAT_A, { configured: false, validation: 'missing' })])
    assert.ok(nodesOf(render()).some(node => node.props.id === 'trae-seat-detail-PAT_A'))
  } finally { h.restore() }
})
test('pool page: permanent rejection reason overrides old valid evidence and stays actionable', () => {
  const h = browserHarness()
  try {
    const state = { seats: [SEAT_A], credentials: {}, status: { phase: 'ready', value: poolValue([poolRow(SEAT_A, { validation: 'valid', reasonCode: 'credential-rejected', retryAt: null })]) } }
    const text = deepText(h.components.get('dsh-trae-pat-pool')({ ...h.props, useTraePool: select => select(state), useTraeSeatQuota: select => select({ seats: [] }), useTraeCard: select => select({ status: { phase: 'ready', models: [] } }) }))
    assert.match(text, /凭据被拒绝/)
    assert.match(text, /令牌失效/)
  } finally { h.restore() }
})

test('pool page: English unnamed accounts, errors, verification and controls use translated strings', () => {
  const h = browserHarness()
  try {
    const seat = { ...SEAT_A, name: '' }
    const state = { seats: [seat], credentials: {}, fields: {}, status: { phase: 'ready', value: poolValue([poolRow(seat, { name: '', identity: null, configured: false, validation: 'missing' })]) } }
    const text = deepText(h.components.get('dsh-trae-pat-pool')({ ...h.props, t: key => h.dictionaries.en[key] ?? key, useTraePool: select => select(state), useTraeSeatQuota: select => select({ seats: [] }), useTraeCard: select => select({ status: { phase: 'ready', models: [] } }) }))
    assert.match(text, /Account 1/)
    assert.match(text, /Save and verify/)
    assert.doesNotMatch(text, /\p{Script=Han}/u)
    assert.doesNotMatch(text, /validationMissing|poolUsable|EMAIL_A/)
  } finally { h.restore() }
})

test('pool and usage polling: dedup, visibility pause/resume, intervals and disposal discard', async () => {
  const h = browserHarness()
  const timers = new Map()
  const events = new Map()
  const realSet = globalThis.setTimeout
  const realClear = globalThis.clearTimeout
  let seq = 0
  globalThis.setTimeout = (fn, delay) => { const id = ++seq; timers.set(id, { fn, delay }); return id }
  globalThis.clearTimeout = id => timers.delete(id)
  document.hidden = false
  document.addEventListener = (name, fn) => events.set(name, fn)
  document.removeEventListener = (name, fn) => { if (events.get(name) === fn) events.delete(name) }
  try {
    const stopPool = h.props.mountPool()
    const stopPool2 = h.props.mountPool()
    await flushAsync()
    assert.equal(h.asked.filter(([url]) => url.endsWith('/pool')).length, 1)
    assert.ok([...timers.values()].some(timer => timer.delay === 15000))
    document.hidden = true
    for (const fn of events.values()) fn()
    assert.equal(timers.size, 0)
    document.hidden = false
    for (const fn of events.values()) fn()
    await flushAsync()
    assert.equal(h.asked.filter(([url]) => url.endsWith('/pool')).length, 2)
    stopPool(); stopPool2()
    assert.equal(timers.size, 0)
    assert.equal(events.size, 0)
  } finally { h.restore(); globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear }
})

/**
 * Render the composer chip against a quota snapshot and return its label and
 * the lines of its tooltip. The element recorder stands in for React: nothing
 * is mounted, so effects are collected and never run, and the dictionaries the
 * client registers are the ones the strings are read from — asserting on what
 * a Chinese UI actually shows rather than on message keys.
 */
function renderChip(value) {
  const react = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useEffect: () => {},
  }
  const plugin = loadClient(react)
  let Chip
  let zh
  const { ctx } = hostCtx({
    register: (options, component) => { if (options.id === 'trae-quota') Chip = component },
    locale: (dicts) => { zh = dicts.zh },
  })
  plugin.apply(ctx)
  const node = Chip({
    t: key => zh[key],
    useTraeModel: select => select({ current: { provider: 'trae' } }),
    useTraeQuota: select => select({ phase: 'ready', value }),
    refresh: () => {},
  })
  const button = node.children[0]
  // The button is text, bar, text: the bar is a component the recorder leaves
  // uncalled, so it is rendered here the way React would to read its segments.
  const bar = button.children.find(child => child && typeof child.type === 'function')
  return {
    label: button.props['aria-label'],
    text: button.children.filter(child => child && typeof child.type === 'string')
      .map(child => child.children[0]).join(' '),
    color: button.props.style.color,
    segments: bar.type(bar.props).children.flat().map(segment => ({
      weight: Number(String(segment.props.style.flex).split(' ')[0]),
      left: segment.children[0].props.style.width,
      color: segment.children[0].props.style.background,
    })),
    lines: node.props.label.split('\n'),
    portal: node.props.portal,
  }
}

const chipTooltip = value => renderChip(value).lines

test('chip: several allowances are listed one by one, with the total only explaining the chip', () => {
  // The plan's own quota plus a top-up: 89% of the sum says nothing about
  // which of the two is nearly gone, so both are spelled out.
  assert.deepEqual(chipTooltip({
    packs: [
      { name: '企业版', limit: 600, used: 87.63, remaining: 512.37 },
      { name: '加油包', limit: 200, used: 0, remaining: 200 },
    ],
    limit: 800, used: 87.63, remaining: 712.37, dollars: false,
  }), [
    '企业版：剩余 512.37 / 600（85%）',
    '加油包：剩余 200 / 200（100%）',
    '合计：剩余 712.37 / 800（89%）',
    '点击刷新',
  ])

  // An unlimited pack and one that carries no quota of this kind still each
  // say what they can, rather than being folded into a number.
  assert.deepEqual(chipTooltip({
    packs: [
      { name: '不限量包', limit: null, used: 12, remaining: null },
      { name: '免费', limit: 0, used: 3, remaining: 0 },
      { name: '加油包', limit: 100, used: 40, remaining: 60 },
    ],
    limit: 100, used: 55, remaining: 60, dollars: true,
  }), [
    '不限量包：不限量',
    '免费：已用 $3',
    '加油包：剩余 $60 / $100（60%）',
    '合计：剩余 $60 / $100（60%）',
    '点击刷新',
  ])

  // One allowance is nothing to split: the line stays as it was.
  assert.deepEqual(chipTooltip({
    packs: [{ name: '企业版', limit: 800, used: 87.63, remaining: 712.37 }],
    limit: 800, used: 87.63, remaining: 712.37, dollars: false,
  }), ['剩余 712.37 / 800（89%）', '已用 87.63', '点击刷新'])
})

test('chip: one figure for the total, one bar segment per allowance', () => {
  const two = renderChip({
    packs: [
      { name: '企业版', limit: 600, used: 600, remaining: 0 },
      { name: '加油包', limit: 200, used: 24, remaining: 176 },
    ],
    limit: 800, used: 624, remaining: 176, dollars: false,
  })
  // "0% / 88%" read as a fraction; the chip now says what is left in total
  // and leaves which pack is gone to the bar.
  assert.equal(two.label, 'Trae 剩余 22%')
  assert.equal(two.text, 'Trae 剩余 22%')
  // The colour follows that same total: 22% left is tight, not yet empty.
  assert.equal(two.color, 'var(--dsw-alias-state-warn-primary)')
  // Segments are as wide as the allowance they stand for, and filled with
  // what is left of it — the drained plan is an empty 3:1 segment.
  assert.deepEqual(two.segments, [
    { weight: 0.75, left: '0%', color: 'var(--dsw-alias-state-error-primary)' },
    { weight: 0.25, left: '88%', color: 'var(--dsw-alias-state-success-primary)' },
  ])

  // A comfortable quota keeps the quiet label colour.
  const one = renderChip({
    packs: [{ name: '企业版', limit: 800, used: 87.63, remaining: 712.37 }],
    limit: 800, used: 87.63, remaining: 712.37, dollars: false,
  })
  assert.equal(one.label, 'Trae 剩余 89%')
  assert.equal(one.color, 'var(--dsw-alias-label-secondary)')
  assert.equal(one.segments.length, 1)
  // The bubble mounts under the body, outside the composer row the host
  // re-measures on every mutation in its subtree.
  assert.equal(one.portal, true)

  // A pack with no quota of this kind (limit 0) has no share to fill, so it
  // draws no segment rather than a stray empty one.
  assert.equal(renderChip({
    packs: [
      { name: '免费', limit: 0, used: 0, remaining: 0 },
      { name: '企业版', limit: 800, used: 87.63, remaining: 712.37 },
    ],
    limit: 800, used: 87.63, remaining: 712.37, dollars: false,
  }).segments.length, 1)
})

/**
 * Walk the switch notice through a sequence of model selections, running its
 * effect between renders the way React would, and return what it showed after
 * each one (null = nothing shown). Timers are stubbed, so the notice never
 * expires inside the test and no handle outlives it.
 */
function renderNotice(selections) {
  const slots_ = []
  let cursor = 0
  let effect = null
  const react = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => {
      const at = cursor++
      if (!(at in slots_)) slots_[at] = initial
      return [slots_[at], (next) => { slots_[at] = typeof next === 'function' ? next(slots_[at]) : next }]
    },
    useRef: (initial) => {
      const at = cursor++
      if (!(at in slots_)) slots_[at] = { current: initial }
      return slots_[at]
    },
    useEffect: (fn) => { effect = fn },
  }
  const plugin = loadClient(react)
  let Notice, zh
  const { ctx } = hostCtx({
    register: (options, component) => { if (options.id === 'trae-switch') Notice = component },
    locale: (dicts) => { zh = dicts.zh },
  })
  plugin.apply(ctx)
  const timeout = globalThis.setTimeout
  const clear = globalThis.clearTimeout
  globalThis.setTimeout = () => 0
  globalThis.clearTimeout = () => {}
  const shown = []
  try {
    for (const current of selections) {
      const render = () => {
        cursor = 0
        effect = null
        return Notice({ t: key => zh[key], useTraeModel: select => select({ current }) })
      }
      render()
      if (effect) effect()
      // The state the effect set is only visible on the next render.
      const node = render()
      shown.push(node ? node.children[0].children[0] : null)
    }
  } finally {
    globalThis.setTimeout = timeout
    globalThis.clearTimeout = clear
  }
  return shown
}

test('switch notice: quiet until the picked model or level moves, and only for Trae', () => {
  const glm = { provider: 'trae', modelId: 'GLM-5.3', reasoningEffort: 'high' }
  // Binding a session to its first model is not a switch.
  assert.deepEqual(renderNotice([glm, glm]), [null, null])
  // The level alone is a switch: the next turn runs in a new upstream chat.
  assert.deepEqual(renderNotice([glm, { ...glm, reasoningEffort: 'light' }]), [null, '换了模型／档位 · 下一轮重开会话'])
  assert.deepEqual(renderNotice([glm, { ...glm, modelId: 'Kimi-K3' }]), [null, '换了模型／档位 · 下一轮重开会话'])
  // Another provider's selection is none of this plugin's business.
  assert.deepEqual(renderNotice([glm, { provider: 'deepseek', modelId: 'deepseek-chat' }]), [null, null])
  // A selection this plugin cannot read keeps it quiet rather than guessing.
  assert.deepEqual(renderNotice([null, glm]), [null, null])
})

const SESSION = 'f3a9c1d2-7b44-4e55-9a66-0b1122334455'
const UPSTREAM = 'c0ffee00-1111-5222-8333-444455556666'

const SUPPORT = `312308224:2026102815494900_${UPSTREAM}.no_mid.no_mid:codex_exec.0.206.1-tob.no_sid.no_ppe.T(2026/10/28 15:49:49)`

/**
 * Render the session-ids View tab against one answer from the host's session
 * route, running effects the way React would, then press one row's copy button
 * and report what landed on the clipboard. The clipboard and `fetch` are
 * stubbed for the call and put back after it.
 */
async function renderSessionTab(value, { provider = 'trae', sessionId = SESSION, copyRow = 0 } = {}) {
  const cells = []
  let cursor = 0
  let effects = []
  const react = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => {
      const at = cursor++
      if (!(at in cells)) cells[at] = initial
      return [cells[at], (next) => { cells[at] = typeof next === 'function' ? next(cells[at]) : next }]
    },
    useEffect: (fn) => { effects.push(fn) },
  }
  const plugin = loadClient(react)
  let Tab, zh
  const { ctx, entry } = hostCtx({
    register: (options, component) => { if (options.name === 'conversation.view') Tab = component },
    locale: (dicts) => { zh = dicts.zh },
  })
  plugin.apply(ctx)
  // The tab only exists once a session on screen reports a Trae model; a
  // non-Trae `provider` here is then the split-view case, where the tab is on
  // the row for another session.
  entry('conversation.input.right', 'trae-session-watch').inject('trae-session-on-screen').watch(true)
  const asked = []
  const copied = []
  const realFetch = globalThis.fetch
  const realNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const settle = () => new Promise(resolve => setTimeout(resolve, 0))
  globalThis.fetch = async (url) => { asked.push(String(url)); return Response.json({ ok: true, value }) }
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { clipboard: { writeText: async (text) => { copied.push(text) } } },
  })
  const props = {
    t: key => zh[key],
    sessionId,
    useTraeModel: select => select({ current: { provider, modelId: 'GLM-5.3' } }),
  }
  const render = (Component) => {
    cursor = 0
    effects = []
    return Component(props)
  }
  try {
    // The whole tab is rendered row by row: the recorder leaves child
    // components uncalled, so each row is rendered the way React would.
    render(Tab)
    for (const effect of effects) effect()
    await settle()
    // The tab is a full-width scroller around one chat-width column.
    const view = render(Tab)
    assert.equal(view.props.className, 'trae-view')
    const tab = view.children[0]
    assert.equal(tab.props.className, 'trae-ids')
    // The id rows sit in their own card, under the share section.
    const idRows = tab.children.flatMap(child => child && child.props?.className === 'trae-card' ? child.children : [child])
    const rows = idRows.filter(child => child && child.type?.name === 'IdRow').map((row) => {
      cursor = 0
      effects = []
      const node = row.type(row.props)
      const head = node.children[0]
      const body = node.children[1]
      return {
        label: head.children[0].children[0],
        copy: head.children[1],
        value: body.props.className === 'trae-id-value' ? body.children[0] : null,
        empty: body.props.className === 'trae-id-empty' ? body.children[0] : null,
        hint: node.children[2]?.children?.[0] ?? null,
      }
    })
    const pressed = rows[copyRow]
    if (pressed.copy) pressed.copy.props.onClick()
    await settle()
    return {
      // The line a session on another provider is told, when there is one.
      note: tab.children.find(child => child?.props?.className === 'trae-id-note')?.children?.[0] ?? null,
      // Section headings and child components in page order, so a test can
      // say what the one Trae page holds.
      layout: tab.children.filter(Boolean).map(child => typeof child.type === 'function'
        ? child.type.name
        : child.props?.className === 'trae-card' ? `card: ${child.props['aria-label']}` : child.props?.className),
      rows,
      asked,
      copied,
    }
  } finally {
    globalThis.fetch = realFetch
    if (realNavigator) Object.defineProperty(globalThis, 'navigator', realNavigator)
  }
}

test('session tab: one row per id, each copied on its own, and no tab outside Trae', async () => {
  const ran = await renderSessionTab({
    session: SESSION, conversation: UPSTREAM, model: 'GLM-5.3', effort: 'high', at: 1, debug: SUPPORT,
  })
  assert.deepEqual(ran.rows.map(row => row.label), ['会话 ID', '上游会话', '排查串'])
  assert.deepEqual(ran.rows.map(row => row.value), [SESSION, UPSTREAM, SUPPORT])
  // The row says which variant that upstream chat belongs to.
  assert.equal(ran.rows[1].hint, '上一轮跑在：GLM-5.3 · high')
  assert.equal(ran.asked[0], `api/dsh-trae-pat-pool/session?session=${SESSION}`)
  // Pressing copy on the first row copies the whole session id, and re-reads:
  // the other two move with every turn.
  assert.deepEqual(ran.copied, [SESSION])
  assert.equal(ran.asked.length, 2)
  // On a Trae session there is no note, and the ids and the share links are
  // one page: sharing on top (what the tab is opened for), the three id rows
  // in a card of their own underneath.
  assert.equal(ran.note, null)
  assert.deepEqual(ran.layout, ['ShareSection', 'card: 会话 ID'])

  const upstreamRow = await renderSessionTab({
    session: SESSION, conversation: UPSTREAM, model: 'Kimi-K3', effort: null, at: 1, debug: SUPPORT,
  }, { copyRow: 1 })
  assert.deepEqual(upstreamRow.copied, [UPSTREAM])
  assert.equal(upstreamRow.rows[1].hint, '上一轮跑在：Kimi-K3')
  const supportRow = await renderSessionTab({
    session: SESSION, conversation: UPSTREAM, model: 'GLM-5.3', effort: 'high', at: 1, debug: SUPPORT,
  }, { copyRow: 2 })
  assert.deepEqual(supportRow.copied, [SUPPORT])

  // Before the first answer there is no upstream chat and no support line: the
  // rows say so instead of offering an empty copy.
  const fresh = await renderSessionTab({
    session: SESSION, conversation: null, model: null, effort: null, at: null, debug: null,
  }, { copyRow: 1 })
  assert.deepEqual(fresh.rows.map(row => row.empty), [null, '这条会话还没发过一轮，发一轮就有了', '这条会话还没发过一轮，发一轮就有了'])
  assert.deepEqual(fresh.rows.map(row => row.copy === null), [false, true, true])
  assert.deepEqual(fresh.copied, [])

  // The View tab row is a global registry, so another provider's session has
  // this tab too: it says the last two rows are not about it, and still shows
  // the one id that is.
  const other = await renderSessionTab({
    session: SESSION, conversation: null, model: null, effort: null, at: null, debug: null,
  }, { provider: 'deepseek' })
  assert.equal(other.note, '这条会话现在选的不是 Trae 模型，下面两项说的是它上一轮跑 Trae 时的情况。')
  assert.equal(other.rows[0].value, SESSION)
})

/**
 * Render the next-step cards for one session state with the same element
 * recorder as the chip, plus just enough of React's state hook to re-render
 * after a click. Effects never run on their own: the last render's are kept
 * in `effects` for a test to run by hand. The slot's own inject() supplies
 * load/clear/dismiss/close/fold against the real controller, seeded
 * through its store; `storage` stands in for the page's localStorage.
 */
function renderCards({ cards, dismissed = [], subagent = false, running = false, draft = '', phase = 'plain', storage }) {
  const states = []
  let cursor = 0
  const effects = []
  const react = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useEffect: (effect) => { effects.push(effect) },
    useRef: value => ({ current: value }),
    useState: (initial) => {
      const at = cursor++
      if (!(at in states)) states[at] = initial
      return [states[at], (next) => { states[at] = typeof next === 'function' ? next(states[at]) : next }]
    },
  }
  const plugin = loadClient(react)
  if (storage) globalThis.window.localStorage = storage
  let Cards, entry, zh
  const { ctx } = hostCtx({
    register: (options, component) => { if (options.id === 'trae-choices') { Cards = component; entry = options } },
    locale: (dicts) => { zh = dicts.zh },
  })
  plugin.apply(ctx)
  const injected = entry.inject('s1')
  const store = injected.hooks.traeChoices
  store.set({ id: 'sug-1', cards, dismissed, subagent })
  const sent = []
  const inputActions = {
    setDraft: (text) => { sent.push(['draft', text]) },
    submit: () => { sent.push(['submit']) },
  }
  const render = () => {
    cursor = 0
    effects.length = 0
    return Cards({
      t: key => zh[key],
      sessionId: 's1',
      inputActions,
      useSession: select => select({ running }),
      useInput: select => select({ draft, phase }),
      useTraeChoices: select => select(store.getSnapshot()),
      useTraeChoicesFolded: select => select(injected.hooks.traeChoicesFolded.getSnapshot()),
      ...injected,
    })
  }
  return { node: render(), render, store, sent, effects }
}

/** Pull the parts of a card out of the recorded tree. */
const cardsOf = node => node.children[0]
const headOf = card => card.children[0]
const eyebrowOf = card => headOf(card).children[0].children[0].children[1]
const questionOf = card => headOf(card).children[0].children[1].children[0]
const closeOf = card => headOf(card).children[1]
const actionsOf = card => card.children[1].children
const choiceButtonsOf = card => actionsOf(card).filter(button => button.props['data-other'] === undefined)
const otherButtonOf = card => actionsOf(card).find(button => button.props['data-other'] === '')
const labelOf = button => button.children.at(-1).children[0]
const otherBoxOf = card => card.children[2]
/** The box under the cards once anything is picked: the count, the note and send. */
const composeOf = node => node.children[1]
const pickedCountOf = node => composeOf(node).children[0].children[1]
const extraOf = node => composeOf(node).children[1].children[0]
const sendOf = node => composeOf(node).children[1].children[1]
/** The line under the round: who does the task, and what that means. */
const footOf = node => node.children[2]
const whoOf = node => footOf(node).children[0]
const noteOf = node => footOf(node).children[1].children[0]
const pressedOf = card => choiceButtonsOf(card).map(button => button.props['aria-pressed'])
/** A key press the way the browser reports it to a textarea. */
const key = (k, extra = {}) => ({ key: k, shiftKey: false, keyCode: 0, nativeEvent: {}, preventDefault() {}, ...extra })
const typeInto = (input, value) => { input.props.onChange({ target: { value, style: {}, scrollHeight: 44 } }) }

/** Run `body` with the host's event route recorded instead of fetched. */
function withEvents(body) {
  const original = globalThis.fetch
  const events = []
  globalThis.fetch = async (_url, init) => { events.push(JSON.parse(init.body)); return Response.json({ ok: true }) }
  try { body(events) } finally { globalThis.fetch = original }
}

const TWO_CARDS = [
  {
    question: '要把 README 里过时的安装路径改掉吗？',
    choices: [
      { label: '改路径', reply: '把 README 里过时的安装路径改成 DSH NEXT.app' },
      { label: '先查可执行名', reply: '先查一下实际的可执行文件名，再改路径' },
    ],
  },
  { question: '要补上配置何时生效的说明吗？', choices: [{ label: '补说明', reply: '在 README 里补上配置何时生效的说明' }] },
]

test('cards: one card per decision, the model\'s own answers as buttons, its pick first, then "something else"', () => {
  const { node } = renderCards({ cards: TWO_CARDS })
  assert.equal(node.props.className, 'trae-choices')
  const cards = cardsOf(node)
  assert.deepEqual(cards.map(questionOf), ['要把 README 里过时的安装路径改掉吗？', '要补上配置何时生效的说明吗？'])
  assert.deepEqual(cards.map(eyebrowOf), ['下一步 · 1/2', '下一步 · 2/2'])
  assert.deepEqual(cards.map(card => choiceButtonsOf(card).map(labelOf)), [['改路径', '先查可执行名'], ['补说明']])
  assert.deepEqual(choiceButtonsOf(cards[0]).map(button => button.props['data-primary']), ['', undefined])
  assert.deepEqual(cards.map(card => labelOf(otherButtonOf(card))), ['其他建议', '其他建议'])
  assert.equal(otherBoxOf(cards[0]), null, 'the box stays shut until asked for')
  // Nothing picked yet: nothing pressed, and nothing to send.
  assert.deepEqual(cards.map(pressedOf), [[false, false], [false]])
  assert.equal(composeOf(node), null)
  assert.equal(noteOf(node), '点按钮选中，选好后一起发送，在当前会话里做。')

  // A single card needs no count.
  assert.equal(eyebrowOf(cardsOf(renderCards({ cards: TWO_CARDS.slice(0, 1) }).node)[0]), '下一步')
})

test('cards: a button picks its card\'s answer and sends nothing; another replaces it, a second click takes it back', () => {
  withEvents((events) => {
    const { node, render, sent } = renderCards({ cards: TWO_CARDS })
    choiceButtonsOf(cardsOf(node)[0])[1].props.onClick()
    let next = render()
    assert.deepEqual(pressedOf(cardsOf(next)[0]), [false, true])
    assert.equal(labelOf(choiceButtonsOf(cardsOf(next)[0])[1]), '先查可执行名')
    assert.equal(pickedCountOf(next), '已选 1/2')
    assert.deepEqual(sent, [])
    assert.deepEqual(events, [], 'a pick is not an answer until it is sent')

    choiceButtonsOf(cardsOf(next)[0])[0].props.onClick()
    next = render()
    assert.deepEqual(pressedOf(cardsOf(next)[0]), [true, false])
    choiceButtonsOf(cardsOf(next)[0])[0].props.onClick()
    next = render()
    assert.deepEqual(pressedOf(cardsOf(next)[0]), [false, false])
    assert.equal(composeOf(next), null)
  })
})

test('cards: every answer goes out as one message, each under its question, the note last', () => {
  withEvents((events) => {
    const { node, render, sent } = renderCards({ cards: TWO_CARDS })
    choiceButtonsOf(cardsOf(node)[0])[1].props.onClick()
    choiceButtonsOf(cardsOf(render())[1])[0].props.onClick()
    const picked = render()
    assert.equal(pickedCountOf(picked), '已选 2/2')
    assert.equal(extraOf(picked).props.placeholder, '补充几句（可选），回车发送')
    typeInto(extraOf(picked), '  改完跑一下 lint  ')
    sendOf(render()).props.onClick()
    // The chat never saw the questions — they came from a side completion —
    // so an answer alone would leave the model guessing which decision it settles.
    assert.deepEqual(sent, [
      ['draft', [
        '关于「要把 README 里过时的安装路径改掉吗？」：先查一下实际的可执行文件名，再改路径',
        '关于「要补上配置何时生效的说明吗？」：在 README 里补上配置何时生效的说明',
        '',
        '补充：改完跑一下 lint',
      ].join('\n')],
      ['submit'],
    ])
    // Cue counts one accepted button a round: the first picked, in card order.
    assert.deepEqual(events, [{ session: 's1', id: 'sug-1', action: 'accept', card: 0, choice: 1 }])
    assert.equal(render(), null, 'answered: every card is done')
  })
})

test('cards: one answer reads as it always did, and Enter in the note sends it', () => {
  withEvents(() => {
    const { node, render, sent } = renderCards({ cards: TWO_CARDS })
    choiceButtonsOf(cardsOf(node)[0])[0].props.onClick()
    const note = extraOf(render())
    // Enter while an IME is still composing picks a candidate; Shift+Enter is a new line.
    note.props.onKeyDown(key('Enter', { nativeEvent: { isComposing: true } }))
    note.props.onKeyDown(key('Enter', { keyCode: 229 }))
    note.props.onKeyDown(key('Enter', { shiftKey: true }))
    assert.deepEqual(sent, [])
    note.props.onKeyDown(key('Enter'))
    assert.deepEqual(sent, [['draft', '关于「要把 README 里过时的安装路径改掉吗？」：把 README 里过时的安装路径改成 DSH NEXT.app'], ['submit']])
  })
  // A card the model gave no question sends the reply as it is.
  withEvents(() => {
    const { node, render, sent } = renderCards({ cards: [{ question: '', choices: [{ label: '跑测试', reply: '跑一下测试' }] }] })
    choiceButtonsOf(cardsOf(node)[0])[0].props.onClick()
    sendOf(render()).props.onClick()
    assert.deepEqual(sent, [['draft', '跑一下测试'], ['submit']])
  })
})

test('cards: with the host delegating, one pick goes to a subagent and the cards say so', () => {
  withEvents((events) => {
    const { node, render, sent } = renderCards({ cards: TWO_CARDS, subagent: true })
    assert.equal(whoOf(node).props['aria-pressed'], true)
    assert.equal(labelOf(whoOf(node)), '子会话处理')
    assert.equal(noteOf(node), '点按钮选中，选好后一起发送；交给子会话去做，不占当前会话的上下文，做完回来汇报。')
    assert.deepEqual(cardsOf(node).map(card => eyebrowOf(card)), ['下一步 · 1/2', '下一步 · 2/2'])

    choiceButtonsOf(cardsOf(node)[0])[0].props.onClick()
    sendOf(render()).props.onClick()
    const [[, text]] = sent
    assert.ok(text.startsWith('请开一个子会话来做下面这件事：'), text)
    assert.ok(text.includes('subagent 工具'))
    // The child cannot see the chat at all, so the question travels as context.
    assert.ok(text.includes('背景：上一轮结束时待定的问题是「要把 README 里过时的安装路径改掉吗？」。'), text)
    assert.ok(text.endsWith('任务：把 README 里过时的安装路径改成 DSH NEXT.app'), text)
    assert.deepEqual(sent[1], ['submit'])
    // Which button was pressed is reported as before: the wrapping is the composer's.
    assert.deepEqual(events, [{ session: 's1', id: 'sug-1', action: 'accept', card: 0, choice: 0 }])
    assert.equal(render(), null)
  })
})

test('cards: several picks go to a subagent each, numbered, with the note to pass on', () => {
  withEvents(() => {
    const { node, render, sent } = renderCards({ cards: TWO_CARDS, subagent: true })
    choiceButtonsOf(cardsOf(node)[0])[0].props.onClick()
    choiceButtonsOf(cardsOf(render())[1])[0].props.onClick()
    typeInto(extraOf(render()), '改完跑一下测试')
    sendOf(render()).props.onClick()
    const [[, text]] = sent
    assert.ok(text.startsWith('请为下面每件事各开一个子会话来做：每件事用 subagent 工具单独派出去'), text)
    assert.ok(text.endsWith([
      '1. 背景：上一轮结束时待定的问题是「要把 README 里过时的安装路径改掉吗？」。',
      '   任务：把 README 里过时的安装路径改成 DSH NEXT.app',
      '',
      '2. 背景：上一轮结束时待定的问题是「要补上配置何时生效的说明吗？」。',
      '   任务：在 README 里补上配置何时生效的说明',
      '',
      '补充（派活时一并交代给子会话）：改完跑一下测试',
    ].join('\n')), text)
  })
})

test('cards: the round can be switched back to this session, and sends the answers bare again', () => {
  withEvents(() => {
    const { node, render, sent } = renderCards({ cards: TWO_CARDS, subagent: true })
    whoOf(node).props.onClick()
    const back = render()
    assert.equal(whoOf(back).props['aria-pressed'], false)
    assert.equal(labelOf(whoOf(back)), '当前会话处理')
    assert.equal(noteOf(back), '点按钮选中，选好后一起发送，在当前会话里做。')

    otherButtonOf(cardsOf(back)[0]).props.onClick()
    typeInto(otherBoxOf(cardsOf(render())[0]).children[0], '先只改路径')
    otherBoxOf(cardsOf(render())[0]).children[0].props.onKeyDown(key('Enter'))
    assert.deepEqual(sent, [['draft', '关于「要把 README 里过时的安装路径改掉吗？」：先只改路径'], ['submit']])
  })
})

test('cards: the user\'s own words travel with the task when it goes to a subagent', () => {
  withEvents(() => {
    const { node, sent, render } = renderCards({ cards: TWO_CARDS, subagent: true })
    otherButtonOf(cardsOf(node)[0]).props.onClick()
    typeInto(otherBoxOf(cardsOf(render())[0]).children[0], '把安装路径和配置说明一起改掉')
    sendOf(render()).props.onClick()
    assert.equal(sent.length, 2)
    assert.ok(sent[0][1].includes('背景：上一轮结束时待定的问题是「要把 README 里过时的安装路径改掉吗？」。'), sent[0][1])
    assert.ok(sent[0][1].endsWith('任务：把安装路径和配置说明一起改掉'), sent[0][1])
  })
})

test('cards: "something else" answers its card in the user\'s own words, which Cue never hears of', () => {
  withEvents((events) => {
    const { node, render, sent } = renderCards({ cards: TWO_CARDS })
    otherButtonOf(cardsOf(node)[1]).props.onClick()
    let cards = cardsOf(render())
    assert.equal(otherBoxOf(cards[0]), null)
    assert.equal(otherButtonOf(cards[1]).props['aria-expanded'], true)
    const box = otherBoxOf(cards[1])
    assert.equal(box.children.length, 1, 'one send for the whole round, under the cards')
    const [input] = box.children
    assert.equal(input.props.autoFocus, true)
    assert.equal(input.props.placeholder, '说说你想怎么做，回车发送')
    // An empty box answers nothing: no count, and Enter sends nothing.
    assert.equal(composeOf(render()), null)
    input.props.onKeyDown(key('Enter'))
    assert.deepEqual(sent, [])

    typeInto(input, '  先只改路径，配置说明下次再补  ')
    const typed = render()
    assert.equal(otherBoxOf(cardsOf(typed)[1]).children[0].props.value, '  先只改路径，配置说明下次再补  ')
    assert.equal(pickedCountOf(typed), '已选 1/2')

    otherBoxOf(cardsOf(typed)[1]).children[0].props.onKeyDown(key('Enter'))
    assert.deepEqual(sent, [['draft', '关于「要补上配置何时生效的说明吗？」：先只改路径，配置说明下次再补'], ['submit']])
    assert.deepEqual(events, [], 'the user\'s own words are no suggestion of Trae\'s')
    assert.equal(render(), null, 'answered: every card is done')
  })
})

test('cards: a button and the box take turns as a card\'s answer', () => {
  const { node, render } = renderCards({ cards: TWO_CARDS })
  otherButtonOf(cardsOf(node)[0]).props.onClick()
  typeInto(otherBoxOf(cardsOf(render())[0]).children[0], '先只改路径')
  choiceButtonsOf(cardsOf(render())[0])[1].props.onClick()
  let card = cardsOf(render())[0]
  assert.equal(otherBoxOf(card), null)
  assert.equal(otherButtonOf(card).props['aria-expanded'], false)
  assert.deepEqual(pressedOf(card), [false, true])

  otherButtonOf(card).props.onClick()
  card = cardsOf(render())[0]
  assert.deepEqual(pressedOf(card), [false, false])
  assert.equal(otherBoxOf(card).children[0].props.value, '')
})

test('cards: Escape or a second click shuts the box without sending', () => {
  const { node, render, sent } = renderCards({ cards: TWO_CARDS })
  otherButtonOf(cardsOf(node)[0]).props.onClick()
  otherBoxOf(cardsOf(render())[0]).children[0].props.onKeyDown(key('Escape'))
  assert.equal(otherBoxOf(cardsOf(render())[0]), null)

  otherButtonOf(cardsOf(render())[0]).props.onClick()
  otherButtonOf(cardsOf(render())[0]).props.onClick()
  assert.equal(otherBoxOf(cardsOf(render())[0]), null)
  assert.deepEqual(sent, [])
})

test('cards: × closes just that card and drops its answer; typing, a running turn or an open menu hide them all', () => {
  const { node, render } = renderCards({ cards: TWO_CARDS })
  choiceButtonsOf(cardsOf(node)[0])[0].props.onClick()
  choiceButtonsOf(cardsOf(render())[1])[0].props.onClick()
  assert.equal(pickedCountOf(render()), '已选 2/2')
  closeOf(cardsOf(render())[0]).props.onClick()
  const left = render()
  assert.deepEqual(cardsOf(left).map(questionOf), ['要补上配置何时生效的说明吗？'])
  assert.equal(pickedCountOf(left), '已选 1/1')

  assert.equal(renderCards({ cards: TWO_CARDS, draft: '我自己说' }).node, null)
  assert.equal(renderCards({ cards: TWO_CARDS, running: true }).node, null)
  assert.equal(renderCards({ cards: TWO_CARDS, phase: 'claimed' }).node, null)
  assert.equal(renderCards({ cards: TWO_CARDS, dismissed: [0, 1] }).node, null)
  assert.equal(renderCards({ cards: [] }).node, null)
})

test('cards: folding keeps what was picked and typed', () => {
  const { node, render } = renderCards({ cards: TWO_CARDS, storage: memoryStorage() })
  choiceButtonsOf(cardsOf(node)[0])[1].props.onClick()
  typeInto(extraOf(render()), '顺便看下 CI')
  foldOf(render()).props.onClick()
  foldedRowOf(render()).props.onClick()
  const back = render()
  assert.deepEqual(pressedOf(cardsOf(back)[0]), [false, true])
  assert.equal(extraOf(back).props.value, '顺便看下 CI')
})

/** The fold switch at the end of the round's line, and the one row a folded round shrinks to. */
const foldOf = node => footOf(node).children[2]
const foldedRowOf = node => node.children[0]
const foldedTextOf = node => {
  const [eyebrow, peek, unfold] = foldedRowOf(node).children
  return { eyebrow: eyebrow.children[1], peek: peek.children[0], unfold: unfold.children[0] }
}
const FOLDED_KEY = 'dsh-trae-pat-pool:choices-folded'

/** Just enough of a page's localStorage. */
function memoryStorage(entries = {}) {
  const map = new Map(Object.entries(entries))
  return { map, getItem: key => map.get(key) ?? null, setItem: (key, value) => { map.set(key, String(value)) } }
}

test('cards: one click folds the round to a line, and a click on that line opens it again', () => {
  const storage = memoryStorage()
  const { node, render } = renderCards({ cards: TWO_CARDS, storage })
  const fold = foldOf(node)
  assert.equal(labelOf(fold), '折叠')
  assert.equal(fold.props['aria-expanded'], true)

  fold.props.onClick()
  const folded = render()
  assert.equal(folded.props['data-folded'], '')
  assert.equal(foldedRowOf(folded).props['aria-expanded'], false)
  assert.deepEqual(foldedTextOf(folded), { eyebrow: '下一步 · 2 条', peek: '要把 README 里过时的安装路径改掉吗？', unfold: '展开' })
  assert.equal(storage.map.get(FOLDED_KEY), '1')

  foldedRowOf(folded).props.onClick()
  const back = render()
  assert.equal(back.props['data-folded'], undefined)
  assert.deepEqual(cardsOf(back).map(questionOf), ['要把 README 里过时的安装路径改掉吗？', '要补上配置何时生效的说明吗？'])
  assert.equal(storage.map.get(FOLDED_KEY), '0')
})

test('cards: folding is the user\'s choice, so a reload and the next round arrive folded', () => {
  const { node, render, store } = renderCards({ cards: TWO_CARDS, storage: memoryStorage({ [FOLDED_KEY]: '1' }) })
  assert.deepEqual(foldedTextOf(node), { eyebrow: '下一步 · 2 条', peek: '要把 README 里过时的安装路径改掉吗？', unfold: '展开' })

  // A closed card leaves the row to the next one still open, and one card needs no count.
  store.set({ ...store.getSnapshot(), dismissed: [0] })
  assert.deepEqual(foldedTextOf(render()), { eyebrow: '下一步', peek: '要补上配置何时生效的说明吗？', unfold: '展开' })

  // A card the model gave no question shows its first answer instead.
  store.set({ id: 'sug-2', cards: [{ question: '', choices: [{ label: '跑测试', reply: '跑一下测试' }] }], dismissed: [], subagent: false })
  assert.equal(foldedTextOf(render()).peek, '跑测试')

  // Folded or not, typing or a running turn still hides it.
  assert.equal(renderCards({ cards: TWO_CARDS, draft: '我自己说', storage: memoryStorage({ [FOLDED_KEY]: '1' }) }).node, null)
  assert.equal(renderCards({ cards: TWO_CARDS, running: true, storage: memoryStorage({ [FOLDED_KEY]: '1' }) }).node, null)
})

test('cards: a folded round is not reported shown until it is opened', () => {
  const original = globalThis.fetch
  const events = []
  globalThis.fetch = async (_url, init) => { events.push(JSON.parse(init.body)); return Response.json({ ok: true }) }
  try {
    const { node, render, effects } = renderCards({ cards: TWO_CARDS, storage: memoryStorage({ [FOLDED_KEY]: '1' }) })
    // The component's last effect is the "shown" report.
    effects.at(-1)()
    assert.deepEqual(events, [], 'only the row is on screen, not the buttons')

    foldedRowOf(node).props.onClick()
    render()
    effects.at(-1)()
    assert.deepEqual(events, [{ session: 's1', id: 'sug-1', action: 'shown' }])
  } finally { globalThis.fetch = original }
})

test('settings: the card switches next-step cards on and off, as the host\'s suggestions', () => {
  const forms = []
  const plugin = loadClient(undefined, forms)
  plugin.apply(hostCtx().ctx)
  const [[, specs]] = forms
  const spec = specs.find(s => s.field === 'suggestions')
  assert.ok(spec, 'the card edits suggestions')
  // Absent is the schema default — on — and so is a host too old to serve it.
  assert.equal(spec.format(undefined), 'on')
  assert.equal(spec.format(true), 'on')
  assert.equal(spec.format(false), 'off')
  assert.deepEqual(spec.parse('off'), { kind: 'set', value: false })
  assert.deepEqual(spec.parse('on'), { kind: 'set', value: true })
})

test('settings: the card offers who does a next-step card by default, as the host\'s suggestSubagent', () => {
  const forms = []
  const plugin = loadClient(undefined, forms)
  plugin.apply(hostCtx().ctx)
  const [[, specs]] = forms
  const spec = specs.find(s => s.field === 'suggestSubagent')
  assert.ok(spec, 'the card edits suggestSubagent')
  // Absent is the schema default — on — and so is a host too old to serve it.
  assert.equal(spec.format(undefined), 'subagent')
  assert.equal(spec.format(true), 'subagent')
  assert.equal(spec.format(false), 'inline')
  assert.deepEqual(spec.parse('inline'), { kind: 'set', value: false })
  assert.deepEqual(spec.parse('subagent'), { kind: 'set', value: true })
})
