import { Event as NostrEvent} from 'nostr-tools/core'
import { Filter as NostrFilter} from 'nostr-tools/filter'
import { SimplePool } from 'nostr-tools/pool'
import { useWebSocketImplementation } from 'nostr-tools/pool'
import { subjectId, Interpreter, InterpreterParams, InterpreterRequest, InteractionData, InteractionsMap, actorId, InterpreterInitializer, lowercase } from "../types"
import WebSocket from 'ws'
import { applyInteractionsByTag } from "./callbacks"
import { fetchEvents, sliceBigArray } from "./helpers"
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

const maxauthors = 1000
const delaybetweenfetches = 500 // milliceconds

export type NostrInterpreterId = `nostr-${lowercase}-${number}`

export class NostrInterpreterFactory extends Map<NostrInterpreterId, InterpreterInitializer> {
  parseID(id: NostrInterpreterId): { source: string; [key: string]: string | number } {
    const split = id.split('-')
    return { source: split.shift()!, kind: Number(split.pop()), label: split.join('-') }
  }
  getIDsByKind(kind: number): NostrInterpreterId[] {
    return Array.from(this.keys()).filter((id) => this.parseID(id).kind === kind)
  }
}

export type NostrInterpreterConfig<ParamsType extends InterpreterParams> = {
  kinds : number[],
  params : ParamsType,
  interpret? : 
    (instance : Interpreter<ParamsType>, dos : number) 
    => Promise<InteractionsMap>,
  validate? : 
    (events : Set<NostrEvent>, authors : actorId[], previous? : Set<NostrEvent>) 
    => boolean | actorId[],
}

export class NostrInterpreterClass<ParamsType extends InterpreterParams> implements Interpreter<ParamsType> {
  readonly kinds : number[]
  request? : InterpreterRequest
  private _params : ParamsType
  get params(){ return {...this._params, ...this.request?.params}}
  fetched : Set<NostrEvent>[] = []
  interactions : InteractionsMap = new Map()
  interpret : (dos? : number) => Promise<InteractionsMap>
  validate? : 
  (events : Set<NostrEvent>, authors : actorId[], previous? : Set<NostrEvent>) 
  => boolean | actorId[]

  constructor(config: NostrInterpreterConfig<ParamsType>){
    this.kinds = config.kinds
    this._params = config.params
    this.validate = config.validate
    this.interpret = async (dos? : number) => {
      if(!this.fetched.length) throw('GrapeRank : '+this.request?.interpId+' interpreter interpret() : ERROR : NO EVENTS FETCHED PRIOR TO INTERPRET')
      // use the set of fetched events at fetchedIndex or LAST index
      dos = dos || this.fetched.length
      let fetchedIndex = dos - 1
      let newInteractions : InteractionsMap 
      console.log("GrapeRank : ",this.request?.interpId," interpreter : interpreting " ,this.fetched[fetchedIndex].size, " events fetched in iteration ", dos)
      // interpret newInteractions via defined callback or default
      if(config.interpret) {
        newInteractions = await config.interpret(this, dos) 
      }else{
        newInteractions = await applyInteractionsByTag(this, dos)
      }

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

      console.log("GrapeRank : ",this.request?.interpId," interpreter : merged iteration ",dos," into total interpreted : ", numInteractionsMerged ," new interactions and ",numInteractionsDuplicate," duplicate interactions from ",newInteractions.size," authors")

      return newInteractions
    }
  }

  // breaks up a large actors list into multiple authors lists 
  // suitable for relay requests, and sends them all in parallel
  // returns a single promise that is resolved when all fetches are complete.
  async fetchData(authors? : Set<actorId>) : Promise<number> {
    authors = authors || new Set(this.request?.authors)
    // authorslists is authors broken into an array of list, 
    // where each list is maximum size allowed for relay requests
    const authorslists : actorId[][] = authors.size > maxauthors ? 
      sliceBigArray([...authors], maxauthors) : [[...authors]]
    // fetchedSet is where each promise will add newly fetched events
    const fetchedSet : Set<NostrEvent> = new Set()
    const promises : Promise<void>[] = []

    console.log("GrapeRank : nostr interpreter : fetching events in ",authorslists.length, " requests for ",authors.size," actors")
    // send one relay request per `maxauthors` sized list of authors
    for(let index in authorslists){
      let fetchfilter : NostrFilter = {
        ...this.request?.filter, 
        authors : authorslists[index] as string[],
        kinds : this.kinds,
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


