export type actorId = string
export type subjectId = string
export type dos = number
export type lowercase = Lowercase<string>
export type ParamValue = string | number | boolean
export type ParamsArray = Array<ParamValue>
export type ParamsObject = {
  [k: string]: ParamValue | ParamsArray
}

export type CalculatorParams = {
  attenuation: number
  rigor: number
  minimum: number
  precision: number
  devmode?: boolean
}

export type CalculatorSums = {
  weights: number
  products: number
}

export type WeightedInteractions = {
  dos?: number
  weighted: number
  numInteractions: number
  numRatedBy: number
}

export type RankingData = {
  confidence?: number
  rank?: number
  interactions?: Record<InterpreterId<any>, WeightedInteractions>
}

export interface Ranking {
  subject: actorId | subjectId
  confidence?: number
  score?: number
  interactions?: Record<InterpreterId<any>, WeightedInteractions>
}

export type CalculatorIterationStatus = Record<
  dos,
  {
    calculated?: number
    uncalculated?: number
    average?: number
  }
>

export type RankingsEntry = [subjectId, RankingData]

// Interpreter ID 
// is a kebab case stringification standard for identifying interpreter instances
// they should start with a namespace in lowercase letters,
// followed by one or more specifiers having hyphen + alphanumeric characters
// these specifiers (within each namespace) should follow some known standard 
// by which service requests may be interoperable across supporting service provider
// for example : `nostr-<kind>-<tag>` is a standard format for Nostr event intrerpreters. 
export type InterpreterId<namespace extends lowercase> = `${namespace}${InterpreterIdPart}`
type InterpreterIdPart = `-${string | number}`

export type InterpreterParams = {
  value: number
  confidence: number
  [param: string]: ParamValue | undefined
}

export type InterpreterRequest<ParamsType> = {
  interpreterId: InterpreterId<any>
  params?: ParamsType
  iterate?: number
  filter?: ParamsObject
  actors?: actorId[]
}

export type InterpreterResponse = {
  request: InterpreterRequest<any>
  index: number
  iteration: number
  numActors?: number
  numFetched?: number
  numInteractions?: number
}



export type InteractionData = {
  confidence: number
  value: number
  dos?: number
}

export interface Interaction extends InteractionData {
  interpreterId: InterpreterId<any>
  index: number
  actor: actorId
  subject: subjectId
}

export type InteractionsList = Interaction[]

export type InteractionsMap = Map<actorId, Map<subjectId, InteractionData>>

export type InterpretationResults = {
  interactions: InteractionsList
  responses: InterpreterResponse[]
}

export type InterpreterStatus = {
  interpreterId: InterpreterId<any>
  dos?: dos
  authors: number
  fetched?: [number, number, true?]
  interpreted?: [number, number, true?]
}

// Pluggable Interpreters are responsible for 
// fetching and normalizing actor and subject interactions 
// from any network of users and/or content 
export interface Interpreter<ParamsType extends InterpreterParams> {
  readonly interpreterId: InterpreterId<any>
  label: string
  description: string
  request?: InterpreterRequest<ParamsType>
  params: ParamsType // default parameters
  readonly fetched: Set<any>[]
  readonly interactions: InteractionsMap
  discoveredActors?: Set<actorId>
  fetchData(this: Interpreter<ParamsType>, actors?: Set<actorId>, subjects?: Set<subjectId>): Promise<number>
  interpret(this: Interpreter<ParamsType>, fetchedIndex?: number): Promise<InteractionsMap | undefined>
}

// export type InterpretResult = {
//   interactions: InteractionsMap
//   subjects: Set<subjectId>
// }

export type InterpreterInitializer = () => Interpreter<InterpreterParams>
