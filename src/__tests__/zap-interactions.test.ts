import { NostrEvent } from '../lib/nostr-tools'
import { NostrInterpreterClass } from '../nostr-interpreters/classes'
import { applyEventAuthorBaseline, applyZapInteractions } from '../nostr-interpreters/callbacks'
import { buildEventActorId } from '../nostr-interpreters/helpers'

type ZapActorType = 'e' | 'p' | 'pubkey'
type ZapSubjectType = 'e' | 'p' | 'pubkey'

function buildZapReceiptEvent(
  sender: string,
  recipient: string,
  referencedEventId: string,
  overrides?: {
    id?: string
    amountMsats?: number
    includeSenderTag?: boolean
    includeDescription?: boolean
    descriptionPubkey?: string
  },
): NostrEvent {
  const tags: string[][] = [
    ['p', recipient],
    ['e', referencedEventId],
    ['amount', String(overrides?.amountMsats ?? 12000)],
  ]

  if (overrides?.includeSenderTag !== false) {
    tags.unshift(['P', sender])
  }

  if (overrides?.includeDescription !== false) {
    tags.push(['description', JSON.stringify({ pubkey: overrides?.descriptionPubkey || sender })])
  }

  return {
    id: overrides?.id || 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    pubkey: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    created_at: 1710000000,
    kind: 9735,
    tags,
    content: '',
    sig: 'sig',
  }
}

function buildZapInterpreter(
  actorType: ZapActorType,
  subjectType: ZapSubjectType,
  thresholdParams?: Record<string, number>,
): NostrInterpreterClass<any> {
  return new NostrInterpreterClass({
    interpretKind: 9735,
    fetchKinds: [9735, 9734],
    label: 'Zap test interpreter',
    description: 'Zap interpreter test config',
    allowedActorTypes: ['e', 'p', 'pubkey'],
    allowedSubjectTypes: ['e', 'p', 'pubkey'],
    defaultParams: {
      value: 1,
      confidence: 0.5,
      actorType,
      subjectType,
      ...(thresholdParams || {}),
    },
    interpret: (instance, dos) => applyZapInteractions(instance, dos),
  })
}

function buildEventAuthorBaselineInterpreter(): NostrInterpreterClass<any> {
  return new NostrInterpreterClass({
    interpretKind: 0,
    fetchKinds: [],
    label: 'Event author baseline test interpreter',
    description: 'Event author baseline interpreter test config',
    allowedActorTypes: ['e'],
    allowedSubjectTypes: ['pubkey'],
    defaultParams: {
      value: 1,
      confidence: 0.2,
      actorType: 'e',
      subjectType: 'pubkey',
    },
    interpret: (instance, dos) => applyEventAuthorBaseline(instance, dos),
  })
}

describe('applyZapInteractions', () => {
  test('maps p -> pubkey and applies value thresholds to summed msats totals', async () => {
    const sender = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const recipient = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    const referencedEventId = '1111111111111111111111111111111111111111111111111111111111111111'

    const zapA = buildZapReceiptEvent(sender, recipient, referencedEventId, {
      id: 'abababababababababababababababababababababababababababababababab',
      amountMsats: 6000,
    })
    const zapB = buildZapReceiptEvent(sender, recipient, referencedEventId, {
      id: 'cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd',
      amountMsats: 6000,
    })

    const interpreter = buildZapInterpreter('p', 'pubkey', { '>10000': 4 })
    interpreter.fetched = [new Set([zapA, zapB])]

    const interactions = await applyZapInteractions(interpreter, 1)
    const actorInteractions = interactions?.get(sender)

    expect(actorInteractions?.get(recipient)).toEqual({
      confidence: 0.5,
      value: 4,
      dos: 1,
    })
  })

  test('maps pubkey -> p in reverse pubkey mode', async () => {
    const sender = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const recipient = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    const referencedEventId = '2222222222222222222222222222222222222222222222222222222222222222'
    const zapReceipt = buildZapReceiptEvent(sender, recipient, referencedEventId)

    const interpreter = buildZapInterpreter('pubkey', 'p')
    interpreter.fetched = [new Set([zapReceipt])]

    const interactions = await applyZapInteractions(interpreter, 1)
    const actorInteractions = interactions?.get(recipient)

    expect(actorInteractions?.get(sender)).toEqual({
      confidence: 0.5,
      value: 1,
      dos: 1,
    })
  })

  test('maps pubkey -> e as zap sender -> ranked event in event-reverse mode', async () => {
    const sender = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const eventAuthor = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    const eventId = '3333333333333333333333333333333333333333333333333333333333333333'
    const zapReceipt = buildZapReceiptEvent(sender, eventAuthor, eventId)

    const eventActorId = buildEventActorId({ referenceType: 'e', value: eventId, relayHints: [] })
    expect(eventActorId).toBeDefined()

    const interpreter = buildZapInterpreter('pubkey', 'e')
    interpreter.fetched = [new Set([zapReceipt])]
    interpreter.setPovActorContext({
      actorMode: 'event',
      povType: 'pubkey',
      rankedPov: [[eventActorId!]],
      eventActorReferenceMap: new Map([[eventActorId!, { referenceType: 'e', value: eventId, relayHints: [] }]]),
      eventActorResolvedTypeValues: new Map([[eventActorId!, eventAuthor]]),
    })

    ;(interpreter as any).eventActorBindingsByDos = [
      new Map([[zapReceipt.id, new Set([eventActorId!])]]),
    ]

    const interactions = await applyZapInteractions(interpreter, 1)
    const actorInteractions = interactions?.get(sender)

    expect(actorInteractions?.get(eventActorId!)).toEqual({
      confidence: 0.5,
      value: 1,
      dos: 1,
    })
  })

  test('accepts sender only from NIP-57 description pubkey', async () => {
    const senderFromTag = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const senderFromDescription = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    const recipient = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
    const referencedEventId = '4444444444444444444444444444444444444444444444444444444444444444'

    const invalidZap = buildZapReceiptEvent(senderFromTag, recipient, referencedEventId, {
      id: '5656565656565656565656565656565656565656565656565656565656565656',
      includeDescription: false,
      includeSenderTag: true,
    })
    const validZap = buildZapReceiptEvent(senderFromTag, recipient, referencedEventId, {
      id: '6767676767676767676767676767676767676767676767676767676767676767',
      descriptionPubkey: senderFromDescription,
      includeSenderTag: true,
    })

    const interpreter = buildZapInterpreter('p', 'pubkey')
    interpreter.fetched = [new Set([invalidZap, validZap])]

    const interactions = await applyZapInteractions(interpreter, 1)
    expect(interactions?.size).toBe(1)
    expect(interactions?.get(senderFromTag)).toBeUndefined()
    expect(interactions?.get(senderFromDescription)?.get(recipient)).toEqual({
      confidence: 0.5,
      value: 1,
      dos: 1,
    })
  })

  test('event-forward emits eventActor -> author directly with zap-weighted value', async () => {
    const sender = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const authorIncluded = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    const authorFilteredOut = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
    const eventIdIncluded = '7777777777777777777777777777777777777777777777777777777777777777'
    const eventIdFilteredOut = '8888888888888888888888888888888888888888888888888888888888888888'

    const eventActorIncluded = buildEventActorId({ referenceType: 'e', value: eventIdIncluded, relayHints: [] })
    const eventActorFilteredOut = buildEventActorId({ referenceType: 'e', value: eventIdFilteredOut, relayHints: [] })
    expect(eventActorIncluded).toBeDefined()
    expect(eventActorFilteredOut).toBeDefined()

    const zapA = buildZapReceiptEvent(sender, authorIncluded, eventIdIncluded, {
      id: '8989898989898989898989898989898989898989898989898989898989898989',
      amountMsats: 7000,
    })
    const zapB = buildZapReceiptEvent(sender, authorIncluded, eventIdIncluded, {
      id: '9090909090909090909090909090909090909090909090909090909090909090',
      amountMsats: 7000,
    })
    const zapFiltered = buildZapReceiptEvent(sender, authorFilteredOut, eventIdFilteredOut, {
      id: '9191919191919191919191919191919191919191919191919191919191919191',
      amountMsats: 7000,
    })

    const interpreter = buildZapInterpreter('e', 'pubkey', { '>10000': 5 })
    interpreter.fetched = [new Set([zapA, zapB, zapFiltered])]
    interpreter.setPovActorContext({
      actorMode: 'event',
      povType: 'pubkey',
      rankedPov: [
        [eventActorIncluded!, 0.9],
        [eventActorFilteredOut!, 0.8],
      ],
      eventActorReferenceMap: new Map([
        [eventActorIncluded!, { referenceType: 'e', value: eventIdIncluded, relayHints: [] }],
        [eventActorFilteredOut!, { referenceType: 'e', value: eventIdFilteredOut, relayHints: [] }],
      ]),
      eventActorResolvedTypeValues: new Map([
        [eventActorIncluded!, authorIncluded],
        [eventActorFilteredOut!, authorFilteredOut],
      ]),
    })

    ;(interpreter as any).eventActorBindingsByDos = [
      new Map([
        [zapA.id, new Set([eventActorIncluded!])],
        [zapB.id, new Set([eventActorIncluded!])],
        [zapFiltered.id, new Set([eventActorFilteredOut!])],
      ]),
    ]

    const interactions = await interpreter.interpret(1)

    expect(interactions?.get(eventActorIncluded!)?.get(authorIncluded)).toEqual({
      confidence: 0.5,
      value: 5,
      dos: 1,
    })

    expect(interactions?.get(eventActorFilteredOut!)?.get(authorFilteredOut)).toEqual({
      confidence: 0.5,
      value: 1,
      dos: 1,
    })

    expect(interactions?.get(sender)).toBeUndefined()
    expect(interpreter.needsFinalization).toBe(false)
  })

  test('event-forward omits authors of events with no zaps', async () => {
    const zappedAuthor = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    const unzappedAuthor = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
    const zappedEventId = 'aaaa111111111111111111111111111111111111111111111111111111111111'
    const unzappedEventId = 'bbbb222222222222222222222222222222222222222222222222222222222222'

    const eventActorZapped = buildEventActorId({ referenceType: 'e', value: zappedEventId, relayHints: [] })
    const eventActorUnzapped = buildEventActorId({ referenceType: 'e', value: unzappedEventId, relayHints: [] })
    expect(eventActorZapped).toBeDefined()
    expect(eventActorUnzapped).toBeDefined()

    const sender = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const zapReceipt = buildZapReceiptEvent(sender, zappedAuthor, zappedEventId, {
      id: 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1',
      amountMsats: 7000,
    })

    const interpreter = buildZapInterpreter('e', 'pubkey')
    interpreter.fetched = [new Set([zapReceipt])]
    interpreter.setPovActorContext({
      actorMode: 'event',
      povType: 'pubkey',
      rankedPov: [
        [eventActorZapped!, 0.9],
        [eventActorUnzapped!, 0.7],
      ],
      eventActorReferenceMap: new Map([
        [eventActorZapped!, { referenceType: 'e', value: zappedEventId, relayHints: [] }],
        [eventActorUnzapped!, { referenceType: 'e', value: unzappedEventId, relayHints: [] }],
      ]),
      eventActorResolvedTypeValues: new Map([
        [eventActorZapped!, zappedAuthor],
        [eventActorUnzapped!, unzappedAuthor],
      ]),
    })

    ;(interpreter as any).eventActorBindingsByDos = [
      new Map([[zapReceipt.id, new Set([eventActorZapped!])]]),
    ]

    const interactions = await interpreter.interpret(1)

    expect(interactions?.get(eventActorZapped!)?.get(zappedAuthor)).toEqual({
      confidence: 0.5,
      value: 1,
      dos: 1,
    })
    expect(interactions?.get(eventActorUnzapped!)).toBeUndefined()
  })

  test('event author baseline emits all resolved authors without fetching zaps', async () => {
    const firstAuthor = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    const secondAuthor = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
    const firstEventId = 'aaaa111111111111111111111111111111111111111111111111111111111111'
    const secondEventId = 'bbbb222222222222222222222222222222222222222222222222222222222222'

    const firstEventActor = buildEventActorId({ referenceType: 'e', value: firstEventId, relayHints: [] })
    const secondEventActor = buildEventActorId({ referenceType: 'e', value: secondEventId, relayHints: [] })
    expect(firstEventActor).toBeDefined()
    expect(secondEventActor).toBeDefined()

    const interpreter = buildEventAuthorBaselineInterpreter()
    interpreter.fetched = [new Set()]
    interpreter.setPovActorContext({
      actorMode: 'event',
      povType: 'pubkey',
      rankedPov: [
        [firstEventActor!, 0.9],
        [secondEventActor!, 0.7],
      ],
      eventActorReferenceMap: new Map([
        [firstEventActor!, { referenceType: 'e', value: firstEventId, relayHints: [] }],
        [secondEventActor!, { referenceType: 'e', value: secondEventId, relayHints: [] }],
      ]),
      eventActorResolvedTypeValues: new Map([
        [firstEventActor!, firstAuthor],
        [secondEventActor!, secondAuthor],
      ]),
    })

    const interactions = await interpreter.interpret(1)

    expect(interactions?.get(firstEventActor!)?.get(firstAuthor)).toEqual({
      confidence: 0.2,
      value: 1,
      dos: 1,
    })
    expect(interactions?.get(secondEventActor!)?.get(secondAuthor)).toEqual({
      confidence: 0.2,
      value: 1,
      dos: 1,
    })
  })
})
