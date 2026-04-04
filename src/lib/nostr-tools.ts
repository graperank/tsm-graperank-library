/**
 * Centralized barrel file for nostr-tools imports
 * 
 * This file consolidates all nostr-tools imports into a single location
 * to minimize IDE import errors. The nostr-tools package uses ESM 
 * with subpath exports, which can cause TypeScript language 
 * server warnings when importing directly in CommonJS modules.
 * 
 * By centralizing imports here, IDE warnings are isolated 
 * to just this one file, while all other files can import 
 * from this barrel without errors.
 * 
 * Note: These warnings are only cosmetic and do not affect runtime behavior.
 */

export type { Event as NostrEvent } from 'nostr-tools/core'
export type { Filter as NostrFilter } from 'nostr-tools/filter'

export { SimplePool, useWebSocketImplementation } from 'nostr-tools/pool'
export { npubEncode, decode } from 'nostr-tools/nip19'
