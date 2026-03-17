import { Event as NostrEvent } from 'nostr-tools/core'
import { npubEncode } from "nostr-tools/nip19"
import { InteractionsMap, InteractionData, actorId, subjectId, InterpretResult } from "../types"
import { NostrInterpreterClass } from "./classes"


export async function applyInteractionsByTag(instance : NostrInterpreterClass<any>, dos : number, tag = "p", subjectIndex = 1, valueIndex? : number) : Promise<InterpretResult> {
  console.log("GrapeRank : nostr interpreter : applyInteractionsByTag()")
  let fetchedIndex = dos - 1
  const fetchedSet = instance.fetched[fetchedIndex]
  const newInteractionsMap : InteractionsMap = new Map()
  const subjects : Set<subjectId> = new Set()
  let eventindex : number = 0, 
    totalInteractions : number = 0, 
    duplicateInteractions : number = 0, 
    actor : actorId,
    subject : subjectId,
    // apply a single value for all interactions, as indicated in params.value
    defaultValue = instance.params.value as number || 0,
    defaultConfidence = instance.params.confidence as number || .5
  
  // Check mode to determine direction
  const actorIsPubkey = instance.actorType === 'pubkey'
  
  // loop through the events of fetchedSet to find tags for making new interactions
  for(let event of fetchedSet) {
    eventindex ++
    
    // Determine actor and subjects based on mode
    if(actorIsPubkey) {
      // Mode: pubkey -> p tag (normal direction)
      actor = event.pubkey
      const actorInteractions = new Map<string, InteractionData>()
      
      // loop through all tags of each event to find the ones to make interactions from
      if(!!event.tags && event.tags.length < 10000){
        for(let t in event.tags){
          // `tag` argument defines what event tag to makes interactions from
          if(event.tags[t][0] == tag){
            subject = event.tags[t][subjectIndex]
            
            // skip for this tag if interaction already exists for this actor / subject
            if(actorInteractions.has(subject)) {
              duplicateInteractions ++
              continue
            }
            
            // validate pubkey before applying an interaction
            if(tag == 'p' && subjectIndex == 1 && !validatePubkey(event.tags[t][1])) {
              continue
            }
            
            actorInteractions.set(subject, { 
              confidence : defaultConfidence,
              value : valueIndex ? instance.params[event.tags[t][valueIndex]] as unknown as number : defaultValue,
              dos : dos
            })
            
            subjects.add(subject)
            totalInteractions ++
          }
        }
      }else{
        console.log("GrapeRank : nostr interpreter : applyInteractionsByTag : event not processed")
      }
      
      if(actorInteractions.size > 0) {
        newInteractionsMap.set(actor, actorInteractions)
      }
    } else {
      // Mode: p tag -> pubkey (reversed direction)
      // Each p tag becomes an actor, event.pubkey becomes the subject
      subject = event.pubkey
      
      if(!!event.tags && event.tags.length < 10000){
        for(let t in event.tags){
          if(event.tags[t][0] == tag){
            actor = event.tags[t][subjectIndex]
            
            // validate pubkey
            if(tag == 'p' && subjectIndex == 1 && !validatePubkey(event.tags[t][1])) {
              continue
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
              value : valueIndex ? instance.params[event.tags[t][valueIndex]] as unknown as number : defaultValue,
              dos : dos
            })
            
            subjects.add(subject)
            totalInteractions++
          }
        }
      }
    }
  }

  console.log("GrapeRank : nostr interpreter : applyInteractionsByTag : total interpreted ", totalInteractions, " new interactions and skipped ",duplicateInteractions," duplicate interactions for ",newInteractionsMap.size," actors in iteration ", fetchedIndex)
  return {
    interactions: newInteractionsMap,
    subjects: subjects
  }
}


export function validatePubkey(pubkey : string){
  try{
    npubEncode(pubkey)
  }catch(e){
    return false
  }
  return true
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

export async function applyHashtagInteractions(instance : NostrInterpreterClass<any>, dos : number) : Promise<InterpretResult> {
  console.log("GrapeRank : nostr interpreter : applyHashtagInteractions()")
  let fetchedIndex = dos - 1
  const fetchedSet = instance.fetched[fetchedIndex]
  const newInteractionsMap : InteractionsMap = new Map()
  const subjects : Set<subjectId> = new Set()
  let totalInteractions : number = 0
  let duplicateInteractions : number = 0
  const defaultValue = instance.params.value as number || 0
  const defaultConfidence = instance.params.confidence as number || .5

  for(let event of fetchedSet) {
    // Actor is event.id, subjects are hashtags from 't' tags
    const actor = event.id
    const actorInteractions = new Map<string, InteractionData>()
    
    if(!!event.tags && event.tags.length < 10000){
      for(let t in event.tags){
        if(event.tags[t][0] == 't'){
          const subject = event.tags[t][1]
          
          if(actorInteractions.has(subject)) {
            duplicateInteractions ++
            continue
          }
          
          actorInteractions.set(subject, { 
            confidence : defaultConfidence,
            value : defaultValue,
            dos : dos
          })
          
          subjects.add(subject)
          totalInteractions ++
        }
      }
    }
    
    if(actorInteractions.size > 0) {
      newInteractionsMap.set(actor, actorInteractions)
    }
  }

  console.log("GrapeRank : nostr interpreter : applyHashtagInteractions : total interpreted ", totalInteractions, " new interactions and skipped ",duplicateInteractions," duplicate interactions for ",newInteractionsMap.size," event IDs")
  return {
    interactions: newInteractionsMap,
    subjects: subjects
  }
}

export async function applyZapInteractions(instance : NostrInterpreterClass<any>, dos : number) : Promise<InterpretResult> {
  console.log("GrapeRank : nostr interpreter : applyZapInteractions()")
  let fetchedIndex = dos - 1
  const fetchedSet = instance.fetched[fetchedIndex]
  const newInteractionsMap : InteractionsMap = new Map()
  const subjects : Set<subjectId> = new Set()
  let totalInteractions : number = 0
  let duplicateInteractions : number = 0
  let skippedInvalid : number = 0
  const defaultValue = instance.params.value as number || 0
  const defaultConfidence = instance.params.confidence as number || .5
  
  // Check mode to determine direction
  const actorIsSender = instance.actorType === 'P'

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
      // Mode: sender (P) -> recipient (p)
      actor = sender
      subject = recipient
    } else {
      // Mode: recipient (p) -> sender (P)
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
    
    subjects.add(subject)
    totalInteractions++
  }

  console.log("GrapeRank : nostr interpreter : applyZapInteractions : total interpreted ", totalInteractions, " new interactions, skipped ",duplicateInteractions," duplicates and ",skippedInvalid," invalid zap receipts")
  return {
    interactions: newInteractionsMap,
    subjects: subjects
  }
}
