import { Event as NostrEvent } from 'nostr-tools/core'
import { InteractionsMap, InteractionData, actorId, subjectId } from "../types"
import { NostrInterpreterClass } from "./classes"
import { NostrInterpreterParams, NostrType } from './types'
import { getEventActor, getEventSubject, validatePubkey } from './helpers'

// A generic callback for interpreting interactions from individual tags
// where each tag represents a single actor/subject interaction in an event,
// and where one tag index is the subject id and another is the actor's interaction,
// (eg: ["p", "<pubkey>", "<interaction>"])
// and where all events in a set of fetched events are interpreted in the same manner
// Each interaction string extracted from an event tag (at interactionIndex)
// SHOULD have a corresponding entry in the interpreter's params array
// If no interactionIndex is provided, or no corresponding entry exists, 
// the default interpretation value (params.value) is used
export async function applyInteractionsByTag(instance : NostrInterpreterClass<NostrInterpreterParams>, dos : number, tag? : NostrType, subjectIndex : number = 1, interactionIndex? : number) : Promise<InteractionsMap | undefined>{
  console.log("GrapeRank : nostr interpreter : applyInteractionsByTag()")
  const actorType = instance.request?.params?.actorType
  // validate 
  if(!actorType || !instance.allowedActorTypes.includes(actorType)) 
    return undefined
  const subjectType = tag || instance.request?.params?.subjectType
  if(!subjectType || !instance.allowedSubjectTypes.includes(subjectType)) 
    return undefined
  
  let fetchedIndex = dos - 1
  const fetchedSet = instance.fetched[fetchedIndex]
  const newInteractionsMap : InteractionsMap = new Map()
  let eventindex : number = 0, 
    totalInteractions : number = 0, 
    duplicateInteractions : number = 0, 
    defaultValue = instance.params.value as number || 0,
    confidence = instance.params.confidence as number || .5
  
  for(let event of fetchedSet) {
    let actor = getEventActor(actorType, event)
    if(!actor) continue
    const actorInteractions = new Map<string, InteractionData>()
    eventindex ++
    
    // DoS prevention: Skip events with excessive tags (potential attack vector)
    const MAX_TAGS_TO_PROCESS = 10000
    if(event.tags && event.tags.length < MAX_TAGS_TO_PROCESS){
      for(let t in event.tags){
        let value : number = defaultValue
        let tag = event.tags[t]
        let subject = getEventSubject(subjectType, event, tag, subjectIndex)
        if(!subject) continue
        
        if(actorInteractions.has(subject)) {
          duplicateInteractions ++
          continue
        }

        if(interactionIndex && tag[interactionIndex] 
          && typeof instance.params[tag[interactionIndex]] == 'number'){
          value = instance.params[tag[interactionIndex]] as number
        }

        actorInteractions.set(subject, {confidence, value, dos})
        totalInteractions ++
        }
      }
    // }else{
    //   console.log("GrapeRank : nostr interpreter : applyInteractionsByTag : event not processed")
    // }
    
    newInteractionsMap.set(actor, actorInteractions)
  }

  console.log("GrapeRank : nostr interpreter : applyInteractionsByTag : total interpreted ", totalInteractions, " new interactions and skipped ", duplicateInteractions, " duplicate interactions for ", newInteractionsMap.size, " actors in iteration ", fetchedIndex)
  return  newInteractionsMap
}


export function validateEachEventHasAuthor( events : Set<NostrEvent>, authors : actorId[], previous? : Set<NostrEvent> ) : boolean | actorId[] { 
  if(authors.length == events.size) return true
  if(!validateOneEventIsNew(events,authors,previous)) return false
  let authorswithoutevents = getEventsAuthors(events, authors) 
  return authorswithoutevents.length ? authorswithoutevents : true
}

export function validateOneEventIsNew( events : Set<NostrEvent>, authors : actorId[], previous? : Set<NostrEvent> ) : boolean { 
  if(!previous || !previous.size) return true
  
  for(const newevent of events) {
    let isNew = true
    for(const pevent of previous) {
      if(pevent.id === newevent.id) {
        isNew = false
        break
      }
    }
    if(isNew) return true
  }
  return false
}


export function getEventsAuthors(events: Set<NostrEvent>, exclude? : actorId[]) : actorId[]{
  const authors : actorId[] = []
  events.forEach((event)=> {
    if(!exclude || !exclude.includes(event.pubkey))
      authors.push(event.pubkey)
  })
  return authors
}

// a zap specific callback 
// for interpreting zap interactions from zap receipt events
// Accepts `<` and `>` prefixed interpreter params (eg: <1000) 
// allowing requestors to specify interaction values 
// based on zap amount.
export async function applyZapInteractions(instance : NostrInterpreterClass<NostrInterpreterParams>, dos : number) : Promise<InteractionsMap | undefined> {
  console.log("GrapeRank : nostr interpreter : applyZapInteractions()")
  const actorType = instance.request?.params?.actorType
  if(!actorType || !instance.allowedActorTypes.includes(actorType)) 
    return undefined
  const subjectType = instance.request?.params?.subjectType
  if(!subjectType || !instance.allowedSubjectTypes.includes(subjectType)) 
    return undefined
  
  let fetchedIndex = dos - 1
  const fetchedSet = instance.fetched[fetchedIndex]
  const newInteractionsMap : InteractionsMap = new Map()
  let totalInteractions : number = 0
  let duplicateInteractions : number = 0
  let skippedInvalid : number = 0
  const defaultValue = instance.params.value as number || 0
  const confidence = instance.params.confidence as number || .5

  for(let zapReceipt of fetchedSet) {
    // Per NIP-57: zap receipt pubkey is the lightning server, not the sender or recipient
    // Sender is in uppercase 'P' tag, recipient is in lowercase 'p' tag
    
    const sender = getEventSubject('P', zapReceipt)
    if(!sender) {
      skippedInvalid++
      continue
    }
    
    const recipient = getEventSubject('p', zapReceipt)
    if(!recipient) {
      skippedInvalid++
      continue
    }
    
    // Extract zap amount in millisatoshi
    let zapAmount: number | undefined
    const amountTag = zapReceipt.tags.find(tag => tag[0] === 'amount')
    if(amountTag && amountTag[1]) {
      zapAmount = parseInt(amountTag[1])
    }
    
    // Calculate value based on zap amount and params
    let value = defaultValue
    if(zapAmount !== undefined && !isNaN(zapAmount)) {
      // Collect and sort comparison-based params
      const lessThanParams: Array<{threshold: number, value: number}> = []
      const greaterThanParams: Array<{threshold: number, value: number}> = []
      
      for(const [key, paramValue] of Object.entries(instance.params)) {
        if(typeof paramValue !== 'number') continue
        
        if(key.startsWith('<')) {
          const threshold = parseInt(key.substring(1))
          if(!isNaN(threshold)) {
            lessThanParams.push({threshold, value: paramValue})
          }
        } else if(key.startsWith('>')) {
          const threshold = parseInt(key.substring(1))
          if(!isNaN(threshold)) {
            greaterThanParams.push({threshold, value: paramValue})
          }
        }
      }
      
      // Sort < in descending order, > in ascending order
      lessThanParams.sort((a, b) => b.threshold - a.threshold)
      greaterThanParams.sort((a, b) => a.threshold - b.threshold)
      
      // Check < params first, then > params
      for(const param of lessThanParams) {
        if(zapAmount < param.threshold) {
          value = param.value
          break
        }
      }
      if(value === defaultValue) {
        for(const param of greaterThanParams) {
          if(zapAmount > param.threshold) {
            value = param.value
            break
          }
        }
      }
    }
    
    let actor: actorId
    let subject: subjectId
    
    if(actorType === 'P') {
      actor = sender
      subject = recipient
    } else {
      actor = recipient
      subject = sender
    }
    
    let actorInteractions = newInteractionsMap.get(actor)
    if(!actorInteractions) {
      actorInteractions = new Map<string, InteractionData>()
      newInteractionsMap.set(actor, actorInteractions)
    }
    
    if(actorInteractions.has(subject)) {
      duplicateInteractions++
      continue
    }
    
    actorInteractions.set(subject, {confidence, value, dos})
    totalInteractions++
  }

  console.log("GrapeRank : nostr interpreter : applyZapInteractions : total interpreted ", totalInteractions, " new interactions, skipped ", duplicateInteractions, " duplicates and ", skippedInvalid, " invalid zap receipts")
  return newInteractionsMap
}
