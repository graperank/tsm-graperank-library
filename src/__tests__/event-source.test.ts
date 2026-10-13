import type { NostrEvent, NostrFilter } from '../lib/nostr-tools'
import { fetchEvents } from '../nostr-interpreters/helpers'
import { getEventSource, setEventSource } from '../nostr-interpreters/event-source'

// Any attempt to open a websocket fails the test: with a source registered,
// fetchEvents must never reach the relay code.
jest.mock('ws', () => ({
  __esModule: true,
  default: jest.fn(() => {
    throw new Error('a websocket was opened')
  }),
}))

const A = 'aa'.repeat(32)
const B = 'bb'.repeat(32)

function event(pubkey: string, tags: string[][]): NostrEvent {
  return { id: '11'.repeat(32), pubkey, created_at: 1700000000, kind: 3, tags, content: '', sig: 'sig' }
}

describe('event source switch', () => {
  afterEach(() => setEventSource(undefined))

  test('nothing registered: no source, and empty relays give an empty set as before', async () => {
    expect(getEventSource()).toBeUndefined()
    const result = await fetchEvents({ authors: [A], kinds: [3] }, [])
    expect(result.size).toBe(0)
  })

  test('a registered source answers fetchEvents; the relays are never contacted', async () => {
    const seen: NostrFilter[] = []
    setEventSource(async (filter) => {
      seen.push(filter)
      return new Set([event(A, [['p', B]])])
    })
    const filter: NostrFilter = { authors: [A], kinds: [3] }
    const result = await fetchEvents(filter, ['wss://relay.invalid'])
    expect([...result].map((e) => e.pubkey)).toEqual([A])
    expect(seen).toEqual([filter])
  })

  test('the source sees the filter as the interpreter built it: no relay limit added', async () => {
    const seen: NostrFilter[] = []
    setEventSource(async (filter) => {
      seen.push({ ...filter })
      return new Set()
    })
    await fetchEvents({ authors: [A], kinds: [3] }, ['wss://relay.invalid'])
    expect(seen[0].limit).toBeUndefined()
  })

  test('unregistering restores the relay path', async () => {
    setEventSource(async () => new Set([event(A, [])]))
    setEventSource(undefined)
    expect(getEventSource()).toBeUndefined()
    expect((await fetchEvents({ authors: [A], kinds: [3] }, [])).size).toBe(0)
  })
})
