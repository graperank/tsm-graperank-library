import { NostrEvent, NostrFilter } from '../lib/nostr-tools'
import { NostrInterpreterClass } from '../nostr-interpreters/classes'
import { setArchive, NostrEventArchive } from '../nostr-interpreters/event-source'
import * as helpers from '../nostr-interpreters/helpers'

jest.mock('../nostr-interpreters/helpers', () => {
  const actual = jest.requireActual('../nostr-interpreters/helpers')
  return {
    ...actual,
    fetchEvents: jest.fn(),
  }
})

const fetchEventsMock = helpers.fetchEvents as jest.MockedFunction<typeof helpers.fetchEvents>

const A = 'aa'.repeat(32)
const B = 'bb'.repeat(32)

function event(pubkey: string, kind: number, tags: string[][]): NostrEvent {
  return { id: '11'.repeat(32), pubkey, created_at: 1700000000, kind, tags, content: '', sig: 'sig' }
}

function archive(kinds: number[]): NostrEventArchive {
  return {
    source: async () => new Set([event(A, 3, [['p', B]])]),
    covers: (filter: NostrFilter) => (filter.kinds ?? []).every((k) => kinds.includes(k)),
    ping: async () => true,
    describe: () => `stub lake holding ${kinds.join(',')}`,
  }
}

function interpreter(kind: number): NostrInterpreterClass<any> {
  return new NostrInterpreterClass({
    interpretKind: kind,
    fetchKinds: [kind],
    label: 'Test',
    description: 'Test the choice of source',
    allowedActorTypes: ['pubkey', 'p'],
    allowedSubjectTypes: ['pubkey', 'p'],
    defaultParams: { value: 1, confidence: 1, actorType: 'pubkey', subjectType: 'p' },
  })
}

describe('each interpreter chooses the archive or the relays once per request', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    fetchEventsMock.mockImplementation(async () => new Set())
    NostrInterpreterClass.relays = ['wss://relay.default']
  })
  afterEach(() => setArchive(undefined))

  test('the archive holds the kind: fetchEvents gets the archive source', async () => {
    const lake = archive([3, 10000])
    setArchive(lake)
    const follows = interpreter(3)
    follows.request = { id: 'nostr-3', actors: [A] }
    await follows.fetchData()
    expect(follows.eventSource).toEqual({ source: 'archive', reason: 'stub lake holding 3,10000' })
    expect(fetchEventsMock).toHaveBeenCalledTimes(1)
    const [filter, relays, source] = fetchEventsMock.mock.calls[0]
    expect(filter).toEqual({ authors: [A], kinds: [3] })
    expect(relays).toEqual(['wss://relay.default'])
    expect(source).toBe(lake.source)
  })

  test('liveNetwork on the request: the relays, no source passed', async () => {
    setArchive(archive([3]))
    const follows = interpreter(3)
    follows.request = { id: 'nostr-3', actors: [A], liveNetwork: true }
    await follows.fetchData()
    expect(follows.eventSource).toEqual({ source: 'relays', reason: 'liveNetwork' })
    expect(fetchEventsMock.mock.calls[0][2]).toBeUndefined()
  })

  test('a kind the archive does not hold: the relays, while another interpreter reads the archive', async () => {
    setArchive(archive([3]))
    const reports = interpreter(1984)
    reports.request = { id: 'nostr-1984', actors: [A] }
    await reports.fetchData()
    expect(reports.eventSource).toEqual({ source: 'relays', reason: 'not held' })
    expect(fetchEventsMock.mock.calls[0][2]).toBeUndefined()
  })

  test('no archive: the relays', async () => {
    const follows = interpreter(3)
    follows.request = { id: 'nostr-3', actors: [A] }
    await follows.fetchData()
    expect(follows.eventSource).toEqual({ source: 'relays', reason: 'no archive' })
  })

  test('the choice is made once per request and forgotten when a new request is set', async () => {
    const lake = archive([3])
    setArchive(lake)
    const follows = interpreter(3)
    follows.request = { id: 'nostr-3', actors: [A] }
    await follows.fetchData()
    await follows.fetchData(new Set([B]))
    expect(fetchEventsMock.mock.calls.map((c) => c[2])).toEqual([lake.source, lake.source])
    // a new request: chosen again, now with liveNetwork
    follows.request = { id: 'nostr-3', actors: [A], liveNetwork: true }
    expect(follows.eventSource).toBeUndefined()
    await follows.fetchData()
    expect(follows.eventSource?.source).toBe('relays')
    expect(fetchEventsMock.mock.calls[2][2]).toBeUndefined()
  })
})
