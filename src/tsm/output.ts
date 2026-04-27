import { NostrEvent } from '../lib/nostr-tools'
import { InterpretationController, InterpretersMap } from '../graperank/interpretation'
import { CalculationController } from '../graperank/calculation'
import { InterpreterFactory } from '../nostr-interpreters/factory'
import { PubkeyTypes } from '../nostr-interpreters/types'
import { parseCoordinate, parseEventActorId, validatePubkey } from '../nostr-interpreters/helpers'
import { UnsignedEvent, MetricsCollector, RequestMetrics } from './types'
import { ParsedServiceRequest } from './requests'
import { InterpreterStatus, CalculatorIterationStatus } from '../graperank/types'

/**
 * Generate Service Output Events
 * 
 * Execute InterpretationController
 * Execute CalculationController
 * Output unsigned kind 7000 feedback events via callback
 * Output unsigned kind 37573 ranking events via callback
 */

export type FeedbackEventType = 'info' | 'warning' | 'error' | 'success'

export type ServiceOutputCallbacks = {
  onFeedbackEvent?: (event: UnsignedEvent) => void | Promise<void>
  onOutputEvent?: (event: UnsignedEvent) => void | Promise<void>
  onKeepAlive?: () => void
}

export type ServiceOutputConfig = {
  requestEvent: NostrEvent
  parsedRequest: ParsedServiceRequest
  callbacks?: ServiceOutputCallbacks
  pageSize?: number
  pageNumber?: number
  verboseFeedback?: boolean
}

export class ServiceOutputError extends Error {
  constructor(message: string, public stage?: string) {
    super(message)
    this.name = 'ServiceOutputError'
  }
}

export async function executeServiceRequest(
  config: ServiceOutputConfig
): Promise<void> {
  const { requestEvent, parsedRequest, callbacks, pageSize, pageNumber, verboseFeedback } = config
  const { interpretationInput, calculatorParams } = parsedRequest

  const metrics = new MetricsCollector(requestEvent.id)

  const onInterpreterStatus = async (status: InterpreterStatus): Promise<boolean> => {
    if (verboseFeedback && callbacks?.onFeedbackEvent) {
      const fetchProgressMessage = status.fetchProgress
        ? `, fetch progress ${status.fetchProgress.processedActors}/${status.fetchProgress.totalActors} actors`
        : ''
      const message = `Interpreter ${status.interpreterId} DOS ${status.dos || 0}: ${status.authors} actors${fetchProgressMessage}, ${status.fetched?.[0] || 0} events fetched (${status.fetched?.[1] || 0}ms), ${status.interpreted?.[0] || 0} interactions interpreted (${status.interpreted?.[1] || 0}ms)`
      await sendFeedback(requestEvent, 'info', message, callbacks.onFeedbackEvent)
    }
    return true
  }

  const onCalculatorStatus = async (status: CalculatorIterationStatus): Promise<void> => {
    if (verboseFeedback && callbacks?.onFeedbackEvent) {
      const statusEntries = Object.entries(status) as Array<[
        string,
        { calculated?: number; uncalculated?: number; average?: number }
      ]>
      const message = `Calculator iteration: ${statusEntries.map(([dos, data]) => 
        `DOS ${dos}: ${data.calculated || 0} converged, ${data.uncalculated || 0} calculating, avg rank ${data.average?.toFixed(4) || 0}`
      ).join('; ')}`
      await sendFeedback(requestEvent, 'info', message, callbacks.onFeedbackEvent)
    }
  }

  const onComplete = async (): Promise<void> => {
    if (verboseFeedback && callbacks?.onFeedbackEvent) {
      await sendFeedback(requestEvent, 'info', 'Calculator iterations complete', callbacks.onFeedbackEvent)
    }
  }

  try {
    await sendFeedback(
      requestEvent,
      'info',
      `Request ${requestEvent.id.slice(0, 8)}: Processing started`,
      callbacks?.onFeedbackEvent
    )

    metrics.startPhase('interpretation')

    const interpretersMap = new InterpretersMap([InterpreterFactory])
    const interpretationController = new InterpretationController(
      interpretersMap,
      onInterpreterStatus,
      callbacks?.onKeepAlive
    )

    await sendFeedback(
      requestEvent,
      'info',
      'Interpretation phase started',
      callbacks?.onFeedbackEvent
    )

    const interpretationOutput = await interpretationController.interpret(interpretationInput)

    if (!interpretationOutput) {
      throw new ServiceOutputError('Interpretation was stopped or returned no output', 'interpretation')
    }

    const { interactions, responses, pov } = interpretationOutput

    metrics.setInterpretationTotals(interactions.length, responses.length)
    metrics.endPhase()

    await sendFeedback(
      requestEvent,
      'success',
      `Interpretation completed: ${interactions.length} interactions from ${responses.length} interpreters`,
      callbacks?.onFeedbackEvent
    )

    if (interactions.length === 0) {
      await sendFeedback(
        requestEvent,
        'warning',
        'No interactions found. Cannot calculate rankings.',
        callbacks?.onFeedbackEvent
      )
      return
    }

    metrics.startPhase('calculation')

    await sendFeedback(
      requestEvent,
      'info',
      'Calculation phase started',
      callbacks?.onFeedbackEvent
    )

    const calculationController = new CalculationController(
      pov,
      interactions,
      calculatorParams,
      onCalculatorStatus,
      onComplete
    )

    const rankings = await calculationController.calculate()

    metrics.setCalculationTotals(rankings.length)
    metrics.endPhase()

    await sendFeedback(
      requestEvent,
      'success',
      `Calculation completed: ${rankings.length} rankings generated`,
      callbacks?.onFeedbackEvent
    )

    metrics.startPhase('output')

    const totalPages = pageSize && pageSize > 0 ? Math.ceil(rankings.length / pageSize) : 1
    const startPage = pageNumber !== undefined ? pageNumber : 1
    
    console.log(`[pagination] totalResults=${rankings.length}, pageSize=${pageSize}, totalPages=${totalPages}, startPage=${startPage}`)

    for (let page = startPage; page <= (pageNumber !== undefined ? startPage : totalPages); page++) {
      console.log(`[pagination] generating page ${page} of ${totalPages}`)
      
      // Send keep-alive every 5 pages to prevent connection timeout
      if (page % 5 === 0 && callbacks?.onKeepAlive) {
        callbacks.onKeepAlive()
      }
      
      const startIdx = (page - 1) * (pageSize || rankings.length)
      const endIdx = startIdx + (pageSize || rankings.length)
      const rankingsToOutput = rankings.slice(startIdx, endIdx).map(
        ([subject, data]) => [
          subject,
          { rank: data.rank, confidence: data.confidence }
        ] as [string, { rank?: number; confidence?: number }]
      )

      await sendFeedback(
        requestEvent,
        'info',
        `Output page ${page}/${totalPages}: ${rankingsToOutput.length} rankings`,
        callbacks?.onFeedbackEvent
      )

      const rankingEvent = generateRankingOutputEvent(
        requestEvent,
        rankingsToOutput,
        {
          totalResults: rankings.length,
          pageSize,
          pageNumber: page
        },
      )

      if (callbacks?.onOutputEvent) {
        await callbacks.onOutputEvent(rankingEvent)
      }
    }

    metrics.setOutputTotals(totalPages, rankings.length)
    metrics.endPhase()

    const finalMetrics = metrics.finalize()
    
    await sendFeedback(
      requestEvent,
      'success',
      `Request ${requestEvent.id.slice(0, 8)}: Completed successfully (${totalPages} page(s), ${rankings.length} rankings)`,
      callbacks?.onFeedbackEvent,
      finalMetrics
    )

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    const stage = error instanceof ServiceOutputError ? error.stage : 'unknown'
    
    await sendFeedback(
      requestEvent,
      'error',
      `${stage} error: ${errorMessage}`,
      callbacks?.onFeedbackEvent
    )
    
    throw error
  }
}

export function generateFeedbackEvent(
  requestEvent: NostrEvent,
  type: FeedbackEventType,
  message: string,
  metrics?: RequestMetrics
): UnsignedEvent {
  const tags: string[][] = [
    ['e', requestEvent.id, '', 'request'],
    ['p', requestEvent.pubkey],
    ['k', String(requestEvent.kind)],
    ['status', type]
  ]

  // Add structured metrics as a tag if provided
  if (metrics) {
    tags.push(['metrics', JSON.stringify(metrics)])
  }

  return {
    kind: 7000,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: message
  }
}

export function generateRankingOutputEvent(
  requestEvent: NostrEvent,
  rankings: [string, { rank?: number; confidence?: number }][],
  pagination?: {
    totalResults: number
    pageSize?: number
    pageNumber?: number
  }
): UnsignedEvent {
  const requestedType = requestEvent.tags.find(t => t[0] === 'config' && t[1] === 'type')?.[2]
  const resultTagName = getRankingOutputTagName(requestedType)
  const { validRankings, invalidCount } = coerceAndFilterRankingsByTagName(rankings, resultTagName)

  // Validation is enforced here so malformed ranking subjects never reach relays.
  if (invalidCount > 0) {
    console.warn(
      `[output] request=${requestEvent.id.slice(0, 8)} filtered=${invalidCount}/${rankings.length} invalid '${resultTagName}' ranking subjects`,
    )
  }

  if (rankings.length > 0 && validRankings.length === 0) {
    throw new ServiceOutputError(
      `output validation failed: no valid '${resultTagName}' ranking subjects (filtered ${invalidCount}/${rankings.length}) for request ${requestEvent.id.slice(0, 8)}`,
      'output',
    )
  }

  const requestDTag = requestEvent.tags.find(t => t[0] === 'd')?.[1]
  
  const tags: string[][] = [
    ['e', requestEvent.id, '', 'request'],
    ['p', requestEvent.pubkey],
    ['k', String(requestEvent.kind)]
  ]
  const pageIds: string[] = generatePageIds(requestDTag, pagination)

  // Add d tag from request to make output replaceable
  // append page number to `d` tag to make each page separately addressable
  const dTagValue = pageIds[pagination?.pageNumber - 1]
  tags.push(['d', dTagValue])

  // Pagination metadata gets added as `v` tags to output events
  // Rather than reserving 'page' or other arbitrary tagnames
  // output metadata is always rendered to `v` tags
  // allowing output results to be rendered to any tag 
  // without worry of name collisions
  if (pagination) {
    tags.push(['v', `total:${pagination.totalResults}`])
    if (pagination.pageSize !== undefined) {
      tags.push(['v', `page-size:${pagination.pageSize}`])
    }
    // page tag MUST include a json array of every `d` tag value
    // from all the pages in this result, as a third value
    if (pagination.pageNumber !== undefined) {
      tags.push(['v', `page:${pagination.pageNumber}`, JSON.stringify(pageIds)])
    }
  }

  validRankings.forEach(([subject, data]) => {
    const rank = data.rank ?? 0
    const confidence = data.confidence ?? 0
    tags.push([
      resultTagName,
      subject,
      rank.toFixed(6),
      confidence.toFixed(4)
    ])
  })

  return {
    kind: 37573,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: ''
  }
}

function getRankingOutputTagName(requestedType?: string): string {
  return requestedType && PubkeyTypes.includes(requestedType as typeof PubkeyTypes[number])
    ? 'p'
    : (requestedType || 'p')
}

function coerceAndFilterRankingsByTagName(
  rankings: [string, { rank?: number; confidence?: number }][],
  tagName: string,
): {
  validRankings: [string, { rank?: number; confidence?: number }][]
  invalidCount: number
} {
  const validRankings: [string, { rank?: number; confidence?: number }][] = []
  let invalidCount = 0

  for (const [subject, data] of rankings) {
    const coercedSubject = coerceRankingSubjectForTag(tagName, subject)
    if (!coercedSubject || !isValidRankingSubjectForTag(tagName, coercedSubject)) {
      invalidCount += 1
      continue
    }

    validRankings.push([coercedSubject, data])
  }

  return {
    validRankings,
    invalidCount,
  }
}

// Best-effort coercion pass before output emission.
// This is intentionally focused on current p/e/a needs and can be expanded later
// into a generic cross-type coercion strategy if we need richer conversions.
function coerceRankingSubjectForTag(tagName: string, subject: string): string | undefined {
  const normalizedSubject = subject?.trim()
  if (!normalizedSubject) return undefined

  if (tagName === 'p') {
    if (validatePubkey(normalizedSubject)) return normalizedSubject

    const parsedEventActorId = parseEventActorId(normalizedSubject)
    if (parsedEventActorId?.referenceType === 'a') {
      const coordinate = parseCoordinate(parsedEventActorId.value)
      if (coordinate && validatePubkey(coordinate.pubkey)) {
        return coordinate.pubkey
      }
    }

    const directCoordinate = parseCoordinate(normalizedSubject)
    if (directCoordinate && validatePubkey(directCoordinate.pubkey)) {
      return directCoordinate.pubkey
    }

    return undefined
  }

  if (tagName === 'e') {
    if (isValidEventId(normalizedSubject)) return normalizedSubject.toLowerCase()

    const parsedEventActorId = parseEventActorId(normalizedSubject)
    if (parsedEventActorId?.referenceType === 'e' && isValidEventId(parsedEventActorId.value)) {
      return parsedEventActorId.value.toLowerCase()
    }

    return undefined
  }

  if (tagName === 'a') {
    const normalizedCoordinate = normalizeCoordinateValue(normalizedSubject)
    if (normalizedCoordinate) return normalizedCoordinate

    const parsedEventActorId = parseEventActorId(normalizedSubject)
    if (parsedEventActorId?.referenceType === 'a') {
      return normalizeCoordinateValue(parsedEventActorId.value)
    }

    return undefined
  }

  return normalizedSubject
}

function normalizeCoordinateValue(value: string): string | undefined {
  const coordinate = parseCoordinate(value)
  if (!coordinate || !validatePubkey(coordinate.pubkey)) return undefined
  return `${coordinate.kind}:${coordinate.pubkey.toLowerCase()}:${coordinate.identifier}`
}

function isValidEventId(value: string): boolean {
  return /^[0-9a-f]{64}$/i.test(value)
}

function isValidRankingSubjectForTag(tagName: string, subject: string): boolean {
  const normalizedSubject = subject?.trim()
  if (!normalizedSubject) return false

  if (tagName === 'p') {
    return validatePubkey(normalizedSubject)
  }

  if (tagName === 'e') {
    return isValidEventId(normalizedSubject)
  }

  if (tagName === 'a') {
    return !!normalizeCoordinateValue(normalizedSubject)
  }

  // For tags beyond p/e/a, preserve existing permissive behavior.
  return true
}

async function sendFeedback(
  requestEvent: NostrEvent,
  type: FeedbackEventType,
  message: string,
  callback?: (event: UnsignedEvent) => void | Promise<void>,
  metrics?: RequestMetrics
): Promise<void> {
  if (!callback) return

  const feedbackEvent = generateFeedbackEvent(requestEvent, type, message, metrics)
  await callback(feedbackEvent)
}

function applyPagination<T>(
  items: T[],
  pageSize?: number,
  pageNumber?: number
): T[] {
  if (!pageSize || !pageNumber) {
    return items
  }

  const startIndex = (pageNumber - 1) * pageSize
  const endIndex = startIndex + pageSize

  return items.slice(startIndex, endIndex)
}

function generatePageIds(baseId: string, pagination?: { totalResults: number; pageSize?: number }): string[] {
  // If no pagination, return just the base ID
  if (!pagination || pagination.pageSize === undefined || pagination.pageSize <= 0) return [baseId]  
  // Generate page IDs for all pages
  const totalPages = Math.ceil(pagination.totalResults / pagination.pageSize)
  const pageIds = Array.from({ length: totalPages }, (_, i) => `${baseId}:${i + 1}`)
  // replace the first page ID with the original base ID
  pageIds[0] = baseId
  return pageIds
}
