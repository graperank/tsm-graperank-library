import { NostrEvent } from '../lib/nostr-tools'
import { InteractionsMap, InteractionData, InteractionsList, actorId, subjectId } from "../graperank/types"
import { NostrInterpreterClass } from "./classes"
import { NostrInterpreterParams, NostrType } from './types'
import { getEventActor, getEventSubject, validatePubkey } from './helpers'

type ZapTotalsByActorSubject = Map<actorId, Map<subjectId, number>>
type ZapEventActorSenderTotals = ZapTotalsByActorSubject
type ZapEventActorSenderTotalsByDos = Map<number, ZapEventActorSenderTotals>

type ApplyZapInteractionsOptions = {
  // Optional hook used by interpreter factories to keep staged finalization
  // state outside `NostrInterpreterClass`.
  stageEventActorSenderTotals?: (dos: number, totalsByEventActor: ZapEventActorSenderTotals) => void
}

function getFirstTagValue(event: NostrEvent, tagName: string): string | undefined {
  const found = event.tags.find((t) => t[0] === tagName)
  return found?.[1]
}

function parsePubkeyFromAddressTag(address: string): string | undefined {
  const parts = address.split(':')
  if(parts.length < 2) return undefined
  const pubkey = parts[1]
  if(!validatePubkey(pubkey)) return undefined
  return pubkey
}

function getAttestationSubjectPubkey(event: NostrEvent): string | undefined {
  const address = getFirstTagValue(event, 'a')
  if(address) {
    const pubkey = parsePubkeyFromAddressTag(address)
    if(pubkey) return pubkey
  }
  const p = getFirstTagValue(event, 'p')
  if(p && validatePubkey(p)) return p
  return undefined
}

function getActorsForEvent(
  instance: NostrInterpreterClass<NostrInterpreterParams>,
  dos: number,
  event: NostrEvent,
  actorType: NostrType,
  options?: { requireBoundActors?: boolean },
): actorId[] {
  const eventActorBindings = instance.getEventActorBindings(dos)
  const boundActors = eventActorBindings?.get(event.id)
  if (boundActors && boundActors.size > 0) {
    return [...boundActors]
  }

  if (options?.requireBoundActors) {
    return []
  }

  const extractedActor = getEventActor(actorType, event)
  return extractedActor ? [extractedActor] : []
}

function getZapRequestPubkeyFromDescription(zapReceipt: NostrEvent): string | undefined {
  const description = getFirstTagValue(zapReceipt, 'description')
  if (!description) return undefined

  try {
    const parsed = JSON.parse(description) as { pubkey?: unknown }
    const candidate = typeof parsed?.pubkey === 'string' ? parsed.pubkey : undefined
    if (!candidate || !validatePubkey(candidate)) return undefined
    return candidate
  } catch {
    return undefined
  }
}

type ZapPairMode =
  | 'event-forward'
  | 'event-reverse'
  | 'pubkey-forward'
  | 'pubkey-reverse'

function resolveZapPairMode(actorType: NostrType, subjectType: NostrType): ZapPairMode | undefined {
  if (actorType === 'e' && subjectType === 'pubkey') {
    return 'event-forward'
  }

  if (actorType === 'pubkey' && subjectType === 'e') {
    return 'event-reverse'
  }

  if (actorType === 'p' && subjectType === 'pubkey') {
    return 'pubkey-forward'
  }

  if (actorType === 'pubkey' && subjectType === 'p') {
    return 'pubkey-reverse'
  }

  return undefined
}

function resolveZapSenderPubkey(zapReceipt: NostrEvent): string | undefined {
  return getZapRequestPubkeyFromDescription(zapReceipt)
}

function parseZapAmountMsats(zapReceipt: NostrEvent): number {
  const amountTag = zapReceipt.tags.find((tag) => tag[0] === 'amount')
  if (!amountTag || !amountTag[1]) {
    return 0
  }

  const parsedAmount = parseInt(amountTag[1], 10)
  return Number.isFinite(parsedAmount) ? parsedAmount : 0
}

export function resolveZapInteractionValue(params: NostrInterpreterParams, zapAmountMsats: number): number {
  // Zap weights are configured through numeric params where keys like
  // `<1000` / `>10000000` define threshold buckets in msats.
  const defaultValue = params.value as number || 0
  if (!Number.isFinite(zapAmountMsats)) {
    return defaultValue
  }

  const lessThanParams: Array<{ threshold: number; value: number }> = []
  const greaterThanParams: Array<{ threshold: number; value: number }> = []

  for (const [key, paramValue] of Object.entries(params)) {
    if (typeof paramValue !== 'number') continue

    if (key.startsWith('<')) {
      const threshold = parseInt(key.substring(1), 10)
      if (!isNaN(threshold)) {
        lessThanParams.push({ threshold, value: paramValue })
      }
    } else if (key.startsWith('>')) {
      const threshold = parseInt(key.substring(1), 10)
      if (!isNaN(threshold)) {
        greaterThanParams.push({ threshold, value: paramValue })
      }
    }
  }

  lessThanParams.sort((a, b) => b.threshold - a.threshold)
  greaterThanParams.sort((a, b) => a.threshold - b.threshold)

  for (const thresholdParam of lessThanParams) {
    if (zapAmountMsats < thresholdParam.threshold) {
      return thresholdParam.value
    }
  }

  for (const thresholdParam of greaterThanParams) {
    if (zapAmountMsats > thresholdParam.threshold) {
      return thresholdParam.value
    }
  }

  return defaultValue
}

function addZapAmount(
  totalsByActor: Map<actorId, Map<subjectId, number>>,
  actor: actorId,
  subject: subjectId,
  zapAmountMsats: number,
): boolean {
  let actorTotals = totalsByActor.get(actor)
  if (!actorTotals) {
    actorTotals = new Map()
    totalsByActor.set(actor, actorTotals)
  }

  const previousTotal = actorTotals.get(subject) || 0
  actorTotals.set(subject, previousTotal + zapAmountMsats)
  return previousTotal > 0
}

function buildInteractionsFromZapTotals(
  instance: NostrInterpreterClass<NostrInterpreterParams>,
  dos: number,
  totalsByActor: ZapTotalsByActorSubject,
  resolveValue: (totalMsats: number) => number,
): InteractionsMap {
  const confidence = instance.params.confidence as number || .5
  const interactions: InteractionsMap = new Map()

  totalsByActor.forEach((subjectTotals, actor) => {
    const actorInteractions = new Map<subjectId, InteractionData>()

    subjectTotals.forEach((totalMsats, subject) => {
      actorInteractions.set(subject, {
        confidence,
        value: resolveValue(totalMsats),
        dos,
      })
    })

    if (actorInteractions.size) {
      interactions.set(actor, actorInteractions)
    }
  })

  return interactions
}

function getEventActorResolvedPubkeys(
  instance: NostrInterpreterClass<NostrInterpreterParams>,
  dos: number,
  zapReceipt: NostrEvent,
): {
  eventActorIds: actorId[]
  eventAuthorPubkeys: subjectId[]
} {
  const eventActorIds = getActorsForEvent(instance, dos, zapReceipt, 'e', { requireBoundActors: true })
  if (!eventActorIds.length) {
    return { eventActorIds: [], eventAuthorPubkeys: [] }
  }

  const resolvedTypeValues = instance.getPovActorContext()?.eventActorResolvedTypeValues
  if (!resolvedTypeValues?.size) {
    return { eventActorIds, eventAuthorPubkeys: [] }
  }

  const eventAuthorPubkeys = new Set<subjectId>()
  for (const eventActorId of eventActorIds) {
    const resolvedValue = resolvedTypeValues.get(eventActorId)
    if (!resolvedValue) continue

    const candidates = Array.isArray(resolvedValue) ? resolvedValue : [resolvedValue]
    for (const candidate of candidates) {
      if (typeof candidate !== 'string' || !validatePubkey(candidate)) continue
      eventAuthorPubkeys.add(candidate)
    }
  }

  return {
    eventActorIds,
    eventAuthorPubkeys: [...eventAuthorPubkeys],
  }
}

export async function finalizeZapEventActorProjection(
  instance: NostrInterpreterClass<NostrInterpreterParams>,
  interactions: InteractionsList,
  pendingByDos: ZapEventActorSenderTotalsByDos,
): Promise<InteractionsMap | undefined> {
  // Finalization is one-shot per request execution. Consume staged totals
  // before projecting so repeated finalize calls are naturally idempotent.
  const pendingEntries = [...pendingByDos.entries()]
  pendingByDos.clear()
  instance.needsFinalization = false

  if (!pendingEntries.length) {
    return undefined
  }

  const resolvedTypeValues = instance.getPovActorContext()?.eventActorResolvedTypeValues
  if (!resolvedTypeValues?.size) {
    return undefined
  }

  const existingSubjects = new Set<subjectId>()
  for (const interaction of interactions) {
    existingSubjects.add(interaction.subject)
  }

  // Only emit projections onto subjects that already exist in the request's
  // interpreted graph, keeping event-actor projection bounded to prior outputs.
  if (!existingSubjects.size) {
    return undefined
  }

  const mergedSenderTotalsByEventActor: ZapEventActorSenderTotals = new Map()
  pendingEntries.forEach(([, totalsByEventActor]) => {
    totalsByEventActor.forEach((senderTotals, eventActorId) => {
      let mergedSenderTotals = mergedSenderTotalsByEventActor.get(eventActorId)
      if (!mergedSenderTotals) {
        mergedSenderTotals = new Map()
        mergedSenderTotalsByEventActor.set(eventActorId, mergedSenderTotals)
      }

      senderTotals.forEach((msats, senderPubkey) => {
        const priorTotal = mergedSenderTotals!.get(senderPubkey) || 0
        mergedSenderTotals!.set(senderPubkey, priorTotal + msats)
      })
    })
  })

  if (!mergedSenderTotalsByEventActor.size) {
    return undefined
  }

  const finalizedInteractions: InteractionsMap = new Map()
  const confidence = instance.params.confidence as number || .5
  const dosValues = pendingEntries.map(([dos]) => dos)
  const finalizedDos = dosValues.length ? Math.max(...dosValues) : undefined

  mergedSenderTotalsByEventActor.forEach((senderTotals, eventActorId) => {
    if (!senderTotals.size) return

    const resolvedValue = resolvedTypeValues.get(eventActorId)
    if (!resolvedValue) return

    const resolvedSubjects = (Array.isArray(resolvedValue) ? resolvedValue : [resolvedValue]).filter(
      (candidate): candidate is string => typeof candidate === 'string' && validatePubkey(candidate),
    )
    if (!resolvedSubjects.length) return

    let projectedValue = 0
    senderTotals.forEach((msats) => {
      projectedValue += resolveZapInteractionValue(instance.params, msats)
    })

    let actorInteractions = finalizedInteractions.get(eventActorId)
    if (!actorInteractions) {
      actorInteractions = new Map()
      finalizedInteractions.set(eventActorId, actorInteractions)
    }

    resolvedSubjects.forEach((resolvedSubject) => {
      if (!existingSubjects.has(resolvedSubject)) return

      actorInteractions!.set(resolvedSubject, {
        confidence,
        value: projectedValue,
        dos: finalizedDos,
      })
    })

    if (!actorInteractions.size) {
      finalizedInteractions.delete(eventActorId)
    }
  })

  return finalizedInteractions.size ? finalizedInteractions : undefined
}

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
  const actorType = instance.params.actorType
  console.log("GrapeRank : nostr interpreter : applyInteractionsByTag : actorType=", actorType, "allowedActorTypes=", instance.allowedActorTypes)
  // validate 
  if(!actorType || !instance.allowedActorTypes.includes(actorType)) {
    console.log("GrapeRank : nostr interpreter : applyInteractionsByTag : FAILED actorType validation")
    return undefined
  }
  const subjectType = tag || instance.params.subjectType
  console.log("GrapeRank : nostr interpreter : applyInteractionsByTag : subjectType=", subjectType, "allowedSubjectTypes=", instance.allowedSubjectTypes)
  if(!subjectType || !instance.allowedSubjectTypes.includes(subjectType)) {
    console.log("GrapeRank : nostr interpreter : applyInteractionsByTag : FAILED subjectType validation")
    return undefined
  }
  
  let fetchedIndex = dos - 1
  const fetchedSet = instance.fetched[fetchedIndex]
  console.log("GrapeRank : nostr interpreter : applyInteractionsByTag : processing", fetchedSet.size, "events")
  const newInteractionsMap : InteractionsMap = new Map()
  let eventindex : number = 0, 
    totalInteractions : number = 0, 
    duplicateInteractions : number = 0, 
    defaultValue = instance.params.value as number || 0,
    confidence = instance.params.confidence as number || .5
  
  for(let event of fetchedSet) {
    console.log("GrapeRank : nostr interpreter : applyInteractionsByTag : event", event.id.substring(0, 8), "kind", event.kind, "tags:", event.tags?.length || 0)
    const eventActors = getActorsForEvent(instance, dos, event, actorType)
    if(!eventActors.length) continue

    const eventInteractions = new Map<subjectId, InteractionData>()
    eventindex ++
    
    // DoS prevention: Skip events with excessive tags (potential attack vector)
    const MAX_TAGS_TO_PROCESS = 10000
    if(event.tags && event.tags.length < MAX_TAGS_TO_PROCESS){
      for(let t in event.tags){
        let value : number = defaultValue
        let tag = event.tags[t]
        let subject = getEventSubject(subjectType, event, tag, subjectIndex)
        if(!subject) continue
        
        if(eventInteractions.has(subject)) {
          duplicateInteractions ++
          continue
        }

        if(interactionIndex && tag[interactionIndex] 
          && typeof instance.params[tag[interactionIndex]] == 'number'){
          value = instance.params[tag[interactionIndex]] as number
        }

        eventInteractions.set(subject, {confidence, value, dos})
        }
      }
    // }else{
    //   console.log("GrapeRank : nostr interpreter : applyInteractionsByTag : event not processed")
    // }

    if (!eventInteractions.size) continue

    for (const eventActor of eventActors) {
      let actorInteractions = newInteractionsMap.get(eventActor)
      if(!actorInteractions) {
        actorInteractions = new Map<string, InteractionData>()
        newInteractionsMap.set(eventActor, actorInteractions)
      }

      eventInteractions.forEach((interactionData, subject) => {
        if(actorInteractions!.has(subject)) {
          duplicateInteractions ++
          return
        }

        actorInteractions!.set(subject, interactionData)
        totalInteractions ++
      })
    }
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
export async function applyZapInteractions(
  instance : NostrInterpreterClass<NostrInterpreterParams>,
  dos : number,
  options?: ApplyZapInteractionsOptions,
) : Promise<InteractionsMap | undefined> {
  console.log("GrapeRank : nostr interpreter : applyZapInteractions()")
  const actorType = instance.params.actorType
  if(!actorType || !instance.allowedActorTypes.includes(actorType)) 
    return undefined
  const subjectType = instance.params.subjectType
  if(!subjectType || !instance.allowedSubjectTypes.includes(subjectType)) 
    return undefined

  const pairMode = resolveZapPairMode(actorType, subjectType)
  if (!pairMode) {
    console.log(
      "GrapeRank : nostr interpreter : applyZapInteractions : skipped unsupported pair actorType=",
      actorType,
      "subjectType=",
      subjectType,
    )
    return new Map()
  }

  const eventActorMode = instance.getPovActorContext()?.actorMode === 'event'
  const resolveValue = (totalMsats: number) => resolveZapInteractionValue(instance.params, totalMsats)
  if ((pairMode === 'event-forward' || pairMode === 'event-reverse') && !eventActorMode) {
    console.log(
      "GrapeRank : nostr interpreter : applyZapInteractions : skipped event-directional pair outside event mode actorType=",
      actorType,
      "subjectType=",
      subjectType,
    )
    return new Map()
  }
  
  let fetchedIndex = dos - 1
  const fetchedSet = instance.fetched[fetchedIndex]
  const zapTotalsByActorSubject: ZapTotalsByActorSubject = new Map()
  const eventActorSenderTotals: ZapEventActorSenderTotals = new Map()
  let totalInteractions : number = 0
  let aggregatedInteractions : number = 0
  let skippedInvalid : number = 0

  for(let zapReceipt of fetchedSet) {
    const sender = resolveZapSenderPubkey(zapReceipt)
    if(!sender) {
      skippedInvalid++
      continue
    }

    const recipient = getEventSubject('p', zapReceipt)
    if ((pairMode === 'pubkey-forward' || pairMode === 'pubkey-reverse') && !recipient) {
      skippedInvalid++
      continue
    }

    const zapAmountMsats = parseZapAmountMsats(zapReceipt)
    let actors: actorId[] = []
    let subjects: subjectId[] = []

    if (pairMode === 'event-forward' || pairMode === 'event-reverse') {
      const { eventActorIds, eventAuthorPubkeys } = getEventActorResolvedPubkeys(instance, dos, zapReceipt)
      if (!eventActorIds.length || !eventAuthorPubkeys.length) {
        skippedInvalid++
        continue
      }

      if (pairMode === 'event-forward') {
        actors = [sender]
        subjects = eventAuthorPubkeys
        eventActorIds.forEach((eventActorId) => {
          addZapAmount(eventActorSenderTotals, eventActorId, sender, zapAmountMsats)
        })
      } else {
        actors = eventAuthorPubkeys
        subjects = [sender]
      }
    } else if (pairMode === 'pubkey-forward') {
      actors = [sender]
      subjects = recipient ? [recipient] : []
    } else {
      actors = recipient ? [recipient] : []
      subjects = [sender]
    }

    if(!actors.length || !subjects.length) {
      skippedInvalid++
      continue
    }

    for (const actor of actors) {
      for (const subject of subjects) {
        const alreadyAggregated = addZapAmount(zapTotalsByActorSubject, actor, subject, zapAmountMsats)
        if (alreadyAggregated) {
          aggregatedInteractions++
        } else {
          totalInteractions++
        }
      }
    }
  }

  if (pairMode === 'event-forward' && eventActorMode && options?.stageEventActorSenderTotals) {
    options.stageEventActorSenderTotals(dos, eventActorSenderTotals)
  }

  const newInteractionsMap = buildInteractionsFromZapTotals(instance, dos, zapTotalsByActorSubject, resolveValue)

  console.log("GrapeRank : nostr interpreter : applyZapInteractions : total interpreted ", totalInteractions, " new interactions, aggregated ", aggregatedInteractions, " repeated zaps and ", skippedInvalid, " invalid zap receipts")
  return newInteractionsMap
}


export async function applyAttestorRecommendationInteractions(
  instance : NostrInterpreterClass<NostrInterpreterParams>,
  dos : number
) : Promise<InteractionsMap | undefined> {
  console.log("GrapeRank : nostr interpreter : applyAttestorRecommendationInteractions()")
  const actorType = instance.params.actorType
  if(!actorType || !instance.allowedActorTypes.includes(actorType)) return undefined

  const fetchedIndex = dos - 1
  const fetchedSet = instance.fetched[fetchedIndex]
  const newInteractionsMap : InteractionsMap = new Map()

  const confidence = (instance.params.confidence as number) || .5
  const perKindValue = typeof instance.params.perKindValue === 'number'
    ? (instance.params.perKindValue as number)
    : ((instance.params.value as number) || 0)
  const maxKinds = typeof instance.params.maxKinds === 'number'
    ? Math.max(0, instance.params.maxKinds as number)
    : 1

  let totalInteractions = 0
  let skippedInvalid = 0
  let duplicateInteractions = 0

  for(const event of fetchedSet) {
    const actor = getEventActor(actorType, event)
    if(!actor) {
      skippedInvalid++
      continue
    }

    const kindCountRaw = event.tags.filter((t) => t[0] === 'k').length
    const kindCount = Math.min(kindCountRaw, maxKinds)
    const value = perKindValue * kindCount

    const subjects: string[] = []
    for(const tag of event.tags) {
      if(tag[0] !== 'p') continue
      const candidate = tag[1]
      if(candidate && validatePubkey(candidate)) subjects.push(candidate)
    }

    // Fallback: treat 'd' as pubkey if no valid p tags exist
    if(subjects.length === 0) {
      const d = getFirstTagValue(event, 'd')
      if(d && validatePubkey(d)) subjects.push(d)
    }

    if(subjects.length === 0) {
      skippedInvalid++
      continue
    }

    let actorInteractions = newInteractionsMap.get(actor)
    if(!actorInteractions) {
      actorInteractions = new Map<string, InteractionData>()
      newInteractionsMap.set(actor, actorInteractions)
    }

    for(const subject of subjects) {
      if(actorInteractions.has(subject)) {
        duplicateInteractions++
        continue
      }
      actorInteractions.set(subject, {confidence, value, dos})
      totalInteractions++
    }
  }

  console.log(
    "GrapeRank : nostr interpreter : applyAttestorRecommendationInteractions : total interpreted ",
    totalInteractions,
    " new interactions, skipped ",
    duplicateInteractions,
    " duplicates and ",
    skippedInvalid,
    " invalid recommendations"
  )

  return newInteractionsMap
}


export async function applyAttestationInteractions(
  instance : NostrInterpreterClass<NostrInterpreterParams>,
  dos : number
) : Promise<InteractionsMap | undefined> {
  console.log("GrapeRank : nostr interpreter : applyAttestationInteractions()")
  const actorType = instance.params.actorType
  if(!actorType || !instance.allowedActorTypes.includes(actorType)) return undefined

  const fetchedIndex = dos - 1
  const fetchedSet = instance.fetched[fetchedIndex]
  const newInteractionsMap : InteractionsMap = new Map()

  const confidence = (instance.params.confidence as number) || .5
  const valueValid = typeof instance.params.valueValid === 'number' ? (instance.params.valueValid as number) : (instance.params.value as number) || 0
  const valueInvalid = typeof instance.params.valueInvalid === 'number' ? (instance.params.valueInvalid as number) : 0

  const revokedD = new Set<string>()
  for(const event of fetchedSet) {
    const d = getFirstTagValue(event, 'd')
    if(!d) continue
    const state = getFirstTagValue(event, 's')
    if(state === 'revoked') revokedD.add(d)
  }

  let totalInteractions = 0
  let skippedInvalid = 0
  let skippedRevoked = 0
  let duplicateInteractions = 0

  for(const event of fetchedSet) {
    const d = getFirstTagValue(event, 'd')
    if(d && revokedD.has(d)) {
      skippedRevoked++
      continue
    }
    const state = getFirstTagValue(event, 's')
    if(state === 'revoked') {
      skippedRevoked++
      continue
    }

    const actor = getEventActor(actorType, event)
    if(!actor) {
      skippedInvalid++
      continue
    }
    const subject = getAttestationSubjectPubkey(event)
    if(!subject) {
      skippedInvalid++
      continue
    }

    const validity = getFirstTagValue(event, 'v')
    let value: number | undefined
    if(validity === 'valid') value = valueValid
    else if(validity === 'invalid') value = valueInvalid
    else {
      skippedInvalid++
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

    actorInteractions.set(subject, {confidence, value, dos})
    totalInteractions++
  }

  console.log(
    "GrapeRank : nostr interpreter : applyAttestationInteractions : total interpreted ",
    totalInteractions,
    " new interactions, skipped ",
    duplicateInteractions,
    " duplicates, skipped ",
    skippedRevoked,
    " revoked and ",
    skippedInvalid,
    " invalid attestations"
  )

  return newInteractionsMap
}
