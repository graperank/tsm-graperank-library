import type { NostrEvent, NostrFilter } from '../lib/nostr-tools'
import { fetchEvents } from '../nostr-interpreters/helpers'
import { chooseEventSource, getArchive, setArchive, NostrEventArchive } from '../nostr-interpreters/event-source'

// Any attempt to open a websocket fails the test: with a source given,
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

/** A stub archive holding `kinds`, reachable unless told otherwise. */
function archive(kinds: number[], up = true): NostrEventArchive {
  return {
    source: async () => new Set([event(A, [['p', B]])]),
    covers: (filter) => (filter.kinds ?? []).every((k) => kinds.includes(k)),
    ping: async () => up,
    describe: () => `stub lake holding ${kinds.join(',')}`,
  }
}

describe('fetchEvents with an explicit source', () => {
  test('no source and empty relays give an empty set, as before', async () => {
    expect((await fetchEvents({ authors: [A], kinds: [3] }, [])).size).toBe(0)
  })

  test('a source given answers; the relays are never contacted', async () => {
    const seen: NostrFilter[] = []
    const source = async (filter: NostrFilter) => {
      seen.push(filter)
      return new Set([event(A, [['p', B]])])
    }
    const filter: NostrFilter = { authors: [A], kinds: [3] }
    const result = await fetchEvents(filter, ['wss://relay.invalid'], source)
    expect([...result].map((e) => e.pubkey)).toEqual([A])
    expect(seen).toEqual([filter])
  })

  test('the source sees the filter as the interpreter built it: no relay limit added', async () => {
    const seen: NostrFilter[] = []
    await fetchEvents({ authors: [A], kinds: [3] }, ['wss://relay.invalid'], async (filter) => {
      seen.push({ ...filter })
      return new Set()
    })
    expect(seen[0].limit).toBeUndefined()
  })
})

describe('chooseEventSource: the archive first, relays otherwise', () => {
  afterEach(() => setArchive(undefined))
  const follows: NostrFilter = { authors: [A], kinds: [3] }

  test('no archive registered: relays', async () => {
    expect(getArchive()).toBeUndefined()
    expect(await chooseEventSource(follows)).toEqual({ source: 'relays', reason: 'no archive' })
    expect(await chooseEventSource(follows, false)).toEqual({ source: 'relays', reason: 'no archive' })
  })

  test('liveNetwork true: relays, whatever the archive holds', async () => {
    setArchive(archive([3]))
    expect(await chooseEventSource(follows, true)).toEqual({ source: 'relays', reason: 'liveNetwork' })
  })

  test('the archive holds the kind and answers: archive, with its description as the reason', async () => {
    setArchive(archive([3, 10000]))
    expect(await chooseEventSource(follows)).toEqual({ source: 'archive', reason: 'stub lake holding 3,10000' })
    expect(await chooseEventSource(follows, false)).toEqual({ source: 'archive', reason: 'stub lake holding 3,10000' })
  })

  test('a kind the archive does not hold: relays', async () => {
    setArchive(archive([3]))
    expect(await chooseEventSource({ authors: [A], kinds: [1984] })).toEqual({ source: 'relays', reason: 'not held' })
  })

  test('an archive that does not answer the ping: relays', async () => {
    setArchive(archive([3], false))
    expect(await chooseEventSource(follows)).toEqual({ source: 'relays', reason: 'archive unreachable' })
  })

  test('a ping that throws counts as unreachable', async () => {
    const broken = archive([3])
    broken.ping = async () => {
      throw new Error('connection refused')
    }
    setArchive(broken)
    expect(await chooseEventSource(follows)).toEqual({ source: 'relays', reason: 'archive unreachable' })
  })
})
