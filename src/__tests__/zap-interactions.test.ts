import { NostrEvent } from '../lib/nostr-tools'
import { NostrInterpreterClass } from '../nostr-interpreters/classes'
import { applyZapInteractions } from '../nostr-interpreters/callbacks'
import { buildEventActorId } from '../nostr-interpreters/helpers'

type ZapActorType = 'P' | 'p' | 'e' | 'a'
type ZapSubjectType = 'P' | 'p'

function buildZapReceiptEvent(sender: string, recipient: string, referencedEventId: string): NostrEvent {
  return {
    id: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    pubkey: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    created_at: 1710000000,
    kind: 9735,
    tags: [
      ['P', sender],
      ['p', recipient],
      ['e', referencedEventId],
      ['amount', '12000'],
    ],
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
    allowedSubjectTypes: ['P', 'p'],
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
  test('uses bound event actor ids when actorType is e', async () => {
    const sender = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const recipient = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    const referencedEventId = '1111111111111111111111111111111111111111111111111111111111111111'
    const zapReceipt = buildZapReceiptEvent(sender, recipient, referencedEventId)

    const eventActorId = buildEventActorId({ referenceType: 'e', value: referencedEventId, relayHints: [] })
    expect(eventActorId).toBeDefined()

    const interpreter = buildZapInterpreter('e', 'p')
    interpreter.fetched = [new Set([zapReceipt])]

    ;(interpreter as any).eventActorBindingsByDos = [
      new Map([[zapReceipt.id, new Set([eventActorId!])]]),
    ]

    const interactions = await applyZapInteractions(interpreter, 1)
    const actorInteractions = interactions?.get(eventActorId!)

    expect(actorInteractions).toBeDefined()
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
