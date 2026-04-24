import { NostrEvent } from '../lib/nostr-tools'
import { InterpreterFactory } from '../nostr-interpreters/factory'


describe('Nostr Attestor Recommendations Interpreter (31873)', () => {
  test('should create recommender->attestor interaction and scale by k tags with cap', async () => {
    const RECOMMENDER = 'a'.repeat(64)
    const ATTESTOR_1 = 'b'.repeat(64)
    const ATTESTOR_2 = 'c'.repeat(64)

    const recommendation: NostrEvent = {
      id: 'recommendation'.repeat(6),
      pubkey: RECOMMENDER,
      created_at: 1700000100,
      kind: 31873,
      tags: [
        ['d', ATTESTOR_1],
        ['p', ATTESTOR_1],
        ['p', ATTESTOR_2],
        ['k', '31871'],
        ['k', '31872'],
        ['k', '31873'],
        ['k', '11871'],
      ],
      content: '',
      sig: 'sig'.repeat(16)
    }

    const initializer = InterpreterFactory.get('nostr-31873')
    expect(initializer).toBeDefined()

    const interpreter = initializer!() as any
    interpreter.request = {
      id: 'nostr-31873',
      params: {
        value: 1,
        confidence: 1,
        actorType: 'pubkey',
        subjectType: 'p',
        perKindValue: 2,
        maxKinds: 3,
      }
    }

    interpreter.fetched = [new Set([recommendation])]

    const interactions = await interpreter.interpret(1)
    expect(interactions).toBeDefined()

    const recommenderMap = interactions!.get(RECOMMENDER)
    expect(recommenderMap).toBeDefined()

    // 4 k tags but capped at 3 -> value = perKindValue(2) * 3 = 6
    expect(recommenderMap!.get(ATTESTOR_1)).toEqual({ value: 6, confidence: 1, dos: 1 })
    expect(recommenderMap!.get(ATTESTOR_2)).toEqual({ value: 6, confidence: 1, dos: 1 })
  })
})
