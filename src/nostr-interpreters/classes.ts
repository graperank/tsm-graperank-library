import { Event as NostrEvent} from 'nostr-tools/core'
import { Filter as NostrFilter} from 'nostr-tools/filter'
import { SimplePool } from 'nostr-tools/pool'
import { useWebSocketImplementation } from 'nostr-tools/pool'
import { subjectId, Interpreter, InterpreterRequest, InteractionsMap, actorId, InterpreterInitializer, InterpreterParams, InterpreterId, InteractionData } from "../types"
import { NostrInterpreterClassConfig, NostrInterpreterId, NostrInterpreterKeys, NostrInterpreterParams, NostrType } from "./types"
import { applyInteractionsByTag } from "./callbacks"
import { fetchEvents, sliceBigArray, maxfetch } from "./helpers"
import WebSocket from 'ws'
import { InterpreterFactory } from '../graperank/interpretation'
useWebSocketImplementation(WebSocket)

const relays = [
  "wss://gv.rogue.earth",
  // "wss://purplepag.es",
  // "wss://relay.primal.net",
  // "wss://relay.damus.io",
  // "wss://nostr-pub.wellorder.net",
  // "wss://relay.nostr.bg",
  "wss://nostr.bitcoiner.social",
  // "wss://nostr.fmt.wiz.biz",
  // "wss://nostr.oxtr.dev",
  // "wss://nostr.mom",
  "wss://relay.nostr.band",
  "wss://relay.snort.social",
  // "wss://soloco.nl",
  "wss://nos.lol",
]

const delaybetweenfetches = 500 // milliceconds


function parseNostrInterpreterID(id: NostrInterpreterId): NostrInterpreterKeys {
  const split = id.split('-')
  const kind = Number(split[1])
  const type = split[2] as NostrType
  return { kind, type }
}
function constructNostrInterpreterID(key: NostrInterpreterKeys): NostrInterpreterId {
  return `nostr-${key.kind}${key.type ? `-${key.type}` : ''}` as NostrInterpreterId
}

export class NostrInterpreterFactory extends InterpreterFactory<"nostr"> {
  readonly namespace = "nostr"
  parseID = parseNostrInterpreterID
  getID = constructNostrInterpreterID
}

/**
 * Nostr interpreters are responsible for
 * fetching published events and normalizing their content 
 * as user or event interactions.
 * 
 */
export class NostrInterpreterClass<ParamsType extends NostrInterpreterParams> implements Interpreter<ParamsType> {
  // Nostr interpreters are identified by kinmd number and tag type
  readonly interpreterId: NostrInterpreterId
  // labels and descriptions for improved user experiences 
  readonly label: string
  readonly description: string
  // 
  readonly fetchKinds : number[]
  readonly allowedActorTypes: string[]
  readonly allowedSubjectTypes: string[]
  discoveredActors? : Set<actorId>
  request? : InterpreterRequest<ParamsType>
  private defaultParams : ParamsType
  get params(){ 
    return {...this.defaultParams, ...this.request?.params}
  }
  
  fetched : Set<NostrEvent>[] = []
  interactions : InteractionsMap = new Map()
  interpret : (dos? : number) => Promise<InteractionsMap | undefined>
  validate? : 
  (events : Set<NostrEvent>, authors : actorId[], previous? : Set<NostrEvent>) 
  => boolean | actorId[]

  constructor(config: NostrInterpreterClassConfig<ParamsType>){
    this.interpreterId = constructNostrInterpreterID({kind: config.interpretKind})
    this.label = config.label
    this.description = config.description
    this.fetchKinds = config.fetchKinds
    this.allowedActorTypes = config.allowedActorTypes
    this.allowedSubjectTypes = config.allowedSubjectTypes
    this.defaultParams = config.defaultParams
    this.validate = config.validate
    
    this.interpret = async (dos? : number) => {
      if(!this.fetched.length) throw('GrapeRank : '+this.request?.interpreterId+' interpreter interpret() : ERROR : NO EVENTS FETCHED PRIOR TO INTERPRET')
      // use the set of fetched events at fetchedIndex or LAST index
      dos = dos || this.fetched.length
      let fetchedIndex = dos - 1
      
      let result : InteractionsMap | undefined
      console.log("GrapeRank : ",this.request?.interpreterId," interpreter : interpreting " ,this.fetched[fetchedIndex].size, " events fetched in iteration ", dos)
      // interpret newInteractions via defined callback or default
      if(config.interpret) {
        result = await config.interpret(this, dos) 
      }else{
        result = await applyInteractionsByTag(this, dos)
      }
      
      const newInteractions = result || new Map<actorId, Map<subjectId, InteractionData>>()

      // merge newInteractions into this.interactions
      let numInteractionsMerged = 0
      let numActorInteractions = 0
      let numInteractionsDuplicate = 0
      newInteractions.forEach((subjectMap, actor)=>{ 
        let actorInteractions = this.interactions.get(actor)
        if(actorInteractions) {
          numActorInteractions = actorInteractions.size
          subjectMap.forEach((interactionData, subject)=>{
            actorInteractions.set(subject, interactionData)
          })
          numInteractionsMerged = numInteractionsMerged + (actorInteractions.size - numActorInteractions)
          numInteractionsDuplicate = numInteractionsDuplicate + (subjectMap.size - (actorInteractions.size - numActorInteractions))
        }else{
          numInteractionsMerged = numInteractionsMerged + subjectMap.size
          this.interactions.set(actor, subjectMap) 
        }
      })

      console.log("GrapeRank : ",this.request?.interpreterId," interpreter : merged iteration ",dos," into total interpreted : ", numInteractionsMerged ," new interactions and ",numInteractionsDuplicate," duplicate interactions from ",newInteractions.size," authors")

      return result
    }
  }

  // breaks up a large actors list into multiple actors lists 
  // suitable for relay requests, and sends them all in parallel
  // returns a single promise that is resolved when all fetches are complete.
  async fetchData(actors? : Set<actorId>, subjects? : Set<subjectId>) : Promise<number> {
    this.discoveredActors = new Set()
    
    const fetchActors = new Set<actorId>()
    if(actors) actors.forEach(a => fetchActors.add(a))
    
    if(subjects) {
      subjects.forEach(s => {
        fetchActors.add(s)
        this.discoveredActors!.add(s)
      })
    }
    if(!fetchActors.size) return 0
    if(!this.request) throw('no request set for this interpreter')
    actors = actors || new Set(this.request?.actors)
    // actorslists is actors broken into an array of list, 
    // where each list is maximum size allowed for relay requests
    const actorslists = fetchActors.size > maxfetch ? sliceBigArray([...fetchActors], maxfetch) : [[...fetchActors]]
    // fetchedSet is where each promise will add newly fetched events
    const fetchedSet : Set<NostrEvent> = new Set()
    const promises : Promise<void>[] = []

    console.log("GrapeRank : nostr interpreter : fetching events in ",actorslists.length, " requests for ",actors.size," actors")
    // send one relay request per `maxfetch` sized list of actors
    for(let index in actorslists){
      let fetchfilter : NostrFilter = {
        ...this.request?.filter, 
        authors : actorslists[index] as string[],
        kinds : this.fetchKinds,
      }
      // delay between relay requests
      await new Promise<void>((resolve)=>{
        setTimeout(()=> resolve(), delaybetweenfetches)
      })
      promises.push(this.fetchEventsPromise(fetchfilter, fetchedSet, index  as unknown as number))
    }
    // wait for all promises to resolve
    await Promise.all(promises)
    console.log("GrapeRank : nostr interpreter : fetching complete with ", fetchedSet.size, " events ")

    // add fetchedSet to this.fetched array of event sets, 
    // and return the new dos for interactions interpretation 
    return this.fetched.push(fetchedSet)
  }

  // An iterative function ... 
  // possibly calls itself again if validation fails
  // returns a single promise with possibly nested promises
  private async fetchEventsPromise(filter: NostrFilter, fetchedSet : Set<NostrEvent>, iteration = 0) : Promise<void> {
    if(!filter.authors) 
      return new Promise((resolve,reject)=> reject("No authors provided"))
    console.log("GrapeRank : nostr interpreter : fetching events in request ",iteration, " for ",filter.authors?.length, " actors")
    return new Promise((resolve)=>{
      fetchEvents(filter).then(async (newFetchedSet)=>{
        let validation = true // this.validate ? this.validate(newFetchedSet, filter.authors as string[], fetchedSet) : true
        try{

          // FALSE validation will log error
          // if(validation === false ) {
          //   throw('events validaiton failed')
          // }

          // TRUE validation will add events to fetchedSet
          if(validation === true){ 
            // fetchedSet = new Set([...fetchedSet, ...newFetchedSet])
            newFetchedSet.forEach((event)=>{ fetchedSet.add(event) })
            throw("fetched " + newFetchedSet.size + " new events, for total of "+ fetchedSet.size)
          }

          // otherwise try request again with reduced authors list
          console.log("GrapeRank : nostr interpreter : fetch request ",iteration," : requesting again")
          await this.fetchEventsPromise(
            {...filter, authors : validation as string[]}, fetchedSet,
            iteration )

        }catch(e){
          console.log("GrapeRank : nostr interpreter : fetch request  ",iteration," complete : ", e)
        }
        resolve()
      }).catch((error)=>{
        console.log("GrapeRank : nostr interpreter : ERROR in fetch request ", iteration, error)
      })
    })
  }

}

export type pubkey = string
export type signature = string
