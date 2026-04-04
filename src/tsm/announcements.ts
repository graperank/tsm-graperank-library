import { InterpreterFactory } from '../nostr-interpreters/factory'
import { InterpreterRequest } from '../graperank/types'
import { UnsignedEvent, ServiceAnnouncementConfig } from './types'

/**
 * Service Announcement Event Generator
 * 
 * Introspect InterpreterFactory 
 * to generate default interpreters JSON
 * Build kind 37570 event with all required/optional tags
 * Support provider customization of interpreters and metadata
 * Output unsigned kind 37570 announcement event via callback
 */

export const TSM_OUTPUT_KIND = '37573'
export const TSM_GRAPERANK_NIP = 'https://github.com/graperank/tsm-nip'


export function getAllowedSubjectTypes(): string[] {
  const allowedTypes = new Set<string>()
  
  InterpreterFactory.forEach((initializer) => {
    const instance = initializer()
    if ('allowedSubjectTypes' in instance) {
      (instance as any).allowedSubjectTypes.forEach((type: string) => {
        allowedTypes.add(type)
      })
    }
  })
  
  return Array.from(allowedTypes).sort()
}

export function generateDefaultInterpreters(): InterpreterRequest<any>[] {
  const interpreterRequests: InterpreterRequest<any>[] = []
  
  InterpreterFactory.forEach((initializer, interpreterId) => {
    const instance = initializer()
    interpreterRequests.push({
      id: interpreterId,
      params: instance.params || []
    })
  })
  
  return interpreterRequests
}

export function generateServiceAnnouncement(
  config: ServiceAnnouncementConfig
): UnsignedEvent {
  const tags: string[][] = []
  
  tags.push(['d', config.identifier])
  tags.push(['n', TSM_GRAPERANK_NIP])
  tags.push(['k', TSM_OUTPUT_KIND])
  
  if (config.title) {
    tags.push(['title', config.title])
  }
  
  if (config.summary) {
    tags.push(['summary', config.summary])
  }
  
  if (config.relays) {
    config.relays.forEach(relay => tags.push(['r', relay]))
  }
  
  const derivedAllowedTypes = getAllowedSubjectTypes()
  const typeConfig = config.type || { 
    default: derivedAllowedTypes.includes('p') ? 'p' : derivedAllowedTypes[0], 
    allowed: derivedAllowedTypes 
  }
  tags.push([
    'config',
    'type',
    'tagname',
    'Expected format for POV.',
    typeConfig.default,
    typeConfig.allowed ? JSON.stringify(typeConfig.allowed) : '[]'
  ])
  
  tags.push([
    'config',
    'pov',
    'string[]|naddr',
    'A string, or an array of strings, or a naddr reference to an event with a list of tags with string values in the format of `type`'
  ])
  
  const minrankConfig = config.minrank || { default: 0, range: [0, 100] }
  tags.push([
    'config',
    'minrank',
    '0-100',
    'Minimum rank threshold for including subjects in the output.',
    String(minrankConfig.default),
    minrankConfig.range ? JSON.stringify(minrankConfig.range) : '[0, 100]'
  ])
  
  const attenuationConfig = config.attenuation || { default: 0.5, range: [0, 1] }
  tags.push([
    'config',
    'attenuation',
    '0-1',
    'Influence decay per degree of separation',
    String(attenuationConfig.default),
    attenuationConfig.range ? JSON.stringify(attenuationConfig.range) : '[0, 1]'
  ])
  
  const rigorConfig = config.rigor || { default: 0.5, range: [0, 1] }
  tags.push([
    'config',
    'rigor',
    '0-1',
    'Confidence threshold factor',
    String(rigorConfig.default),
    rigorConfig.range ? JSON.stringify(rigorConfig.range) : '[0, 1]'
  ])
  
  const precisionConfig = config.precision || { default: 0.00001, min: 0 }
  tags.push([
    'config',
    'precision',
    '0+',
    'Max delta between iterations (0=iterate until stable)',
    String(precisionConfig.default)
  ])
  
  const interpreters = config.interpreters || generateDefaultInterpreters()
  tags.push([
    'config',
    'interpreters',
    'InterpreterRequest[]',
    'Array of interpreter configurations',
    JSON.stringify(interpreters)
  ])
  
  if (config.pagination) {
    tags.push(['V', 'page', 'integer', 'Page number for paginated results'])
  }
  
  if (config.customConfigs) {
    config.customConfigs.forEach(cfg => {
      const tag = ['config', cfg.key, cfg.valueType, cfg.description, cfg.defaultValue]
      if (cfg.allowedValues) {
        tag.push(cfg.allowedValues)
      }
      tags.push(tag)
    })
  }
  
  if (config.customOptions) {
    config.customOptions.forEach(opt => {
      tags.push(['option', opt.key, opt.valueType, opt.description, opt.defaultValue])
    })
  }
  
  if (config.info) {
    Object.entries(config.info).forEach(([key, value]) => {
      tags.push(['info', key, value])
    })
  }
  
  return {
    kind: 37570,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: ''
  }
}