export type actorId = string
export type subjectId = string
export type lowercase = Lowercase<string>
export type InterpreterId = string
export type dos = number

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
  interactions?: Record<InterpreterId, WeightedInteractions>
}

export interface Ranking {
  subject: actorId | subjectId
  confidence?: number
  score?: number
  interactions?: Record<InterpreterId, WeightedInteractions>
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

export type InterpretationMode<ActorType = string, SubjectType = string> = {
  name: string
  description: string
  actorType: ActorType
  subjectType: SubjectType
}

export type InterpretResult = {
  interactions: InteractionsMap
  subjects: Set<subjectId>
}

export type InterpreterParams = {
  value: number
  confidence: number
  [param: string]: ParamValue | undefined
}

export type InterpreterRequest = {
  domain?: string
  interpId: InterpreterId
  params?: InterpreterParams
  iterate?: number
  filter?: ParamsObject
  authors?: actorId[]
}

export type InterpreterResponse = {
  request: InterpreterRequest
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
  interpId: InterpreterId
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
  interpId: InterpreterId
  dos?: dos
  authors: number
  fetched?: [number, number, true?]
  interpreted?: [number, number, true?]
}

export interface Interpreter<ParamsType extends InterpreterParams> {
  readonly schema?: string
  request?: InterpreterRequest
  params: ParamsType
  readonly fetched: Set<any>[]
  readonly interactions: InteractionsMap
  discoveredActors?: Set<actorId>
  fetchData(this: Interpreter<ParamsType>, authors?: Set<actorId>, subjects?: Set<subjectId>): Promise<number>
  interpret(this: Interpreter<ParamsType>, fetchedIndex?: number): Promise<InterpretResult>
}

export type InterpreterInitializer = () => Interpreter<InterpreterParams>
