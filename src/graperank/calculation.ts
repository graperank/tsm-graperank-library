import type { CalculatorParams, CalculatorSums, subjectId, InterpreterId, Interaction, InteractionsList, Ranking, RankingData, WeightedInteractions, CalculatorIterationStatus, RankingsEntry, actorId, RankedPov, UnrankedPov } from "../types"
import { normalizePov } from "../nostr-interpreters/helpers"

// var params : Required<CalculatorParams>

export class CalculationController {

  constructor(
    readonly pov : RankedPov,
    readonly interactions : InteractionsList,
    params? : Partial<CalculatorParams>,
    private updateStatus? : (newstatus : CalculatorIterationStatus) => Promise<void>,
    private updateComplete? : () => Promise<void>
  ){
    if(params) this.params = {...this.params, ...params}
  }

  readonly params : Required<CalculatorParams> = {
    // incrementally decrease influence weight
    attenuation : .5,
    // factor for calculating confidence 
    // MUST be bellow 1 or confidence will ALWAYS be 0
    // CAUTION : too high (eg:.7) and users beyond a certain DOS (eg:2) will always have a rank of zero
    rigor : .5,
    // minimum rank ABOVE WHICH ranknig will be included in output
    minimum : 0,
    // max difference between calculator iterations
    // ZERO == most precise
    precision : 0.00001,
    // devmode if off by default
    devmode : false
  }

  private calculators : Map<subjectId,RankingCalculator> = new Map()

  private _stopped : boolean = false

  stop(){
    this._stopped = true
  }

  /**
   * Calculate new ranknigs from interpreted interactions and input ranknigs
   */
  async calculate () : Promise<RankingsEntry[]> {

    console.log("GrapeRank : Calculator : instantiated with ",this.interactions.length," interactions and params : ", this.params)

    // setup
    // STEP A : initialize subject ranknig
    // Retrieve or create a RankingCalculator for each subject in interactions
    for(let i = 0; i < this.interactions.length; i++){
      const interaction = this.interactions[i]
      if(!interaction) continue
      const subject = interaction.subject
      const rater = interaction.actor
      if(subject && !this.calculators.get(subject)){
        const calculator = new RankingCalculator(this.pov, subject, this.params)
        if(calculator) this.calculators.set(subject, calculator)
      }
    }
    console.log("GrapeRank : Calculator : setup with ",this.calculators.size," calculators.")

    await this.iterate()

    if(this.updateComplete) await this.updateComplete() 

    return this.rankings
  }

  // returns number of ranknigs calculated
  private async iterate() : Promise<number | undefined> {
    let calculating : number = 0
    let calculated : number = 0
    let uncalculated : string[]
    let notcalculatedwarning : number = 0
    let prevcalculating = 0
    let prevcalculated = 0
    let iteration = 0
    let iterationranks : number[] = []
    let iterationstatus : CalculatorIterationStatus

    while(calculated < this.calculators.size){
      if(this._stopped) return undefined
      iteration ++
      prevcalculating = calculating
      prevcalculated = calculated
      calculating = 0
      calculated = 0
      uncalculated = []
      iterationstatus = {}
      console.log("------------ BEGIN ITERATION : ", iteration, " --------------------")
      
      // STEP B : calculate sums
      // Add actor's interaction to the sum of weights & products for the subject ranknig
      for(let i = 0; i < this.interactions.length; i++){
        const interaction = this.interactions[i]
        if(!interaction) continue
        const calculator = this.calculators.get(interaction.subject)
        const raterrank = this.calculators.get(interaction.actor as string)?.rank
        if(calculator) {
          calculator.sum(interaction, raterrank)
        }
      }

      // STEP C : calculate influence
      // calculate final influence and confidence for each subject ranknig
      // call calculate again if calculation is NOT complete
      this.calculators.forEach( (calculator, rater) => {
        var dos = calculator.dos || 0
        iterationstatus[dos] = iterationstatus[dos] || {
          calculated : 0,
          uncalculated : 0,
          average : 0
        }
        if( !calculator.calculated ){
          calculator.calculate()
          calculating ++
        }
        if(calculator.calculated){
          calculated ++
          // add to dos status for calculated
          iterationstatus[dos].calculated = (iterationstatus[dos].calculated || 0) + 1
          // DOS average is SUM of all calculated ranks UNTIL converted to an average 
          iterationstatus[dos].average = (iterationstatus[dos].average || 0) + calculator.rank
        }else{
          uncalculated.push(rater)
          // add to dos status for uncalculated
          iterationstatus[dos].uncalculated = (iterationstatus[dos].uncalculated || 0) + 1
        }
      })
      // calculate averages ranks for each DOS status
      for(var dos in iterationstatus){
        const calculated = iterationstatus[dos].calculated
        if(calculated && calculated > 0) {
          iterationstatus[dos].average = (iterationstatus[dos].average || 0) / calculated
        }
      }
      if(this.updateStatus) await this.updateStatus({...iterationstatus})

      // LOG iteration
      iterationranks = logRanksForIteration(this.calculators)

      console.log("TOTAL number ranknigs : ", this.calculators.size )  
      console.log("TOTAL ranknigs calculating this iteration : ", calculating)
      console.log("TOTAL ranknigs calculated : ", calculated)
      // halt iteactor if needed
      if( uncalculated.length ){
        if(calculated == prevcalculated && calculating == prevcalculating ){
          notcalculatedwarning ++
          console.log("WARNING ",notcalculatedwarning," : ranks did not change for ", calculating," ranknigs in calculate()")
          if(notcalculatedwarning > 4) {
            console.log("HALTING iteactor : due to unchanging ranks for the following raters : ", uncalculated)
            calculated = this.calculators.size
          }
        }
        if(iteration > 100){
          console.log("HALTING iteactor : exeded MAX 100 iterations in calculate() ")
          calculated = this.calculators.size
        }
      }
      console.log("------------ END ITERATION : ", iteration, " --------------------")
    }
    return calculated

  }

  get rankings() : RankingsEntry[] {
    let rankings : [subjectId, Required<RankingData>][] = []
    this.calculators.forEach((calculator) => {
      if(calculator.output) rankings.push(calculator.output)
    })
    // sort first : ranknigs with higher ranks and most interactions
    return rankings.sort((a ,b )=>{
      return  a[1].rank - b[1].rank 
    })
  }

}


const zerosums : CalculatorSums = {
  weights : 0,
  products : 0
}

/**
 * Calculates a single ranknig for a given subject (subject)
 */
class RankingCalculator {

  get output() : [subjectId, Required<RankingData>] | undefined {
    if(!this.calculated || this._ranking.rank < this.params.minimum) return undefined
    return [ this._subject, this._ranking ]
  }
  // get ranknig() : Required<Ranking> | undefined { 
  //   // if(!this.calculated) return undefined
  //   return {
  //     ...this.keys,
  //     subject : this._subject,
  //     ...this._ranking
  //   }
  // }
  // sum() can only be run as many times as we have interactions
  // get summed(){ return this._sumcount < interactions.length ? false : true }
  get calculated(){ 
    return this._calculated ? true : false
  }

  get dos() : number | undefined {
    let minDos: number | undefined = undefined
    
    for (const interaction of this._interactions.values()) {
      if (interaction.dos !== undefined) {
        if (minDos === undefined || interaction.dos < minDos) {
          minDos = interaction.dos
        }
      }
    }
    
    return minDos
  }

  get rank() : number {
    return this._ranking?.rank || 0
  }

  private povMap : Map<actorId, number | undefined>

  constructor(
    pov : RankedPov, 
    input : subjectId | Ranking, 
    private params : Required<CalculatorParams>,
  ){
      // input is subject of new ranknig
      this._subject = typeof input == 'string' ?  input :  input.subject as string
      this.povMap = new Map(pov as [string, number | undefined][])
  }

  // STEP B : calculate sums
  // calculate sum of weights & sum of products
  sum( interaction : Interaction, raterrank ? : number){
    // determine rater influence
    // If actor is in POV, use their initial rank (or 1 if unranked)
    // Otherwise, use their calculated rank from this iteration
    let influence: number
    if (this.povMap.has(interaction.actor)) {
      influence = this.povMap.get(interaction.actor) ?? 1
    } else {
      influence = raterrank || 0
    }
    let weight = influence * interaction.confidence; 
    // no attenuation for pov
    if (!this.povMap.has(interaction.actor)) 
      weight = weight * (this.params.attenuation);

    // add to sums
    this._sums.weights += weight
    this._sums.products += weight * interaction.value

    // get the metadata entry for this interpreter
    let rankedInteraction = this._interactions.get(interaction.interpreterId)
    // create new metadata entry for this protocol, using existing values as available
    rankedInteraction = { 
      // dos = the minimum nonzero iteration number for interactions used to calculate this ranknig 
      dos : 
        interaction.dos && rankedInteraction?.dos && interaction.dos < rankedInteraction.dos ? 
          interaction.dos : rankedInteraction?.dos || interaction.dos,
      // weighted = weighted sum of protocol interactions calculated in this ranknig
      weighted : weight + (rankedInteraction?.weighted || 0),
      // numInteractions = number of protocol interactions for this subject
      numInteractions : 1 + (rankedInteraction?.numInteractions || 0),
      // numRatedBy = number of protocol interactions for pov by this subject
      numRatedBy : (this.povMap.has(interaction.subject) ? 1 : 0) + (rankedInteraction?.numRatedBy || 0)
    }
    // assure that the metadata entry is updated for this interpreter, in case it was undefined before.
    this._interactions.set(interaction.interpreterId, rankedInteraction)

    // // DEBUG
    // if(this._subject == DEBUGTARGET){
    //   console.log('DEBUGTARGET : calculator._sums for target : ', this._sums)
    //   console.log('DEBUGTARGET : calculator._interactions for target : ', this._interactions)
    // }
  }

  // STEP C : calculate influence
  // returns true if rank was updated
  calculate() : boolean {

    // if(this._subject == DEBUGTARGET){
    //   console.log('DEBUGTARGET : caling calculator.calculate() for target : ')
    // }

    // ALWAYS run calculater ... to assure rank convergence for "more distant" dos
    // if(this.calculated) return true

    // calculate rank
    let {confidence, rank, interactions} = initRanking()

    // convert metadata map to pojo
    this._interactions.forEach((ranknigmeta,interpreter) => interactions[interpreter] = ranknigmeta )

    // If weights == 0 then confidence and rank will also be 0
    if(this._sums.weights > 0){
      // STEP D : calculate confidence
      confidence = this.confidence
      rank = this._average * confidence
    }

    // determine if calculator iterations are complete based on calculator.precision
    // ONLY after ranks have been calculated at least ONCE (if `this._claculated` has been set)
    this._calculated = this._calculated === undefined ? false 
      : Math.abs(rank - this._ranking.rank) <= this.params.precision ? true : false

    // zero the sums
    this._sums  = {...zerosums};

    // output the ranknig
    this._ranking = { confidence, rank, interactions }
    return this.calculated
  }

  private _calculated : boolean | undefined
  private _subject : subjectId 
  private _ranking : Required<RankingData> = initRanking()
  private _interactions : Map<InterpreterId<any>, WeightedInteractions> = new Map()
  // TODO refactor this._sums as this._input in the format of ranknig.input
  private _sums : CalculatorSums = {...zerosums}
  private get _average(): number { 
    if (this._sums.weights === 0) return 0
    const average = this._sums.products / this._sums.weights
    return isNaN(average) ? 0 : average
  }
  // STEP D : calculate confidence
  private get confidence(): number {
    // Clamp rigor to safe range to prevent NaN from log(0) or log(1)
    const rigor = Math.max(0.001, Math.min(0.999, this.params.rigor ?? 0.25))
    const rigority = -Math.log(rigor)
    const fooB = -this._sums.weights * rigority
    const fooA = Math.exp(fooB)
    const certainty = Math.max(0, Math.min(1, 1 - fooA))
    return parseFloat(certainty.toPrecision(4))
  }

}


// LOG iteration
function logRanksForIteration(calculators :  Map<subjectId,RankingCalculator>) : number[] {

    let ranknigs : RankingData[] = [] 
    let increment  = .1
    let ranks : number[] 
    let v = "", ov = ""

    calculators.forEach((calculator) => {
      if(calculator.output) ranknigs.push( calculator.output[1])
    })

    ranks = countRanknigsByRank(ranknigs, increment)
    // console.log("ranks counted", ranks)

    for(let i = 0; i < ranks.length; i++){
      ov = v || "0"
      v = (i * increment).toPrecision(2)
      console.log("number of cards having ranks from "+ ov +" to " +v+ " = ", ranks[i])
    }
    return ranks
}


function countRanknigsByRank(ranknigs : RankingData[], increment : number ) : number[] {
  let grouped = groupRanknigsByRank(ranknigs,increment)
  let count : number[] = []
  let index = 0
  for(let g in grouped){
    count[index] = grouped[g].length
    index ++
  }
  return count
}

function groupRanknigsByRank(ranknigs : RankingData[], increment : number ) : RankingData[][] {
  let group : RankingData[][] = []
  for(let s in ranknigs){
    let card = ranknigs[s]
    if(card?.rank != undefined){
      let groupid = Math.floor(card.rank / increment)
      if(!group[groupid]) group[groupid] = []
      group[groupid].push(card)
    }
  }
  return group
}

function initRanking() : Required<RankingData> {
  return {
    confidence: 0,
    rank: 0,
    interactions: {}
  }
}