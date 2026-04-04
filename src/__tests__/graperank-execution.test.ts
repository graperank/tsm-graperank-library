import { NostrEvent, SimplePool } from '../lib/nostr-tools'
import { parseServiceRequest } from '../tsm/requests'
import { InterpretationController, InterpretersMap } from '../graperank/interpretation'
import { CalculationController } from '../graperank/calculation'
import { InterpreterFactory } from '../nostr-interpreters/factory'

describe('GrapeRank Full Execution with Mock Data', () => {
  // Track all SimplePool instances for cleanup
  const pools: SimplePool[] = []
  
  afterAll(async () => {
    // Close all WebSocket connections to prevent Jest hanging
    pools.forEach(pool => pool.close([]))
    // Give connections time to close
    await new Promise(resolve => setTimeout(resolve, 100))
  })
  // Mock pubkeys for POV and subjects
  const POV_PUBKEY_1 = 'pov1'.repeat(16) // 64 char hex
  const POV_PUBKEY_2 = 'pov2'.repeat(16)
  const SUBJECT_A = 'subA'.repeat(16)
  const SUBJECT_B = 'subB'.repeat(16)
  const SUBJECT_C = 'subC'.repeat(16)
  const SUBJECT_D = 'subD'.repeat(16)

  // Mock Kind 3 (follow list) events
  const mockFollowEvents: NostrEvent[] = [
    // POV_1 follows SUBJECT_A and SUBJECT_B
    {
      id: 'event1'.repeat(8),
      pubkey: POV_PUBKEY_1,
      created_at: 1700000000,
      kind: 3,
      tags: [
        ['p', SUBJECT_A],
        ['p', SUBJECT_B]
      ],
      content: '',
      sig: 'sig1'.repeat(16)
    },
    // POV_2 follows SUBJECT_B and SUBJECT_C
    {
      id: 'event2'.repeat(8),
      pubkey: POV_PUBKEY_2,
      created_at: 1700000001,
      kind: 3,
      tags: [
        ['p', SUBJECT_B],
        ['p', SUBJECT_C]
      ],
      content: '',
      sig: 'sig2'.repeat(16)
    },
    // SUBJECT_A follows SUBJECT_C and SUBJECT_D
    {
      id: 'event3'.repeat(8),
      pubkey: SUBJECT_A,
      created_at: 1700000002,
      kind: 3,
      tags: [
        ['p', SUBJECT_C],
        ['p', SUBJECT_D]
      ],
      content: '',
      sig: 'sig3'.repeat(16)
    },
    // SUBJECT_B follows SUBJECT_D
    {
      id: 'event4'.repeat(8),
      pubkey: SUBJECT_B,
      created_at: 1700000003,
      kind: 3,
      tags: [
        ['p', SUBJECT_D]
      ],
      content: '',
      sig: 'sig4'.repeat(16)
    }
  ]

  describe('Complete TSM flow with real interpretation and calculation', () => {
    test('should execute full GrapeRank calculation with mock follow events', async () => {
      // Create a properly typed mock interpreter
      const createMockInterpreter = () => {
        const mockInteractions = new Map()
        const mockFetched = [new Set()]
        
        return {
          interpreterId: 'nostr-3' as const,
          label: 'Mock Follows',
          description: 'Test interpreter',
          params: { value: 1, confidence: 1, subjectType: 'p' },
          fetched: mockFetched,
          interactions: mockInteractions,
          
          resolveActors: async () => {
            return new Set([POV_PUBKEY_1, POV_PUBKEY_2])
          },
          
          fetchData: async () => {
            mockFetched[0] = new Set(mockFollowEvents)
            return mockFollowEvents.length
          },
          
          interpret: async () => {
            // Clear and rebuild the mockInteractions map
            mockInteractions.clear()
            
            mockFollowEvents.forEach(event => {
              event.tags.forEach((tag: string[]) => {
                if (tag[0] === 'p') {
                  const actor = event.pubkey
                  const subject = tag[1]
                  
                  if (!mockInteractions.has(actor)) {
                    mockInteractions.set(actor, new Map())
                  }
                  mockInteractions.get(actor)!.set(subject, {
                    value: 1,
                    confidence: 1,
                    dos: 0
                  })
                }
              })
            })
            
            return mockInteractions
          }
        }
      }

      // Create interpretation input
      const interpretationInput = {
        type: 'p' as const,
        pov: [POV_PUBKEY_1, POV_PUBKEY_2],
        requests: [
          {
            id: 'nostr-3' as const,
            iterate: 3
          }
        ]
      }

      // Create interpreters map with mock
      const interpretersMap = new InterpretersMap([])
      interpretersMap.set('nostr-3', createMockInterpreter())
      
      // Set each request individually
      interpretationInput.requests.forEach(req => {
        interpretersMap.setRequest(req)
      })

      // Execute interpretation
      const interpretationController = new InterpretationController(interpretersMap)
      const interpretationOutput = await interpretationController.interpret(interpretationInput)

      expect(interpretationOutput).toBeDefined()
      expect(interpretationOutput!.interactions.length).toBeGreaterThan(0)
      expect(interpretationOutput!.pov.length).toBe(2)

      // Verify some interactions were created
      const interactions = interpretationOutput!.interactions
      expect(interactions.some(i => i.actor === POV_PUBKEY_1 && i.subject === SUBJECT_A)).toBe(true)
      expect(interactions.some(i => i.actor === POV_PUBKEY_1 && i.subject === SUBJECT_B)).toBe(true)
      expect(interactions.some(i => i.actor === POV_PUBKEY_2 && i.subject === SUBJECT_B)).toBe(true)

      // Execute calculation
      const calculatorParams = {
        attenuation: 0.5,
        rigor: 0.5,
        minimum: 0,
        precision: 0.00001
      }

      const calculationController = new CalculationController(
        interpretationOutput!.pov,
        interpretationOutput!.interactions,
        calculatorParams
      )

      const rankings = await calculationController.calculate()

      // Verify rankings were generated
      expect(rankings).toBeDefined()
      expect(rankings.length).toBeGreaterThan(0)

      // Rankings should include subjects that were followed
      const rankedSubjects = rankings.map(r => r[0])
      expect(rankedSubjects).toContain(SUBJECT_A)
      expect(rankedSubjects).toContain(SUBJECT_B)
      expect(rankedSubjects).toContain(SUBJECT_C)

      // SUBJECT_B should have highest rank (followed by both POV members)
      const subjectBRanking = rankings.find(r => r[0] === SUBJECT_B)
      expect(subjectBRanking).toBeDefined()
      expect(subjectBRanking![1].rank).toBeGreaterThan(0)
      expect(subjectBRanking![1].confidence).toBeGreaterThan(0)

      // Verify DOS (Degree of Separation) is tracked
      const subjectDRanking = rankings.find(r => r[0] === SUBJECT_D)
      if (subjectDRanking) {
        // SUBJECT_D is at DOS 2 (followed by SUBJECT_A and SUBJECT_B)
        expect(subjectDRanking[1].rank).toBeGreaterThan(0)
      }

      console.log('\n=== GrapeRank Results ===')
      console.log(`Total rankings: ${rankings.length}`)
      rankings.forEach(([subject, data]) => {
        console.log(`  ${subject.substring(0, 8)}: rank=${data.rank?.toFixed(4)}, confidence=${data.confidence?.toFixed(4)}`)
      })
    }, 30000)

    test('should handle multi-iteration interpretation', async () => {
      const createMockInterpreter = () => {
        const mockInteractions = new Map()
        const mockFetched = [new Set()]
        
        return {
          interpreterId: 'nostr-3' as const,
          label: 'Mock Follows',
          description: 'Test interpreter',
          params: { value: 1, confidence: 1, subjectType: 'p' },
          fetched: mockFetched,
          interactions: mockInteractions,
          
          resolveActors: async () => {
            return new Set([POV_PUBKEY_1, POV_PUBKEY_2])
          },
          
          fetchData: async () => {
            mockFetched[0] = new Set(mockFollowEvents)
            return mockFollowEvents.length
          },
          
          interpret: async () => {
            // Clear and rebuild the mockInteractions map
            mockInteractions.clear()
            
            mockFollowEvents.forEach(event => {
              event.tags.forEach((tag: string[]) => {
                if (tag[0] === 'p') {
                  const actor = event.pubkey
                  const subject = tag[1]
                  
                  if (!mockInteractions.has(actor)) {
                    mockInteractions.set(actor, new Map())
                  }
                  mockInteractions.get(actor)!.set(subject, {
                    value: 1,
                    confidence: 1,
                    dos: 0
                  })
                }
              })
            })
            
            return mockInteractions
          }
        }
      }

      const interpretationInput = {
        type: 'p' as const,
        pov: [POV_PUBKEY_1, POV_PUBKEY_2],
        requests: [
          {
            id: 'nostr-3' as const,
            iterate: 2 // Two iterations should expand the network
          }
        ]
      }

      const interpretersMap = new InterpretersMap([])
      interpretersMap.set('nostr-3', createMockInterpreter())
      
      interpretationInput.requests.forEach(req => {
        interpretersMap.setRequest(req)
      })

      const interpretationController = new InterpretationController(interpretersMap)
      const interpretationOutput = await interpretationController.interpret(interpretationInput)

      expect(interpretationOutput).toBeDefined()
      
      // With 2 iterations, we should get interactions at DOS 0, 1, and potentially 2
      const interactions = interpretationOutput!.interactions
      const uniqueDosValues = new Set(interactions.map(i => i.dos))
      
      expect(uniqueDosValues.size).toBeGreaterThan(0)
      expect(interactions.length).toBeGreaterThan(2)
    }, 30000)

    test('should respect calculator parameters', async () => {
      const createMockInterpreter = () => {
        const mockInteractions = new Map()
        const mockFetched = [new Set()]
        
        return {
          interpreterId: 'nostr-3' as const,
          label: 'Mock Follows',
          description: 'Test interpreter',
          params: { value: 1, confidence: 1, subjectType: 'p' },
          fetched: mockFetched,
          interactions: mockInteractions,
          
          resolveActors: async () => {
            return new Set([POV_PUBKEY_1, POV_PUBKEY_2])
          },
          
          fetchData: async () => {
            mockFetched[0] = new Set(mockFollowEvents)
            return mockFollowEvents.length
          },
          
          interpret: async () => {
            // Clear and rebuild the mockInteractions map
            mockInteractions.clear()
            
            mockFollowEvents.forEach(event => {
              event.tags.forEach((tag: string[]) => {
                if (tag[0] === 'p') {
                  const actor = event.pubkey
                  const subject = tag[1]
                  
                  if (!mockInteractions.has(actor)) {
                    mockInteractions.set(actor, new Map())
                  }
                  mockInteractions.get(actor)!.set(subject, {
                    value: 1,
                    confidence: 1,
                    dos: 0
                  })
                }
              })
            })
            
            return mockInteractions
          }
        }
      }

      const interpretationInput = {
        type: 'p' as const,
        pov: [POV_PUBKEY_1, POV_PUBKEY_2],
        requests: [{ id: 'nostr-3' as const, iterate: 1 }]
      }

      const interpretersMap = new InterpretersMap([])
      interpretersMap.set('nostr-3', createMockInterpreter())
      
      interpretationInput.requests.forEach(req => {
        interpretersMap.setRequest(req)
      })

      const interpretationController = new InterpretationController(interpretersMap)
      const interpretationOutput = await interpretationController.interpret(interpretationInput)

      // Test with high minimum rank (should filter out low-ranked results)
      const strictParams = {
        attenuation: 0.5,
        rigor: 0.5,
        minimum: 0.8, // High threshold
        precision: 0.00001
      }

      const strictController = new CalculationController(
        interpretationOutput!.pov,
        interpretationOutput!.interactions,
        strictParams
      )

      const strictRankings = await strictController.calculate()

      // Test with low minimum rank (should include more results)
      const lenientParams = {
        attenuation: 0.5,
        rigor: 0.5,
        minimum: 0, // No threshold
        precision: 0.00001
      }

      const lenientController = new CalculationController(
        interpretationOutput!.pov,
        interpretationOutput!.interactions,
        lenientParams
      )

      const lenientRankings = await lenientController.calculate()

      // Lenient should have same or more results than strict
      expect(lenientRankings.length).toBeGreaterThanOrEqual(strictRankings.length)
      
      // All strict rankings should have rank >= 0.8
      strictRankings.forEach(([_, data]) => {
        expect(data.rank).toBeGreaterThanOrEqual(0.8)
      })
    }, 30000)

    test('should handle empty POV gracefully', async () => {
      const interpretationInput = {
        type: 'p' as const,
        pov: [], // Empty POV
        requests: [{ id: 'nostr-3' as const, iterate: 1 }]
      }

      const interpretersMap = new InterpretersMap([InterpreterFactory])
      
      interpretationInput.requests.forEach(req => {
        interpretersMap.setRequest(req)
      })

      const interpretationController = new InterpretationController(interpretersMap)
      const interpretationOutput = await interpretationController.interpret(interpretationInput)

      // Should complete without error but produce no rankings
      expect(interpretationOutput).toBeDefined()
      expect(interpretationOutput!.pov.length).toBe(0)
      expect(interpretationOutput!.interactions.length).toBe(0)
    }, 30000)
  })
})
