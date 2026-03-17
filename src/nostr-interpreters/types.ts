import { InterpreterParams, InterpretationMode } from "../types"

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

export type NostrType = NostrEventField | NostrSingleLetterTag | NostrMultiLetterTag

export type NostrInterpretationMode = InterpretationMode<NostrType, NostrType>

export interface NostrInterpreterParams extends InterpreterParams {
  mode?: string
}
