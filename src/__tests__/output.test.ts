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
      ['d', 'request-dtag'],
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
    const getRankingTags = (output: UnsignedEvent, rankingTagName = 'p'): string[][] =>
      output.tags.filter((tag: string[]) => tag[0] === rankingTagName && tag.length === 4)

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

      const rankingTag = output.tags.find((tag: string[]) => tag[0] === 'p' && tag[1] === 'subject1')
      expect(rankingTag).toBeDefined()
      expect(rankingTag![2]).toBe('0.123457')
      expect(rankingTag![3]).toBe('0.9876')
    })

    test('should canonicalize config:type pubkey to p output tags', () => {
      const requestEventWithPubkeyType: NostrEvent = {
        ...mockRequestEvent,
        tags: [
          ['config', 'type', 'pubkey'],
          ['config', 'pov', '"npub1test"'],
        ],
      }

      const rankings: [string, { rank?: number; confidence?: number }][] = [
        ['subject1', { rank: 0.5, confidence: 0.8 }],
      ]

      const output = generateRankingOutputEvent(requestEventWithPubkeyType, rankings)

      const pTags = output.tags.filter((tag) => tag[0] === 'p' && tag[1] === 'subject1')
      const pubkeyTags = output.tags.filter((tag) => tag[0] === 'pubkey')

      expect(pTags.length).toBe(1)
      expect(pubkeyTags.length).toBe(0)
    })

    test('should canonicalize config:type P to p output tags', () => {
      const requestEventWithUppercasePType: NostrEvent = {
        ...mockRequestEvent,
        tags: [
          ['config', 'type', 'P'],
          ['config', 'pov', '"npub1test"'],
        ],
      }

      const rankings: [string, { rank?: number; confidence?: number }][] = [
        ['subject1', { rank: 0.9, confidence: 0.7 }],
      ]

      const output = generateRankingOutputEvent(requestEventWithUppercasePType, rankings)

      const pTags = output.tags.filter((tag) => tag[0] === 'p' && tag[1] === 'subject1')
      const uppercasePTags = output.tags.filter((tag) => tag[0] === 'P')

      expect(pTags.length).toBe(1)
      expect(uppercasePTags.length).toBe(0)
    })

    test('should handle undefined rank and confidence with defaults', () => {
      const rankings: [string, { rank?: number; confidence?: number }][] = [
        ['subject1', {}]
      ]

      const output = generateRankingOutputEvent(
        mockRequestEvent,
        rankings
      )

      const rankingTag = output.tags.find((tag: string[]) => tag[0] === 'p' && tag[1] === 'subject1')
      expect(rankingTag).toBeDefined()
      expect(rankingTag![2]).toBe('0.000000')
      expect(rankingTag![3]).toBe('0.0000')
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

      expect(output.tags).toContainEqual(['v', 'total:100'])
      expect(output.tags).toContainEqual(['v', 'page-size:10'])
      expect(output.tags).toContainEqual([
        'v',
        'page:2',
        JSON.stringify([
          'request-dtag',
          'request-dtag:2',
          'request-dtag:3',
          'request-dtag:4',
          'request-dtag:5',
          'request-dtag:6',
          'request-dtag:7',
          'request-dtag:8',
          'request-dtag:9',
          'request-dtag:10',
        ]),
      ])
      expect(output.tags).toContainEqual(['d', 'request-dtag:2'])
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

      expect(output.tags).toContainEqual(['v', 'total:100'])
      expect(output.tags.find((tag: string[]) => tag[0] === 'v' && tag[1].startsWith('page-size:'))).toBeUndefined()
      expect(output.tags.find((tag: string[]) => tag[0] === 'v' && tag[1].startsWith('page:'))).toBeUndefined()
      expect(output.tags).toContainEqual(['d', undefined])
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

      const rankingTags = getRankingTags(output)
      expect(rankingTags).toHaveLength(3)
      expect(rankingTags[0][1]).toBe('subject1')
      expect(rankingTags[1][1]).toBe('subject2')
      expect(rankingTags[2][1]).toBe('subject3')
    })

    test('should handle empty rankings array', () => {
      const rankings: [string, { rank?: number; confidence?: number }][] = []

      const output = generateRankingOutputEvent(
        mockRequestEvent,
        rankings
      )

      const rankingTags = getRankingTags(output)
      expect(rankingTags).toHaveLength(0)
    })
  })
})
