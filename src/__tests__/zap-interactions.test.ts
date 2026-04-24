import { NostrEvent } from '../lib/nostr-tools'
import { NostrInterpreterClass } from '../nostr-interpreters/classes'
import { applyZapInteractions } from '../nostr-interpreters/callbacks'
import { buildEventActorId } from '../nostr-interpreters/helpers'

type ZapActorType = 'P' | 'p' | 'e' | 'a'
type ZapSubjectType = 'P' | 'p' | 'e' | 'a'

function buildZapReceiptEvent(
  sender: string,
  recipient: string,
  referencedEventId: string,
  overrides?: {
    id?: string
    includeSenderTag?: boolean
    descriptionPubkey?: string
  },
): NostrEvent {
  const tags: string[][] = [
    ['p', recipient],
    ['e', referencedEventId],
    ['amount', '12000'],
  ]

  if (overrides?.includeSenderTag !== false) {
    tags.unshift(['P', sender])
  }

  if (overrides?.descriptionPubkey) {
    tags.push(['description', JSON.stringify({ pubkey: overrides.descriptionPubkey })])
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

function buildZapInterpreter(actorType: ZapActorType, subjectType: ZapSubjectType): NostrInterpreterClass<any> {
  return new NostrInterpreterClass({
    interpretKind: 9735,
    fetchKinds: [9735, 9734],
    label: 'Zap test interpreter',
    description: 'Zap interpreter test config',
    allowedActorTypes: ['P', 'p', 'e', 'a'],
    allowedSubjectTypes: ['P', 'p', 'e', 'a'],
    defaultParams: {
      value: 1,
      confidence: 0.5,
      actorType,
      subjectType,
    },
    interpret: (instance, dos) => applyZapInteractions(instance, dos),
  })
}

describe('applyZapInteractions', () => {
  test('maps event actor to zap sender for e -> P event-actor mode', async () => {
    const sender = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const recipient = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    const referencedEventId = '1111111111111111111111111111111111111111111111111111111111111111'
    const zapReceipt = buildZapReceiptEvent(sender, recipient, referencedEventId)

    const eventActorId = buildEventActorId({ referenceType: 'e', value: referencedEventId, relayHints: [] })
    expect(eventActorId).toBeDefined()

    const interpreter = buildZapInterpreter('e', 'P')
    interpreter.fetched = [new Set([zapReceipt])]
    interpreter.setPovActorContext({
      actorMode: 'event',
      povType: 'pubkey',
      rankedPov: [[eventActorId!]],
      eventActorReferenceMap: new Map([[eventActorId!, { referenceType: 'e', value: referencedEventId, relayHints: [] }]]),
    })

    ;(interpreter as any).eventActorBindingsByDos = [
      new Map([[zapReceipt.id, new Set([eventActorId!])]]),
    ]

    const interactions = await applyZapInteractions(interpreter, 1)
    const actorInteractions = interactions?.get(eventActorId!)

    expect(actorInteractions).toBeDefined()
    expect(actorInteractions?.get(sender)).toEqual({
      confidence: 0.5,
      value: 1,
      dos: 1,
    })
  })

  test('maps zap sender to resolved event actor subject for P -> e event-actor mode', async () => {
    const sender = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const recipient = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    const resolvedSubject = '9999999999999999999999999999999999999999999999999999999999999999'
    const referencedEventId = '1212121212121212121212121212121212121212121212121212121212121212'
    const zapReceipt = buildZapReceiptEvent(sender, recipient, referencedEventId)

    const eventActorId = buildEventActorId({ referenceType: 'e', value: referencedEventId, relayHints: [] })
    expect(eventActorId).toBeDefined()

    const interpreter = buildZapInterpreter('P', 'e')
    interpreter.fetched = [new Set([zapReceipt])]
    interpreter.setPovActorContext({
      actorMode: 'event',
      povType: 'pubkey',
      rankedPov: [[eventActorId!]],
      eventActorReferenceMap: new Map([[eventActorId!, { referenceType: 'e', value: referencedEventId, relayHints: [] }]]),
      eventActorResolvedTypeValues: new Map([[eventActorId!, resolvedSubject]]),
    })

    ;(interpreter as any).eventActorBindingsByDos = [
      new Map([[zapReceipt.id, new Set([eventActorId!])]]),
    ]

    const interactions = await applyZapInteractions(interpreter, 1)
    const actorInteractions = interactions?.get(sender)

    expect(actorInteractions).toBeDefined()
    expect(actorInteractions?.get(resolvedSubject)).toEqual({
      confidence: 0.5,
      value: 1,
      dos: 1,
    })
  })

  test('falls back to embedded zap request pubkey when sender tag is missing', async () => {
    const sender = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const recipient = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    const referencedEventId = '3333333333333333333333333333333333333333333333333333333333333333'
    const zapReceipt = buildZapReceiptEvent(sender, recipient, referencedEventId, {
      includeSenderTag: false,
      descriptionPubkey: sender,
    })

    const interpreter = buildZapInterpreter('P', 'p')
    interpreter.fetched = [new Set([zapReceipt])]

    const interactions = await applyZapInteractions(interpreter, 1)
    const actorInteractions = interactions?.get(sender)

    expect(actorInteractions).toBeDefined()
    expect(actorInteractions?.get(recipient)).toEqual({
      confidence: 0.5,
      value: 1,
      dos: 1,
    })
  })

  test('skips invalid zaps when sender tag conflicts with embedded request pubkey', async () => {
    const sender = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const conflictingSender = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
    const recipient = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    const referencedEventId = '4444444444444444444444444444444444444444444444444444444444444444'
    const zapReceipt = buildZapReceiptEvent(sender, recipient, referencedEventId, {
      descriptionPubkey: conflictingSender,
    })

    const interpreter = buildZapInterpreter('P', 'p')
    interpreter.fetched = [new Set([zapReceipt])]

    const interactions = await applyZapInteractions(interpreter, 1)

    expect(interactions?.size).toBe(0)
  })

  test('preserves dedupe per actor-subject pair', async () => {
    const sender = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const recipient = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    const referencedEventId = '5555555555555555555555555555555555555555555555555555555555555555'
    const zapReceiptA = buildZapReceiptEvent(sender, recipient, referencedEventId, {
      id: 'abababababababababababababababababababababababababababababababab',
    })
    const zapReceiptB = buildZapReceiptEvent(sender, recipient, referencedEventId, {
      id: 'cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd',
    })

    const interpreter = buildZapInterpreter('P', 'p')
    interpreter.fetched = [new Set([zapReceiptA, zapReceiptB])]

    const interactions = await applyZapInteractions(interpreter, 1)
    const actorInteractions = interactions?.get(sender)

    expect(actorInteractions).toBeDefined()
    expect(actorInteractions?.size).toBe(1)
    expect(actorInteractions?.get(recipient)).toEqual({
      confidence: 0.5,
      value: 1,
      dos: 1,
    })
  })

  test('keeps legacy sender-to-recipient behavior for actorType P', async () => {
    const sender = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const recipient = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    const referencedEventId = '2222222222222222222222222222222222222222222222222222222222222222'
    const zapReceipt = buildZapReceiptEvent(sender, recipient, referencedEventId)

    const interpreter = buildZapInterpreter('P', 'p')
    interpreter.fetched = [new Set([zapReceipt])]

    const interactions = await applyZapInteractions(interpreter, 1)
    const actorInteractions = interactions?.get(sender)

    expect(actorInteractions).toBeDefined()
    expect(actorInteractions?.get(recipient)).toEqual({
      confidence: 0.5,
      value: 1,
      dos: 1,
    })
  })
})
