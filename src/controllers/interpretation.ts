import type { InterpreterRequest, InteractionsList, actorId, subjectId, InterpretationResults, InterpreterResponse, InteractionsMap, InterpreterStatus, InterpreterId } from "../types"
import type { Interpreter, InterpreterInitializer, InterpreterParams } from "../types"


export class InterpretationController {
  private stopping : boolean = false
  constructor(
    private interpreters : InterpretersMap,
    private updateStatus? : (status : InterpreterStatus) => Promise<boolean>
  ){}
  stop(){
    this.stopping = true
  }
  async interpret(
    actors : actorId[],
    requests : InterpreterRequest[],
  ) : Promise<InterpretationResults | undefined>{
    var outputResponses : InterpreterResponse[] = []
    var outputInteractions : InteractionsList = []
    // `allActors` map keys hold all actors added as input and between protocol requests
    // map value is the iteration number at which the actor was added
    // (this number ends up in the scorecard as `dos` from observer) 
    const allActors : Map<actorId,number> = new Map()
    var requestActors : Set<actorId> | undefined

    if(!!actors && !!requests){
      console.log("GrapeRank : interpret : instantiating ",requests.length, " protocols for ",actors.length," actors")
      console.log("----------------------------------")
      // add input actors to allActors
      actors.forEach((actorId) => allActors.set(actorId,0))

      // loop through each interpreter request
      // requests having `iterations` will ADD to `allActors` with each interation
      // each request will use the `allActors` list from previous requests
      for(let r in requests){
        if(this.stopping) return undefined
        let requestindex = r as unknown as number
        let request = requests[requestindex]
        this.interpreters.setRequest(request)
        // reset newActors, currentInteractions, and newInteractions 
        // between interpreter requests
        const currentInteractions = this.interpreters.getInteractions(request.interpId) || new Map()
        let newActors : Set<actorId> = new Set()
        let newInteractions : InteractionsMap | undefined
        let currentSubjects : Set<subjectId> | undefined
        let currentIteration : number = 0
        let maxIterations : number = request.iterate || 1
        let currentActors : Set<actorId>
        if(request.authors && request.authors.length) requestActors = new Set(request.authors)
        
        let interpreterStatus : InterpreterStatus
        console.log("GrapeRank : interpret : calling " +request.interpId+" protocol with params : ",this.interpreters.get(request.interpId)?.params)

        while(currentIteration < maxIterations){
          if(this.stopping) return undefined
          // increment for each protocol iteration
          currentIteration ++
          currentActors = requestActors || ( newActors?.size ?  newActors : new Set(allActors.keys()) )
          console.log("GrapeRank : interpret : "+request.interpId+" protocol : begin iteration ", currentIteration, " of ", maxIterations,", with ",currentActors?.size," actors")
          // // DEBUG
          // if(currentActors.has(DEBUGTARGET))
          //   console.log('DEBUGTARGET : interpret : target found in currentIteration actors')
          try{
            interpreterStatus = {
              interpId : request.interpId,
              // FIXME dos needs to be set on initial status ... 
              // how to determine this acurately BEFORE fetchData() has been called?
              dos : request.iterate ? this.interpreters.get(request.interpId)?.fetched?.length || 0 : undefined,
              authors : currentActors.size
            }
            if(this.updateStatus && !await this.updateStatus(interpreterStatus)) throw('failed updating initial status')
            let fetchstart = Date.now()
            // fetch interpreter specific dataset for requestActors OR newActors OR allActors
            // pass currentSubjects from previous iteration
            let dos = await this.interpreters.fetchData(request.interpId, currentActors, currentSubjects) || 1
            interpreterStatus.fetched = [
                this.interpreters.get(request.interpId)?.fetched[dos -1]?.size || 0, // number of fetched events
                Date.now() - fetchstart, // duration of fetch request
                currentIteration == maxIterations ? true : undefined // final DOS iteration ?
              ]
            if(this.updateStatus && !await this.updateStatus(interpreterStatus)) throw('failed updating status after fetch')
            let interpretstart = Date.now()
            // interpret fetched data and get interactions + subjects for next iteration
            const interpretResult = await this.interpreters.interpret(request.interpId, dos)
            if(!interpretResult) throw('interpret returned undefined')
            newInteractions = interpretResult.interactions
            currentSubjects = interpretResult.subjects
            interpreterStatus.interpreted = [
                countInteractionsMap(newInteractions), // number of interpretations rated
                Date.now() - interpretstart, // duration of interpretation
                currentIteration == maxIterations ? true : undefined // final DOS iteration ?
              ]
            if(this.updateStatus && !await this.updateStatus(interpreterStatus)) throw('failed updating status after interpret')

            console.log("GrapeRank : interpret : ",request.interpId," protocol : interpretation complete for iteration ",currentIteration)

            // prepare for next iteration ONLY IF not on final iteration
            if(currentIteration < maxIterations) {
              // get new actors discovered during fetch (from subject resolution)
              const discoveredActors = this.interpreters.getDiscoveredActors(request.interpId)
              if(discoveredActors?.size) {
                discoveredActors.forEach((actor) => {
                  if(!allActors.has(actor)) {
                    newActors.add(actor)
                    allActors.set(actor, currentIteration)
                  }
                })
                console.log("GrapeRank : interpret : "+request.interpId+" protocol : added " ,newActors.size, " new actors")
              }
            }
            console.log("GrapeRank : interpretat : total ", allActors.size," actors")

          }catch(e){
            console.log('GrapeRank : interpret : ERROR : ',e)
          }

          outputResponses.push({
            request : {...request, params : this.interpreters.get(request.interpId)?.params},
            index : requestindex,
            iteration : currentIteration,
            numActors : currentActors.size,
            // TODO get numFetched from protocol
            numFetched : undefined,
            numInteractions : newInteractions ? newInteractions.size : 0
          })

          console.log("GrapeRank : interpret : "+request.interpId+" protocol : end iteration ", currentIteration, " of ", maxIterations)
          console.log("----------------------------------")
        }

        // add the final map of currentInteractions to interactions list
        addToInteractionsList(request.interpId, r as unknown as number, currentInteractions, outputInteractions)
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
    return {interactions: outputInteractions, responses: outputResponses}

  }

}

// FIXME this ONLY works when USERS are being rated, not CONTENT
// TODO extraction of new authors from rated content SHOULD be handled by each protocol ...  

// TODO some protocols, like `nostr-mutes` && `nostr-reports`, should NOT append new ratees to allactors 
// the scorecards generated should ONLY include "those ratees within the [`nostr-follows`] network" ...
// maybe there should be a designated protocol that "defines the set of new actors" ?
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

function addToInteractionsList(interpId : InterpreterId, index : number, interactionsMap : InteractionsMap, interactionslist: InteractionsList){
  interactionsMap.forEach((subjectMap,actor)=>{
    subjectMap.forEach((interactionData,subject)=>{
      interactionslist.push({
        interpId,
        index,
        actor,
        subject,
        ...interactionData
      })
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

// Export ALL module instances of Interpreter interface
// as this[source][protocol]



export abstract class InterpreterFactory<IDType> extends Map<IDType, InterpreterInitializer>{
  // a callback to parse the ID string 
  abstract parseID(id : IDType) : {source : string, [key:string]:string | number}
  // get protocol IDs by a specific attribute (e.g., kind number for Nostr)
  abstract getIDsByKind(kind : number) : IDType[]
}

export class InterpretersMap extends Map<InterpreterId, Interpreter<InterpreterParams>> {
  constructor(factories : InterpreterFactory<any>[]) {
    super()
    factories.forEach((factory) => {
      factory.forEach((initializer, interpId)=>{
        if(!this.has(interpId)) this.set(interpId, initializer())
      })
    })
  }

  setRequest(request:InterpreterRequest){
    const interpreter = this.get(request.interpId)
    if(interpreter) interpreter.request = request
  }

  getParams(interpId: InterpreterId){ 
    return this.get(interpId)?.params
  }

  getInteractions(interpId : InterpreterId) : InteractionsMap | undefined{
    return this.get(interpId)?.interactions
  }

  async fetchData(interpId:InterpreterId, actors?: Set<actorId>, subjects?: Set<subjectId>){
    return await this.get(interpId)?.fetchData(actors, subjects)
  }

  async interpret(interpId : InterpreterId, dos : number){
    let interpreter = this.get(interpId)
    let result = await interpreter?.interpret(dos)
    return result
  }

  getDiscoveredActors(interpId: InterpreterId): Set<actorId> | undefined {
    return this.get(interpId)?.discoveredActors
  }

}