import { NostrEvent } from '../lib/nostr-tools'
import { InterpreterFactory } from '../nostr-interpreters/factory'


describe('Nostr Attestations Interpreter (31871)', () => {
  test('should apply valid/invalid values and ignore revoked attestations by shared d tag', async () => {
    const ATTESTOR = 'attestor'.repeat(8)
    const ASSERTOR = 'assertor'.repeat(8)

    const dTag = 'attestor:claim-1'

    const validAttestation: NostrEvent = {
      id: 'valid-attestation'.repeat(4),
      pubkey: ATTESTOR,
      created_at: 1700000000,
      kind: 31871,
      tags: [
        ['d', dTag],
        ['a', `30023:${ASSERTOR}:some-identifier`],
        ['v', 'valid']
      ],
      content: '',
      sig: 'sig'.repeat(16)
    }

    const invalidAttestation: NostrEvent = {
      id: 'invalid-attestation'.repeat(3),
      pubkey: ATTESTOR,
      created_at: 1700000001,
      kind: 31871,
      tags: [
        ['d', 'attestor:claim-2'],
        ['a', `30023:${ASSERTOR}:some-identifier`],
        ['v', 'invalid']
      ],
      content: '',
      sig: 'sig2'.repeat(16)
    }

    const revokedLater: NostrEvent = {
      id: 'revoked-later'.repeat(5),
      pubkey: ATTESTOR,
      created_at: 1700000002,
      kind: 31871,
      tags: [
        ['d', dTag],
        ['s', 'revoked']
      ],
      content: '',
      sig: 'sig3'.repeat(16)
    }

    const initializer = InterpreterFactory.get('nostr-31871')
    expect(initializer).toBeDefined()

    const interpreter = initializer!() as any
    interpreter.request = {
      id: 'nostr-31871',
      params: {
        value: 1,
        confidence: 1,
        actorType: 'pubkey',
        subjectType: 'a',
        valueValid: 1,
        valueInvalid: 0,
      }
    }

    interpreter.fetched = [new Set([validAttestation, invalidAttestation, revokedLater])]

    const interactions = await interpreter.interpret(1)
    expect(interactions).toBeDefined()

    const attestorMap = interactions!.get(ATTESTOR)
    expect(attestorMap).toBeDefined()

    // The valid attestation shares the same d tag as a revoked event, so it should be ignored entirely
    // Only the invalid attestation should remain, with valueInvalid=0
    expect(attestorMap!.get(ASSERTOR)).toEqual({ value: 0, confidence: 1, dos: 1 })
  })
})
