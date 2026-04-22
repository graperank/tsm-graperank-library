import type { EventReferenceType } from '../nostr-interpreters/types'
import type { RankedPov, actorId } from './types'

export type EventActorReference = {
  referenceType: EventReferenceType
  value: string
  relayHints: string[]
}

export type EventActorBindings = Map<string, Set<actorId>>

export type PovActorContext = {
  actorMode: 'pubkey' | 'event'
  rankedPov: RankedPov
  eventActorReferenceMap?: Map<actorId, EventActorReference>
}
