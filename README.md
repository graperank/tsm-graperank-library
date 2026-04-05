# TSM GrapeRank: 

## Next-Generation Webs of Trust for Nostr

> **⚠️ This library supersedes and deprecates [`@Pretty-Good-Freedom-Tech/graperank-nodejs`](https://github.com/Pretty-Good-Freedom-Tech/graperank-nodejs)**  
> If you're using the original GrapeRank library, please migrate to this TSM-compatible version for improved modularity, standardization, and interoperability.

TSM GrapeRank allows anyone to set up a sovereignty-respecting recommendation and discovery service for Nostr, powered by Trust Machines and grapes. This rewritten library implements the [GrapeRank TSM NIP](https://github.com/graperank/tsm-graperank-nip) to allow for full user control and interoperability of algorithm configurations across service providers.


## What's New in TSM GrapeRank

This library is a complete rewrite that adds:

- **📋 Compliance with [TSM Specification](https://nostrhub.io/naddr1qvzqqqrcvypzphm8lxn7gyf9w3wtu7k0hhxsx6ghsrry8hmm44c0t5ss3uk5lssqqy28wumn8ghj7un9d3shjtnyv9kh2uewd9hsqxn5wdkj6arjw4ehgttnv4e8v6trv5kk6ctrdp5kuetnl84x4n)**: Standardized service announcements (kind 37570), service requests (kind 37572), and ranking outputs (kind 37573)
- **🔌 Full Interoperability**: Works seamlessly with any TSM-compatible client or service
- **🧩 Enhanced Modularity**: Clean separation between TSM protocol layer, GrapeRank engine, and interpreter implementations
- **✅ Comprehensive Testing**: Full test coverage with unit, integration, and execution tests
- **📦 Better TypeScript Support**: Fully typed with improved DX and IDE support
- **🎯 NIP Standardization**: Native support for TSM-specific NIPs with extensible config system

## What is TSM (Trust Service Machines)?

TSM is a specification for building interoperable trust and ranking services on Nostr. It standardizes:

- **Service Announcements** (kind 37570): Declare available ranking services and their capabilities
- **Service Requests** (kind 37572): Submit ranking requests with configurable parameters
- **Service Output** (kind 37573): Deliver paginated ranking results with metadata
- **Feedback Events** (kind 7000): Provide real-time status updates during calculation

This allows any TSM-compatible service to work with any TSM-compatible client, creating a decentralized ecosystem of trust services.

## Why Webs of Trust?

**Sovereignty is respected when users have the freedom to choose... and a variety of useful choices.**

On Nostr, there's no central trust authority. Weeding out bots and bad actors while providing useful recommendations requires a decentralized approach. Webs of Trust solve this by defining "trustworthiness" **relative to each end user**, based on their own content and interactions.

GrapeRank respects sovereignty by:
- ✅ Allowing users to choose their own recommendation service
- ✅ Supporting multiple interpreters and contexts
- ✅ Providing transparent, configurable calculations
- ✅ Avoiding centralized "popularity contests"

## Architecture

### Core Components

#### 🔍 **Interpreters** (`src/nostr-interpreters/`)
Pluggable modules that ingest and normalize ANY content to standardized interaction ratings (0-1 scale):

- **nostr-3**: Follow lists (kind 3) - each follow = 1.0 trust
- **nostr-10000**: Mute lists (kind 10000) - each mute = 0.0 trust  
- **nostr-1984**: Report events (kind 1984) - weighted by report type
- **nostr-1-t**: Hashtag mentions in notes
- **nostr-9735**: Zap receipts weighted by amount

**Extensible**: Add custom interpreters for any protocol or network!

#### ⚙️ **Calculator** (`src/graperank/calculation.ts`)
The heart of GrapeRank - iteratively processes interactions to determine influence scores:

- **Weighted Average Algorithm**: Fixed ceiling prevents influencer dominance
- **Configurable Parameters**: `attenuation`, `rigor`, `minimum`, `precision`
- **Degree of Separation Tracking**: Multi-iteration network expansion
- **Regular Users Shine**: Avoids pure popularity contests

#### 🎯 **TSM Layer** (`src/tsm/`)
Handles TSM protocol compliance:

- **Announcements** (`announcements.ts`): Generate service announcement events
- **Requests** (`requests.ts`): Parse and validate service request events
- **Output** (`output.ts`): Generate ranking and feedback events with pagination

## Installation

```bash
npm install github:graperank/tsm-graperank-library
```

## Usage

### Basic Ranking Service

```typescript
import { parseServiceRequest, executeServiceRequest } from 'graperank-tsm/tsm/output'
import { InterpreterFactory } from 'graperank-tsm/nostr-interpreters/factory'

// Parse incoming TSM request event (kind 37572)
const request = parseServiceRequest(requestEvent)

// Execute ranking with callbacks
await executeServiceRequest(request, requestEvent, {
  interpreterFactory: InterpreterFactory,
  
  // Receive feedback events during processing
  onFeedbackEvent: async (feedbackEvent) => {
    await publishEvent(feedbackEvent) // kind 7000
  },
  
  // Receive final ranking output
  onOutputEvent: async (rankingEvent) => {
    await publishEvent(rankingEvent) // kind 37573
  }
})
```

### Generate Service Announcement

```typescript
import { generateServiceAnnouncement } from 'graperank-tsm/tsm/announcements'
import { InterpreterFactory } from 'graperank-tsm/nostr-interpreters/factory'

const announcement = generateServiceAnnouncement({
  identifier: 'my-graperank-service',
  title: 'My GrapeRank Service',
  summary: 'Web of Trust rankings for Nostr',
  relays: ['wss://relay.example.com']
}, InterpreterFactory)

// Publish announcement (kind 37570)
await publishEvent(announcement)
```

### Custom Configuration

Request events can specify custom parameters:

```json
{
  "kind": 37572,
  "tags": [
    ["config", "type", "p"],
    ["config", "pov", "[\"npub1...\", \"npub2...\"]"],
    ["config", "interpreters", "[{\"id\":\"nostr-3\",\"iterate\":3}]"],
    ["config", "attenuation", "0.5"],
    ["config", "rigor", "0.5"],
    ["config", "minimum", "0.0"]
  ]
}
```

## Project Structure

```
src/
├── tsm/                    # TSM protocol implementation
│   ├── announcements.ts    # Generate service announcements (kind 37570)
│   ├── requests.ts         # Parse service requests (kind 37572)
│   ├── output.ts           # Generate rankings & feedback (kind 37573, 7000)
│   └── types.ts            # TSM-specific types
├── graperank/              # Core GrapeRank engine
│   ├── interpretation.ts   # Orchestrates interpreters
│   ├── calculation.ts      # Weighted average algorithm
│   └── types.ts            # Core algorithm types
├── nostr-interpreters/     # Nostr-specific interpreters
│   ├── factory.ts          # Interpreter registry
│   ├── classes.ts          # Base interpreter class
│   ├── callbacks.ts        # Interpretation helpers
│   └── helpers.ts          # Event fetching & validation
└── __tests__/              # Comprehensive test suite
    ├── requests.test.ts
    ├── output.test.ts
    ├── integration.test.ts
    └── graperank-execution.test.ts
```

## Testing

```bash
# Run all tests
npm test

# Run with coverage
npm run test:coverage

# Watch mode for development
npm run test:watch
```

**Test Coverage**: 36 tests across unit, integration, and full execution scenarios

## Configuration Reference

### Calculator Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `attenuation` | number | 0.5 | How quickly influence decays with distance |
| `rigor` | number | 0.5 | How strictly confidence affects final scores |
| `minimum` | number | 0.0 | Minimum score threshold for results |
| `precision` | number | 0.00001 | Convergence precision for iterative calculation |

### Interpreter Requests

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | Interpreter ID (e.g., "nostr-3") |
| `iterate` | number | Degrees of separation to traverse |
| `params` | object | Custom interpreter parameters |

## Migration from Original GrapeRank

If you're migrating from [`@graperank/graperank`](https://github.com/Pretty-Good-Freedom-Tech/graperank-nodejs):

### Key Differences

1. **TSM Compliance**: Events now follow TSM specification (kinds 37570, 37572, 37573)
2. **Modular Structure**: Cleaner separation of concerns
3. **Type Safety**: Full TypeScript support with no implicit `any`
4. **Testing**: Comprehensive test coverage included
5. **API Changes**: New event-based API instead of class-based engine

### Breaking Changes

- ❌ `GrapeRank.init()` → ✅ Use `executeServiceRequest()`
- ❌ `.generate()`, `.scorecards()` → ✅ TSM event-based workflow
- ❌ S3 storage coupling → ✅ Storage is external to core library
- ❌ Custom cache → ✅ Use relay caching or external solutions

## Contributing

Contributions welcome! Please ensure:
- ✅ All tests pass (`npm test`)
- ✅ Code follows existing patterns
- ✅ New features include tests

## Credits

**GrapeRank TSM Developed by:** [ManiMe@nostrmeet.me](https://njump.me/npub1manlnflyzyjhgh970t8mmngrdytcp3jrmaa66u846ggg7t20cgqqvyn9tn)  
**Algorithm Designed by:** [David@bitcoinpark.com](https://njump.me/npub1u5njm6g5h5cpw4wy8xugu62e5s7f6fnysv0sj0z3a8rengt2zqhsxrldq3)

## License

MIT

---

**Related Projects:**
- [Original GrapeRank Library](https://github.com/Pretty-Good-Freedom-Tech/graperank-nodejs) (deprecated)
- [GrapeRank TSM NIP](https://github.com/graperank/tsm-graperank-nip)
- [TSM Ranking Services Nip](https://nostrhub.io/naddr1qvzqqqrcvypzphm8lxn7gyf9w3wtu7k0hhxsx6ghsrry8hmm44c0t5ss3uk5lssqqy28wumn8ghj7un9d3shjtnyv9kh2uewd9hsq9r5wdkj6unpde4kjmn894ek2unkd93k2ucqkht0d)
- [Trust Service Machines (TSM)](https://nostrhub.io/naddr1qvzqqqrcvypzphm8lxn7gyf9w3wtu7k0hhxsx6ghsrry8hmm44c0t5ss3uk5lssqqy28wumn8ghj7un9d3shjtnyv9kh2uewd9hsqxn5wdkj6arjw4ehgttnv4e8v6trv5kk6ctrdp5kuetnl84x4n)

