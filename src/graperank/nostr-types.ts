import type { EventReferenceType, NostrType } from '../nostr-interpreters/types'
import type { RankedPov, actorId } from './types'

export type EventActorReference = {
  referenceType: EventReferenceType
  value: string
  relayHints: string[]
}

export type EventActorBindings = Map<string, Set<actorId>>

export type PovActorContext = {
  actorMode: 'pubkey' | 'event'
  povType: NostrType
  rankedPov: RankedPov
  eventActorReferenceMap?: Map<actorId, EventActorReference>
  eventActorResolvedTypeValues?: Map<actorId, string | string[]>
}
