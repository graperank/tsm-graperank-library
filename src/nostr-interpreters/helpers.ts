import { Event as NostrEvent } from 'nostr-tools/core'
import { Filter as NostrFilter } from 'nostr-tools/filter'
import { SimplePool } from 'nostr-tools/pool'

const relays = [
  "wss://gv.rogue.earth",
  "wss://nostr.bitcoiner.social",
  "wss://relay.nostr.band",
  "wss://relay.snort.social",
  "wss://nos.lol",
]

export const maxauthors = 500

/**
 * Adapted from NDK
 * @param filters 
 * @returns 
 */
export async function fetchEvents(
    filters: NostrFilter 
): Promise<Set<NostrEvent>> {
    return new Promise((resolve) => {
        const events: Map<string, NostrEvent> = new Map();

        const onEvent = (event: NostrEvent) => {
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
            onevent : onEvent,
            oneose() {
              h.close()
              resolve(new Set(events.values()));
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
      (event.kind && event.kind >= 10000 && event.kind < 20000)
  ) {
      return `${event.kind}:${event.pubkey}`;
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
