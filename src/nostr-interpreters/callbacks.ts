import { Event as NostrEvent } from 'nostr-tools/core'
import { InteractionsMap, InteractionData, actorId, subjectId } from "../types"
import { NostrInterpreterClass } from "./classes"
import { NostrInterpreterParams, NostrType } from './types'
import { EventTypes, getEventActor, getEventSubject, PubkeyTypes, validateNostrTypeValue, validatePubkey } from './helpers'


export async function applyInteractionsByTag(instance : NostrInterpreterClass<NostrInterpreterParams>, dos : number, tag? : NostrType, subjectIndex : number = 1, valueIndex? : number) : Promise<InteractionsMap | undefined>{
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
    
    if(!!event.tags && event.tags.length < 10000){
      for(let t in event.tags){
        let value : number = defaultValue
        let tag = event.tags[t]
        let subject = getEventSubject(subjectType, event, tag, subjectIndex)
        if(!subject) continue
        
        if(actorInteractions.has(subject)) {
          duplicateInteractions ++
          continue
        }

        if(valueIndex && tag[valueIndex] 
          && typeof instance.params[tag[valueIndex]] == 'number'){
          value = instance.params[tag[valueIndex]] as number
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

export function validateOneEventIsNew( events : Set<NostrEvent>, authors : actorId[], previous? : Set<NostrEvent> ) : boolean | actorId[] { 
  if(!previous || !previous.size) return true
  previous.forEach((pevent)=>{
    events.forEach((newevent)=>{
      if(pevent.id != newevent.id) return true
    })
  })
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

export async function applyZapInteractions(instance : NostrInterpreterClass<any>, dos : number) : Promise<InteractionsMap> {
  console.log("GrapeRank : nostr interpreter : applyZapInteractions()")
  let fetchedIndex = dos - 1
  const fetchedSet = instance.fetched[fetchedIndex]
  const newInteractionsMap : InteractionsMap = new Map()
  let totalInteractions : number = 0
  let duplicateInteractions : number = 0
  let skippedInvalid : number = 0
  const defaultValue = instance.params.value as number || 0
  const defaultConfidence = instance.params.confidence as number || .5
  
  // Determine direction of interpretation
  const actorIsSender = instance.allowedActorTypes.includes('P')

  for(let zapReceipt of fetchedSet) {
    // Per NIP-57: zap receipt pubkey is the lightning server, not the sender or recipient
    // Sender is in uppercase 'P' tag, recipient is in lowercase 'p' tag
    
    // Find sender P tag (zap sender from the zap request)
    const senderTag = zapReceipt.tags.find(tag => tag[0] === 'P')
    if(!senderTag || !senderTag[1]) {
      skippedInvalid++
      continue
    }
    const sender = senderTag[1]
    
    // Find recipient p tag
    const recipientTag = zapReceipt.tags.find(tag => tag[0] === 'p')
    if(!recipientTag || !recipientTag[1]) {
      skippedInvalid++
      continue
    }
    const recipient = recipientTag[1]
    
    // Validate both pubkeys
    if(!validatePubkey(sender) || !validatePubkey(recipient)) {
      skippedInvalid++
      continue
    }
    
    let actor: actorId
    let subject: subjectId
    
    if(actorIsSender) {
      // sender (P) -> recipient (p)
      actor = sender
      subject = recipient
    } else {
      // recipient (p) -> sender (P)
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
    
    actorInteractions.set(subject, { 
      confidence : defaultConfidence,
      value : defaultValue,
      dos : dos
    })
    
    totalInteractions++
  }

  console.log("GrapeRank : nostr interpreter : applyZapInteractions : total interpreted ", totalInteractions, " new interactions, skipped ",duplicateInteractions," duplicates and ",skippedInvalid," invalid zap receipts")
  return newInteractionsMap
}
