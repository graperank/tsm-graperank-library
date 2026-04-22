import { NostrEvent } from '../lib/nostr-tools'
import { applyInteractionsByTag } from '../nostr-interpreters/callbacks'
import { NostrInterpreterClass } from '../nostr-interpreters/classes'

const eventId = '1111111111111111111111111111111111111111111111111111111111111111'
const eventPubkey = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const subjectPubkey = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

function buildEvent(tags: string[][]): NostrEvent {
  return {
    id: eventId,
    pubkey: eventPubkey,
    created_at: 1710000000,
    kind: 3,
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
    description: 'Test callback actor bindings',
    allowedActorTypes: ['pubkey', 'p'],
    allowedSubjectTypes: ['pubkey', 'p'],
    defaultParams: {
      value: 1,
      confidence: 0.5,
      actorType: 'pubkey',
      subjectType: 'p',
      boost: 5,
    },
  })
}

describe('applyInteractionsByTag event actor bindings', () => {
  test('uses bound event actors instead of event pubkey actor when bindings exist', async () => {
    const interpreter = buildInterpreter()
    interpreter.fetched = [new Set([buildEvent([['p', subjectPubkey]])])]

    const boundEventActor = `event:e:${eventId}`
    ;(interpreter as any).eventActorBindingsByDos = [
      new Map([[eventId, new Set([boundEventActor])]]),
    ]

    const interactions = await applyInteractionsByTag(interpreter, 1)

    expect(interactions).toBeDefined()
    expect(interactions!.has(boundEventActor)).toBe(true)
    expect(interactions!.has(eventPubkey)).toBe(false)

    const boundActorInteractions = interactions!.get(boundEventActor)
    expect(boundActorInteractions?.has(subjectPubkey)).toBe(true)
    expect(boundActorInteractions?.get(subjectPubkey)?.value).toBe(1)
    expect(boundActorInteractions?.get(subjectPubkey)?.confidence).toBe(0.5)
  })

  test('preserves interpreter-defined interaction values for bound event actors', async () => {
    const interpreter = buildInterpreter()
    interpreter.fetched = [new Set([buildEvent([['p', subjectPubkey, 'boost']])])]

    const eventActorA = `event:e:${eventId}`
    const eventActorB = `event:e:${'2'.repeat(64)}`
    ;(interpreter as any).eventActorBindingsByDos = [
      new Map([[eventId, new Set([eventActorA, eventActorB])]]),
    ]

    const interactions = await applyInteractionsByTag(interpreter, 1, undefined, 1, 2)

    expect(interactions).toBeDefined()

    const actorAData = interactions!.get(eventActorA)?.get(subjectPubkey)
    const actorBData = interactions!.get(eventActorB)?.get(subjectPubkey)

    expect(actorAData?.value).toBe(5)
    expect(actorBData?.value).toBe(5)
    expect(actorAData?.confidence).toBe(0.5)
    expect(actorBData?.confidence).toBe(0.5)
  })
})
