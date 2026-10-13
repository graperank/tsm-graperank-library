import type { NostrEvent, NostrFilter } from '../lib/nostr-tools'

/**
 * Where interpreters get their events from.
 *
 * `fetchEvents()` (helpers.ts) asks relays over websockets. A registered
 * source answers the same question from somewhere else, such as a local copy
 * of the nas lake's follow and mute edges, and the interpreters never know
 * the difference: they read only `pubkey`, `kind`, `tags`, `id` and
 * `created_at` of what comes back.
 *
 * The filter is passed exactly as the interpreter built it (`authors` and
 * `kinds`, plus anything from the request's own filter). A source that cannot
 * answer a filter returns an empty set; it never throws.
 *
 * Not named `EventSource`: that is a global in Node 22 and browsers.
 */
export type NostrEventSource = (filter: NostrFilter) => Promise<Set<NostrEvent>>

let current: NostrEventSource | undefined

/** Register the source `fetchEvents()` should use; `undefined` restores the relays. */
export function setEventSource(source?: NostrEventSource): void {
  current = source
}

export function getEventSource(): NostrEventSource | undefined {
  return current
}
