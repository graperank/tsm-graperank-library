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
    console.log("fetchEvents called with relays:", relays, "relays length:", relays.length, "filters:", JSON.stringify(filters))
    return new Promise((resolve) => {
        const events: Map<string, NostrEvent> = new Map();
        let resolved = false;

        const doResolve = (reason: string) => {
            if (resolved) return;
            resolved = true;
            h.close()
            pool.close(relays)
            console.log("fetchEvents resolved via", reason, "with", events.size, "events")
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

        // Resolve after 3 seconds regardless of EOSE
        const timeoutId = setTimeout(() => {
            console.log("fetchEvents timeout after 3 seconds")
            doResolve("timeout");
        }, 3000);

        let h = pool.subscribeMany(
          [...relays],filters,
          {
            onevent : onEvent,
            oneose() {
              console.log("fetchEvents EOSE received")
              // Resolve on first EOSE after a short delay to collect more events
              setTimeout(() => {
                clearTimeout(timeoutId);
                doResolve("EOSE");
              }, 500);
            }
          }
        )
    });
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
