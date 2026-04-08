import { NostrEvent } from '../lib/nostr-tools'
import { InterpretationInput, InterpreterRequest, CalculatorParams, povType, UnrankedPov } from '../graperank/types'

/**
 * Parse Service Request Events
 * 
 * Parse kind 37572 event tags
 * Extract and validate configs
 * Determine POV → actors vs subjects mapping
 * Infer type from first interpreter
 * Build InterpretationInput
 * 
 */
export type ServiceRequestConfigs = {
  type?: povType
  pov?: UnrankedPov
  minrank?: number
  attenuation?: number
  rigor?: number
  precision?: number
  interpreters?: InterpreterRequest<any>[]
  [key: string]: any
}

export type ParsedServiceRequest = {
  interpretationInput: InterpretationInput
  calculatorParams: CalculatorParams
  configs: ServiceRequestConfigs
}

export class ServiceRequestParseError extends Error {
  constructor(message: string, public field?: string) {
    super(message)
    this.name = 'ServiceRequestParseError'
  }
}

function getConfigTag(tags: string[][], key: string): string | undefined {
  const tag = tags.find(t => t[0] === 'config' && t[1] === key)
  return tag?.[2]
}

function parseConfigValue(value: string | undefined, type: 'string' | 'number' | 'json'): any {
  if (value === undefined) return undefined
  
  switch (type) {
    case 'number':
      const num = Number(value)
      return isNaN(num) ? undefined : num
    case 'json':
      try {
        return JSON.parse(value)
      } catch {
        return undefined
      }
    case 'string':
    default:
      return value
  }
}

function validateRange(value: number, min: number, max: number, field: string): void {
  if (value < min || value > max) {
    throw new ServiceRequestParseError(
      `${field} must be between ${min} and ${max}, got ${value}`,
      field
    )
  }
}

export function parseServiceRequest(
  event: NostrEvent,
  defaults?: Partial<ServiceRequestConfigs>
): ParsedServiceRequest {
  if (event.kind !== 37572) {
    throw new ServiceRequestParseError(
      `Expected kind 37572, got kind ${event.kind}`
    )
  }

  const configs: ServiceRequestConfigs = {}
  
  const typeValue = getConfigTag(event.tags, 'type')
  configs.type = parseConfigValue(typeValue, 'string') || defaults?.type
  
  const povValue = getConfigTag(event.tags, 'pov')
  if (povValue) {
    const parsed = parseConfigValue(povValue, 'json')
    configs.pov = parsed !== undefined ? parsed : povValue
  } else if (defaults?.pov) {
    configs.pov = defaults.pov
  }
  
  if (!configs.pov) {
    throw new ServiceRequestParseError(
      'Missing required config: pov',
      'pov'
    )
  }
  
  const minrankValue = getConfigTag(event.tags, 'minrank')
  const minrank = parseConfigValue(minrankValue, 'number') ?? defaults?.minrank ?? 0
  configs.minrank = minrank
  validateRange(minrank, 0, 100, 'minrank')
  
  const attenuationValue = getConfigTag(event.tags, 'attenuation')
  const attenuation = parseConfigValue(attenuationValue, 'number') ?? defaults?.attenuation ?? 0.5
  configs.attenuation = attenuation
  validateRange(attenuation, 0, 1, 'attenuation')
  
  const rigorValue = getConfigTag(event.tags, 'rigor')
  const rigor = parseConfigValue(rigorValue, 'number') ?? defaults?.rigor ?? 0.5
  configs.rigor = rigor
  validateRange(rigor, 0, 1, 'rigor')
  
  const precisionValue = getConfigTag(event.tags, 'precision')
  const precision = parseConfigValue(precisionValue, 'number') ?? defaults?.precision ?? 0.00001
  configs.precision = precision
  if (precision < 0) {
    throw new ServiceRequestParseError(
      `precision must be >= 0, got ${precision}`,
      'precision'
    )
  }
  
  const interpretersValue = getConfigTag(event.tags, 'interpreters')
  configs.interpreters = parseConfigValue(interpretersValue, 'json') || defaults?.interpreters
  
  if (!configs.interpreters || configs.interpreters.length === 0) {
    throw new ServiceRequestParseError(
      'Missing required config: interpreters',
      'interpreters'
    )
  }
  
  event.tags.forEach(tag => {
    if (tag[0] === 'config' && tag[1] && tag[2]) {
      const key = tag[1]
      if (!['type', 'pov', 'minrank', 'attenuation', 'rigor', 'precision', 'interpreters'].includes(key)) {
        configs[key] = tag[2]
      }
    }
  })
  
  if (!configs.type && configs.interpreters.length > 0) {
    const firstInterpreter = configs.interpreters[0]
    if (firstInterpreter.params && 'subjectType' in firstInterpreter.params) {
      configs.type = (firstInterpreter.params as any).subjectType
    }
  }
  
  if (!configs.type) {
    throw new ServiceRequestParseError(
      'Could not determine type from config or first interpreter',
      'type'
    )
  }
  
  const interpretationInput: InterpretationInput = {
    type: configs.type,
    pov: configs.pov,
    requests: configs.interpreters
  }
  
  const calculatorParams: CalculatorParams = {
    attenuation,
    rigor,
    minimum: minrank,
    precision
  }
  
  return {
    interpretationInput,
    calculatorParams,
    configs
  }
}