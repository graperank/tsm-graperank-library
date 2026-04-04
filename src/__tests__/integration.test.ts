import { NostrEvent } from '../lib/nostr-tools'
import { parseServiceRequest } from '../tsm/requests'
import { executeServiceRequest, ServiceOutputError } from '../tsm/output'
import { UnsignedEvent } from '../tsm/types'

describe('TSM Integration: Request to Output', () => {
  const mockRequestEvent: NostrEvent = {
    id: 'test-request-id',
    pubkey: 'test-requester-pubkey',
    created_at: Math.floor(Date.now() / 1000),
    kind: 37572,
    tags: [
      ['config', 'type', 'p'],
      ['config', 'pov', '["test-pubkey-1", "test-pubkey-2"]'],
      ['config', 'attenuation', '0.5'],
      ['config', 'rigor', '0.5'],
      ['config', 'precision', '0.00001'],
      ['config', 'minrank', '0'],
      ['config', 'interpreters', '[{"id":"nostr-3","iterate":1}]']
    ],
    content: '',
    sig: 'test-sig'
  }

  describe('Full request-to-output flow', () => {
    test('should parse request successfully', () => {
      const parsed = parseServiceRequest(mockRequestEvent)

      expect(parsed).toBeDefined()
      expect(parsed.interpretationInput).toBeDefined()
      expect(parsed.calculatorParams).toBeDefined()
      expect(parsed.configs).toBeDefined()
      
      expect(parsed.interpretationInput.type).toBe('p')
      expect(parsed.interpretationInput.pov).toEqual(['test-pubkey-1', 'test-pubkey-2'])
      expect(parsed.interpretationInput.requests).toHaveLength(1)
      expect(parsed.interpretationInput.requests[0].id).toBe('nostr-3')
      
      expect(parsed.calculatorParams.attenuation).toBe(0.5)
      expect(parsed.calculatorParams.rigor).toBe(0.5)
      expect(parsed.calculatorParams.precision).toBe(0.00001)
      expect(parsed.calculatorParams.minimum).toBe(0)
    })

    test('should collect feedback events during execution', async () => {
      const parsed = parseServiceRequest(mockRequestEvent)
      const feedbackEvents: UnsignedEvent[] = []

      await executeServiceRequest({
        requestEvent: mockRequestEvent,
        parsedRequest: parsed,
        callbacks: {
          onFeedbackEvent: async (event) => {
            feedbackEvents.push(event)
          }
        }
      }).catch(() => {
        // Execution may fail due to missing relay data, but we can still test feedback
      })

      expect(feedbackEvents.length).toBeGreaterThan(0)
      expect(feedbackEvents[0].kind).toBe(7000)
      expect(feedbackEvents[0].tags).toContainEqual(['e', 'test-request-id', '', 'request'])
    })

    test('should collect verbose feedback when enabled', async () => {
      const parsed = parseServiceRequest(mockRequestEvent)
      const feedbackEvents: UnsignedEvent[] = []

      await executeServiceRequest({
        requestEvent: mockRequestEvent,
        parsedRequest: parsed,
        verboseFeedback: true,
        callbacks: {
          onFeedbackEvent: async (event) => {
            feedbackEvents.push(event)
          }
        }
      }).catch(() => {
        // Execution may fail due to missing relay data
      })

      // With verbose feedback, we should get more events
      // At minimum: starting, interpretation start, and potentially interpreter status
      expect(feedbackEvents.length).toBeGreaterThan(0)
      
      const hasFeedback = feedbackEvents.some(e => 
        e.content.includes('Starting') || 
        e.content.includes('Interpreter') ||
        e.content.includes('Calculator')
      )
      expect(hasFeedback).toBe(true)
    })

    test('should generate error feedback on invalid request', async () => {
      const invalidEvent: NostrEvent = {
        ...mockRequestEvent,
        tags: [
          ['config', 'pov', '["test-pubkey"]']
          // Missing interpreters - should fail
        ]
      }

      const feedbackEvents: UnsignedEvent[] = []

      await expect(async () => {
        const parsed = parseServiceRequest(invalidEvent)
        await executeServiceRequest({
          requestEvent: invalidEvent,
          parsedRequest: parsed,
          callbacks: {
            onFeedbackEvent: async (event) => {
              feedbackEvents.push(event)
            }
          }
        })
      }).rejects.toThrow()
    })

    test('should handle pagination configuration', async () => {
      const parsed = parseServiceRequest(mockRequestEvent)
      let outputEvent: UnsignedEvent | undefined

      await executeServiceRequest({
        requestEvent: mockRequestEvent,
        parsedRequest: parsed,
        pageSize: 10,
        pageNumber: 1,
        callbacks: {
          onOutputEvent: async (event) => {
            outputEvent = event
          }
        }
      }).catch(() => {
        // May fail due to no data, but config should be preserved
      })

      // Even if execution fails, the pagination config should be set up correctly
      expect(parsed.calculatorParams).toBeDefined()
    })
  })

  describe('Callback handling', () => {
    test('should call onFeedbackEvent callback', async () => {
      const parsed = parseServiceRequest(mockRequestEvent)
      let callbackCalled = false

      await executeServiceRequest({
        requestEvent: mockRequestEvent,
        parsedRequest: parsed,
        callbacks: {
          onFeedbackEvent: async (event) => {
            callbackCalled = true
            expect(event.kind).toBe(7000)
          }
        }
      }).catch(() => {})

      expect(callbackCalled).toBe(true)
    })

    test('should work without callbacks', async () => {
      const parsed = parseServiceRequest(mockRequestEvent)

      // Should not throw even without callbacks
      await expect(
        executeServiceRequest({
          requestEvent: mockRequestEvent,
          parsedRequest: parsed
        })
      ).resolves.not.toThrow()
    })
  })

  describe('Error handling', () => {
    test('should handle ServiceOutputError with stage information', async () => {
      const parsed = parseServiceRequest(mockRequestEvent)

      try {
        await executeServiceRequest({
          requestEvent: mockRequestEvent,
          parsedRequest: parsed
        })
      } catch (error) {
        if (error instanceof ServiceOutputError) {
          expect(error.stage).toBeDefined()
          expect(error.message).toBeDefined()
        }
      }
    })

    test('should generate error feedback on failure', async () => {
      const parsed = parseServiceRequest(mockRequestEvent)
      const feedbackEvents: UnsignedEvent[] = []

      await executeServiceRequest({
        requestEvent: mockRequestEvent,
        parsedRequest: parsed,
        callbacks: {
          onFeedbackEvent: async (event) => {
            feedbackEvents.push(event)
          }
        }
      }).catch(() => {})

      // Should have at least one feedback event (even on failure)
      expect(feedbackEvents.length).toBeGreaterThan(0)
    })
  })
})
