import { NostrEvent } from '../lib/nostr-tools'
import * as nostrTools from '../lib/nostr-tools'
import { NostrInterpreterClass } from '../nostr-interpreters/classes'
import * as helpers from '../nostr-interpreters/helpers'

jest.mock('../nostr-interpreters/helpers', () => {
  const actual = jest.requireActual('../nostr-interpreters/helpers')
  return {
    ...actual,
    fetchEvents: jest.fn(),
  }
})

const fetchEventsMock = helpers.fetchEvents as jest.MockedFunction<typeof helpers.fetchEvents>

const authorPubkey = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const referencedEventAuthor = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const referencedEventAuthor2 = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
const tagValueLower = 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
const tagValueUpper = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
const eventId1 = '1111111111111111111111111111111111111111111111111111111111111111'
const eventId2 = '2222222222222222222222222222222222222222222222222222222222222222'
const rootEventId = '3333333333333333333333333333333333333333333333333333333333333333'
const pageEventId = '4444444444444444444444444444444444444444444444444444444444444444'

function buildEvent(
  id: string,
  pubkey: string,
  kind: number,
  tags: string[][],
): NostrEvent {
  return {
    id,
    pubkey,
    created_at: 1710000000,
    kind,
    tags,
    content: '',
    sig: 'sig',
  }
}

function buildInterpreter(): NostrInterpreterClass<any> {
  return new NostrInterpreterClass({
    interpretKind: 3,
    fetchKinds: [3],
    label: 'Test',
    description: 'Test resolver behavior',
    allowedActorTypes: ['pubkey', 'p', 'P', 'id', 'kind'],
    allowedSubjectTypes: ['pubkey', 'p', 'P', 'id', 'kind'],
    defaultParams: {
      value: 1,
      confidence: 1,
      actorType: 'pubkey',
      subjectType: 'p',
    },
  })
}

describe('NostrInterpreterClass.resolveActors', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    NostrInterpreterClass.relays = ['wss://relay.default']
  })

  test('resolves pubkey actors from paginated e/q references for naddr POV', async () => {
    jest.spyOn(nostrTools, 'decode').mockImplementation((value: string) => {
      if (value === 'naddr1root') {
        return {
          type: 'naddr',
          data: {
            kind: 37573,
            pubkey: authorPubkey,
            identifier: 'root',
            relays: ['wss://relay.hint.root'],
          },
        } as any
      }

      if (value === 'nevent1encoded') {
        return {
          type: 'nevent',
          data: {
            id: eventId2,
            relays: ['wss://relay.hint.q'],
          },
        } as any
      }

      throw new Error(`Unexpected decode value ${value}`)
    })

    const rootEvent = buildEvent(rootEventId, authorPubkey, 37573, [
      ['d', 'root'],
      ['e', eventId1, '0.91'],
      ['v', 'page:1', '["root:2"]'],
    ])

    const pageEvent = buildEvent(pageEventId, authorPubkey, 37573, [
      ['d', 'root:2'],
      ['q', 'nostr:nevent1encoded'],
    ])

    const referencedEvent1 = buildEvent(eventId1, referencedEventAuthor, 1, [])
    const referencedEvent2 = buildEvent(eventId2, referencedEventAuthor2, 1, [])

    fetchEventsMock.mockImplementation(async (filter) => {
      if (filter['#d']?.includes('root')) return new Set([rootEvent])
      if (filter['#d']?.includes('root:2')) return new Set([pageEvent])
      if (filter.ids?.includes(eventId1)) return new Set([referencedEvent1])
      if (filter.ids?.includes(eventId2)) return new Set([referencedEvent2])
      return new Set()
    })

    const interpreter = buildInterpreter()
    const actors = await interpreter.resolveActors('pubkey', 'naddr1root')

    expect([...actors].sort()).toEqual([referencedEventAuthor, referencedEventAuthor2].sort())
  })

  test('uses fallback resolution for event fields (id) rather than source event ids', async () => {
    jest.spyOn(nostrTools, 'decode').mockImplementation((value: string) => {
      if (value === 'naddr1root') {
        return {
          type: 'naddr',
          data: {
            kind: 37573,
            pubkey: authorPubkey,
            identifier: 'root',
            relays: [],
          },
        } as any
      }
      throw new Error(`Unexpected decode value ${value}`)
    })

    const rootEvent = buildEvent(rootEventId, authorPubkey, 37573, [
      ['d', 'root'],
      ['e', eventId1],
    ])
    const referencedEvent = buildEvent(eventId1, referencedEventAuthor, 1, [])

    fetchEventsMock.mockImplementation(async (filter) => {
      if (filter['#d']?.includes('root')) return new Set([rootEvent])
      if (filter.ids?.includes(eventId1)) return new Set([referencedEvent])
      return new Set()
    })

    const interpreter = buildInterpreter()
    const actors = await interpreter.resolveActors('id', 'naddr1root')

    expect([...actors]).toEqual([eventId1])
    expect(actors.has(rootEventId)).toBe(false)
  })

  test('matches uppercase P tags distinctly from lowercase p tags', async () => {
    jest.spyOn(nostrTools, 'decode').mockImplementation((value: string) => {
      if (value === 'naddr1root') {
        return {
          type: 'naddr',
          data: {
            kind: 37573,
            pubkey: authorPubkey,
            identifier: 'root',
            relays: [],
          },
        } as any
      }
      throw new Error(`Unexpected decode value ${value}`)
    })

    const rootEvent = buildEvent(rootEventId, authorPubkey, 37573, [
      ['d', 'root'],
      ['e', eventId1],
      ['v', 'page:1', 'not-json'],
    ])

    const referencedEvent = buildEvent(eventId1, referencedEventAuthor, 1, [
      ['p', tagValueLower],
      ['P', tagValueUpper],
    ])

    fetchEventsMock.mockImplementation(async (filter) => {
      if (filter['#d']?.includes('root')) return new Set([rootEvent])
      if (filter.ids?.includes(eventId1)) return new Set([referencedEvent])
      return new Set()
    })

    const interpreter = buildInterpreter()
    const actors = await interpreter.resolveActors('P', 'naddr1root')

    expect(actors.has(tagValueUpper)).toBe(true)
    expect(actors.has(tagValueLower)).toBe(false)
  })

  test('retries referenced event fetches up to three attempts before succeeding', async () => {
    let referenceFetchAttempts = 0

    jest.spyOn(nostrTools, 'decode').mockImplementation((value: string) => {
      if (value === 'naddr1root') {
        return {
          type: 'naddr',
          data: {
            kind: 37573,
            pubkey: authorPubkey,
            identifier: 'root',
            relays: [],
          },
        } as any
      }
      throw new Error(`Unexpected decode value ${value}`)
    })

    const rootEvent = buildEvent(rootEventId, authorPubkey, 37573, [
      ['d', 'root'],
      ['e', eventId1],
    ])

    const referencedEvent = buildEvent(eventId1, referencedEventAuthor, 1, [])

    fetchEventsMock.mockImplementation(async (filter) => {
      if (filter['#d']?.includes('root')) return new Set([rootEvent])
      if (filter.ids?.includes(eventId1)) {
        referenceFetchAttempts += 1
        if (referenceFetchAttempts < 3) {
          return new Set()
        }
        return new Set([referencedEvent])
      }
      return new Set()
    })

    const interpreter = buildInterpreter()
    const actors = await interpreter.resolveActors('pubkey', 'naddr1root')

    expect(referenceFetchAttempts).toBe(3)
    expect(actors.has(referencedEventAuthor)).toBe(true)
  })

  test('resolvePovContext builds event-actor rankedPov with parsed ranks for kind 37573 source tags', async () => {
    jest.spyOn(nostrTools, 'decode').mockImplementation((value: string) => {
      if (value === 'naddr1root') {
        return {
          type: 'naddr',
          data: {
            kind: 37573,
            pubkey: authorPubkey,
            identifier: 'root',
            relays: [],
          },
        } as any
      }

      if (value === 'nevent1encoded') {
        return {
          type: 'nevent',
          data: {
            id: eventId2,
            relays: [],
          },
        } as any
      }

      throw new Error(`Unexpected decode value ${value}`)
    })

    const rootEvent = buildEvent(rootEventId, authorPubkey, 37573, [
      ['d', 'root'],
      ['e', eventId1, '0.91'],
      ['q', 'nostr:nevent1encoded'],
    ])

    fetchEventsMock.mockImplementation(async (filter) => {
      if (filter['#d']?.includes('root')) return new Set([rootEvent])
      return new Set()
    })

    const interpreter = buildInterpreter()
    const context = await interpreter.resolvePovContext('pubkey', 'naddr1root')

    expect(context).toBeDefined()
    expect(context!.actorMode).toBe('event')

    const rankedMap = new Map<string, number | undefined>()
    context!.rankedPov.forEach(([actor, rank]) => rankedMap.set(actor, rank))
    expect(rankedMap.get(`event:e:${eventId1}`)).toBe(0.91)
    expect(rankedMap.has(`event:e:${eventId2}`)).toBe(true)
    expect(context!.eventActorReferenceMap?.get(`event:e:${eventId1}`)?.value).toBe(eventId1)
    expect(context!.eventActorReferenceMap?.get(`event:e:${eventId2}`)?.value).toBe(eventId2)
  })

  test('resolvePovContext keeps rank undefined when source rank tag is malformed', async () => {
    jest.spyOn(nostrTools, 'decode').mockImplementation((value: string) => {
      if (value === 'naddr1root') {
        return {
          type: 'naddr',
          data: {
            kind: 37573,
            pubkey: authorPubkey,
            identifier: 'root',
            relays: [],
          },
        } as any
      }

      throw new Error(`Unexpected decode value ${value}`)
    })

    const rootEvent = buildEvent(rootEventId, authorPubkey, 37573, [
      ['d', 'root'],
      ['e', eventId1, 'not-a-number'],
    ])

    fetchEventsMock.mockImplementation(async (filter) => {
      if (filter['#d']?.includes('root')) return new Set([rootEvent])
      return new Set()
    })

    const interpreter = buildInterpreter()
    const context = await interpreter.resolvePovContext('pubkey', 'naddr1root')

    expect(context).toBeDefined()
    expect(context!.actorMode).toBe('event')

    const rankedMap = new Map<string, number | undefined>()
    context!.rankedPov.forEach(([actor, rank]) => rankedMap.set(actor, rank))
    expect(rankedMap.has(`event:e:${eventId1}`)).toBe(true)
    expect(rankedMap.get(`event:e:${eventId1}`)).toBeUndefined()
  })
})
