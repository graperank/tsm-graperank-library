import { NostrEvent, NostrFilter, npubEncode, decode, SimplePool, useWebSocketImplementation } from '../lib/nostr-tools'
import { subjectId, Interpreter, InterpreterRequest, InteractionsMap, actorId, InterpreterInitializer, InterpreterParams, InterpreterId, InteractionData, povType } from "../graperank/types"
import { NostrInterpreterClassConfig, NostrInterpreterId, NostrInterpreterKeys, NostrInterpreterParams, NostrType } from "./types"
import { applyInteractionsByTag } from "./callbacks"
import { fetchEvents, sliceBigArray, maxfetch } from "./helpers"
import WebSocket from 'ws'
import { InterpreterFactory } from '../graperank/interpretation'
useWebSocketImplementation(WebSocket)

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

  private static _relays: string[] = [
    "wss://relay.primal.net",
    "wss://relay.damus.io",
    "wss://relay.nostr.band"
  ]
  static get relays() {
    return this._relays
  }
  static set relays(relays: string[]) {
    this._relays = relays
  }


  // Nostr interpreters are identified by kinmd number and tag type
  readonly interpreterId: NostrInterpreterId
  // labels and descriptions for improved user experiences 
  readonly label: string
  readonly description: string
  // 
  readonly fetchKinds : number[]
  readonly allowedActorTypes: string[]
  readonly allowedSubjectTypes: string[]
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
  private customResolveActors? : (instance : any) => Promise<Set<actorId>>

  constructor(config: NostrInterpreterClassConfig<ParamsType>){
    this.interpreterId = constructNostrInterpreterID({kind: config.interpretKind})
    this.label = config.label
    this.description = config.description
    this.fetchKinds = config.fetchKinds
    this.allowedActorTypes = config.allowedActorTypes
    this.allowedSubjectTypes = config.allowedSubjectTypes
    this.defaultParams = config.defaultParams
    this.validate = config.validate
    this.customResolveActors = config.resolveActors
    
    this.interpret = async (dos? : number) => {
      if(!this.fetched.length) throw('GrapeRank : '+this.request?.id+' interpreter interpret() : ERROR : NO EVENTS FETCHED PRIOR TO INTERPRET')
      // use the set of fetched events at fetchedIndex or LAST index
      dos = dos || this.fetched.length
      let fetchedIndex = dos - 1
      
      let result : InteractionsMap | undefined
      console.log("GrapeRank : ",this.request?.id," interpreter : interpreting " ,this.fetched[fetchedIndex].size, " events fetched in iteration ", dos)
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

      console.log("GrapeRank : ",this.request?.id," interpreter : merged iteration ",dos," into total interpreted : ", numInteractionsMerged ," new interactions and ",numInteractionsDuplicate," duplicate interactions from ",newInteractions.size," authors")

      return result
    }
  }


  // resolveActors() returns a set of actor ids supported by this interpreter
  // from a given `type` and `pov` OR from the latest iteration of fetched data.
  // It validates that `type` corresponds to a allowedActorType or allowedSubjectType 
  // AND that `pov` is a string or an array of strings of `type` format
  // OR a naddr reference to an event with `type` tags
  // It parses these `type` formatted strings and returns a set of actor ids.
  // Actor IDs should always be strings in a format compatible with the requested `actorType`
  async resolveActors(type?: povType, pov?: string | string[]):Promise<Set<actorId>>{
    const actors: Set<actorId> = new Set()
    
    if(type && pov) {
      if(!this.allowedActorTypes.includes(type as NostrType) && !this.allowedSubjectTypes.includes(type as NostrType)) {
        throw new Error(`GrapeRank : ${this.interpreterId} : resolveActors : type '${type}' not allowed`)
      }
      
      const povArray = Array.isArray(pov) ? pov : [pov]
      
      for(const povItem of povArray) {
        try {
          if(povItem.startsWith('naddr')) {
            const decoded = decode(povItem)
            if(decoded.type === 'naddr') {
              const { kind, pubkey, identifier } = decoded.data
              const filter: NostrFilter = {
                kinds: [kind],
                authors: [pubkey],
                '#d': identifier ? [identifier] : undefined
              }
              const events = await fetchEvents(filter, NostrInterpreterClass.relays)
              for(const event of events) {
                for(const tag of event.tags) {
                  if(tag[0] === type && tag[1]) {
                    actors.add(tag[1])
                  }
                }
              }
            }
          } else if(type === 'pubkey' || type === 'p' || type === 'P') {
            if(povItem.startsWith('npub')) {
              const decoded = decode(povItem)
              if(decoded.type === 'npub') {
                actors.add(decoded.data as string)
              }
            } else {
              actors.add(povItem)
            }
          } else {
            actors.add(povItem)
          }
        } catch(e) {
          console.log(`GrapeRank : ${this.interpreterId} : resolveActors : failed to parse POV item '${povItem}':`, e)
        }
      }
    } else {
      if(this.customResolveActors) {
        return await this.customResolveActors(this)
      }
      
      if(!this.fetched.length) return actors
      
      const latestFetched = this.fetched[this.fetched.length - 1]
      const subjectType = this.params.subjectType as NostrType
      
      if(!subjectType) return actors
      
      for(const event of latestFetched) {
        if(subjectType === 'pubkey') {
          actors.add(event.pubkey)
        } else if(subjectType === 'id') {
          actors.add(event.id)
        } else {
          for(const tag of event.tags) {
            if(tag[0] === subjectType && tag[1]) {
              actors.add(tag[1])
            }
          }
        }
      }
    }
    
    return actors
  }

  // breaks up a large actors list into multiple actors lists 
  // suitable for relay requests, and sends them all in parallel
  // returns a single promise that is resolved when all fetches are complete.
  async fetchData(actors? : Set<actorId>) : Promise<number> {
    // get actors from request if not provided
    if(!this.request) throw('no request set for this interpreter')
    actors = actors || new Set(this.request?.actors)
    // actorslists is actors broken into an array of list, 
    // where each list is maximum size allowed for relay requests
    const actorslists = actors.size > maxfetch ? sliceBigArray([...actors], maxfetch) : [[...actors]]
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
      fetchEvents(filter, NostrInterpreterClass.relays).then(async (newFetchedSet)=>{
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
