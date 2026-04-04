import { NostrEvent } from '../lib/nostr-tools'
import { generateFeedbackEvent, generateRankingOutputEvent } from '../tsm/output'
import { UnsignedEvent } from '../tsm/types'

describe('TSM Output Generators', () => {
  const mockRequestEvent: NostrEvent = {
    id: 'request-event-id',
    pubkey: 'requester-pubkey',
    created_at: Math.floor(Date.now() / 1000),
    kind: 37572,
    tags: [
      ['config', 'pov', '"npub1test"'],
      ['config', 'interpreters', '[{"id":"nostr-3"}]']
    ],
    content: '',
    sig: 'request-sig'
  }

  describe('generateFeedbackEvent', () => {
    test('should generate kind 7000 feedback event', () => {
      const feedback = generateFeedbackEvent(
        mockRequestEvent,
        'info',
        'Test feedback message'
      )

      expect(feedback.kind).toBe(7000)
      expect(feedback.content).toBe('Test feedback message')
      expect(feedback.tags).toContainEqual(['e', 'request-event-id', '', 'request'])
      expect(feedback.tags).toContainEqual(['p', 'requester-pubkey'])
      expect(feedback.tags).toContainEqual(['k', '37572'])
      expect(feedback.tags).toContainEqual(['status', 'info'])
      expect(feedback).not.toHaveProperty('pubkey')
      expect(feedback).not.toHaveProperty('sig')
      expect(feedback).not.toHaveProperty('id')
    })

    test('should handle different feedback types', () => {
      const types: Array<'info' | 'warning' | 'error' | 'success'> = ['info', 'warning', 'error', 'success']

      types.forEach(type => {
        const feedback = generateFeedbackEvent(
          mockRequestEvent,
          type,
          `${type} message`
        )

        expect(feedback.tags).toContainEqual(['status', type])
        expect(feedback.content).toBe(`${type} message`)
      })
    })

    test('should have created_at timestamp', () => {
      const before = Math.floor(Date.now() / 1000)
      const feedback = generateFeedbackEvent(
        mockRequestEvent,
        'info',
        'Test'
      )
      const after = Math.floor(Date.now() / 1000)

      expect(feedback.created_at).toBeGreaterThanOrEqual(before)
      expect(feedback.created_at).toBeLessThanOrEqual(after)
    })
  })

  describe('generateRankingOutputEvent', () => {
    test('should generate kind 37573 ranking output event', () => {
      const rankings: [string, { rank?: number; confidence?: number }][] = [
        ['subject1', { rank: 0.95, confidence: 0.85 }],
        ['subject2', { rank: 0.80, confidence: 0.75 }],
        ['subject3', { rank: 0.65, confidence: 0.60 }]
      ]

      const output = generateRankingOutputEvent(
        mockRequestEvent,
        rankings
      )

      expect(output.kind).toBe(37573)
      expect(output.content).toBe('')
      expect(output.tags).toContainEqual(['e', 'request-event-id', '', 'request'])
      expect(output.tags).toContainEqual(['p', 'requester-pubkey'])
      expect(output.tags).toContainEqual(['k', '37572'])
      expect(output).not.toHaveProperty('pubkey')
      expect(output).not.toHaveProperty('sig')
      expect(output).not.toHaveProperty('id')
    })

    test('should include result tags with proper formatting', () => {
      const rankings: [string, { rank?: number; confidence?: number }][] = [
        ['subject1', { rank: 0.123456789, confidence: 0.9876 }]
      ]

      const output = generateRankingOutputEvent(
        mockRequestEvent,
        rankings
      )

      const resultTag = output.tags.find((t: string[]) => t[0] === 'result')
      expect(resultTag).toBeDefined()
      expect(resultTag![1]).toBe('subject1')
      expect(resultTag![2]).toBe('0.123457') // rank with 6 decimals
      expect(resultTag![3]).toBe('0.9876') // confidence with 4 decimals
      expect(resultTag![4]).toBe('0') // index
    })

    test('should handle undefined rank and confidence with defaults', () => {
      const rankings: [string, { rank?: number; confidence?: number }][] = [
        ['subject1', {}]
      ]

      const output = generateRankingOutputEvent(
        mockRequestEvent,
        rankings
      )

      const resultTag = output.tags.find((t: string[]) => t[0] === 'result')
      expect(resultTag![2]).toBe('0.000000')
      expect(resultTag![3]).toBe('0.0000')
    })

    test('should include pagination info when provided', () => {
      const rankings: [string, { rank?: number; confidence?: number }][] = [
        ['subject1', { rank: 0.95, confidence: 0.85 }]
      ]

      const output = generateRankingOutputEvent(
        mockRequestEvent,
        rankings,
        {
          totalResults: 100,
          pageSize: 10,
          pageNumber: 2
        }
      )

      expect(output.tags).toContainEqual(['total', '100'])
      expect(output.tags).toContainEqual(['page-size', '10'])
      expect(output.tags).toContainEqual(['page', '2'])
    })

    test('should omit optional pagination fields when not provided', () => {
      const rankings: [string, { rank?: number; confidence?: number }][] = [
        ['subject1', { rank: 0.95, confidence: 0.85 }]
      ]

      const output = generateRankingOutputEvent(
        mockRequestEvent,
        rankings,
        {
          totalResults: 100
        }
      )

      expect(output.tags).toContainEqual(['total', '100'])
      expect(output.tags.find((t: string[]) => t[0] === 'page-size')).toBeUndefined()
      expect(output.tags.find((t: string[]) => t[0] === 'page')).toBeUndefined()
    })

    test('should handle multiple rankings with correct indices', () => {
      const rankings: [string, { rank?: number; confidence?: number }][] = [
        ['subject1', { rank: 0.95, confidence: 0.85 }],
        ['subject2', { rank: 0.80, confidence: 0.75 }],
        ['subject3', { rank: 0.65, confidence: 0.60 }]
      ]

      const output = generateRankingOutputEvent(
        mockRequestEvent,
        rankings
      )

      const resultTags = output.tags.filter((t: string[]) => t[0] === 'result')
      expect(resultTags).toHaveLength(3)
      expect(resultTags[0][4]).toBe('0')
      expect(resultTags[1][4]).toBe('1')
      expect(resultTags[2][4]).toBe('2')
    })

    test('should handle empty rankings array', () => {
      const rankings: [string, { rank?: number; confidence?: number }][] = []

      const output = generateRankingOutputEvent(
        mockRequestEvent,
        rankings
      )

      const resultTags = output.tags.filter((t: string[]) => t[0] === 'result')
      expect(resultTags).toHaveLength(0)
    })
  })
})
