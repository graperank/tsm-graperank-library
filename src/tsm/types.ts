import { NostrEvent } from '../lib/nostr-tools'
import { InterpreterRequest } from '../graperank/types'
// Unsigned event type = NostrEvent - `sig` and `id`
export type UnsignedEvent = Omit<NostrEvent, 'sig' | 'id' | 'pubkey'>

export * from './metrics'


export type ServiceAnnouncementConfig = {
  identifier: string
  title?: string
  summary?: string
  relays?: string[]
  attenuation?: { default: number, range?: [number, number] }
  rigor?: { default: number, range?: [number, number] }
  precision?: { default: number, min?: number }
  interpreters?: InterpreterRequest<any>[]
  type?: {
    default: string
    allowed?: string[]
    valueType?: string
    description?: string
  }
  minrank?: { default: number, range?: [number, number] }
  pagination?: boolean
  customConfigs?: Array<{
    key: string
    valueType: string
    description: string
    defaultValue: string
    allowedValues?: string
  }>
  customOptions?: Array<{
    key: string
    valueType: string
    description: string
    defaultValue: string
  }>
  info?: Record<string, string>
}