/** Bounded main-request snapshots. Callers identify every update by request id. */
export interface RequestTrack {
  requestId: string
  session: string
  phase: 'selecting' | 'running' | 'completed' | 'failed' | 'cancelled'
  seatId: string | null
  seatName: string | null
  credentialVersion: string | null
  model: string
  startedAt: number
  finishedAt: number | null
  switches: { from: string; to: string; reasonCode: string; at: number }[]
}
export class RequestUsage {
  private readonly sessions = new Map<string, RequestTrack>()
  private latestId: string | undefined
  constructor(private readonly limit = 64) {}
  start(session: string, requestId: string, model: string): void {
    this.sessions.delete(session)
    this.sessions.set(session, { requestId, session, model, phase: 'selecting', seatId: null, seatName: null, credentialVersion: null, startedAt: Date.now(), finishedAt: null, switches: [] })
    this.latestId = requestId
    while (this.sessions.size > this.limit) this.sessions.delete(this.sessions.keys().next().value!)
  }
  select(session: string, requestId: string, seatId: string, seatName: string, reasonCode = 'retry', credentialVersion: string | null = null): void {
    const track = this.sessions.get(session)
    if (!track || track.requestId !== requestId) return
    if (track.seatId && track.seatId !== seatId) {
      track.switches.push({ from: track.seatId, to: seatId, reasonCode, at: Date.now() })
      track.switches = track.switches.slice(-10)
    }
    track.seatId = seatId; track.seatName = seatName; track.credentialVersion = credentialVersion; track.phase = 'running'
  }
  finish(session: string, requestId: string, phase: 'completed' | 'failed' | 'cancelled'): void {
    const track = this.sessions.get(session)
    if (!track || track.requestId !== requestId) return
    track.phase = phase; track.finishedAt = Date.now()
  }
  get(session: string): RequestTrack | null {
    const track = this.sessions.get(session)
    return track ? { ...track, switches: track.switches.map(s => ({ ...s })) } : null
  }
  latest(): RequestTrack | null {
    for (const track of this.sessions.values()) if (track.requestId === this.latestId) return this.get(track.session)
    return null
  }
}
