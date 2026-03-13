import { Event as NostrEvent } from 'nostr-tools/core'
import { npubEncode } from "nostr-tools/nip19"
import { InteractionsMap, InteractionData, actorId, subjectId } from "../types"
import { NostrInterpreterClass } from "./classes"


export async function applyInteractionsByTag(instance : NostrInterpreterClass<any>, dos : number, tag = "p", subjectIndex = 1, valueIndex? : number) : Promise<InteractionsMap> {
  console.log("GrapeRank : nostr interpreter : applyInteractionsByTag()")
  let fetchedIndex = dos - 1
  const fetchedSet = instance.fetched[fetchedIndex]
  const newInteractionsMap : InteractionsMap = new Map()
  let eventindex : number = 0, 
    totalInteractions : number = 0, 
    duplicateInteractions : number = 0, 
    actor : actorId,
    subject : subjectId,
    // apply a single value for all interactions, as indicated in params.value
    defaultValue = instance.params.value as number || 0,
    defaultConfidence = instance.params.confidence as number || .5
  // loop through the events of fetchedSet to find tags for making new interactions
  for(let event of fetchedSet) {
    actor = event.pubkey
    const actorInteractions = new Map<string, InteractionData>
    eventindex ++
    let oldDuplicateInteractions = duplicateInteractions
    // loop through all tags of each event to find the ones to make interactions from
    if(!!event.tags && event.tags.length < 10000){
      for(let t in event.tags){
        // `subjectIndex` argument determines the tag index from which to get the ID of what's been rated
        subject = event.tags[t][subjectIndex]
        // skip for this tag if interaction already exists for this actor / subject
        if(actorInteractions.has(subject)) {
          duplicateInteractions ++
          continue
        }
        // `tag` argument defines what event tag to makes interactions from
        if(event.tags[t][0] == tag){
          // validate pubkey before applying an interaction
          if(tag == 'p' && subjectIndex == 1 && !validatePubkey(event.tags[t][1])) {
            continue
          }
          actorInteractions.set(subject, { 
            confidence : defaultConfidence,
            // if `valueIndex` argument has been defined...
            // and if the value of this tag[valueIndex] is a property in params ...
            // then apply a custom value per interaction according to the index value in params
            value : valueIndex ? instance.params[event.tags[t][valueIndex]] as unknown as number : defaultValue,
            dos : dos
          })
            
          totalInteractions ++
        }
      }
    }else{
      console.log("GrapeRank : nostr interpreter : applyInteractionsByTag : event not processed")
    }
    newInteractionsMap.set(actor, actorInteractions)
  }

  console.log("GrapeRank : nostr interpreter : applyInteractionsByTag : total interpreted ", totalInteractions, " new interactions and skipped ",duplicateInteractions," duplicate interactions for ",newInteractionsMap.size," authors in iteration ", fetchedIndex)
  return newInteractionsMap
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
