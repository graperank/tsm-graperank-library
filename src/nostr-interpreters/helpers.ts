import { NostrEvent, NostrFilter, SimplePool, useWebSocketImplementation, npubEncode, decode } from '../lib/nostr-tools'
import { EventReferenceTarget, EventReferenceType, EventReferenceTypes, EventTagTypes, EventTypes, NostrTagType, NostrType, PubkeyTypes } from './types'
import { RankedPov, UnrankedPov, actorId } from '../graperank/types'
import { EventActorReference } from '../graperank/nostr-types'


export const maxfetch = 500
const eventReferenceTagTypes: ReadonlyArray<NostrType> = [...EventTagTypes]
const eventReferenceTagTypeSet = new Set<string>(eventReferenceTagTypes)
const eventTypeSet = new Set<NostrType>(EventTypes as ReadonlyArray<NostrType>)
const pubkeyTypeSet = new Set<NostrType>(PubkeyTypes as ReadonlyArray<NostrType>)

const eventIdReferenceType: EventReferenceType = EventReferenceTypes[0]
const eventAddressReferenceType: EventReferenceType = EventReferenceTypes[1]

function isEventReferenceType(value: string): value is EventReferenceType {
  return (EventReferenceTypes as ReadonlyArray<string>).includes(value)
}

export function isEventType(value: NostrType): boolean {
  return eventTypeSet.has(value)
}

export function isPubkeyType(value: NostrType): boolean {
  return pubkeyTypeSet.has(value)
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function normalizeEventActorReference(reference: EventReferenceTarget | EventActorReference): EventActorReference | undefined {
  if (reference.referenceType === eventIdReferenceType) {
    const normalizedId = reference.value?.trim().toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(normalizedId)) return undefined
    return {
      referenceType: eventIdReferenceType,
      value: normalizedId,
      relayHints: mergeRelayLists(reference.relayHints),
    }
  }

  const coordinate = parseCoordinate(reference.value)
  if (!coordinate) return undefined

  return {
    referenceType: eventAddressReferenceType,
    value: `${coordinate.kind}:${coordinate.pubkey.toLowerCase()}:${coordinate.identifier}`,
    relayHints: mergeRelayLists(reference.relayHints),
  }
}

export function buildEventActorId(reference: EventReferenceTarget | EventActorReference): actorId | undefined {
  const normalizedEventActorReference = normalizeEventActorReference(reference)
  if (!normalizedEventActorReference) return undefined
  return `event:${normalizedEventActorReference.referenceType}:${normalizedEventActorReference.value}`
}

export function parseEventActorId(value: actorId): EventActorReference | undefined {
  const split = value.split(':')
  if (split.length < 3 || split[0] !== 'event') return undefined

  const referenceType = split[1]
  if (!isEventReferenceType(referenceType)) return undefined

  if (referenceType === eventIdReferenceType) {
    const eventId = split[2]
    return normalizeEventActorReference({
      referenceType: eventIdReferenceType,
      value: eventId,
      relayHints: [],
    })
  }

  if (referenceType === eventAddressReferenceType) {
    const coordinateValue = split.slice(2).join(':')
    return normalizeEventActorReference({
      referenceType: eventAddressReferenceType,
      value: coordinateValue,
      relayHints: [],
    })
  }

  return undefined
}

export function extractReferenceTags(sourceEvents: Set<NostrEvent>): Array<{ sourceEvent: NostrEvent; tag: string[] }> {
  const referenceTags: Array<{ sourceEvent: NostrEvent; tag: string[] }> = []

  for (const sourceEvent of sourceEvents) {
    for (const tag of sourceEvent.tags) {
      if (!tag[1]) continue
      if (!EventTagTypes.includes(tag[0] as typeof EventTagTypes[number])) continue
      referenceTags.push({ sourceEvent, tag })
    }
  }

  return referenceTags
}

export function parseReferenceRank(sourceEvent: NostrEvent, tag: string[]): number | undefined {
  if (sourceEvent.kind !== 37573) return undefined
  const parsedRank = Number(tag[2])
  if (!Number.isFinite(parsedRank)) return undefined
  return parsedRank
}

export function deriveActorIdsFromRankedPov(rankedPov: RankedPov): Set<actorId> {
  return new Set(rankedPov.map(([rankedActorId]) => rankedActorId))
}

export function isRelayUrl(value: string): boolean {
  return value.startsWith('ws://') || value.startsWith('wss://')
}

export function mergeRelayLists(...relayLists: Array<string[] | undefined>): string[] {
  const merged = new Set<string>()
  for (const relayList of relayLists) {
    if (!relayList) continue
    for (const relay of relayList) {
      const trimmed = relay?.trim()
      if (trimmed) merged.add(trimmed)
    }
  }
  return [...merged]
}

export function parseCoordinate(value: string): { kind: number; pubkey: string; identifier: string } | undefined {
  const parts = value.split(':', 3)
  if (parts.length !== 3) return undefined
  const kind = Number(parts[0])
  const pubkey = parts[1]?.trim()
  const identifier = parts[2]?.trim()
  if (!Number.isFinite(kind) || !pubkey || !identifier) return undefined
  return { kind, pubkey, identifier }
}

function normalizeEventReferenceValue(value: string): string {
  if (value.startsWith('nostr:')) return value.slice(6)
  return value
}

export function decodeEventReference(referenceValue: string): EventReferenceTarget | undefined {
  const normalizedReference = normalizeEventReferenceValue(referenceValue.trim())
  const relayHints: string[] = []

  if (/^[0-9a-fA-F]{64}$/.test(normalizedReference)) {
    return { referenceType: eventIdReferenceType, value: normalizedReference.toLowerCase(), relayHints }
  }

  const coordinate = parseCoordinate(normalizedReference)
  if (coordinate) {
    return {
      referenceType: eventAddressReferenceType,
      value: `${coordinate.kind}:${coordinate.pubkey.toLowerCase()}:${coordinate.identifier}`,
      relayHints,
    }
  }

  try {
    const decodedReference = decode(normalizedReference)
    if (decodedReference.type === 'note') {
      return {
        referenceType: eventIdReferenceType,
        value: String(decodedReference.data).toLowerCase(),
        relayHints,
      }
    }

    if (decodedReference.type === 'nevent') {
      const eventData = decodedReference.data as { id?: string; relays?: string[] }
      if (!eventData.id) return undefined
      return {
        referenceType: eventIdReferenceType,
        value: eventData.id.toLowerCase(),
        relayHints: mergeRelayLists(eventData.relays),
      }
    }

    if (decodedReference.type === 'naddr') {
      const naddrData = decodedReference.data as {
        kind?: number
        pubkey?: string
        identifier?: string
        relays?: string[]
      }
      if (!naddrData.kind || !naddrData.pubkey || !naddrData.identifier) return undefined
      return {
        referenceType: eventAddressReferenceType,
        value: `${naddrData.kind}:${naddrData.pubkey.toLowerCase()}:${naddrData.identifier}`,
        relayHints: mergeRelayLists(naddrData.relays),
      }
    }
  } catch {
    return undefined
  }

  return undefined
}

export function extractDTagValue(event: NostrEvent): string | undefined {
  return event.tags.find(tag => tag[0] === 'd' && tag[1])?.[1]
}

export function extractPaginationDTags(event: NostrEvent): string[] {
  const discovered: string[] = []
  for (const tag of event.tags) {
    if (tag[0] !== 'v' || !tag[1]?.startsWith('page:')) continue
    const encodedCandidates = tag[2]
    if (!encodedCandidates) continue

    try {
      const parsed = JSON.parse(encodedCandidates)
      if (Array.isArray(parsed)) {
        for (const dTagValue of parsed) {
          if (typeof dTagValue === 'string' && dTagValue.trim()) {
            discovered.push(dTagValue.trim())
          }
        }
      }
    } catch {
      // MVP behavior: silently skip malformed pagination tags
    }
  }
  return discovered
}

export function hasEventReferenceTags(events: Set<NostrEvent>): boolean {
  for (const event of events) {
    for (const tag of event.tags) {
      if (eventReferenceTagTypeSet.has(tag[0]) && !!tag[1]) {
        return true
      }
    }
  }
  return false
}

/**
 * Adapted from NDK
 * @param filters 
 * @returns 
 */
// ── Relay fetch configuration ────────────────────────────────────────────────

export interface RelayFetchConfig {
  /**
   * Relays the caller considers local and complete (same host or private
   * network). When every relay of a fetch is local, no inter-fetch delay
   * is applied and no end-of-stream grace is waited for stragglers.
   * Matched by normalized URL (case-insensitive, trailing slash ignored).
   * The library never assumes which relays are local; callers declare them.
   */
  localRelays: string[]
  /** After the first external relay ends its stream, wait at most this long for the others. */
  eoseGraceMs: number
  /** Give up on a fetch after this long regardless of relay state. */
  absoluteTimeoutMs: number
  /** Delay between consecutive fetches when any relay in the fetch is external (politeness). */
  interFetchDelayMs: number
  /** How long to wait for a relay websocket to open. */
  connectionTimeoutMs: number
}

const relayFetchConfig: RelayFetchConfig = {
  localRelays: [],
  eoseGraceMs: 2000,
  absoluteTimeoutMs: 12000,
  interFetchDelayMs: 500,
  connectionTimeoutMs: 5000,
}

export function normalizeRelayUrl(url: string): string {
  return url.trim().toLowerCase().replace(/\/+$/, '')
}

/** Override relay fetch behaviour. Unspecified fields keep their current value. */
export function configureRelayFetch(options: Partial<RelayFetchConfig>): RelayFetchConfig {
  if (options.localRelays) {
    relayFetchConfig.localRelays = options.localRelays.filter(isRelayUrl).map(normalizeRelayUrl)
  }
  for (const key of ['eoseGraceMs', 'absoluteTimeoutMs', 'interFetchDelayMs', 'connectionTimeoutMs'] as const) {
    const value = options[key]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) relayFetchConfig[key] = value
  }
  return getRelayFetchConfig()
}

export function getRelayFetchConfig(): RelayFetchConfig {
  return { ...relayFetchConfig, localRelays: [...relayFetchConfig.localRelays] }
}

export function isLocalRelay(url: string): boolean {
  return relayFetchConfig.localRelays.includes(normalizeRelayUrl(url))
}

export function allRelaysLocal(relays: string[]): boolean {
  return relays.length > 0 && relays.every(isLocalRelay)
}

/** Politeness delay to apply before a fetch against `relays`: none when all are local. */
export function fetchDelayFor(relays: string[]): number {
  return allRelaysLocal(relays) ? 0 : relayFetchConfig.interFetchDelayMs
}

// ── Shared connections (one per relay, reused across fetches) ────────────────

type WsModule = typeof import('ws')
let wsModulePromise: Promise<WsModule['default']> | undefined
function loadWs(): Promise<WsModule['default']> {
  if (!wsModulePromise) wsModulePromise = import('ws').then(m => m.default)
  return wsModulePromise
}

let sharedPool: SimplePool | undefined
let websocketImplementationInstalled = false

async function getSharedPool(): Promise<SimplePool> {
  if (!sharedPool) {
    // nostr-tools needs a global WebSocket; Node < 22 has none.
    if (!websocketImplementationInstalled && typeof (globalThis as { WebSocket?: unknown }).WebSocket === 'undefined') {
      const ws = await loadWs()
      useWebSocketImplementation(ws as unknown as typeof WebSocket)
      websocketImplementationInstalled = true
    }
    sharedPool = new SimplePool()
  }
  return sharedPool
}

interface RawSubscriptionHandlers {
  onEvent: (event: NostrEvent) => void
  onEose: () => void
  onClose: (reason: string) => void
}

/**
 * A single persistent websocket to one relay, multiplexing REQ
 * subscriptions by id. Used for kinds whose events can exceed what
 * nostr-tools is willing to validate (large follow lists), so that path
 * no longer opens a fresh connection per fetch.
 */
class RawRelayConnection {
  private ws: import('ws').WebSocket | undefined
  private opening: Promise<void> | undefined
  private readonly subscriptions = new Map<string, RawSubscriptionHandlers>()

  constructor(readonly url: string) {}

  private async open(): Promise<void> {
    if (this.ws && this.ws.readyState === this.ws.OPEN) return
    if (this.opening) return this.opening
    this.opening = (async () => {
      const WebSocketImpl = await loadWs()
      await new Promise<void>((resolve, reject) => {
        const socket = new WebSocketImpl(this.url)
        let settled = false
        const timer = setTimeout(() => {
          if (settled) return
          settled = true
          try { socket.terminate() } catch { /* ignore */ }
          reject(new Error(`connection timeout after ${relayFetchConfig.connectionTimeoutMs}ms`))
        }, relayFetchConfig.connectionTimeoutMs)

        socket.on('open', () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          this.ws = socket
          resolve()
        })
        socket.on('message', (data: Buffer) => this.dispatch(data))
        socket.on('error', (err: Error) => {
          if (!settled) {
            settled = true
            clearTimeout(timer)
            reject(err)
          } else {
            console.warn(`RawRelayConnection ${this.url}: error:`, err.message)
          }
        })
        socket.on('close', (code: number) => {
          if (!settled) {
            settled = true
            clearTimeout(timer)
            reject(new Error(`closed before open (code ${code})`))
          }
          if (this.ws === socket) this.ws = undefined
          const pending = [...this.subscriptions.entries()]
          this.subscriptions.clear()
          for (const [, handlers] of pending) handlers.onClose(`connection closed (code ${code})`)
        })
      })
    })().finally(() => { this.opening = undefined })
    return this.opening
  }

  private dispatch(data: Buffer): void {
    let message: unknown
    try { message = JSON.parse(data.toString()) } catch { return }
    if (!Array.isArray(message)) return
    const [type, subscriptionId, payload] = message as [string, string, unknown]
    const handlers = this.subscriptions.get(subscriptionId)
    if (!handlers) return
    if (type === 'EVENT') {
      handlers.onEvent(payload as NostrEvent)
    } else if (type === 'EOSE') {
      handlers.onEose()
    } else if (type === 'CLOSED') {
      this.subscriptions.delete(subscriptionId)
      handlers.onClose(typeof payload === 'string' ? payload : 'closed by relay')
    }
  }

  /**
   * Open a REQ. Returns a function that closes it. Connection failures are
   * reported through `handlers.onClose` so callers treat them like a relay
   * that answered with nothing.
   */
  async request(filters: NostrFilter, handlers: RawSubscriptionHandlers): Promise<() => void> {
    try {
      await this.open()
    } catch (err) {
      handlers.onClose(err instanceof Error ? err.message : String(err))
      return () => { /* nothing to close */ }
    }
    const socket = this.ws
    if (!socket) {
      handlers.onClose('no connection')
      return () => { /* nothing to close */ }
    }
    const subscriptionId = Math.random().toString(36).slice(2, 10)
    this.subscriptions.set(subscriptionId, handlers)
    try {
      socket.send(JSON.stringify(['REQ', subscriptionId, filters]))
    } catch (err) {
      this.subscriptions.delete(subscriptionId)
      handlers.onClose(err instanceof Error ? err.message : String(err))
      return () => { /* nothing to close */ }
    }
    return () => {
      if (!this.subscriptions.delete(subscriptionId)) return
      if (socket.readyState === socket.OPEN) {
        try { socket.send(JSON.stringify(['CLOSE', subscriptionId])) } catch { /* ignore */ }
      }
    }
  }

  terminate(): void {
    const socket = this.ws
    this.ws = undefined
    this.subscriptions.clear()
    if (socket) {
      try { socket.terminate() } catch { /* ignore */ }
    }
  }
}

const rawConnections = new Map<string, RawRelayConnection>()
function getRawConnection(url: string): RawRelayConnection {
  const key = normalizeRelayUrl(url)
  let connection = rawConnections.get(key)
  if (!connection) {
    connection = new RawRelayConnection(url)
    rawConnections.set(key, connection)
  }
  return connection
}

/** Tear down every shared relay connection (process shutdown, tests). */
export function closeRelayConnections(): void {
  for (const connection of rawConnections.values()) connection.terminate()
  rawConnections.clear()
  if (sharedPool) {
    try { sharedPool.destroy() } catch { /* ignore */ }
    sharedPool = undefined
  }
}

// ── Fetching ─────────────────────────────────────────────────────────────────

export async function fetchEvents(
    filters: NostrFilter,
    relays: string[]
): Promise<Set<NostrEvent>> {
    if (!relays || relays.length === 0) {
        return new Set()
    }

    // Add limit if not present (many relays require it)
    if (!filters.limit) {
        filters.limit = 1000;
    }
    console.log("fetchEvents called with relays:", relays, "relays length:", relays.length, "filters:", JSON.stringify(filters))

    // For replaceable kinds (0, 3, 10k-20k) use the raw connection to bypass
    // nostr-tools validation, which fails on very large events (620+ tags).
    const isReplaceableKind = filters.kinds?.includes(3) || filters.kinds?.includes(0) ||
                               (filters.kinds?.some(k => k >= 10000 && k < 20000))

    if (isReplaceableKind) {
        return fetchEventsRaw(filters, relays)
    }

    const pool = await getSharedPool()
    const events: Map<string, NostrEvent> = new Map()

    return new Promise((resolve) => {
        let resolved = false
        let subscription: { close: () => void } | undefined

        const finish = (reason: string) => {
            if (resolved) return
            resolved = true
            clearTimeout(absoluteTimer)
            try { subscription?.close() } catch (err) { console.warn("fetchEvents: subscription close failed:", err) }
            console.log("fetchEvents closing with", events.size, "events (" + reason + ")")
            resolve(new Set(events.values()))
        }

        const absoluteTimer = setTimeout(() => finish("absolute timeout"), relayFetchConfig.absoluteTimeoutMs)

        subscription = pool.subscribeMany([...relays], filters, {
            onevent(event: NostrEvent) {
                const dedupKey = deduplicationKey(event)
                const existingEvent = events.get(dedupKey)
                events.set(dedupKey, existingEvent ? dedupEvent(existingEvent, event) : event)
            },
            // nostr-tools fires `oneose` once every relay has ended its
            // stream or failed to connect, so nothing is gained by waiting
            // any longer.
            oneose() { finish("all relays ended") },
            onclose(reasons: string[]) { finish("all relays closed: " + reasons.join("; ")) },
        })
        if (resolved) {
            try { subscription.close() } catch { /* ignore */ }
        }
    });
}

/**
 * Fetch over persistent raw websockets (one per relay). Resolves when every
 * relay has ended its stream or failed, or, for fetches that include
 * external relays, `eoseGraceMs` after the first relay ends its stream, or
 * at `absoluteTimeoutMs`. Fetches against local relays only never wait for
 * stragglers.
 */
async function fetchEventsRaw(
    filters: NostrFilter,
    relays: string[]
): Promise<Set<NostrEvent>> {
    const events: Map<string, NostrEvent> = new Map()
    const graceMs = allRelaysLocal(relays) ? 0 : relayFetchConfig.eoseGraceMs

    return new Promise((resolve) => {
        let resolved = false
        let relaysDone = 0
        let eoseCount = 0
        let graceTimer: ReturnType<typeof setTimeout> | undefined
        const closers: Array<() => void> = []

        const finish = (reason: string) => {
            if (resolved) return
            resolved = true
            clearTimeout(absoluteTimer)
            if (graceTimer) clearTimeout(graceTimer)
            for (const close of closers) {
                try { close() } catch (err) { console.warn("fetchEventsRaw: close failed:", err) }
            }
            console.log("fetchEventsRaw closing with", events.size, "events from", eoseCount, "of", relays.length, "relays (" + reason + ")")
            resolve(new Set(events.values()))
        }

        const absoluteTimer = setTimeout(() => finish("absolute timeout"), relayFetchConfig.absoluteTimeoutMs)

        const relayDone = () => {
            relaysDone++
            if (relaysDone >= relays.length) finish("all relays done")
        }

        for (const relay of relays) {
            let done = false
            const once = (fn: () => void) => { if (!done) { done = true; fn() } }
            void getRawConnection(relay).request(filters, {
                onEvent: (event) => {
                    if (resolved || !event || typeof event !== 'object') return
                    const dedupKey = deduplicationKey(event)
                    const existingEvent = events.get(dedupKey)
                    events.set(dedupKey, existingEvent ? dedupEvent(existingEvent, event) : event)
                },
                onEose: () => once(() => {
                    eoseCount++
                    if (eoseCount === 1 && graceMs > 0 && !resolved) {
                        graceTimer = setTimeout(() => finish("grace after first end of stream"), graceMs)
                    }
                    relayDone()
                }),
                onClose: (reason) => once(() => {
                    if (!resolved) console.log("fetchEventsRaw relay", relay, "closed:", reason)
                    relayDone()
                }),
            }).then((close) => {
                if (resolved) close()
                else closers.push(close)
            })
        }
    })
}

function dedupEvent(event1: NostrEvent, event2: NostrEvent) {
  // return the newest of the two
  if (event1.created_at! > event2.created_at!) {
      return event1;
  }
  return event2;
}

/**
 * Provides a deduplication key for the event.
 *
 * For kinds 0, 3, 10k-20k this will be the event <kind>:<pubkey>
 * For kinds 30k-40k this will be the event <kind>:<pubkey>:<d-tag>
 * For all other kinds this will be the event id
 */
function deduplicationKey(event: NostrEvent): string {
  if (
      event.kind === 0 ||
      event.kind === 3 ||
      (event.kind >= 10000 && event.kind < 20000)
  ) {
      return `${event.kind}:${event.pubkey}`;
  } else if (event.kind >= 30000 && event.kind < 40000) {
      const dTag = event.tags.find(tag => tag[0] === 'd')?.[1] || '';
      return `${event.kind}:${event.pubkey}:${dTag}`;
  } else {
      return event.id;
  }
}

// Helper function to slice big arrays
export function sliceBigArray<T>(array: T[], chunkSize: number): T[][] {
  const result: T[][] = []
  for (let i = 0; i < array.length; i += chunkSize) {
    result.push(array.slice(i, i + chunkSize))
  }
  return result
}

// Actors are always EITHER event types or pubkey types
export function getEventActor(actorType : NostrType, event : NostrEvent) : string | undefined {
  if(!actorType || (!isPubkeyType(actorType) && !isEventType(actorType))) return
  return getEventSubject(actorType, event)
}

// Subject may be any valid event field or tag
export function getEventSubject(subjectType : NostrType, event : NostrEvent, tag? : string[], tagIndex = 1) : string | undefined {
  let subject : string | undefined
  if(subjectType == "pubkey") subject = event.pubkey
  if(subjectType == "id") subject = event.id
  if(!subject && tag && tag[0] == subjectType) subject = tag[tagIndex]
  if(!subject){
    // matches the first matching tag value
    subject = event.tags.find(tag => tag[0] == subjectType)?.[tagIndex]
  }
  if(!validateNostrTypeValue(subjectType, subject)) return undefined
  return subject
}


export function validateNostrTypeValue(type: NostrType, value?: string): boolean {
  if(!value) return false
  if (isPubkeyType(type)) {
    return validatePubkey(value)
  }
  return true
}


export function validatePubkey(pubkey : string){
  try{
    npubEncode(pubkey)
  }catch(e){
    return false
  }
  return true
}

  // Helper to convert all POV formats to RankedPov format
  export function normalizePov(pov: RankedPov | UnrankedPov): RankedPov {
    if (typeof pov === 'string') {
      return [[pov]]
    } else if (Array.isArray(pov)) {
      if (pov.length === 0) {
        return []
      } else if (Array.isArray(pov[0])) {
        // RankedPov format: [[actorId, rank], ...]
        return pov as RankedPov
      } else {
        // UnrankedPov array format: [actorId, ...]
        return pov.map(actorId => [actorId]) as RankedPov
      }
    }
    return []
  }
