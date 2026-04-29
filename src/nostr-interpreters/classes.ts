import { NostrEvent, NostrFilter, npubEncode, decode, SimplePool, useWebSocketImplementation } from '../lib/nostr-tools'
import { RankedPov, subjectId, Interpreter, InterpreterRequest, InteractionsMap, actorId, InterpreterInitializer, InterpreterParams, InterpreterId, InteractionData, povType, InterpreterFetchProgress, InterpreterFetchProgressCallback, InteractionsList } from "../graperank/types"
import { EventActorReference, EventActorBindings, PovActorContext } from '../graperank/nostr-types'
import { EventReferenceTarget, EventReferenceTypes, NostrEventField, NostrEventFields, NostrInterpreterClassConfig, NostrInterpreterId, NostrInterpreterKeys, NostrInterpreterParams, NostrType } from "./types"
import { applyInteractionsByTag } from "./callbacks"
import { buildEventActorId, decodeEventReference, deriveActorIdsFromRankedPov, extractDTagValue, extractPaginationDTags, extractReferenceTags, fetchEvents, hasEventReferenceTags, isEventType, isPubkeyType, isRelayUrl, maxfetch, mergeRelayLists, normalizeEventActorReference, parseCoordinate, parseEventActorId, parseReferenceRank, sliceBigArray, sleep, validateNostrTypeValue } from "./helpers"
import WebSocket from 'ws'
import { InterpreterFactory } from '../graperank/interpretation'
useWebSocketImplementation(WebSocket)

const delaybetweenfetches = 500 // milliceconds
const fetchRetryAttempts = 3
const fetchRetryBackoffMs = 250
const eventActorFetchConcurrency = 20
const eventActorProgressActorsStep = 50
const eventActorProgressIntervalMs = 5000
const eventActorReferenceBatchSize = maxfetch
const eventIdField: NostrEventField = NostrEventFields[0]
const eventIdReferenceType = EventReferenceTypes[0]
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

  private static _relays: string[] = []
  static get relays() {
    return this._relays
  }
  static set relays(relays: string[]) {
    this._relays = relays
  }


  // Nostr interpreters are identified by kind number and tag type
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
  needsFinalization = false
  private povActorContext?: PovActorContext
  private eventActorBindingsByDos: EventActorBindings[] = []
  interpret : (dos? : number) => Promise<InteractionsMap | undefined>
  // Optional interpreter-specific post-processing hook.
  // Concrete interpreters decide when this should be enabled.
  finalize? : (interactions: InteractionsList) => Promise<InteractionsMap | undefined>
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

    if (config.finalize) {
      // Keep class-level finalization generic by delegating implementation
      // details to the interpreter factory configuration.
      this.finalize = async (interactions: InteractionsList) => {
        return await config.finalize!(this, interactions)
      }
    }
  }

  private addRankedActor(rankedActorMap: Map<actorId, number | undefined>, actor: actorId, rank?: number): void {
    if (!rankedActorMap.has(actor)) {
      rankedActorMap.set(actor, rank)
      return
    }

    const currentRank = rankedActorMap.get(actor)
    if (currentRank === undefined && rank !== undefined) {
      rankedActorMap.set(actor, rank)
    }
  }

  private isAllowedType(requestedType: NostrType): boolean {
    const allowedTypes = [...this.allowedActorTypes, ...this.allowedSubjectTypes] as NostrType[]
    if (allowedTypes.includes(requestedType)) {
      return true
    }

    if (isPubkeyType(requestedType) && allowedTypes.some((allowedType) => isPubkeyType(allowedType))) {
      return true
    }

    if (isEventType(requestedType) && allowedTypes.some((allowedType) => isEventType(allowedType))) {
      return true
    }

    return false
  }

  private async fetchEventsWithRetry(filter: NostrFilter, relays: string[]): Promise<Set<NostrEvent>> {
    if (!relays.length) {
      return new Set()
    }

    for (let attempt = 1; attempt <= fetchRetryAttempts; attempt++) {
      try {
        const fetchedEvents = await fetchEvents(filter, relays)
        if (fetchedEvents.size > 0) return fetchedEvents
      } catch {
        // MVP behavior: relay fetch failures are retried and then skipped silently.
      }

      if (attempt < fetchRetryAttempts) {
        await sleep(fetchRetryBackoffMs * attempt)
      }
    }

    return new Set()
  }

  private async resolvePaginatedAddressableEvents(
    rootEvents: Set<NostrEvent>,
    kind: number,
    pubkey: string,
    relays: string[],
  ): Promise<Set<NostrEvent>> {
    const allEvents = new Map<string, NostrEvent>()
    const discoveredDTags = new Set<string>()
    const pendingDTags = new Set<string>()

    for (const rootEvent of rootEvents) {
      allEvents.set(rootEvent.id, rootEvent)
      const dTagValue = extractDTagValue(rootEvent)
      if (dTagValue) discoveredDTags.add(dTagValue)
    }

    for (const event of allEvents.values()) {
      const paginationDTags = extractPaginationDTags(event)
      for (const dTagValue of paginationDTags) {
        if (!discoveredDTags.has(dTagValue)) pendingDTags.add(dTagValue)
      }
    }

    while (pendingDTags.size > 0) {
      const nextBatch = [...pendingDTags]
      pendingDTags.clear()
      nextBatch.forEach(dTag => discoveredDTags.add(dTag))

      const filter: NostrFilter = {
        kinds: [kind],
        authors: [pubkey],
        '#d': nextBatch,
      }

      const pageEvents = await this.fetchEventsWithRetry(filter, relays)
      for (const pageEvent of pageEvents) {
        allEvents.set(pageEvent.id, pageEvent)

        const dTagValue = extractDTagValue(pageEvent)
        if (dTagValue) discoveredDTags.add(dTagValue)

        const nestedDTags = extractPaginationDTags(pageEvent)
        for (const nestedDTag of nestedDTags) {
          if (!discoveredDTags.has(nestedDTag)) {
            pendingDTags.add(nestedDTag)
          }
        }
      }
    }

    return new Set(allEvents.values())
  }

  private extractActorsFromEvents(events: Set<NostrEvent>, requestedType: NostrType): Set<actorId> {
    const extracted = new Set<actorId>()

    for (const event of events) {
      if (requestedType === 'pubkey') {
        if (validateNostrTypeValue('pubkey', event.pubkey)) {
          extracted.add(event.pubkey)
        }
        continue
      }

      if (requestedType === 'id') {
        extracted.add(event.id)
        continue
      }

      if (requestedType === 'kind') {
        extracted.add(String(event.kind))
        continue
      }

      for (const tag of event.tags) {
        if (tag[0] === requestedType && tag[1] && validateNostrTypeValue(requestedType, tag[1])) {
          extracted.add(tag[1])
        }
      }
    }

    return extracted
  }

  private collectReferenceTargets(events: Set<NostrEvent>): EventReferenceTarget[] {
    const targets: EventReferenceTarget[] = []

    for (const event of events) {
      for (const tag of event.tags) {
        const tagName = tag[0] as NostrType
        if ((!isEventType(tagName) || tagName === eventIdField) || !tag[1]) continue

        const decodedReference = decodeEventReference(tag[1])
        if (!decodedReference) continue

        const relayHintsFromTag = tag.slice(2).filter(value => typeof value === 'string' && isRelayUrl(value))
        targets.push({
          ...decodedReference,
          relayHints: mergeRelayLists(decodedReference.relayHints, relayHintsFromTag),
        })
      }
    }

    return targets
  }

  private async fetchReferencedEvents(
    sourceEvents: Set<NostrEvent>,
    fallbackRelays: string[],
  ): Promise<Map<string, NostrEvent>> {
    const referencedEvents = new Map<string, NostrEvent>()
    const referenceTargets = this.collectReferenceTargets(sourceEvents)

    for (const target of referenceTargets) {
      const targetRelays = mergeRelayLists(target.relayHints, fallbackRelays)
      if (!targetRelays.length) continue

      let filter: NostrFilter | undefined
      if (target.referenceType === eventIdReferenceType) {
        filter = { ids: [target.value] }
      } else {
        const coordinate = parseCoordinate(target.value)
        if (!coordinate) continue
        filter = {
          kinds: [coordinate.kind],
          authors: [coordinate.pubkey],
          '#d': [coordinate.identifier],
        }
      }

      const fetched = await this.fetchEventsWithRetry(filter, targetRelays)
      for (const event of fetched) {
        referencedEvents.set(event.id, event)
      }
    }

    return referencedEvents
  }

  private async resolveActorsFromReferences(
    sourceEvents: Set<NostrEvent>,
    requestedType: NostrType,
    fallbackRelays: string[],
  ): Promise<Set<actorId>> {
    const referencedEvents = await this.fetchReferencedEvents(sourceEvents, fallbackRelays)
    return this.extractActorsFromEvents(new Set(referencedEvents.values()), requestedType)
  }

  private mergeResolvedTypeValue(
    targetMap: Map<actorId, string | string[]>,
    actor: actorId,
    resolvedValue: string | string[],
  ): void {
    const nextValues = Array.isArray(resolvedValue) ? resolvedValue : [resolvedValue]
    const existing = targetMap.get(actor)
    const existingValues = existing === undefined
      ? []
      : (Array.isArray(existing) ? existing : [existing])
    const mergedValues = [...new Set([...existingValues, ...nextValues])]

    if (!mergedValues.length) return

    targetMap.set(actor, mergedValues.length === 1 ? mergedValues[0] : mergedValues)
  }

  private async resolveEventActorTypeValues(
    eventActorReferenceMap: Map<actorId, EventActorReference>,
    requestedType: NostrType,
    fallbackRelays: string[],
  ): Promise<Map<actorId, string | string[]>> {
    const resolvedTypeValues = new Map<actorId, string | string[]>()
    // Group event-id references by relay set so we can batch-fetch ids instead of
    // issuing one relay request per referenced event actor.
    const eventIdReferencesByRelayKey = new Map<string, {
      relays: string[]
      actorIdsByEventId: Map<string, actorId[]>
    }>()
    // Address references keep per-reference filters because kind/author/d must stay paired.
    const addressReferences: Array<{ eventActorId: actorId; eventActorReference: EventActorReference; relays: string[] }> = []

    for (const [eventActorId, eventActorReference] of eventActorReferenceMap.entries()) {
      const relays = mergeRelayLists(eventActorReference.relayHints, fallbackRelays)
      if (!relays.length) continue

      if (eventActorReference.referenceType === eventIdReferenceType) {
        const relayKey = relays.join('|')
        const normalizedEventId = eventActorReference.value.toLowerCase()
        let relayGroup = eventIdReferencesByRelayKey.get(relayKey)

        if (!relayGroup) {
          relayGroup = {
            relays,
            actorIdsByEventId: new Map<string, actorId[]>(),
          }
          eventIdReferencesByRelayKey.set(relayKey, relayGroup)
        }

        const actorIds = relayGroup.actorIdsByEventId.get(normalizedEventId) || []
        actorIds.push(eventActorId)
        relayGroup.actorIdsByEventId.set(normalizedEventId, actorIds)
        continue
      }

      addressReferences.push({ eventActorId, eventActorReference, relays })
    }

    // Resolve event-id references in batches, preserving relay scoping and actor bindings.
    for (const relayGroup of eventIdReferencesByRelayKey.values()) {
      const eventIds = [...relayGroup.actorIdsByEventId.keys()]
      const eventIdChunks = eventIds.length > eventActorReferenceBatchSize
        ? sliceBigArray(eventIds, eventActorReferenceBatchSize)
        : [eventIds]

      for (const eventIdChunk of eventIdChunks) {
        const referencedEvents = await this.fetchEventsWithRetry({ ids: eventIdChunk }, relayGroup.relays)

        for (const referencedEvent of referencedEvents) {
          const actorIds = relayGroup.actorIdsByEventId.get(referencedEvent.id.toLowerCase())
          if (!actorIds?.length) continue

          const extractedTypeValues = [...this.extractActorsFromEvents(new Set([referencedEvent]), requestedType)]
          if (!extractedTypeValues.length) continue

          const resolvedValue: string | string[] = extractedTypeValues.length === 1
            ? extractedTypeValues[0]
            : extractedTypeValues

          for (const actorIdForReference of actorIds) {
            this.mergeResolvedTypeValue(resolvedTypeValues, actorIdForReference, resolvedValue)
          }
        }
      }
    }

    // Resolve address references with strict coordinate filters.
    for (const { eventActorId, eventActorReference, relays } of addressReferences) {
      let filter: NostrFilter | undefined

      const coordinate = parseCoordinate(eventActorReference.value)
      if (!coordinate) continue
      filter = {
        kinds: [coordinate.kind],
        authors: [coordinate.pubkey],
        '#d': [coordinate.identifier],
      }

      const referencedEvents = await this.fetchEventsWithRetry(filter, relays)
      const extractedTypeValues = [...this.extractActorsFromEvents(referencedEvents, requestedType)]
      if (!extractedTypeValues.length) continue

      this.mergeResolvedTypeValue(
        resolvedTypeValues,
        eventActorId,
        extractedTypeValues.length === 1 ? extractedTypeValues[0] : extractedTypeValues,
      )
    }

    return resolvedTypeValues
  }

  private buildEventActorContext(sourceEvents: Set<NostrEvent>): {
    rankedPov: RankedPov
    eventActorReferenceMap: Map<actorId, EventActorReference>
  } | undefined {
    const rankedActorMap = new Map<actorId, number | undefined>()
    const eventActorReferenceMap = new Map<actorId, EventActorReference>()

    for (const { sourceEvent, tag } of extractReferenceTags(sourceEvents)) {
      const decodedReference = decodeEventReference(tag[1])
      if (!decodedReference) continue

      const relayHintsFromTag = tag.slice(2).filter(value => typeof value === 'string' && isRelayUrl(value))
      const normalizedEventActorReference = normalizeEventActorReference({
        ...decodedReference,
        relayHints: mergeRelayLists(decodedReference.relayHints, relayHintsFromTag),
      })
      if (!normalizedEventActorReference) continue

      const eventActorId = buildEventActorId(normalizedEventActorReference)
      if (!eventActorId) continue

      eventActorReferenceMap.set(eventActorId, normalizedEventActorReference)
      this.addRankedActor(rankedActorMap, eventActorId, parseReferenceRank(sourceEvent, tag))
    }

    if (!rankedActorMap.size) return undefined

    return {
      rankedPov: [...rankedActorMap.entries()],
      eventActorReferenceMap,
    }
  }

  getPovActorContext(): PovActorContext | undefined {
    return this.povActorContext
  }

  setPovActorContext(context?: PovActorContext): void {
    this.povActorContext = context
    this.eventActorBindingsByDos = []
    // A new POV context starts a new interpretation lifecycle.
    // Any pending finalization state from previous context is invalid.
    this.needsFinalization = false
  }

  getEventActorBindings(dos: number): EventActorBindings | undefined {
    if (dos < 1) return undefined
    return this.eventActorBindingsByDos[dos - 1]
  }

  async resolvePovContext(type?: povType, pov?: string | string[]): Promise<PovActorContext | undefined> {
    if (!type || !pov) {
      return this.povActorContext
    }

    const requestedType = type as NostrType

    if (!this.isAllowedType(requestedType)) {
      throw new Error(`GrapeRank : ${this.interpreterId} : resolvePovContext : type '${type}' not allowed`)
    }

    const rankedActorMap = new Map<actorId, number | undefined>()
    const eventActorReferenceMap = new Map<actorId, EventActorReference>()
    const eventActorResolvedTypeValues = new Map<actorId, string | string[]>()
    let actorMode: 'pubkey' | 'event' = 'pubkey'
    const povArray = Array.isArray(pov) ? pov : [pov]

    for(const povItem of povArray) {
      try {
        if(povItem.startsWith('naddr')) {
          const decoded = decode(povItem)
          if(decoded.type !== 'naddr') continue

          const { kind, pubkey, identifier } = decoded.data
          const naddrRelays = Array.isArray(decoded.data.relays)
            ? decoded.data.relays.filter((relay): relay is string => typeof relay === 'string')
            : []
          const relays = mergeRelayLists(naddrRelays, NostrInterpreterClass.relays)

          const filter: NostrFilter = {
            kinds: [kind],
            authors: [pubkey],
            '#d': identifier ? [identifier] : undefined,
          }

          const rootEvents = await this.fetchEventsWithRetry(filter, relays)
          const sourceEvents = await this.resolvePaginatedAddressableEvents(rootEvents, kind, pubkey, relays)
          const sourceHasReferenceTags = hasEventReferenceTags(sourceEvents)
          // use EventActor mode ...
          // if requested `pov` value is a naddr,
          // and if resolved pov event(s) have event reference tags,
          // and if requested `type` value is NOT an event reference type,
          // and if resolved pov event(s) do NOT have tags of the requested `type`,
          // then requested `type` should be assumed to refer to 
          // a tag within the event(s) referenced by the resolved pov event(s).
          // This will be the reference resolved pov value.
          const shouldUseEventActors = !isEventType(requestedType) && sourceHasReferenceTags

          if (shouldUseEventActors) {
            const eventActorContext = this.buildEventActorContext(sourceEvents)
            if (eventActorContext) {
              actorMode = 'event'
              eventActorContext.rankedPov.forEach(([rankedActorId, rank]) => this.addRankedActor(rankedActorMap, rankedActorId, rank))
              eventActorContext.eventActorReferenceMap?.forEach((eventActorReference, rankedActorId) => {
                if (!eventActorReferenceMap.has(rankedActorId)) {
                  eventActorReferenceMap.set(rankedActorId, eventActorReference)
                }
              })

              const resolvedTypeValues = await this.resolveEventActorTypeValues(
                eventActorContext.eventActorReferenceMap,
                requestedType,
                relays,
              )
              resolvedTypeValues.forEach((resolvedValue, rankedActorId) => {
                this.mergeResolvedTypeValue(eventActorResolvedTypeValues, rankedActorId, resolvedValue)
              })
            }
            continue
          }

          const typeIsEventField = NostrEventFields.includes(requestedType as NostrEventField)
          const shouldResolveFromReferences = typeIsEventField || (!isEventType(requestedType) && sourceHasReferenceTags)
          const resolvedActors = shouldResolveFromReferences
            ? await this.resolveActorsFromReferences(sourceEvents, requestedType, relays)
            : this.extractActorsFromEvents(sourceEvents, requestedType)
          resolvedActors.forEach((resolvedActor) => this.addRankedActor(rankedActorMap, resolvedActor))
          continue
        }

        if (isPubkeyType(requestedType)) {
          if(povItem.startsWith('npub')) {
            const decoded = decode(povItem)
            if(decoded.type === 'npub') {
              this.addRankedActor(rankedActorMap, decoded.data as string)
            }
          } else {
            this.addRankedActor(rankedActorMap, povItem)
          }
        } else {
          this.addRankedActor(rankedActorMap, povItem)
        }
      } catch(e) {
        console.log(`GrapeRank : ${this.interpreterId} : resolvePovContext : failed to parse POV item '${povItem}':`, e)
      }
    }

    const rankedPov: RankedPov = [...rankedActorMap.entries()]
    const effectiveActorMode: 'pubkey' | 'event' = actorMode === 'event' && rankedPov.length > 0
      ? 'event'
      : 'pubkey'

    const context: PovActorContext = {
      actorMode: effectiveActorMode,
      povType: requestedType,
      rankedPov,
      eventActorReferenceMap: effectiveActorMode === 'event' && eventActorReferenceMap.size ? eventActorReferenceMap : undefined,
      eventActorResolvedTypeValues: effectiveActorMode === 'event' && eventActorResolvedTypeValues.size
        ? eventActorResolvedTypeValues
        : undefined,
    }

    this.povActorContext = context
    return context
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
      const requestedType = type as NostrType

      if (!this.isAllowedType(requestedType)) {
        throw new Error(`GrapeRank : ${this.interpreterId} : resolveActors : type '${type}' not allowed`)
      }

      const povArray = Array.isArray(pov) ? pov : [pov]
      
      for(const povItem of povArray) {
        try {
          if(povItem.startsWith('naddr')) {
            const decoded = decode(povItem)
            if(decoded.type === 'naddr') {
              const { kind, pubkey, identifier } = decoded.data
              const naddrRelays = Array.isArray(decoded.data.relays)
                ? decoded.data.relays.filter((relay): relay is string => typeof relay === 'string')
                : []
              const relays = mergeRelayLists(naddrRelays, NostrInterpreterClass.relays)

              const filter: NostrFilter = {
                kinds: [kind],
                authors: [pubkey],
                '#d': identifier ? [identifier] : undefined
              }

              const rootEvents = await this.fetchEventsWithRetry(filter, relays)
              const sourceEvents = await this.resolvePaginatedAddressableEvents(rootEvents, kind, pubkey, relays)
              const typeIsEventField = NostrEventFields.includes(requestedType as NostrEventField)
              const sourceHasReferenceTags = hasEventReferenceTags(sourceEvents)
              const shouldResolveFromReferences = typeIsEventField || (!isEventType(requestedType) && sourceHasReferenceTags)

              if (shouldResolveFromReferences) {
                const referencedActors = await this.resolveActorsFromReferences(sourceEvents, requestedType, relays)
                referencedActors.forEach(actor => actors.add(actor))
              } else {
                const directActors = this.extractActorsFromEvents(sourceEvents, requestedType)
                directActors.forEach(actor => actors.add(actor))
              }
            }
          } else if (isPubkeyType(requestedType)) {
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
      if (this.povActorContext?.actorMode === 'event') {
        return deriveActorIdsFromRankedPov(this.povActorContext.rankedPov)
      }

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

  private buildEventActorReferenceFetchFilters(eventActorReference: EventActorReference): NostrFilter[] {
    const baseFilter: NostrFilter = {
      ...this.request?.filter,
      kinds: this.fetchKinds,
    }

    if (eventActorReference.referenceType === eventIdReferenceType) {
      return [
        { ...baseFilter, '#e': [eventActorReference.value] },
        { ...baseFilter, '#q': [eventActorReference.value] },
      ]
    }

    return [{ ...baseFilter, '#a': [eventActorReference.value] }]
  }

  private async fetchDataByEventActors(
    actors: Set<actorId>,
    onFetchProgress?: InterpreterFetchProgressCallback,
  ): Promise<number> {
    const fetchedSet: Set<NostrEvent> = new Set()
    const eventActorBindings: EventActorBindings = new Map()
    const eventActorIds = [...actors]
    const totalActors = eventActorIds.length
    const fetchStartMs = Date.now()
    let processedActors = 0
    let lastProgressUpdateMs = 0
    let progressUpdateChain: Promise<void> = Promise.resolve()

    const queueProgressUpdate = (force = false): void => {
      if (!onFetchProgress || !totalActors) return

      const now = Date.now()
      const reachedActorStep = processedActors % eventActorProgressActorsStep === 0
      const reachedInterval = now - lastProgressUpdateMs >= eventActorProgressIntervalMs
      const fetchComplete = processedActors >= totalActors

      if (!force && !fetchComplete && !reachedActorStep && !reachedInterval) {
        return
      }

      lastProgressUpdateMs = now

      const fetchProgress: InterpreterFetchProgress = {
        processedActors,
        totalActors,
        fetchedEvents: fetchedSet.size,
        elapsedMs: now - fetchStartMs,
      }

      progressUpdateChain = progressUpdateChain
        .then(() => Promise.resolve(onFetchProgress(fetchProgress)))
        .catch((error) => {
          console.log(`GrapeRank : ${this.interpreterId} : fetchDataByEventActors : progress callback failed`, error)
        })
    }

    if (eventActorIds.length === 0) {
      const dos = this.fetched.push(fetchedSet)
      this.eventActorBindingsByDos[dos - 1] = eventActorBindings
      return dos
    }

    queueProgressUpdate(true)

    const workerCount = Math.min(eventActorFetchConcurrency, eventActorIds.length)
    const workerPromises: Promise<void>[] = []

    for (let workerIndex = 0; workerIndex < workerCount; workerIndex++) {
      workerPromises.push((async () => {
        for (let eventActorIndex = workerIndex; eventActorIndex < eventActorIds.length; eventActorIndex += workerCount) {
          try {
            const eventActorId = eventActorIds[eventActorIndex]
            const eventActorReference = this.povActorContext?.eventActorReferenceMap?.get(eventActorId) || parseEventActorId(eventActorId)
            if (!eventActorReference) continue

            const relays = mergeRelayLists(eventActorReference.relayHints, NostrInterpreterClass.relays)
            if (!relays.length) continue

            const eventActorReferenceFilters = this.buildEventActorReferenceFetchFilters(eventActorReference)

            await sleep(delaybetweenfetches)
            const fetchedEventSets = await Promise.all(
              eventActorReferenceFilters.map((filter) => this.fetchEventsWithRetry(filter, relays))
            )

            for (const fetchedEvents of fetchedEventSets) {
              for (const event of fetchedEvents) {
                fetchedSet.add(event)

                let bindings = eventActorBindings.get(event.id)
                if (!bindings) {
                  bindings = new Set<actorId>()
                  eventActorBindings.set(event.id, bindings)
                }

                bindings.add(eventActorId)
              }
            }
          } finally {
            processedActors += 1
            queueProgressUpdate()
          }
        }
      })())
    }

    await Promise.all(workerPromises)
    queueProgressUpdate(true)
    await progressUpdateChain

    const dos = this.fetched.push(fetchedSet)
    this.eventActorBindingsByDos[dos - 1] = eventActorBindings
    return dos
  }

  // breaks up a large actors list into multiple actors lists 
  // suitable for relay requests, and sends them all in parallel
  // returns a single promise that is resolved when all fetches are complete.
  async fetchData(
    actors? : Set<actorId>,
    onFetchProgress?: InterpreterFetchProgressCallback,
  ) : Promise<number> {
    // get actors from request if not provided
    if(!this.request) throw('no request set for this interpreter')
    actors = actors || new Set(this.request?.actors)

    if (this.povActorContext?.actorMode === 'event') {
      return this.fetchDataByEventActors(actors, onFetchProgress)
    }
    

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
  private async fetchEventsPromise(filter: NostrFilter, fetchedSet : Set<NostrEvent>, iteration : number = 0) : Promise<void> {
    if(!filter.authors || !filter.authors.length)
      return new Promise((resolve,reject)=> reject("No authors provided"))
    const relays = NostrInterpreterClass.relays
    console.log("GrapeRank : nostr interpreter : fetching events in request ",iteration, " for ",filter.authors?.length, " actors from relays:", relays, "relays length:", relays.length, "relays JSON:", JSON.stringify(relays))
    return new Promise((resolve)=>{
      fetchEvents(filter, NostrInterpreterClass.relays).then(async (newFetchedSet)=>{
        let validation = this.validate ? this.validate(newFetchedSet, filter.authors, fetchedSet) : true
        try{

          // FALSE validation will log error
          // if(validation === false ) {
          //   throw('events validaiton failed')
          // }

          // TRUE validation will add events to fetchedSet
          if(validation === true){ 
            // fetchedSet = new Set([...fetchedSet, ...newFetchedSet])
            newFetchedSet.forEach((event)=>{ fetchedSet.add(event) })
            console.log("GrapeRank : nostr interpreter : fetch request ",iteration," complete : fetched ", newFetchedSet.size, " new events, for total of ", fetchedSet.size)
          } else if (Array.isArray(validation)) {
            // validation returned array of authors to retry with
            console.log("GrapeRank : nostr interpreter : fetch request ",iteration," : requesting again with reduced authors")
            await this.fetchEventsPromise(
              {...filter, authors : validation}, fetchedSet,
              iteration )
          }

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

function parseNostrInterpreterID(id: NostrInterpreterId): NostrInterpreterKeys {
  const split = id.split('-')
  const kind = Number(split[1])
  const type = split[2] as NostrType
  return { kind, type }
}

function constructNostrInterpreterID(key: NostrInterpreterKeys): NostrInterpreterId {
  return `nostr-${key.kind}${key.type ? `-${key.type}` : ''}` as NostrInterpreterId
}
