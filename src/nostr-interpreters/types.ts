import { NostrEvent } from "nostr-tools/core"
import { InterpreterParams, Interpreter, InterpreterId, InteractionsMap, actorId, InterpreterInitializer } from "../types"

export type NostrEventField = 'id' | 'pubkey' | 'kind'

export type NostrSingleLetterTag = 
  | 'a' | 'A' | 'c' | 'd' | 'D' | 'e' | 'E' | 'f' | 'g' | 'h' 
  | 'i' | 'I' | 'k' | 'K' | 'l' | 'L' | 'm' | 'p' | 'P' | 'q' 
  | 'r' | 's' | 't' | 'u' | 'x' | 'y' | 'z' | '-'

export type NostrMultiLetterTag = 
  | 'alt' | 'amount' | 'bolt11' | 'branch-name' | 'challenge' 
  | 'client' | 'clone' | 'content-warning' | 'delegation' 
  | 'dep' | 'description' | 'emoji' | 'encrypted' | 'extension' 
  | 'expiration'

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

export type NostrInterpreterClassConfig<ParamsType extends InterpreterParams> = {
  interpretKind: number,
  label: string,
  description: string,
  fetchKinds : number[],
  allowedActorTypes : NostrType[],
  allowedSubjectTypes : NostrType[],
  defaultParams : ParamsType,
  interpret? : 
    (instance : Interpreter<ParamsType>, dos : number) 
    => Promise<InteractionsMap | undefined>,
  validate? : 
    (events : Set<NostrEvent>, authors : actorId[], previous? : Set<NostrEvent>) 
    => boolean | actorId[],
}