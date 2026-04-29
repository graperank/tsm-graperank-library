import { NostrEvent } from '../lib/nostr-tools'
import { NostrInterpreterClass } from '../nostr-interpreters/classes'
import { applyZapInteractions, finalizeZapEventActorProjection } from '../nostr-interpreters/callbacks'
import { buildEventActorId } from '../nostr-interpreters/helpers'
import type { Interaction } from '../graperank/types'

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
  // Mirrors factory wiring: keep zap projection staging state in closure,
  // not on the generic `NostrInterpreterClass` instance.
  const pendingEventActorSenderTotalsByDos = new Map<number, Map<string, Map<string, number>>>()

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
    interpret: (instance, dos) => applyZapInteractions(instance, dos, {
      stageEventActorSenderTotals: (iterationDos, totalsByEventActor) => {
        // Stage per-iteration totals for one-shot finalize projection.
        if (totalsByEventActor.size > 0) {
          pendingEventActorSenderTotalsByDos.set(iterationDos, totalsByEventActor)
        } else {
          pendingEventActorSenderTotalsByDos.delete(iterationDos)
        }

        instance.needsFinalization = pendingEventActorSenderTotalsByDos.size > 0
      },
    }),
    finalize: (instance, interactions) => finalizeZapEventActorProjection(instance, interactions, pendingEventActorSenderTotalsByDos),
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

  test('maps pubkey -> e as event author -> zap sender in event mode', async () => {
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
    const actorInteractions = interactions?.get(eventAuthor)

    expect(actorInteractions?.get(sender)).toEqual({
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

  test('finalize emits one-shot eventActor -> author projection for event-forward zaps', async () => {
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

    const preFinalizeInteractions = await interpreter.interpret(1)
    expect(preFinalizeInteractions?.get(sender)?.get(authorIncluded)?.value).toBe(5)
    expect(interpreter.needsFinalization).toBe(true)

    const existingInteractions: Interaction[] = [
      {
        interpreterId: 'nostr-1111',
        index: 0,
        actor: sender,
        subject: authorIncluded,
        confidence: 0.5,
        value: 1,
        dos: 1,
      },
    ]

    const finalized = await interpreter.finalize(existingInteractions)
    expect(finalized?.get(eventActorIncluded!)?.get(authorIncluded)).toEqual({
      confidence: 0.5,
      value: 5,
      dos: 1,
    })
    expect(finalized?.get(eventActorFilteredOut!)).toBeUndefined()
    expect(interpreter.needsFinalization).toBe(false)

    const finalizedAgain = await interpreter.finalize(existingInteractions)
    expect(finalizedAgain).toBeUndefined()
  })
})
