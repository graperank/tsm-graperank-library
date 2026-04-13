import { NostrEvent, NostrFilter, SimplePool, npubEncode } from '../lib/nostr-tools'
import { NostrTagType, NostrType } from './types'
import { RankedPov, UnrankedPov } from '../graperank/types'


export const PubkeyTypes : NostrType[] = ["pubkey", "p", "P"]
export const EventTypes : NostrType[] = ["id", "e", "a"]

export const maxfetch = 500

/**
 * Adapted from NDK
 * @param filters 
 * @returns 
 */
export async function fetchEvents(
    filters: NostrFilter,
    relays: string[]
): Promise<Set<NostrEvent>> {
    // Add limit if not present (many relays require it)
    if (!filters.limit) {
        filters.limit = 1000;
    }
    console.log("fetchEvents called with relays:", relays, "relays length:", relays.length, "filters:", JSON.stringify(filters))
    
    // For kind 3 (replaceable), use direct WebSocket to bypass nostr-tools validation
    // which fails on large events (620+ tags)
    const isReplaceableKind = filters.kinds?.includes(3) || filters.kinds?.includes(0) || 
                               (filters.kinds?.some(k => k >= 10000 && k < 20000))
    
    if (isReplaceableKind) {
        console.log("fetchEvents using raw WebSocket for replaceable kind to bypass validation")
        return fetchEventsRaw(filters, relays)
    }
    
    return new Promise((resolve) => {
        const events: Map<string, NostrEvent> = new Map();
        let eoseReceived = false;
        let closed = false;

        const closeAndResolve = () => {
            if (closed) return;
            closed = true;
            console.log("fetchEvents closing with", events.size, "events")
            h.close()
            pool.close(relays)
            resolve(new Set(events.values()));
        };

        const onEvent = (event: NostrEvent) => {
            console.log("fetchEvents onEvent called, event kind:", event.kind, "id:", event.id.substring(0, 8))
            const dedupKey = deduplicationKey(event);

            const existingEvent = events.get(dedupKey);
            if (existingEvent) {
                event = dedupEvent(existingEvent, event);
            }

            events.set(dedupKey, event);
        };

        const pool = new SimplePool()

        let h = pool.subscribeMany(
          [...relays],filters,
          {
            onevent(event: NostrEvent) {
              console.log("fetchEvents onevent triggered for event:", event.id?.substring(0, 8), "kind:", event.kind)
              onEvent(event);
            },
            oneose() {
              if (!eoseReceived) {
                console.log("fetchEvents first EOSE received, waiting 2s for other relays...")
                eoseReceived = true;
                
                // Wait 2 more seconds for other relays to respond after first EOSE
                setTimeout(() => {
                  closeAndResolve();
                }, 2000);
              }
            },
            onclose(reasons: string[]) {
              console.log("fetchEvents subscription closed by relay, reasons:", reasons)
            }
          }
        )

        // Absolute timeout: close after 12 seconds even if no EOSE received
        setTimeout(() => {
            if (!closed) {
                console.log("fetchEvents absolute timeout reached, closing with", events.size, "events")
                closeAndResolve();
            }
        }, 12000);
    });
}

// Raw WebSocket implementation that bypasses nostr-tools validation
// Used for replaceable events (kind 0, 3, 10k-20k) that may be large
async function fetchEventsRaw(
    filters: NostrFilter,
    relays: string[]
): Promise<Set<NostrEvent>> {
    const WebSocket = (await import('ws')).default
    const events: Map<string, NostrEvent> = new Map()
    let eoseCount = 0
    let closed = false

    return new Promise((resolve) => {
        const connections: any[] = []
        const subscriptionId = Math.random().toString(36).substring(7)

        const closeAll = () => {
            if (closed) return
            closed = true
            console.log("fetchEventsRaw closing with", events.size, "events from", eoseCount, "relays")
            connections.forEach(ws => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify(['CLOSE', subscriptionId]))
                    ws.close()
                }
            })
            resolve(new Set(events.values()))
        }

        relays.forEach((relay) => {
            try {
                const ws = new WebSocket(relay)
                connections.push(ws)

                ws.on('open', () => {
                    console.log(`fetchEventsRaw connected to ${relay}, sending filter:`, JSON.stringify(filters))
                    ws.send(JSON.stringify(['REQ', subscriptionId, filters]))
                })

                ws.on('message', (data: Buffer) => {
                    try {
                        const msg = JSON.parse(data.toString())
                        
                        if (msg[0] === 'EVENT' && msg[1] === subscriptionId) {
                            const event = msg[2] as NostrEvent
                            console.log("fetchEventsRaw received event:", event.id?.substring(0, 8), "kind:", event.kind, "from:", relay)
                            
                            const dedupKey = deduplicationKey(event)
                            const existingEvent = events.get(dedupKey)
                            if (existingEvent) {
                                events.set(dedupKey, dedupEvent(existingEvent, event))
                            } else {
                                events.set(dedupKey, event)
                            }
                        } else if (msg[0] === 'EOSE' && msg[1] === subscriptionId) {
                            console.log("fetchEventsRaw EOSE from:", relay)
                            eoseCount++
                            if (eoseCount === 1) {
                                // Wait 2s after first EOSE for other relays
                                setTimeout(() => closeAll(), 2000)
                            } else if (eoseCount >= relays.length) {
                                closeAll()
                            }
                        }
                    } catch (err) {
                        console.error("fetchEventsRaw error parsing message:", err)
                    }
                })

                ws.on('error', (err: Error) => {
                    console.error("fetchEventsRaw WebSocket error for", relay, ":", err.message)
                })

                ws.on('close', (code: number, reason: Buffer) => {
                    console.log(`fetchEventsRaw connection closed to ${relay}, code: ${code}, reason: ${reason.toString()}`)
                })
            } catch (err) {
                console.error("fetchEventsRaw failed to connect to", relay, ":", err)
            }
        })

        // Absolute timeout
        setTimeout(() => {
            if (!closed) {
                console.log("fetchEventsRaw timeout reached")
                closeAll()
            }
        }, 12000)
    })
}

function dedupEvent(event1: NostrEvent, event2: NostrEvent) {
  // return the newest of the two
  if (event1.created_at! > event2.created_at!) {
      return event1;
  }
  return event2;
}

/**
 * Provides a deduplication key for the event.
 *
 * For kinds 0, 3, 10k-20k this will be the event <kind>:<pubkey>
 * For kinds 30k-40k this will be the event <kind>:<pubkey>:<d-tag>
 * For all other kinds this will be the event id
 */
function deduplicationKey(event: NostrEvent): string {
  if (
      event.kind === 0 ||
      event.kind === 3 ||
      (event.kind >= 10000 && event.kind < 20000)
  ) {
      return `${event.kind}:${event.pubkey}`;
  } else if (event.kind >= 30000 && event.kind < 40000) {
      const dTag = event.tags.find(tag => tag[0] === 'd')?.[1] || '';
      return `${event.kind}:${event.pubkey}:${dTag}`;
  } else {
      return event.id;
  }
}

// Helper function to slice big arrays
export function sliceBigArray<T>(array: T[], chunkSize: number): T[][] {
  const result: T[][] = []
  for (let i = 0; i < array.length; i += chunkSize) {
    result.push(array.slice(i, i + chunkSize))
  }
  return result
}

// Actors are always EITHER event types or pubkey types
export function getEventActor(actorType : NostrType, event : NostrEvent) : string | undefined {
  if(!actorType || (!PubkeyTypes.includes(actorType) && !EventTypes.includes(actorType))) return
  return getEventSubject(actorType, event)
}

// Subject may be any valid event field or tag
export function getEventSubject(subjectType : NostrType, event : NostrEvent, tag? : string[], tagIndex = 1) : string | undefined {
  let subject : string | undefined
  if(subjectType == "pubkey") subject = event.pubkey
  if(subjectType == "id") subject = event.id
  if(!subject && tag && tag[0] == subjectType) subject = tag[tagIndex]
  if(!subject){
    // matches the first matching tag value
    subject = event.tags.find(tag => tag[0] == subjectType)?.[tagIndex]
  }
  if(!validateNostrTypeValue(subjectType, subject)) return undefined
  return subject
}


export function validateNostrTypeValue(type: NostrType, value?: string): boolean {
  if(!value) return false
  if (PubkeyTypes.includes(type)) {
    return validatePubkey(value)
  }
  return true
}


export function validatePubkey(pubkey : string){
  try{
    npubEncode(pubkey)
  }catch(e){
    return false
  }
  return true
}

  // Helper to convert all POV formats to RankedPov format
  export function normalizePov(pov: RankedPov | UnrankedPov): RankedPov {
    if (typeof pov === 'string') {
      return [[pov]]
    } else if (Array.isArray(pov)) {
      if (pov.length === 0) {
        return []
      } else if (Array.isArray(pov[0])) {
        // RankedPov format: [[actorId, rank], ...]
        return pov as RankedPov
      } else {
        // UnrankedPov array format: [actorId, ...]
        return pov.map(actorId => [actorId]) as RankedPov
      }
    }
    return []
  }
