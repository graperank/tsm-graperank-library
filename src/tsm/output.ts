import { NostrEvent } from '../lib/nostr-tools'
import { InterpretationController, InterpretersMap } from '../graperank/interpretation'
import { CalculationController } from '../graperank/calculation'
import { InterpreterFactory } from '../nostr-interpreters/factory'
import { UnsignedEvent } from './types'
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

  const onInterpreterStatus = async (status: InterpreterStatus): Promise<boolean> => {
    if (verboseFeedback && callbacks?.onFeedbackEvent) {
      const message = `Interpreter ${status.interpreterId}${status.dos ? ` (DOS ${status.dos})` : ''}: ${status.authors} authors${status.fetched ? `, fetched ${status.fetched[0]} events in ${status.fetched[1]}ms` : ''}${status.interpreted ? `, interpreted ${status.interpreted[0]} interactions in ${status.interpreted[1]}ms` : ''}`
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
        `DOS ${dos}: ${data.calculated || 0} calculated, ${data.uncalculated || 0} pending, avg rank ${data.average?.toFixed(4) || 0}`
      ).join('; ')}`
      await sendFeedback(requestEvent, 'info', message, callbacks.onFeedbackEvent)
    }
  }

  const onComplete = async (): Promise<void> => {
    if (verboseFeedback && callbacks?.onFeedbackEvent) {
      await sendFeedback(requestEvent, 'info', 'Calculation iterations complete', callbacks.onFeedbackEvent)
    }
  }

  try {
    await sendFeedback(
      requestEvent,
      'info',
      'Starting service request processing',
      callbacks?.onFeedbackEvent
    )

    const interpretersMap = new InterpretersMap([InterpreterFactory])
    const interpretationController = new InterpretationController(
      interpretersMap,
      onInterpreterStatus
    )

    await sendFeedback(
      requestEvent,
      'info',
      'Starting interpretation phase',
      callbacks?.onFeedbackEvent
    )

    const interpretationOutput = await interpretationController.interpret(interpretationInput)

    if (!interpretationOutput) {
      throw new ServiceOutputError('Interpretation was stopped or returned no output', 'interpretation')
    }

    const { interactions, responses, pov } = interpretationOutput

    await sendFeedback(
      requestEvent,
      'success',
      `Interpretation complete: ${interactions.length} interactions from ${responses.length} interpreters`,
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

    await sendFeedback(
      requestEvent,
      'info',
      'Starting calculation phase',
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

    await sendFeedback(
      requestEvent,
      'success',
      `Calculation complete: ${rankings.length} rankings generated`,
      callbacks?.onFeedbackEvent
    )

    const totalPages = pageSize && pageSize > 0 ? Math.ceil(rankings.length / pageSize) : 1
    const startPage = pageNumber !== undefined ? pageNumber : 1
    
    console.log(`[pagination] totalResults=${rankings.length}, pageSize=${pageSize}, totalPages=${totalPages}, startPage=${startPage}`)

    for (let page = startPage; page <= (pageNumber !== undefined ? startPage : totalPages); page++) {
      console.log(`[pagination] generating page ${page} of ${totalPages}`)
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
        `Generating output page ${page}: ${rankingsToOutput.length} rankings`,
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

    await sendFeedback(
      requestEvent,
      'success',
      `Service request completed successfully: ${totalPages} page(s) generated`,
      callbacks?.onFeedbackEvent
    )

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    const stage = error instanceof ServiceOutputError ? error.stage : 'unknown'
    
    await sendFeedback(
      requestEvent,
      'error',
      `Error during ${stage}: ${errorMessage}`,
      callbacks?.onFeedbackEvent
    )
    
    throw error
  }
}

export function generateFeedbackEvent(
  requestEvent: NostrEvent,
  type: FeedbackEventType,
  message: string
): UnsignedEvent {
  const tags: string[][] = [
    ['e', requestEvent.id, '', 'request'],
    ['p', requestEvent.pubkey],
    ['k', String(requestEvent.kind)],
    ['status', type]
  ]

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
    pageSize: number
    pageNumber?: number
  }
): UnsignedEvent {
  const resultTagName = requestEvent.tags.find(t => t[0] === 'config' && t[1] === 'type')?.[2] as string
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
      tags.push(['v', `page:${pagination.pageNumber}`, JSON.stringify([requestDTag])])
    }
  }

  rankings.forEach(([subject, data], index) => {
    const rank = data.rank ?? 0
    const confidence = data.confidence ?? 0
    tags.push([
      resultTagName,
      subject,
      rank.toFixed(6),
      confidence.toFixed(4),
      String(index)
    ])
  })

  return {
    kind: 37573,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: ''
  }
}

async function sendFeedback(
  requestEvent: NostrEvent,
  type: FeedbackEventType,
  message: string,
  callback?: (event: UnsignedEvent) => void | Promise<void>
): Promise<void> {
  if (!callback) return

  const feedbackEvent = generateFeedbackEvent(requestEvent, type, message)
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

function generatePageIds(baseId: string, pagination?: { totalResults: number; pageSize: number }): string[] {
  // If no pagination, return just the base ID
  if (!pagination) return [baseId]  
  // Generate page IDs for all pages
  const totalPages = Math.ceil(pagination.totalResults / pagination.pageSize)
  const pageIds = Array.from({ length: totalPages }, (_, i) => `${baseId}-page-${i + 1}`)
  // replace the first page ID with the original base ID
  pageIds[0] = baseId
  return pageIds
}
