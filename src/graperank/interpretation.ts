import type { InterpreterRequest, InteractionsList, actorId, subjectId, InterpreterResponse, InteractionsMap, InterpreterStatus, InterpreterId, lowercase, povType, InterpretationInput, InterpretationOutput, InterpreterFetchProgress, InterpreterFetchProgressCallback, FinalizedInterpreterInteractions } from "./types"
import type { Interpreter, InterpreterInitializer, InterpreterParams } from "./types"
import type { PovActorContext } from './nostr-types'
import { deriveActorIdsFromRankedPov, normalizePov } from "../nostr-interpreters/helpers"


export class InterpretationController {
  private interpreters: InterpretersMap
  private updateStatus?: (status: InterpreterStatus) => Promise<boolean>
  private onKeepAlive?: () => void
  private stopping = false

  constructor(
    interpreters: InterpretersMap,
    updateStatus?: (status: InterpreterStatus) => Promise<boolean>,
    onKeepAlive?: () => void
  ) {
    this.interpreters = interpreters
    this.updateStatus = updateStatus
    this.onKeepAlive = onKeepAlive
  }
  async interpret(input : InterpretationInput) : Promise<InterpretationOutput | undefined>{
    const { type, pov, requests } = input
    const requestIndexesByInterpreterId = new Map<InterpreterId<any>, number>()
    requests?.forEach((request, index) => {
      if (!requestIndexesByInterpreterId.has(request.id)) {
        requestIndexesByInterpreterId.set(request.id, index)
      }
    })
    let actors : Set<actorId> | undefined
    var outputResponses : InterpreterResponse[] = []
    var outputInteractions : InteractionsList = []
    // `allActors` map keys hold all actors added as input and between protocol requests
    // map value is the iteration number at which the actor was added
    // (this number ends up in the scorecard as `dos` from observer) 
    const allActors : Map<actorId,number> = new Map()
    var requestActors : Set<actorId> | undefined

    // Normalize POV to RankedPov format
    const normalizedPov = normalizePov(pov)
    const povActorIds = normalizedPov.map(([rankedActorId]) => rankedActorId)
    let outputPov = normalizedPov
    let povActorContext: PovActorContext | undefined

    if(!!pov && !!requests){
      console.log("GrapeRank : interpret : instantiating ",requests.length, " interpreters for ",povActorIds.length," actors or subjects in pov")
      console.log("----------------------------------")
      // loop through each interpreter request
      // requests having `iterations` will ADD to `allActors` with each interation
      // each request will use the `allActors` list from previous requests
      for(let requestindex = 0; requestindex < requests.length; requestindex++){
        if(this.stopping) return undefined
        const request = requests[requestindex]
        this.interpreters.setRequest(request)
        // resolve actors from pov
        if(!actors) {
          povActorContext = await this.interpreters.resolvePovContext(request.id, type, povActorIds)
          if (povActorContext) {
            outputPov = povActorContext.rankedPov
            this.interpreters.setPovActorContext(povActorContext)
          }

          actors = deriveActorIdsFromRankedPov(outputPov)
          if(!actors) throw new Error("GrapeRank : interpret : failed to resolve pov")
          // add input actors to allActors
          actors.forEach((actorId) => allActors.set(actorId,0))
        }
        // reset newActors, currentInteractions, and newInteractions 
        // between interpreter requests
        const currentInteractions = this.interpreters.getInteractions(request.id) || new Map()
        let newActors : Set<actorId> = new Set()
        let newInteractions : InteractionsMap | undefined
        let currentSubjects : Set<subjectId> | undefined
        let currentIteration : number = 0
        let maxIterations : number = request.iterate || 1
        let currentActors : Set<actorId>
        if(request.actors && request.actors.length) requestActors = new Set(request.actors)
        
        let interpreterStatus : InterpreterStatus
        console.log("GrapeRank : interpret : calling " +request.id +" protocol with params : ",this.interpreters.get(request.id)?.params)

        while(currentIteration < maxIterations){
          if(this.stopping) return undefined
          // Send keep-alive to prevent SSE timeout during long interpretation
          if(this.onKeepAlive && currentIteration % 2 === 0) {
            this.onKeepAlive()
          }
          // increment for each interpreter iteration
          currentIteration ++
          currentActors = requestActors || ( newActors?.size ?  newActors : new Set(allActors.keys()) )
          console.log("GrapeRank : interpret : "+request.id +" protocol : begin iteration ", currentIteration, " of ", maxIterations,", with ",currentActors?.size," actors")
          // // DEBUG
          // if(currentActors.has(DEBUGTARGET))
          //   console.log('DEBUGTARGET : interpret : target found in currentIteration actors')
          try{
            const updateInterpreterStatus = async (status: InterpreterStatus, errorMessage: string): Promise<void> => {
              if (!this.updateStatus) return
              const statusUpdated = await this.updateStatus(status)
              if (!statusUpdated) throw(errorMessage)
            }

            const isEventActorMode = povActorContext?.actorMode === 'event'

            interpreterStatus = {
              interpreterId : request.id,
              // FIXME dos needs to be set on initial status ... 
              // how to determine this acurately BEFORE fetchData() has been called?
              dos : request.iterate ? this.interpreters.get(request.id)?.fetched?.length || 0 : undefined,
              authors : currentActors.size
            }
            await updateInterpreterStatus(interpreterStatus, 'failed updating initial status')
            let fetchstart = Date.now()

            const onFetchProgress: InterpreterFetchProgressCallback | undefined = isEventActorMode
              ? async (fetchProgress: InterpreterFetchProgress): Promise<void> => {
                  interpreterStatus.fetchProgress = fetchProgress
                  interpreterStatus.fetched = [
                    fetchProgress.fetchedEvents,
                    fetchProgress.elapsedMs,
                  ]
                  await updateInterpreterStatus(interpreterStatus, 'failed updating status during fetch progress')
                  if (this.onKeepAlive) {
                    this.onKeepAlive()
                  }
                }
              : undefined

            // fetch interpreter specific dataset for requestActors OR newActors OR allActors
            // pass currentSubjects from previous iteration
            let dos = await this.interpreters.fetchData(request.id, currentActors, onFetchProgress) || 1
            const fetchDurationMs = Date.now() - fetchstart
            const fetchedEventsCount = this.interpreters.get(request.id)?.fetched[dos -1]?.size || 0

            if (isEventActorMode) {
              interpreterStatus.fetchProgress = {
                processedActors: currentActors.size,
                totalActors: currentActors.size,
                fetchedEvents: fetchedEventsCount,
                elapsedMs: fetchDurationMs,
              }
            }

            interpreterStatus.fetched = [
                fetchedEventsCount, // number of fetched events
                fetchDurationMs, // duration of fetch request
                currentIteration == maxIterations ? true : undefined // final DOS iteration ?
              ]
            await updateInterpreterStatus(interpreterStatus, 'failed updating status after fetch')
            let interpretstart = Date.now()
            // interpret fetched data and get interactions for next iteration
            newInteractions = await this.interpreters.interpret(request.id, dos)
            if(!newInteractions) throw('interpret returned undefined')
            interpreterStatus.interpreted = [
                countInteractionsMap(newInteractions), // number of interpretations rated
                Date.now() - interpretstart, // duration of interpretation
                currentIteration == maxIterations ? true : undefined // final DOS iteration ?
              ]
            await updateInterpreterStatus(interpreterStatus, 'failed updating status after interpret')

            console.log("GrapeRank : interpret : ",request.id," protocol : interpretation complete for iteration ",currentIteration)

            // prepare for next iteration ONLY IF not on final iteration
            if(currentIteration < maxIterations) {
              // get new actors discovered during latest iteration fetch
              const resolvedActors = await this.interpreters.resolveActors(request.id)
              resolvedActors?.forEach((actor) => {
                  if(!allActors.has(actor)) {
                    newActors.add(actor)
                    allActors.set(actor, currentIteration)
                  }
                })
                console.log("GrapeRank : interpret : "+request.id +" protocol : added " ,newActors.size, " new actors")
            }
            
            // Memory optimization: Clear fetched events AFTER resolveActors has extracted subjects
            // Events are no longer needed once interactions are extracted and new actors resolved
            const interpreter = this.interpreters.get(request.id)
            if(interpreter && interpreter.fetched[dos - 1]) {
              const eventCount = interpreter.fetched[dos - 1].size
              interpreter.fetched[dos - 1].clear()
              console.log("GrapeRank : interpret : cleared ",eventCount," fetched events from DOS ",dos," to free memory")
            }
            
            // Memory optimization: Suggest garbage collection between DOS iterations
            // This helps prevent memory accumulation during deep iterations
            if(currentIteration < maxIterations && global.gc) {
              global.gc()
              console.log("GrapeRank : interpret : triggered garbage collection after iteration ",currentIteration)
            }
            console.log("GrapeRank : interpretat : total ", allActors.size," actors")

          }catch(e){
            console.log('GrapeRank : interpret : ERROR : ',e)
          }

          outputResponses.push({
            request : {...request, params : this.interpreters.get(request.id)?.params},
            index : requestindex,
            iteration : currentIteration,
            numActors : currentActors.size,
            // TODO get numFetched from protocol
            numFetched : undefined,
            numInteractions : newInteractions ? newInteractions.size : 0
          })

          console.log("GrapeRank : interpret : "+request.id +" protocol : end iteration ", currentIteration, " of ", maxIterations)
          console.log("----------------------------------")
        }

        // add the final map of currentInteractions to interactions list
        addToInteractionsList(request.id, requestindex, currentInteractions, outputInteractions)
      }

      if (povActorContext?.actorMode === 'event') {
        const finalizedInterpreterInteractions = await this.interpreters.finalizePending(outputInteractions)
        finalizedInterpreterInteractions.forEach(({ interpreterId, interactions }) => {
          const requestIndex = requestIndexesByInterpreterId.get(interpreterId) || 0
          addToInteractionsList(interpreterId, requestIndex, interactions, outputInteractions)
        })
      }

      // // DEBUG duplicate ratings
      // let numtargetratings : Map<actorId,number> = new Map()
      // await forEachBigArray(interactions,(interaction)=>{
      //   if(interaction.subject == DEBUGTARGET) {
      //     let numInteractions = numtargetratings.get(interaction.actor) || 0
      //     numtargetratings.set(interaction.actor,numInteractions + 1)
      //   }
      // })
      // numtargetratings.forEach((num,key)=>{
      //   if(num > 1)
      //   console.log('DEBUGTARGET : interperet : found more than ONE rating for ', key)
      // }) 
    
    }else{
      console.log('GrapeRank : ERROR in interpret() : no actorts && requests passed : ', actors, requests)
    }
    this.interpreters.clear()
    return {interactions: outputInteractions, responses: outputResponses, pov: outputPov}

  }

}

// FIXME this ONLY works when USERS are being rated, not CONTENT
// TODO extraction of new actors from rated content SHOULD be handled by each protocol ...  

// TODO interpreters that do NOT iterate should NOT append new subjects to allactors 
// these interpreters should ONLY generate rankings for previously "discovered" actors
function getNewActors(newInteractions? : InteractionsMap, allActors? : Map<actorId, number>) : Set<actorId>{
  let newActors : Set<actorId> = new Set()
  if(!newInteractions) return newActors
  newInteractions.forEach((subjectMap, actor)=>{
    subjectMap.forEach((interactionData, subject)=>{
      if(!allActors || !allActors.has(subject)) newActors.add(subject)  
    })
  })
  // // DEBUG
  // if(newActors.has(DEBUGTARGET))
  //   console.log('DEBUGTARGET : interpret : target found by getNewActors()')
  return newActors
}

function addToInteractionsList(interpreterId : InterpreterId<any>, index : number, interactionsMap : InteractionsMap, interactionslist: InteractionsList){
  interactionsMap.forEach((subjectMap,actor)=>{
    subjectMap.forEach((interactionData,subject)=>{
      interactionslist.push({
        interpreterId,
        index,
        actor,
        subject,
        ...interactionData
      })
    })
  })
}

function mergeInteractionsMap(target: InteractionsMap, source: InteractionsMap): void {
  source.forEach((sourceSubjects, actor) => {
    let targetSubjects = target.get(actor)
    if (!targetSubjects) {
      targetSubjects = new Map()
      target.set(actor, targetSubjects)
    }

    sourceSubjects.forEach((interactionData, subject) => {
      targetSubjects!.set(subject, interactionData)
    })
  })
}


function countInteractionsMap(interactionsMap : InteractionsMap | undefined){
  if(!interactionsMap) return 0
  let count = 0
  interactionsMap.forEach((subjectMap)=>{
    subjectMap.forEach(()=>{
      count ++
    })
  })
  return count
}


export abstract class InterpreterFactory<namespace extends lowercase> extends Map<InterpreterId<namespace>, InterpreterInitializer>{
  abstract get namespace() : namespace
  // a callback to parse the ID string 
  abstract parseID(id : InterpreterId<namespace>) : {[key:string]:string | number}
  // get protocol IDs by a specific attribute (e.g., kind number for Nostr)
  abstract getID(keys : {[key:string]:string | number}) : InterpreterId<namespace>
}

export class InterpretersMap extends Map<InterpreterId<any>, Interpreter<InterpreterParams>> {
  constructor(factories : InterpreterFactory<any>[]) {
    super()
    this.initialize(factories)
  }

  initialize(factories : InterpreterFactory<any>[]){
    factories.forEach((factory) => {
      factory.forEach((initializer, interpreter)=>{
        if(!this.has(interpreter)) this.set(interpreter, initializer())
      })
    })
  }

  setRequest(request:InterpreterRequest<any>){
    const interpreter = this.get(request.id)
    if(interpreter) interpreter.request = request
  }

  getParams(interpreterId: InterpreterId<any>){ 
    return this.get(interpreterId)?.params
  }

  getInteractions(interpreter : InterpreterId<any>) : InteractionsMap | undefined{
    return this.get(interpreter)?.interactions
  }

  async resolveActors(interpreterId:InterpreterId<any>, type? : povType, pov? : string | string[]){
    return await this.get(interpreterId)?.resolveActors(type, pov)
  }

  async resolvePovContext(interpreterId: InterpreterId<any>, type?: povType, pov?: string | string[]) {
    return await this.get(interpreterId)?.resolvePovContext?.(type, pov)
  }

  setPovActorContext(context?: PovActorContext): void {
    this.forEach((interpreter) => {
      interpreter.setPovActorContext?.(context)
    })
  }

  async fetchData(
    interpreterId:InterpreterId<any>,
    actors?: Set<actorId>,
    onFetchProgress?: InterpreterFetchProgressCallback,
  ){
    return await this.get(interpreterId)?.fetchData(actors, onFetchProgress)
  }

  async interpret(interpreter : InterpreterId<any>, dos : number){
    let instance = this.get(interpreter)
    let result = await instance?.interpret(dos)
    return result
  }

  async finalizePending(interactions: InteractionsList): Promise<FinalizedInterpreterInteractions[]> {
    const finalizedInteractions: FinalizedInterpreterInteractions[] = []

    // Run interpreter-specific finalizers after interpretation has produced
    // a shared interactions list that finalizers can inspect/project onto.
    for (const [interpreterId, interpreter] of this.entries()) {
      if (!interpreter.needsFinalization || !interpreter.finalize) {
        continue
      }

      const finalized = await interpreter.finalize(interactions)
      if (!finalized || finalized.size === 0) {
        continue
      }

      // Persist finalized projections into the interpreter map so downstream
      // consumers of `interpreter.interactions` see a complete view.
      mergeInteractionsMap(interpreter.interactions, finalized)
      finalizedInteractions.push({ interpreterId, interactions: finalized })
    }

    return finalizedInteractions
  }

}