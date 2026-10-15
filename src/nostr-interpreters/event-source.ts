import type { NostrEvent, NostrFilter } from '../lib/nostr-tools'

/**
 * Where interpreters get their events from: an archive first, the relays
 * otherwise.
 *
 * `fetchEvents()` (helpers.ts) asks relays over websockets, or a source it is
 * handed instead. An archive is a source that can also say what it holds and
 * whether it is reachable: a copy of the nas lake's follow, mute, report and
 * reaction edges, served over HTTP (sources/lake.ts). The interpreters never
 * see the difference: they read only `pubkey`, `kind`, `tags`, `id` and
 * `created_at` of what comes back.
 *
 * Each interpreter chooses once per request, in `fetchData()`
 * (classes.ts), with `chooseEventSource()`: the request's `liveNetwork`
 * flag forces the relays; otherwise the archive answers when one is
 * registered, holds the interpreter's kinds, and answers a ping. The
 * controllers never see the choice; the interpreter records it in
 * `eventSource` and the service layer reports it.
 *
 * Not named `EventSource`: that is a global in Node 22 and browsers.
 */
export type NostrEventSource = (filter: NostrFilter) => Promise<Set<NostrEvent>>

export type NostrEventArchive = {
  /** Answers a filter of `authors` and `kinds`; empty for what it cannot answer; never throws. */
  source: NostrEventSource
  /** Whether the archive can answer this filter at all: its kinds are held and its keys are understood. */
  covers(filter: NostrFilter): boolean
  /** Whether the archive is there right now (a HEAD on its manifest, a file check). */
  ping(): Promise<boolean>
  /** One line for logs and feedback: where it is, which runs, as of when. */
  describe(): string
}

/** What an interpreter decided for a request, and why. */
export type EventSourceChoice = {
  source: 'archive' | 'relays'
  /** `liveNetwork`, `no archive`, `not held`, `archive unreachable`, or the archive's description. */
  reason: string
}

let current: NostrEventArchive | undefined

/** Register the archive interpreters read first; `undefined` leaves only the relays. */
export function setArchive(archive?: NostrEventArchive): void {
  current = archive
}

export function getArchive(): NostrEventArchive | undefined {
  return current
}

/**
 * The archive when the request allows it, it is registered, it holds the
 * filter and it answers; the relays otherwise. `filter` is the shape of what
 * the interpreter will ask (its `fetchKinds` plus the request's own filter).
 */
export async function chooseEventSource(filter: NostrFilter, liveNetwork?: boolean): Promise<EventSourceChoice> {
  if (liveNetwork === true) return { source: 'relays', reason: 'liveNetwork' }
  const archive = getArchive()
  if (!archive) return { source: 'relays', reason: 'no archive' }
  if (!archive.covers(filter)) return { source: 'relays', reason: 'not held' }
  let reachable = false
  try {
    reachable = await archive.ping()
  } catch {
    reachable = false
  }
  if (!reachable) return { source: 'relays', reason: 'archive unreachable' }
  return { source: 'archive', reason: archive.describe() }
}
