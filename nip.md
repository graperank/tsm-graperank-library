TSM GrapeRank Service
===

`tsm-graperank-service`

`draft`

`extends` [tsm-ranking-services](https://nostrhub.io/naddr1qvzqqqrcvypzphm8lxn7gyf9w3wtu7k0hhxsx6ghsrry8hmm44c0t5ss3uk5lssqqy28wumn8ghj7un9d3shjtnyv9kh2uewd9hsq9r5wdkj6unpde4kjmn894ek2unkd93k2ucqkht0d)

---

This NIP extends the [TSM Ranking Services](https://nostrhub.io/naddr1qvzqqqrcvypzphm8lxn7gyf9w3wtu7k0hhxsx6ghsrry8hmm44c0t5ss3uk5lssqqy28wumn8ghj7un9d3shjtnyv9kh2uewd9hsq9r5wdkj6unpde4kjmn894ek2unkd93k2ucqkht0d) NIP by specifying a format for GrapeRank-specific `config` tags that allow requestors to leverage the highly configurable GrapeRank interpreter and calculator parameters.

## Service Announcement Events

GrapeRank providers SHOULD publish a TSM Service Announcement event (kind `37570`) following the TSM Ranking Services specification, with the addition of GrapeRank-specific `config` tags:

```jsonc
{
  "kind": 37570,
  "pubkey": "<service_pubkey>",
  "tags": [

    // OPTIONAL and REQUIRED tags as specified by TSM Ranking Services
    // ...

    // REQUIRED GrapeRank specific config tags
    // Providers MUST support these configs with at least the default values

    // Calculator influence decay factor per degree of separation. 
    // Higher values preserve influence across network; lower values decay faster
    ["config", "attenuation", "0-1", "Influence decay per degree of separation", "0.5", "[0, 1]"],

    // Calculator confidence threshold factor for score calculation. 
    // Higher values require stronger confidence; lower values are more permissive
    ["config", "rigor", "0-1", "Confidence threshold factor", "0.5", "[0, 1]"],

    // Calculator maximum score difference between iterations. 
    // 0 = iterate until stable; >0 = stop when delta < precision
    ["config", "precision", "0+", "Max delta between iterations (0=iterate until stable)", "0.00001"],

    // An array of interpreter request objects
    // Requestors specify which interpreters to use, in what order, and with what parameters
    // Providers SHOULD include ALL supported interpreter requests (with default parameters) 
    // as the default value for this config
    // Requestors MAY override by providing a custom array of InterpreterRequest objects
    // See Appendix 1 for InterpreterRequest schema
    ["config", "interpreters", "InterpreterRequest[]", "Array of interpreter configurations", "<see Standard Interpreters Registry>"]

    // OPTIONAL Provider specific inputs
    // ANY additional inputs NOT specified by this service NIP 
    // SHOULD be announced as optional inputs by providers
    // WITH default values always available
    ["option", "<key>", "<NostrType>", "<description>", "<default>"],
    
  ],
  "content": "",
}
```

### Config Validation

Providers MUST validate request configs against announced constraints:
- Reject requests with config values outside `<allowed?>` ranges
- Use `<default?>` values when config is omitted from request
- Return kind `7000` feedback event with error details for invalid configs
- Validate interpreter IDs against supported interpreters

### Service Announcement Example

```jsonc
{
  "kind": 37570,
  "pubkey": "<service_pubkey>",
  "tags": [
    ["d", "graperank-v1"],
    ["title", "GrapeRank Service"],
    ["summary", "Configurable GrapeRank-based ranking service"],
    ["n", "./tsm-graperank-service"],
    ["k", "37573"],
    ["r", "wss://relay.example.com"],
    
    // TSM Ranking Services required configs
    ["config", "type", "tagletter", "Subject type to rank", "p", "[\"p\", \"t\", \"e\"]"],
    ["config", "pov", "subject|naddr", "Point of view subject(s)"],
    ["config", "minrank", "0-100", "Minimum rank threshold", "0"],
    
    // GrapeRank specific configs
    ["config", "attenuation", "0-1", "Influence decay per degree of separation", "0.5", "[0, 1]"],
    ["config", "rigor", "0-1", "Confidence threshold factor", "0.5", "[0, 1]"],
    ["config", "precision", "0+", "Max delta between iterations", "0.00001"],
    ["config", "interpreters", "InterpreterRequest[]", "Array of interpreter configurations", "[{\"id\":\"nostr-3\",\"iterate\":3}]"],
    
    // Pagination support
    ["V", "page", "integer", "Page number for paginated results"],
    
    // Additional info
    ["info", "algorithm", "graperank"],
    ["info", "version", "1.0.0"]
  ],
  "content": ""
}
```

## Service Request Events

Users MAY request GrapeRank ranking services by publishing a TSM Service Request event (kind `37572`) following the TSM Ranking Services specification, with optional GrapeRank `config` tags:

**Basic Request (using defaults):**
```jsonc
{
  "kind": 37572,
  "pubkey": "<requester_pubkey>",
  "tags": [
    // OPTIONAL and REQUIRED tags as specified in TSM Ranking Services spec

    // CONDITIONAL GrapeRank specific config tags as required by the provider
    ["config", "attenuation", "0.6"],
    ["config", "rigor", "0.4"],
    ["config", "precision", "0.0001"],
    ["config", "interpreters", "[{\"id\":\"nostr-3\",\"iterate\":4},{\"id\":\"nostr-9735\",\"params\":{\"value\":2}}]"]
  ]
}
```

## Service Output Events

GrapeRank providers SHOULD publish ranking results as kind `37573` events following the TSM Ranking Services output specification:


## Appendix 1: InterpreterRequest JSON Schema

The `interpreters` config accepts an array of `InterpreterRequest` objects with the following schema:

```jsonc
{ 
  // REQUIRED: Interpreter identifier following the Interpreter ID Standard
  // Must match an interpreter ID from the provider's announcement
  "id": "string", // e.g., "nostr-3", "nostr-9735", "nostr-1-t"
  
  // OPTIONAL: Override default interpreter parameters
  // Available params depend on the specific interpreter
  "params": {
    "value": "number",        // Interaction value weight (required by all interpreters)
    "confidence": "number",   // Confidence factor 0-1 (required by all interpreters)
    // Additional interpreter-specific params:
    "actorType": "string",    // Nostr: tag/field type for actors (e.g., "pubkey", "p")
    "subjectType": "string",  // Nostr: tag/field type for subjects (e.g., "p", "t", "e")
    "<param>": "string | number | boolean" // Other custom params
  },
  
  // OPTIONAL: Network depth iterations (default: 1)
  // Each iteration:
  // 1. Fetches data from current actors
  // 2. Interprets interactions
  // 3. Discovers new actors from subjects
  // 4. Uses new actors as input for next iteration
  "iterate": "number",
  
  // OPTIONAL: Filter parameters for data fetching
  // Available filters depend on the protocol (e.g., Nostr relay filters)
  "filter": {
    "since": "timestamp",     // Unix timestamp - events after this time
    "until": "timestamp",     // Unix timestamp - events before this time
    "limit": "number",        // Maximum events to fetch
    "<param>": "string | number" // Other protocol-specific filters
  },
  
  // OPTIONAL: Override actors for this specific interpreter
  // If omitted, uses actors from POV or previous interpreter iterations
  "actors": ["actorId[]"]
}
```

### InterpreterRequest Examples

**Basic usage (use defaults):**
```json
{"id": "nostr-3"}
```

**With iterations:**
```json
{"id": "nostr-3", "iterate": 4}
```

**Override parameters:**
```json
{
  "id": "nostr-9735",
  "params": {
    "value": 2,
    "confidence": 0.7
  }
}
```

**With filter:**
```json
{
  "id": "nostr-1-t",
  "filter": {
    "since": 1704067200,
    "limit": 1000
  }
}
```

**Complete example:**
```json
{
  "id": "nostr-3",
  "params": {
    "value": 1,
    "confidence": 0.6,
    "actorType": "pubkey",
    "subjectType": "p"
  },
  "iterate": 3,
  "filter": {
    "since": 1704067200
  }
}
```


## Appendix 2: Standard Interpreters Registry

To ensure config interoperability, GrapeRank providers SHOULD support these standard Nostr interpreters with consistent behavior:

| Interpreter ID | Kind(s) | Description | Actor Type | Subject Type | Standard Value |
|---|---|---|---|---|---|
| `nostr-3` | 3 | Follow relationships | `pubkey` | `p` | `1` |
| `nostr-10000` | 10000 | Mute lists | `pubkey` | `p` | `0` |
| `nostr-1984` | 1984 | Report events | `pubkey` | `p` | `-1` |
| `nostr-9735` | 9735, 9734 | Zap receipts | `P` | `p` | `1` |
| `nostr-1-t` | 1 | Hashtag usage in notes | `pubkey` | `t` | `1` |

Providers MAY implement additional interpreters using the Interpreter ID Standard. Providers SHOULD document custom interpreters in their service announcement or linked NIP.


## Appendix 3: Interpreter ID Standard

To ensure config interoperability across GrapeRank implementations, interpreter IDs MUST follow a standardized kebab-case format:

**Format:** `<namespace>-<specifier>[-<specifier>...]`

- **namespace**: lowercase letters only (e.g., `nostr`, `atproto`, `farcaster`)
- **specifiers**: alphanumeric characters with hyphens, following namespace-specific conventions
- **Pattern:** `/^[a-z]+(-[a-z0-9]+)+$/`

### Nostr Interpreter ID Convention

Nostr interpreters SHOULD use the format: `nostr-<kind>[-<tag>]`

**Examples:**
- `nostr-3` - Kind 3 follow events
- `nostr-10000` - Kind 10000 mute lists
- `nostr-1984` - Kind 1984 report events
- `nostr-1-t` - Kind 1 notes filtered by `t` (hashtag) tags
- `nostr-9735` - Kind 9735 zap receipts

Other protocol namespaces MAY define their own conventions while adhering to the base format. 
