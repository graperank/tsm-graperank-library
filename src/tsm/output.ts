import { NostrEvent } from 'nostr-tools/core'
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
      const statusEntries = Object.entries(status)
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

    const rankingsToOutput = applyPagination(rankings, pageSize, pageNumber)

    await sendFeedback(
      requestEvent,
      'info',
      `Generating output: ${rankingsToOutput.length} rankings`,
      callbacks?.onFeedbackEvent
    )

    const rankingEvent = generateRankingOutputEvent(
      requestEvent,
      rankingsToOutput,
      {
        totalResults: rankings.length,
        pageSize,
        pageNumber
      }
    )

    if (callbacks?.onOutputEvent) {
      await callbacks.onOutputEvent(rankingEvent)
    }

    await sendFeedback(
      requestEvent,
      'success',
      'Service request completed successfully',
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
    pageSize?: number
    pageNumber?: number
  }
): UnsignedEvent {
  const tags: string[][] = [
    ['e', requestEvent.id, '', 'request'],
    ['p', requestEvent.pubkey],
    ['k', String(requestEvent.kind)]
  ]

  if (pagination) {
    tags.push(['total', String(pagination.totalResults)])
    if (pagination.pageSize !== undefined) {
      tags.push(['page-size', String(pagination.pageSize)])
    }
    if (pagination.pageNumber !== undefined) {
      tags.push(['page', String(pagination.pageNumber)])
    }
  }

  rankings.forEach(([subject, data], index) => {
    const rank = data.rank ?? 0
    const confidence = data.confidence ?? 0
    tags.push([
      'result',
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