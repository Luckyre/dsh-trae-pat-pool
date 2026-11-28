import { createHash, randomUUID } from 'node:crypto'
import { TraeAuth, type TraeSession } from './auth.ts'
import { TraePatPool, type PoolMode } from './pool.ts'
import { parseUserInfo, USER_INFO_PATH } from './user.ts'
import type { RequestUsage } from './request-usage.ts'

export interface PoolSeatView {
  seatId: string; name: string; priority: number
  configured: boolean | null; writable: boolean; source?: string; credentialVersion: string
  validation: 'missing' | 'unknown' | 'checking' | 'valid' | 'unavailable' | 'invalid'
  checkedAt: number | null; validatedUntil: number | null
  reasonCode: string | null; retryAt: number | null; identity: string | null
}
interface Evidence { validation: PoolSeatView['validation']; checkedAt: number; validatedUntil: number | null; reasonCode: string | null; identity: string | null }
interface CredentialState { version: string; fingerprint?: string; generation: number; evidence?: Evidence; pending?: Promise<void> }
export interface PoolViewOptions {
  pool: TraePatPool; host: string; consoleHost: string; clientId: string; userAgent: string
  readSecret(ref: string): Promise<string | undefined>
  writable(ref: string): boolean | { writable: boolean; source?: string } | Promise<boolean | { writable: boolean; source?: string }>
  mode(): PoolMode
  usage?: Pick<RequestUsage, 'latest'>
}
const safeIdentity = (value: string | undefined, secret: string, token: string): string | null => value && !value.includes(secret) && !value.includes(token) && !/eyJ[A-Za-z0-9_-]+\.|[\r\n\x00-\x1f]/.test(value) ? value.slice(0, 120) : null
/** Local metadata and ephemeral server evidence, independent of the scheduler. */
export class TraePoolView {
  private readonly states = new Map<string, CredentialState>()
  constructor(private readonly opts: PoolViewOptions) {}
  private sync(): void {
    const refs = new Set(this.opts.pool.seats().map(seat => seat.pat))
    for (const ref of this.states.keys()) if (!refs.has(ref)) this.states.delete(ref)
  }
  rosterChanged(): void { this.sync() }
  has(ref: string): boolean { return this.opts.pool.seats().some(s => s.pat === ref) }
  invalidate(ref?: string): void {
    if (ref === undefined) { this.states.clear(); return }
    this.states.delete(ref)
  }
  private async credential(ref: string): Promise<{ state: CredentialState; secret?: string; configured: boolean | null; writable: boolean; source?: string }> {
    this.sync()
    let state = this.states.get(ref)
    if (!state) { state = { generation: 0, version: randomUUID() }; this.states.set(ref, state) }
    let writable = false
    let source: string | undefined
    try {
      const metadata = await this.opts.writable(ref)
      writable = typeof metadata === 'boolean' ? metadata : metadata.writable
      source = typeof metadata === 'object' ? metadata.source : undefined
    } catch { /* metadata unavailable */ }
    let secret: string | undefined
    try { secret = (await this.opts.readSecret(ref))?.trim() || undefined } catch { return { state, configured: null, writable } }
    if (this.states.get(ref) !== state) return this.credential(ref)
    const fingerprint = createHash('sha256').update(secret ?? '').digest('hex')
    if (state.fingerprint !== fingerprint) {
      state.generation++; state.version = randomUUID(); state.fingerprint = fingerprint; state.evidence = undefined; state.pending = undefined
    }
    return { state, secret, configured: !!secret, writable, source }
  }
  private async row(ref: string): Promise<PoolSeatView | undefined> {
    const credential = await this.credential(ref)
    const seats = this.opts.pool.seats(); const priority = seats.findIndex(s => s.pat === ref)
    if (priority < 0) return undefined
    const seat = seats[priority]!
    const evidence = credential.state.evidence
    const expired = evidence?.validation === 'valid' && (evidence.validatedUntil ?? 0) <= Date.now()
    const status = (await this.opts.pool.status()).find(s => s.ref === ref)
    const reason = status?.reason ?? null
    return {
      seatId: ref, name: seat.name, priority: priority + 1,
      configured: credential.configured, writable: credential.writable, credentialVersion: credential.state.version,
      ...credential.source ? { source: credential.source } : {},
      validation: credential.configured === null ? 'unknown' : !credential.configured ? 'missing' : reason === 'credential-rejected' ? 'invalid' : credential.state.pending ? 'checking' : expired ? 'unknown' : evidence?.validation ?? 'unknown',
      checkedAt: evidence?.checkedAt ?? null, validatedUntil: evidence?.validatedUntil ?? null,
      reasonCode: reason ?? (credential.configured === null ? 'credential-unavailable' : !credential.configured ? 'missing-credential' : expired ? 'verification-expired' : evidence?.reasonCode ?? null),
      retryAt: reason && reason !== 'credential-rejected' ? status?.retryAtMs ?? null : null,
      identity: credential.configured === true ? evidence?.identity ?? null : null,
    }
  }
  async snapshot() {
    this.sync()
    const seats = (await Promise.all(this.opts.pool.seats().map(s => this.row(s.pat)))).filter((s): s is PoolSeatView => !!s)
    return {
      mode: this.opts.mode(), attempts: this.opts.pool.attempts, updatedAt: Date.now(),
      summary: {
        total: seats.length, configured: seats.filter(s => s.configured === true).length,
        usable: seats.filter(s => s.validation === 'valid' && s.reasonCode === null).length,
        attention: seats.filter(s => s.validation === 'invalid' || ['credential-rejected', 'rate-limited', 'out-of-credit', 'unavailable', 'unusable'].includes(s.reasonCode ?? '')).length,
        pending: seats.filter(s => ['missing', 'unknown', 'checking', 'unavailable'].includes(s.validation)).length,
      }, seats, latestRequest: this.opts.usage?.latest() ?? null,
    }
  }
  async validate(ref: string): Promise<PoolSeatView | undefined> {
    this.sync()
    if (!this.has(ref)) return undefined
    const { state, secret, configured } = await this.credential(ref)
    if (configured !== true || !secret) return this.row(ref)
    if (!state.pending) {
      const generation = state.generation
      const pending = this.verify(secret).then(async evidence => {
        // Re-resolve, even when an environment variable changed without an event.
        const current = await this.credential(ref)
        if (this.has(ref) && current.configured === true && this.states.get(ref) === state && current.state === state && state.generation === generation) state.evidence = evidence
      }).finally(() => { if (state.pending === pending) state.pending = undefined })
      state.pending = pending
    }
    await state.pending
    return this.row(ref)
  }
  async observeRequest(ref: string, session: TraeSession) {
    const current = await this.credential(ref)
    const state = current.state
    const generation = state.generation
    const fingerprint = state.fingerprint
    const identity = current.secret
      ? safeIdentity(session.email ?? session.name, current.secret, session.token)
        ?? safeIdentity(state.evidence?.identity ?? undefined, current.secret, session.token)
      : null
    const eligible = this.has(ref) && current.configured === true && session.credentialFingerprint === fingerprint
    const publish = async (evidence?: Evidence): Promise<boolean> => {
      if (!eligible) return false
      const latest = await this.credential(ref)
      if (!this.has(ref) || latest.configured !== true || this.states.get(ref) !== state || latest.state !== state || state.generation !== generation || state.fingerprint !== fingerprint) return false
      if (evidence) state.evidence = evidence
      return true
    }
    return {
      credentialVersion: eligible ? state.version : null,
      identity,
      isCurrent: () => publish(),
      succeeded: async (): Promise<void> => {
        if (!session.expiryKnown || session.expiresAt <= Date.now()) return
        await publish({ validation: 'valid', checkedAt: Date.now(), validatedUntil: session.expiresAt, reasonCode: null, identity })
      },
      failed: async (code: string): Promise<boolean> => {
        return code === 'AUTH'
          ? publish({ validation: 'invalid', checkedAt: Date.now(), validatedUntil: null, reasonCode: 'credential-rejected', identity: null })
          : code === 'TRANSPORT' || code === 'TIMEOUT'
            ? publish({ validation: 'unavailable', checkedAt: Date.now(), validatedUntil: null, reasonCode: 'verification-unavailable', identity })
            : publish()
      },
    }
  }
  private async verify(secret: string): Promise<Evidence> {
    const checkedAt = Date.now()
    const failure = (validation: Evidence['validation'], reasonCode: string): Evidence => ({ validation, checkedAt, validatedUntil: null, reasonCode, identity: null })
    try {
      const auth = new TraeAuth({ host: this.opts.host, clientId: this.opts.clientId, userAgent: this.opts.userAgent, readSecret: async () => secret })
      const session = await auth.get(true)
      let identity = safeIdentity(session.email ?? session.name, secret, session.token)
      if (/^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(secret)) {
        const res = await fetch(`${this.opts.consoleHost.replace(/\/+$/, '')}${USER_INFO_PATH}`, {
          method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': this.opts.userAgent, 'x-cloudide-token': session.token }, body: '{}', signal: AbortSignal.timeout(15_000),
        })
        if (!res.ok) { await res.body?.cancel(); return failure(res.status === 401 || res.status === 403 ? 'invalid' : 'unavailable', res.status === 401 || res.status === 403 ? 'credential-rejected' : 'verification-unavailable') }
        let user
        try { user = parseUserInfo(await res.json()) } catch { return failure('unavailable', 'verification-protocol') }
        identity = safeIdentity(user.username, secret, session.token) ?? identity
      }
      if (!session.expiryKnown) return failure('unavailable', 'verification-protocol')
      if (!Number.isFinite(session.expiresAt) || session.expiresAt <= Date.now()) return failure('invalid', 'credential-expired')
      return { validation: 'valid', checkedAt, validatedUntil: session.expiresAt, reasonCode: null, identity }
    } catch (error) {
      const code = (error as { code?: string })?.code
      return failure(code === 'AUTH' || code === 'INVALID_CREDENTIAL' ? 'invalid' : 'unavailable', code === 'AUTH' || code === 'INVALID_CREDENTIAL' ? 'credential-rejected' : code === 'PROVIDER_PROTOCOL_ERROR' ? 'verification-protocol' : 'verification-unavailable')
    }
  }
}
