import { NostrEvent } from '../lib/nostr-tools'
import { parseServiceRequest, ServiceRequestParseError } from '../tsm/requests'

describe('TSM Request Parser', () => {
  const baseRequestEvent: NostrEvent = {
    id: 'test-event-id',
    pubkey: 'test-pubkey',
    created_at: Math.floor(Date.now() / 1000),
    kind: 37572,
    tags: [],
    content: '',
    sig: 'test-sig'
  }

  describe('parseServiceRequest', () => {
    test('should parse valid request with all configs', () => {
      const event: NostrEvent = {
        ...baseRequestEvent,
        tags: [
          ['config', 'type', 'p'],
          ['config', 'pov', '["npub1test"]'],
          ['config', 'minrank', '10'],
          ['config', 'attenuation', '0.6'],
          ['config', 'rigor', '0.4'],
          ['config', 'precision', '0.0001'],
          ['config', 'interpreters', '[{"id":"nostr-3","iterate":3}]']
        ]
      }

      const result = parseServiceRequest(event)

      expect(result.configs.type).toBe('p')
      expect(result.configs.pov).toEqual(['npub1test'])
      expect(result.configs.minrank).toBe(10)
      expect(result.configs.attenuation).toBe(0.6)
      expect(result.configs.rigor).toBe(0.4)
      expect(result.configs.precision).toBe(0.0001)
      expect(result.configs.interpreters).toHaveLength(1)
      expect(result.configs.interpreters![0].id).toBe('nostr-3')
      
      expect(result.interpretationInput.type).toBe('p')
      expect(result.interpretationInput.pov).toEqual(['npub1test'])
      expect(result.interpretationInput.requests).toHaveLength(1)
      
      expect(result.calculatorParams.attenuation).toBe(0.6)
      expect(result.calculatorParams.rigor).toBe(0.4)
      expect(result.calculatorParams.minimum).toBe(10)
      expect(result.calculatorParams.precision).toBe(0.0001)
    })

    test('should use defaults when configs are omitted', () => {
      const event: NostrEvent = {
        ...baseRequestEvent,
        tags: [
          ['config', 'type', 'p'],
          ['config', 'pov', '"npub1test"'],
          ['config', 'interpreters', '[{"id":"nostr-3"}]']
        ]
      }

      const result = parseServiceRequest(event)

      expect(result.configs.minrank).toBe(0)
      expect(result.configs.attenuation).toBe(0.5)
      expect(result.configs.rigor).toBe(0.5)
      expect(result.configs.precision).toBe(0.00001)
    })

    test('should infer type from first interpreter if not provided', () => {
      const event: NostrEvent = {
        ...baseRequestEvent,
        tags: [
          ['config', 'pov', '"npub1test"'],
          ['config', 'interpreters', '[{"id":"nostr-3","params":{"subjectType":"p"}}]']
        ]
      }

      const result = parseServiceRequest(event)

      expect(result.configs.type).toBe('p')
    })

    test('should throw error for missing pov', () => {
      const event: NostrEvent = {
        ...baseRequestEvent,
        tags: [
          ['config', 'interpreters', '[{"id":"nostr-3"}]']
        ]
      }

      expect(() => parseServiceRequest(event)).toThrow(ServiceRequestParseError)
      expect(() => parseServiceRequest(event)).toThrow('Missing required config: pov')
    })

    test('should throw error for missing interpreters', () => {
      const event: NostrEvent = {
        ...baseRequestEvent,
        tags: [
          ['config', 'pov', '"npub1test"']
        ]
      }

      expect(() => parseServiceRequest(event)).toThrow(ServiceRequestParseError)
      expect(() => parseServiceRequest(event)).toThrow('Missing required config: interpreters')
    })

    test('should throw error for wrong event kind', () => {
      const event: NostrEvent = {
        ...baseRequestEvent,
        kind: 1,
        tags: [
          ['config', 'pov', '"npub1test"'],
          ['config', 'interpreters', '[{"id":"nostr-3"}]']
        ]
      }

      expect(() => parseServiceRequest(event)).toThrow(ServiceRequestParseError)
      expect(() => parseServiceRequest(event)).toThrow('Expected kind 37572')
    })

    test('should validate attenuation range', () => {
      const event: NostrEvent = {
        ...baseRequestEvent,
        tags: [
          ['config', 'pov', '"npub1test"'],
          ['config', 'attenuation', '1.5'],
          ['config', 'interpreters', '[{"id":"nostr-3"}]']
        ]
      }

      expect(() => parseServiceRequest(event)).toThrow(ServiceRequestParseError)
      expect(() => parseServiceRequest(event)).toThrow('attenuation must be between 0 and 1')
    })

    test('should validate rigor range', () => {
      const event: NostrEvent = {
        ...baseRequestEvent,
        tags: [
          ['config', 'pov', '"npub1test"'],
          ['config', 'rigor', '-0.1'],
          ['config', 'interpreters', '[{"id":"nostr-3"}]']
        ]
      }

      expect(() => parseServiceRequest(event)).toThrow(ServiceRequestParseError)
      expect(() => parseServiceRequest(event)).toThrow('rigor must be between 0 and 1')
    })

    test('should validate minrank range', () => {
      const event: NostrEvent = {
        ...baseRequestEvent,
        tags: [
          ['config', 'pov', '"npub1test"'],
          ['config', 'minrank', '150'],
          ['config', 'interpreters', '[{"id":"nostr-3"}]']
        ]
      }

      expect(() => parseServiceRequest(event)).toThrow(ServiceRequestParseError)
      expect(() => parseServiceRequest(event)).toThrow('minrank must be between 0 and 100')
    })

    test('should validate precision minimum', () => {
      const event: NostrEvent = {
        ...baseRequestEvent,
        tags: [
          ['config', 'pov', '"npub1test"'],
          ['config', 'precision', '-0.001'],
          ['config', 'interpreters', '[{"id":"nostr-3"}]']
        ]
      }

      expect(() => parseServiceRequest(event)).toThrow(ServiceRequestParseError)
      expect(() => parseServiceRequest(event)).toThrow('precision must be >= 0')
    })

    test('should parse custom configs', () => {
      const event: NostrEvent = {
        ...baseRequestEvent,
        tags: [
          ['config', 'type', 'p'],
          ['config', 'pov', '"npub1test"'],
          ['config', 'interpreters', '[{"id":"nostr-3"}]'],
          ['config', 'custom-param', 'custom-value']
        ]
      }

      const result = parseServiceRequest(event)

      expect(result.configs['custom-param']).toBe('custom-value')
    })

    test('should accept pov as string or array', () => {
      const stringPovEvent: NostrEvent = {
        ...baseRequestEvent,
        tags: [
          ['config', 'type', 'p'],
          ['config', 'pov', '"npub1test"'],
          ['config', 'interpreters', '[{"id":"nostr-3"}]']
        ]
      }

      const arrayPovEvent: NostrEvent = {
        ...baseRequestEvent,
        tags: [
          ['config', 'type', 'p'],
          ['config', 'pov', '["npub1test", "npub2test"]'],
          ['config', 'interpreters', '[{"id":"nostr-3"}]']
        ]
      }

      const result1 = parseServiceRequest(stringPovEvent)
      const result2 = parseServiceRequest(arrayPovEvent)

      expect(result1.configs.pov).toBe('npub1test')
      expect(result2.configs.pov).toEqual(['npub1test', 'npub2test'])
    })

    test('should use provided defaults', () => {
      const event: NostrEvent = {
        ...baseRequestEvent,
        tags: [
          ['config', 'pov', '"npub1test"'],
          ['config', 'interpreters', '[{"id":"nostr-3"}]']
        ]
      }

      const defaults = {
        type: 't',
        attenuation: 0.7,
        rigor: 0.3,
        minrank: 5,
        precision: 0.001
      }

      const result = parseServiceRequest(event, defaults)

      expect(result.configs.type).toBe('t')
      expect(result.configs.attenuation).toBe(0.7)
      expect(result.configs.rigor).toBe(0.3)
      expect(result.configs.minrank).toBe(5)
      expect(result.configs.precision).toBe(0.001)
    })
  })
})
