import { NostrEvent } from "../lib/nostr-tools"
import { InterpreterParams, Interpreter, InterpreterId, InteractionsMap, actorId, InterpreterInitializer } from "../graperank/types"
import { NostrInterpreterClass } from "./classes"

export const NostrEventFields = ['id', 'pubkey', 'kind'] as const
export type NostrEventField = typeof NostrEventFields[number]

export const NostrSingleLetterTags = [
  'a', 'A', 'c', 'd', 'D', 'e', 'E', 'f', 'g', 'h', 
  'i', 'I', 'k', 'K', 'l', 'L', 'm', 'p', 'P', 'q', 
  'r', 's', 't', 'u', 'x', 'y', 'z', '-'
] as const
export type NostrSingleLetterTag = typeof NostrSingleLetterTags[number]

export const NostrMultiLetterTags = [
  'alt', 'amount', 'bolt11', 'branch-name', 'challenge', 
  'client', 'clone', 'content-warning', 'delegation', 
  'dep', 'description', 'emoji', 'encrypted', 'extension', 
  'expiration'
] as const
export type NostrMultiLetterTag = typeof NostrMultiLetterTags[number]

export const PubkeyTagTypes = ["p", "P"] as const
export type PubkeyTagType = typeof PubkeyTagTypes[number]

export const PubkeyTypes = ["pubkey", ...PubkeyTagTypes] as const
export type PubkeyType = typeof PubkeyTypes[number]

export const EventReferenceTypes = ["e", "a"] as const
export type EventReferenceType = typeof EventReferenceTypes[number]

export const EventTagTypes = ["q", ...EventReferenceTypes] as const
export type EventTagType = typeof EventTagTypes[number]

export const EventTypes = ["id", ...EventTagTypes] as const
export type EventType = typeof EventTypes[number]

export type EventReferenceTarget = {
  referenceType: EventReferenceType
  value: string
  relayHints: string[]
}

export type pubkey = string
export type signature = string

export type NostrTagType = NostrSingleLetterTag | NostrMultiLetterTag
// standard relay indexable event tags or fields
export type NostrType = NostrEventField | NostrSingleLetterTag 

// Nostr interpreter ID : `nostr-<kind>` or `nostr-<kind>-<tag>`
// Each Nostr interpreter should be identifiable 
// by the kind of event that it interprets and optionally
// by a (fixed) subject tag to extract from the event kind
export type NostrInterpreterId = InterpreterId<"nostr"> & `nostr-${number}` | `nostr-${number}-${NostrType}`

export type NostrInterpreterKeys = {
  kind: number,
  type?: NostrType,
}

// Actor and subject types for Nostr interactions
// are added to the interpreter parameters, to be compared
// against the allowed types for that interpreter
export type NostrInterpreterParams = InterpreterParams & {
  actorType: NostrType, // event tag or field for interaction actors
  subjectType: NostrType // event tag or field for interaction subjects
}

export type NostrInterpreterClassConfig<ParamsType extends NostrInterpreterParams> = {
  interpretKind: number,
  label: string,
  description: string,
  fetchKinds : number[],
  allowedActorTypes : NostrType[],
  allowedSubjectTypes : NostrType[],
  defaultParams : ParamsType,
  interpret? : 
    (instance : NostrInterpreterClass<ParamsType>, dos : number) 
    => Promise<InteractionsMap | undefined>,
  validate? : 
    (events : Set<NostrEvent>, authors : actorId[], previous? : Set<NostrEvent>) 
    => boolean | actorId[],
  resolveActors? : 
    (instance : NostrInterpreterClass<ParamsType>) 
    => Promise<Set<actorId>>,
}