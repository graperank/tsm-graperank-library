import { InterpretationController, InterpretersMap } from '../graperank/interpretation'
import type { InteractionsList, InteractionsMap } from '../graperank/types'
import type { PovActorContext } from '../graperank/nostr-types'

type ActorMode = 'event' | 'pubkey'

function createFinalizableInterpreter(actorMode: ActorMode) {
  // Minimal interpreter stub used to isolate controller-level finalize behavior
  // from nostr-specific interpretation details.
  const interactions: InteractionsMap = new Map()
  const fetched = [new Set<any>()]
  let finalizeCalls = 0

  const pubkeyActor = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  const eventActor = 'event:e:1111111111111111111111111111111111111111111111111111111111111111'

  const interpreter = {
    interpreterId: 'nostr-9735' as const,
    label: 'Finalizer test interpreter',
    description: 'Tests finalizePending plumbing',
    needsFinalization: true,
    params: {
      value: 1,
      confidence: 1,
      actorType: 'e',
      subjectType: 'pubkey',
    },
    fetched,
    interactions,
    resolveActors: async () => {
      return new Set([actorMode === 'event' ? eventActor : pubkeyActor])
    },
    resolvePovContext: async (): Promise<PovActorContext> => {
      if (actorMode === 'event') {
        return {
          actorMode: 'event',
          povType: 'e',
          rankedPov: [[eventActor, 1]],
          eventActorReferenceMap: new Map([[eventActor, { referenceType: 'e', value: eventActor.slice(8), relayHints: [] }]]),
          eventActorResolvedTypeValues: new Map([[eventActor, pubkeyActor]]),
        }
      }

      return {
        actorMode: 'pubkey',
        povType: 'pubkey',
        rankedPov: [[pubkeyActor, 1]],
      }
    },
    setPovActorContext: () => {},
    fetchData: async () => {
      fetched[0] = new Set([{ id: 'mock-event' }])
      return 1
    },
    interpret: async () => {
      interactions.clear()
      interactions.set('actor:base', new Map([
        ['subject:base', { value: 1, confidence: 1, dos: 1 }],
      ]))
      return interactions
    },
    finalize: async (_interactions: InteractionsList) => {
      finalizeCalls += 1
      interpreter.needsFinalization = false

      const finalized: InteractionsMap = new Map()
      finalized.set('actor:final', new Map([
        ['subject:final', { value: 3, confidence: 1, dos: 1 }],
      ]))
      return finalized
    },
  }

  return {
    interpreter,
    getFinalizeCalls: () => finalizeCalls,
  }
}

describe('InterpretationController finalizer plumbing', () => {
  test('runs finalizePending only for event actor mode and appends finalized interactions', async () => {
    const { interpreter, getFinalizeCalls } = createFinalizableInterpreter('event')
    const interpretersMap = new InterpretersMap([])
    interpretersMap.set('nostr-9735', interpreter)

    const controller = new InterpretationController(interpretersMap)
    const output = await controller.interpret({
      type: 'e',
      pov: ['1111111111111111111111111111111111111111111111111111111111111111'],
      requests: [{ id: 'nostr-9735' }],
    })

    // Event-mode request should execute finalize and append its projections.
    expect(output).toBeDefined()
    expect(output?.interactions.some((interaction) => (
      interaction.actor === 'actor:base' && interaction.subject === 'subject:base'
    ))).toBe(true)
    expect(output?.interactions.some((interaction) => (
      interaction.actor === 'actor:final' && interaction.subject === 'subject:final'
    ))).toBe(true)
    expect(getFinalizeCalls()).toBe(1)
    expect(interpreter.needsFinalization).toBe(false)
  })

  test('does not run finalizePending when pov actor mode is not event', async () => {
    const { interpreter, getFinalizeCalls } = createFinalizableInterpreter('pubkey')
    const interpretersMap = new InterpretersMap([])
    interpretersMap.set('nostr-9735', interpreter)

    const controller = new InterpretationController(interpretersMap)
    const output = await controller.interpret({
      type: 'pubkey',
      pov: ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
      requests: [{ id: 'nostr-9735' }],
    })

    expect(output).toBeDefined()
    expect(output?.interactions.some((interaction) => (
      interaction.actor === 'actor:base' && interaction.subject === 'subject:base'
    ))).toBe(true)
    expect(output?.interactions.some((interaction) => interaction.actor === 'actor:final')).toBe(false)
    expect(getFinalizeCalls()).toBe(0)
    expect(interpreter.needsFinalization).toBe(true)
  })
})
