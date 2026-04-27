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
      output.tags.filter((tag: string[]) => tag[0] === rankingTagName && tag.length === 4 && tag[3] !== 'request')
    const validPubkey = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const validPubkey2 = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
    const validPubkey3 = 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
    const validEventId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

    test('should generate kind 37573 ranking output event', () => {
      const rankings: [string, { rank?: number; confidence?: number }][] = [
        [validPubkey, { rank: 0.95, confidence: 0.85 }],
        [validPubkey2, { rank: 0.80, confidence: 0.75 }],
        [validPubkey3, { rank: 0.65, confidence: 0.60 }]
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
        [validPubkey, { rank: 0.123456789, confidence: 0.9876 }]
      ]

      const output = generateRankingOutputEvent(
        mockRequestEvent,
        rankings
      )

      const rankingTag = output.tags.find((tag: string[]) => tag[0] === 'p' && tag[1] === validPubkey)
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
        [validPubkey, { rank: 0.5, confidence: 0.8 }],
      ]

      const output = generateRankingOutputEvent(requestEventWithPubkeyType, rankings)

      const pTags = output.tags.filter((tag) => tag[0] === 'p' && tag[1] === validPubkey)
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
        [validPubkey, { rank: 0.9, confidence: 0.7 }],
      ]

      const output = generateRankingOutputEvent(requestEventWithUppercasePType, rankings)

      const pTags = output.tags.filter((tag) => tag[0] === 'p' && tag[1] === validPubkey)
      const uppercasePTags = output.tags.filter((tag) => tag[0] === 'P')

      expect(pTags.length).toBe(1)
      expect(uppercasePTags.length).toBe(0)
    })

    test('filters malformed pubkey ranking subjects before emitting p tags', () => {
      const requestEventWithPubkeyType: NostrEvent = {
        ...mockRequestEvent,
        tags: [
          ['config', 'type', 'pubkey'],
          ['config', 'pov', '"npub1test"'],
        ],
      }

      const rankings: [string, { rank?: number; confidence?: number }][] = [
        [validPubkey, { rank: 0.95, confidence: 0.9 }],
        ['event:e:1234', { rank: 0.7, confidence: 0.6 }],
      ]

      const output = generateRankingOutputEvent(requestEventWithPubkeyType, rankings)
      const rankingTags = getRankingTags(output)

      expect(rankingTags).toHaveLength(1)
      expect(rankingTags[0][1]).toBe(validPubkey)
    })

    test('best-effort coerces event:a actor ids to pubkeys for p output tags', () => {
      const requestEventWithPubkeyType: NostrEvent = {
        ...mockRequestEvent,
        tags: [
          ['config', 'type', 'pubkey'],
          ['config', 'pov', '"npub1test"'],
        ],
      }

      const rankings: [string, { rank?: number; confidence?: number }][] = [
        [`event:a:30023:${validPubkey}:demo-note`, { rank: 0.9, confidence: 0.7 }],
      ]

      const output = generateRankingOutputEvent(requestEventWithPubkeyType, rankings)
      const rankingTags = getRankingTags(output)

      expect(rankingTags).toHaveLength(1)
      expect(rankingTags[0][1]).toBe(validPubkey)
    })

    test('throws when every ranking subject is invalid for requested output tag', () => {
      const requestEventWithPubkeyType: NostrEvent = {
        ...mockRequestEvent,
        tags: [
          ['config', 'type', 'pubkey'],
          ['config', 'pov', '"npub1test"'],
        ],
      }

      const rankings: [string, { rank?: number; confidence?: number }][] = [
        ['event:e:1234', { rank: 0.7, confidence: 0.6 }],
      ]

      expect(() => generateRankingOutputEvent(requestEventWithPubkeyType, rankings)).toThrow(
        "output validation failed: no valid 'p' ranking subjects",
      )
    })

    test('filters malformed event ids when output tag is e', () => {
      const requestEventWithEventType: NostrEvent = {
        ...mockRequestEvent,
        tags: [
          ['config', 'type', 'e'],
          ['config', 'pov', '"note1test"'],
        ],
      }

      const rankings: [string, { rank?: number; confidence?: number }][] = [
        [validEventId, { rank: 0.8, confidence: 0.7 }],
        ['not-an-event-id', { rank: 0.6, confidence: 0.5 }],
      ]

      const output = generateRankingOutputEvent(requestEventWithEventType, rankings)
      const rankingTags = getRankingTags(output, 'e')

      expect(rankingTags).toHaveLength(1)
      expect(rankingTags[0][1]).toBe(validEventId)
    })

    test('best-effort coerces event:e actor ids to e output tags', () => {
      const requestEventWithEventType: NostrEvent = {
        ...mockRequestEvent,
        tags: [
          ['config', 'type', 'e'],
          ['config', 'pov', '"note1test"'],
        ],
      }

      const rankings: [string, { rank?: number; confidence?: number }][] = [
        [`event:e:${validEventId.toUpperCase()}`, { rank: 0.8, confidence: 0.7 }],
      ]

      const output = generateRankingOutputEvent(requestEventWithEventType, rankings)
      const rankingTags = getRankingTags(output, 'e')

      expect(rankingTags).toHaveLength(1)
      expect(rankingTags[0][1]).toBe(validEventId)
    })

    test('filters malformed coordinates when output tag is a', () => {
      const requestEventWithAddressType: NostrEvent = {
        ...mockRequestEvent,
        tags: [
          ['config', 'type', 'a'],
          ['config', 'pov', '"naddr1test"'],
        ],
      }

      const validCoordinate = `30023:${validPubkey}:demo-note`
      const rankings: [string, { rank?: number; confidence?: number }][] = [
        [validCoordinate, { rank: 0.8, confidence: 0.7 }],
        ['30023:not-a-pubkey:demo-note', { rank: 0.6, confidence: 0.5 }],
      ]

      const output = generateRankingOutputEvent(requestEventWithAddressType, rankings)
      const rankingTags = getRankingTags(output, 'a')

      expect(rankingTags).toHaveLength(1)
      expect(rankingTags[0][1]).toBe(validCoordinate)
    })

    test('best-effort coerces event:a actor ids to canonical a output tags', () => {
      const requestEventWithAddressType: NostrEvent = {
        ...mockRequestEvent,
        tags: [
          ['config', 'type', 'a'],
          ['config', 'pov', '"naddr1test"'],
        ],
      }

      const rankings: [string, { rank?: number; confidence?: number }][] = [
        [`event:a:30023:${validPubkey.toUpperCase()}:demo-note`, { rank: 0.8, confidence: 0.7 }],
      ]

      const output = generateRankingOutputEvent(requestEventWithAddressType, rankings)
      const rankingTags = getRankingTags(output, 'a')

      expect(rankingTags).toHaveLength(1)
      expect(rankingTags[0][1]).toBe(`30023:${validPubkey}:demo-note`)
    })

    test('should handle undefined rank and confidence with defaults', () => {
      const rankings: [string, { rank?: number; confidence?: number }][] = [
        [validPubkey, {}]
      ]

      const output = generateRankingOutputEvent(
        mockRequestEvent,
        rankings
      )

      const rankingTag = output.tags.find((tag: string[]) => tag[0] === 'p' && tag[1] === validPubkey)
      expect(rankingTag).toBeDefined()
      expect(rankingTag![2]).toBe('0.000000')
      expect(rankingTag![3]).toBe('0.0000')
    })

    test('should include pagination info when provided', () => {
      const rankings: [string, { rank?: number; confidence?: number }][] = [
        [validPubkey, { rank: 0.95, confidence: 0.85 }]
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
        [validPubkey, { rank: 0.95, confidence: 0.85 }]
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
        [validPubkey, { rank: 0.95, confidence: 0.85 }],
        [validPubkey2, { rank: 0.80, confidence: 0.75 }],
        [validPubkey3, { rank: 0.65, confidence: 0.60 }]
      ]

      const output = generateRankingOutputEvent(
        mockRequestEvent,
        rankings
      )

      const rankingTags = getRankingTags(output)
      expect(rankingTags).toHaveLength(3)
      expect(rankingTags[0][1]).toBe(validPubkey)
      expect(rankingTags[1][1]).toBe(validPubkey2)
      expect(rankingTags[2][1]).toBe(validPubkey3)
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
