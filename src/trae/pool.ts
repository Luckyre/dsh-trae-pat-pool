/**
 * A pool of Trae PATs — several seats, one plugin.
 *
 * One PAT is one seat: it has its own quota, its own rate limit and its own
 * expiry. A team with three seats gets three times the throughput — but only
 * if something moves between them, and until now the plugin had exactly one
 * credential slot (`patEnv`). A second PAT could only be used by editing the
 * settings and reloading the plugin, which is a switch, not a pool.
 *
 * This module is that "something". The roster is **declared**, not discovered:
 * a PAT has no local account storage the way `dsh-connect-trae`'s accounts do
 * (those are mirrored out of the Trae desktop app's login store), so the user
 * names the credential references that make up the pool. The reference names
 * are what the credential store holds them under; the PAT itself never enters
 * a config file.
 *
 * Two modes, because they answer different questions:
 *
 * - `failover` — a sticky primary answers every request, and the pool only
 *   moves when that seat is refused (its quota is spent, upstream throttled
 *   it, the PAT itself was rejected). One upstream conversation keeps
 *   serving, so the shared prefix cache (`use_prompt_cache_pool`) keeps
 *   working.
 * - `rotate` — every request starts on the next member, spreading the quota
 *   over the seats. The price is that prefix cache: upstream binds the shared
 *   prefix to the conversation, and a different seat does not share it.
 *
 * A member is **excluded** after a member-scoped failure, for as long as
 * upstream says, or for a fallback window when it does not. Those
 * measurements live on disk, outside the settings, for the same reason
 * `dsh-connect-trae` keeps them there: a settings save must not roll a fresh
 * measurement back to a minutes-old draft.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { TraeAuth, type TraeSession } from './auth.ts'
import type { QuotaSnapshot } from './quota.ts'

/** How the pool hands out its members. */
export type PoolMode = 'failover' | 'rotate'

/**
 * Credential reference names a user may put in the roster. The reference is a
 * key in the credential store and a key in the probe file — never a path — so
 * this only has to keep the two apart, not the filesystem.
 */
export const MEMBER_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/**
 * What a measurement says about one member.
 *
 * `credential-rejected` is the only permanent one: the PAT itself was
 * refused, and only editing that PAT can fix it. Everything else expires.
 */
export type MemberOutcome =
  | 'ok'
  | 'credential-rejected'
  | 'rate-limited'
  | 'out-of-credit'
  | 'unavailable'
  | 'unusable'

export interface MemberProbe {
  outcome: MemberOutcome
  /** Epoch ms of the measurement. */
  atMs: number
  /** Epoch ms the member may serve again; absent = "not before the fallback window". */
  retryAtMs?: number
  /** What upstream said, for the card and the logs. Never a credential. */
  message?: string
}

/** How long a member stays out when upstream states no reset time. */
export const FALLBACK_COOLDOWN_MS = 30 * 60_000

/**
 * Failure codes that are about the seat rather than about the request.
 *
 * `CONTEXT_WINDOW_EXCEEDED` and `MODEL_NOT_FOUND` are deliberately absent:
 * they say something about the prompt or the catalog, and replaying them on
 * another seat would burn the same error twice while teaching the pool a
 * false fact about a member that never got a chance to serve.
 */
export const FAILOVER_CODES: ReadonlySet<string> = new Set(['AUTH', 'RATE_LIMIT', 'QUOTA', 'SERVER'])

/** The outcome a failure code leaves behind. */
export function outcomeOfCode(code: string): MemberOutcome {
  switch (code) {
    case 'AUTH': return 'credential-rejected'
    case 'RATE_LIMIT': return 'rate-limited'
    case 'QUOTA': return 'out-of-credit'
    case 'SERVER': return 'unavailable'
    default: return 'unusable'
  }
}

/** The outcome a failed PAT exchange leaves behind. */
export function outcomeOfExchangeError(code: string): MemberOutcome {
  // A transport fault is not the PAT's fault: the seat may be fine.
  if (code === 'AUTH' || code === 'INVALID_CREDENTIAL') return 'credential-rejected'
  return 'unavailable'
}

/** Whether a member's cooldown is over. */
export function retryDue(probe: MemberProbe, nowMs: number, fallbackMs = FALLBACK_COOLDOWN_MS): boolean {
  return nowMs >= (probe.retryAtMs ?? probe.atMs + fallbackMs)
}

/**
 * Why this member is not a candidate right now, or `undefined` when it is.
 *
 * An unknown outcome becomes `unusable` rather than being guessed healthy —
 * a measurement that cannot be read is not evidence that the seat works.
 */
export function exclusionOf(probe: MemberProbe | undefined, nowMs: number): string | undefined {
  if (!probe) return undefined
  switch (probe.outcome) {
    case 'ok': return undefined
    // Permanent: the PAT was refused. Editing that PAT clears it.
    case 'credential-rejected': return 'credential-rejected'
    case 'rate-limited': return retryDue(probe, nowMs) ? undefined : 'rate-limited'
    case 'out-of-credit': return retryDue(probe, nowMs) ? undefined : 'out-of-credit'
    case 'unavailable': return retryDue(probe, nowMs) ? undefined : 'unavailable'
    case 'unusable': return retryDue(probe, nowMs) ? undefined : 'unusable'
  }
}

/**
 * Fold a new measurement into the old one.
 *
 * A plain spread is wrong here: a live failure that states no reset time
 * would DELETE the reset point an earlier measurement had resolved, and the
 * member would be let back in early. So `retryAtMs` and `message` are
 * inherited unless the update states its own.
 */
export function mergeProbe(existing: MemberProbe | undefined, update: MemberProbe): MemberProbe {
  if (!existing) return { ...update }
  return {
    outcome: update.outcome,
    atMs: update.atMs,
    retryAtMs: update.retryAtMs ?? existing.retryAtMs,
    ...update.message !== undefined ? { message: update.message } : existing.message !== undefined ? { message: existing.message } : {},
  }
}

/** Where the measurements live: `$DSH_HOME/.trae-pat-pool.json`. */
export function poolStorePath(): string {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, '.trae-pat-pool.json')
}

/** A member id is a credential reference; anything else is not addressable. */
export function isMemberRef(value: unknown): value is string {
  return typeof value === 'string' && MEMBER_REF_RE.test(value)
}

function isProbe(value: unknown): value is MemberProbe {
  if (typeof value !== 'object' || value === null) return false
  const probe = value as Record<string, unknown>
  return typeof probe.outcome === 'string' && typeof probe.atMs === 'number' && Number.isFinite(probe.atMs)
}

/**
 * Read the measurements. Never throws: a missing, unreadable or malformed
 * file means "nothing measured yet", because a broken observations file must
 * not break the chat.
 */
export async function readProbes(path: string): Promise<Record<string, MemberProbe>> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return {}
  }
  try {
    const parsed = JSON.parse(text) as unknown
    if (typeof parsed !== 'object' || parsed === null) return {}
    const probes = (parsed as Record<string, unknown>).probes
    if (typeof probes !== 'object' || probes === null) return {}
    const out: Record<string, MemberProbe> = {}
    for (const [ref, probe] of Object.entries(probes as Record<string, unknown>)) {
      if (isMemberRef(ref) && isProbe(probe)) out[ref] = probe
    }
    return out
  } catch {
    return {}
  }
}

/**
 * Merge measurements into the file and write it back. Never throws: a failed
 * write costs the pool its memory of a failure, not the user's turn.
 */
export async function writeProbes(path: string, updates: Record<string, MemberProbe>): Promise<void> {
  try {
    const current = await readProbes(path)
    const merged: Record<string, MemberProbe> = { ...current }
    for (const [ref, update] of Object.entries(updates)) {
      if (!isMemberRef(ref)) continue
      merged[ref] = mergeProbe(current[ref], update)
    }
    await mkdir(join(path, '..'), { recursive: true })
    const temporary = `${path}.tmp`
    await writeFile(temporary, JSON.stringify({ version: 1, probes: merged }, null, 2), { mode: 0o600 })
    await rename(temporary, path)
  } catch {
    /* a measurement that could not be written is a measurement we forget */
  }
}

/**
 * One seat: a PAT, and — for an enterprise seat — the console login that
 * reads its quota.
 *
 * The seat is DECLARED, not discovered: a PAT has no local account storage
 * the way `dsh-connect-trae`'s accounts do (those are mirrored out of the Trae
 * desktop app's login store), so the user names the credential references
 * that make up the pool. The references are names in the credential store; the
 * PATs themselves never enter a config file.
 */
export interface TraeSeat {
  /** The seat's label, as the user typed it. Shown in the pool table. */
  name: string
  /** Credential reference holding this seat's PAT. */
  pat: string
  /** Credential reference holding the console e-mail; empty = no console account. */
  email: string
  /** Credential reference holding the console password; empty = no console account. */
  password: string
}

/**
 * A seat's enterprise-console reader.
 *
 * Only the two methods the quota needs; the console itself lives in
 * `tob.ts`, and the pool holds one instance per seat, so two seats can never
 * share a session.
 */
export interface SeatConsole {
  read(now?: number): Promise<QuotaSnapshot | undefined>
  reset(): void
}

export interface TraePatPoolOptions {
  host: string
  clientId: string
  userAgent: string
  /** The declared roster, in priority order. */
  seats: () => readonly TraeSeat[]
  /** How the pool hands out members. */
  mode: () => PoolMode
  /** One member's secret, from the credential store. */
  readSecret: (ref: string) => Promise<string | undefined>
  /** The single PAT used when the roster is empty. */
  singleRef: () => string
  /** Builds the enterprise-console reader for one seat. */
  consoleFor?: (seat: TraeSeat) => SeatConsole | undefined
  /** How many members one request may try. */
  maxAttempts: () => number
  logger: { info(...a: unknown[]): void; warn(...a: unknown[]): void }
  /** Where the measurements live; defaults to `$DSH_HOME/.trae-pat-pool.json`. */
  storeFile?: string
}

/** One member's pick for a request. */
export interface PoolPick {
  /** The credential reference; empty in single-PAT mode. */
  memberId: string
  session: TraeSession
}

/**
 * The pool itself.
 *
 * It answers the same questions as the single-PAT {@link TraeAuth} — a
 * session, a way to drop it, the last one handed out — so every other part of
 * the plugin keeps working unchanged; the pool only adds the ability to move
 * between members.
 */
export class TraePatPool {
  private readonly auths = new Map<string, TraeAuth>()
  private readonly consoles = new Map<string, SeatConsole>()
  private probes: Record<string, MemberProbe> | undefined
  private cursor = 0
  private lastMemberId: string | undefined

  constructor(private readonly opts: TraePatPoolOptions) {}

  /**
   * The declared seats, with unusable entries dropped.
   *
   * A seat needs a PAT reference to exist at all; the console references are
   * optional, because a personal seat has no console account.
   */
  seats(): TraeSeat[] {
    const seen = new Set<string>()
    const out: TraeSeat[] = []
    for (const seat of this.opts.seats()) {
      if (!isMemberRef(seat.pat) || seen.has(seat.pat)) continue
      seen.add(seat.pat)
      out.push({
        name: typeof seat.name === 'string' ? seat.name : '',
        pat: seat.pat,
        email: isMemberRef(seat.email) ? seat.email : '',
        password: isMemberRef(seat.password) ? seat.password : '',
      })
    }
    return out
  }

  /** The roster's PAT references, in order. */
  refs(): string[] {
    return this.seats().map((seat) => seat.pat)
  }

  /**
   * Whether the pool can actually move.
   *
   * A roster of one is not a pool: there is nowhere else to go, so the
   * plugin behaves exactly as it did before the pool existed — no failover,
   * no measurements, no extra requests.
   */
  active(): boolean { return this.refs().length > 1 }

  /** How many members one request may try. */
  get attempts(): number { return Math.max(1, this.opts.maxAttempts()) }

  /** The member that served the last request, for a failure report. */
  get serving(): string | undefined { return this.lastMemberId }

  /** One member's authenticator, with its own JWT cache. */
  private authFor(ref: string): TraeAuth {
    let auth = this.auths.get(ref)
    if (!auth) {
      auth = new TraeAuth({
        host: this.opts.host,
        clientId: this.opts.clientId,
        userAgent: this.opts.userAgent,
        readSecret: () => this.opts.readSecret(ref),
      })
      this.auths.set(ref, auth)
    }
    return auth
  }

  /**
   * One seat's own JWT.
   *
   * The quota reads every seat's figure, so it needs each seat's token — not
   * "the one that would serve now", which is what {@link get} answers.
   */
  async sessionFor(ref: string): Promise<TraeSession> {
    return await this.authFor(ref).get()
  }

  /**
   * One seat's enterprise-console reader.
   *
   * The console login belongs to a seat, not to the plugin: two seats that
   * shared one console account would report the same figures twice, so each
   * seat gets its own reader and its own session.
   */
  consoleFor(seat: TraeSeat): SeatConsole | undefined {
    if (!seat.email || !seat.password) return undefined
    const factory = this.opts.consoleFor
    if (!factory) return undefined
    let reader = this.consoles.get(seat.pat)
    if (!reader) {
      reader = factory(seat)
      if (!reader) return undefined
      this.consoles.set(seat.pat, reader)
    }
    return reader
  }

  /**
   * A session for the member that should serve now.
   *
   * In single-PAT mode this is the configured PAT and nothing else. In pool
   * mode it is the first usable member, skipping the ones a measurement says
   * are out.
   */
  async get(force = false): Promise<TraeSession> {
    const refs = this.refs()
    if (!this.active()) {
      // One seat (or none): the configured PAT, exactly as before the pool
      // existed — no measurements, no files, no extra requests.
      return await this.authFor(refs[0] ?? this.opts.singleRef()).get(force)
    }
    const probes = await this.probeState()
    const now = Date.now()
    const usable = refs.filter((ref) => !exclusionOf(probes[ref], now))
    const candidates = usable.length > 0 ? usable : refs
    let firstError: unknown
    for (const ref of candidates) {
      try {
        const session = await this.authFor(ref).get(force)
        this.lastMemberId = ref
        return session
      } catch (error) {
        firstError ??= error
        await this.report(ref, outcomeOfExchangeError(codeOf(error)), messageOf(error))
      }
    }
    throw firstError ?? new LlmError('Trae：号池里没有可用的 PAT。', 'MISSING_CREDENTIAL')
  }

  /** The last session this pool handed out. */
  get current(): TraeSession | undefined {
    const refs = this.refs()
    const ref = refs.length > 0 ? refs[0]! : this.opts.singleRef()
    return this.authFor(ref).current
  }

  /** Drop every cached JWT — the roster or the settings may have changed. */
  reset(): void {
    for (const auth of this.auths.values()) auth.reset()
    for (const reader of this.consoles.values()) reader.reset()
    this.probes = undefined
  }

  /**
   * Drop one member's cached JWT and forget what was measured about it.
   *
   * The PAT behind a reference changed, so the old measurement is about a
   * secret that no longer exists: keeping it would keep a fixed PAT out of
   * the pool.
   */
  async resetMember(ref: string): Promise<void> {
    this.auths.get(ref)?.reset()
    const state = await this.probeState()
    if (!(ref in state)) return
    const next = { ...state }
    delete next[ref]
    this.probes = next
    await this.persist(next)
  }

  /**
   * Reset whatever a changed credential reference belongs to.
   *
   * A reference can be a seat's PAT or its console e-mail or password, and
   * only the seat that owns it is affected — the other seats keep their warm
   * sessions. The measurement is dropped only when the PAT itself changed:
   * a new console password says nothing about the seat's quota ability.
   */
  async resetByRef(ref: string): Promise<void> {
    const seat = this.seats().find((s) => s.pat === ref || s.email === ref || s.password === ref)
    if (!seat) return
    this.auths.get(seat.pat)?.reset()
    this.consoles.get(seat.pat)?.reset()
    if (seat.pat === ref) await this.resetMember(seat.pat)
  }

  /**
   * The member that should serve the next request.
   *
   * `tried` holds the members this request already failed on; they are not
   * offered again, so one request walks the pool instead of hammering the
   * same seat.
   */
  async prepare(tried: string[] = []): Promise<PoolPick> {
    if (!this.active()) {
      // One seat: the configured PAT, exactly as before the pool existed.
      return { memberId: '', session: await this.get() }
    }
    const pick = await this.pick(tried)
    if (pick) return pick
    throw new LlmError('Trae：号池里没有可用的 PAT。', 'MISSING_CREDENTIAL')
  }

  /**
   * A fresh JWT for the member that is serving — the first half of the
   * two-stage 401 rule: a refused request may mean the JWT went stale, not
   * that the PAT is bad.
   */
  async refresh(memberId: string): Promise<TraeSession> {
    const ref = memberId || this.opts.singleRef()
    return await this.authFor(ref).get(true)
  }

  /**
   * Record a member-scoped failure and move to the next member.
   *
   * Returns `undefined` when the failure is not the member's fault, or when
   * the pool has nobody left to try — the caller then reports the original
   * error.
   */
  async stepAside(memberId: string, code: string, message: string, tried: string[]): Promise<PoolPick | undefined> {
    if (!this.active()) return undefined
    if (!FAILOVER_CODES.has(code)) return undefined
    // The seat that just failed counts as one of the attempts, so a request
    // that may try three seats moves twice and then reports the failure.
    if (tried.length + 1 >= this.opts.maxAttempts()) return undefined
    await this.report(memberId, outcomeOfCode(code), message)
    tried.push(memberId)
    return await this.pick(tried)
  }

  /**
   * Record a failure against the member that served, without moving on.
   *
   * Used for a failure that arrives inside the response stream, where the
   * retry happens further out and the pool is asked for a member then.
   */
  async reportFailure(code: string, message: string): Promise<void> {
    if (!this.active()) return
    const memberId = this.lastMemberId
    if (!memberId) return
    if (!FAILOVER_CODES.has(code)) return
    await this.report(memberId, outcomeOfCode(code), message)
  }

  /** The members that could serve right now, with the reason for the rest. */
  async status(): Promise<{ ref: string; usable: boolean; reason?: string; outcome?: MemberOutcome; retryAtMs?: number }[]> {
    const probes = await this.probeState()
    const now = Date.now()
    return this.refs().map((ref) => {
      const probe = probes[ref]
      const reason = exclusionOf(probe, now)
      return {
        ref,
        usable: reason === undefined,
        ...reason ? { reason } : {},
        ...probe ? { outcome: probe.outcome } : {},
        ...probe?.retryAtMs !== undefined ? { retryAtMs: probe.retryAtMs } : {},
      }
    })
  }

  /**
   * The next member worth trying.
   *
   * Order is the declared order (the first reference is the sticky primary),
   * except in `rotate` mode, where the roster is turned so each request
   * starts on the next member. Members a measurement excluded are skipped
   * unless that leaves nobody — a cooldown is a preference, not a ban.
   */
  private async pick(tried: string[]): Promise<PoolPick | undefined> {
    const refs = this.refs()
    if (refs.length === 0) return undefined
    const probes = await this.probeState()
    const now = Date.now()
    const usable = refs.filter((ref) => !tried.includes(ref) && !exclusionOf(probes[ref], now))
    const fallback = refs.filter((ref) => !tried.includes(ref))
    const candidates = usable.length > 0 ? usable : fallback
    if (candidates.length === 0) return undefined
    const ordered = this.opts.mode() === 'rotate' ? this.rotated(candidates) : candidates
    let firstError: unknown
    for (const ref of ordered) {
      try {
        const session = await this.authFor(ref).get()
        this.lastMemberId = ref
        return { memberId: ref, session }
      } catch (error) {
        firstError ??= error
        await this.report(ref, outcomeOfExchangeError(codeOf(error)), messageOf(error))
      }
    }
    if (firstError) throw firstError
    return undefined
  }

  /** Turn the roster so the next request starts on the next member. */
  private rotated(candidates: string[]): string[] {
    if (candidates.length === 0) return candidates
    const start = this.cursor % candidates.length
    this.cursor = (this.cursor + 1) % candidates.length
    return [...candidates.slice(start), ...candidates.slice(0, start)]
  }

  private async probeState(): Promise<Record<string, MemberProbe>> {
    if (!this.probes) this.probes = await readProbes(this.storeFile())
    return this.probes
  }

  private storeFile(): string {
    return this.opts.storeFile ?? poolStorePath()
  }

  /** Measure one member and remember it. */
  private async report(ref: string, outcome: MemberOutcome, message?: string): Promise<void> {
    const atMs = Date.now()
    const probe: MemberProbe = {
      outcome,
      atMs,
      // A refused PAT stays out until it is edited; everything else cools down.
      ...outcome === 'credential-rejected' ? {} : { retryAtMs: atMs + FALLBACK_COOLDOWN_MS },
      ...message ? { message: message.slice(0, 400) } : {},
    }
    const state = await this.probeState()
    this.probes = { ...state, [ref]: mergeProbe(state[ref], probe) }
    await writeProbes(this.storeFile(), { [ref]: probe })
    this.opts.logger.warn(
      `dsh-trae-pat-pool: 号池成员 ${ref} 暂停使用（${outcome}${message ? `：${message}` : ''}）`,
    )
  }

  /** Write a probe map out without merging (used when a member is cleared). */
  private async persist(probes: Record<string, MemberProbe>): Promise<void> {
    try {
      await mkdir(join(this.storeFile(), '..'), { recursive: true })
      await writeFile(this.storeFile(), JSON.stringify({ version: 1, probes }, null, 2), { mode: 0o600 })
    } catch {
      /* the pool forgets; the chat does not care */
    }
  }
}

/** The failure code an error carries, when it is one of ours. */
function codeOf(error: unknown): string {
  return error instanceof LlmError ? error.code : 'UNKNOWN'
}

/** The message an error carries, for the measurement and the log. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
