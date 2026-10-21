import * as fs from 'fs'
import * as http from 'http'
import * as os from 'os'
import * as path from 'path'
import { DuckDBInstance } from '@duckdb/node-api'
import type { NostrEvent } from '../lib/nostr-tools'
import type { InteractionsList, InterpreterStatus } from '../graperank/types'
import { InterpretationController, InterpretersMap } from '../graperank/interpretation'
import { CalculationController } from '../graperank/calculation'
import { InterpreterFactory } from '../nostr-interpreters/factory'
import { NostrInterpreterClass } from '../nostr-interpreters/classes'
import { setArchive } from '../nostr-interpreters/event-source'
import { createLakeSource, LakeSource } from '../nostr-interpreters/sources/lake'

// All DuckDB tests live in this one file: the native addon is loaded once per
// jest worker.

const hex = (byte: string) => byte.repeat(32)
const A = hex('aa')
const B = hex('bb')
const C = hex('cc')
const D = hex('dd')
const L1 = hex('11')
const L2 = hex('22')
const L3 = hex('33')
const FILE_SHA = hex('f1')
const ACTS_SHA = hex('f2')

// Act relations: C reports A as spam twice and B as nudity once (and A once
// untyped); B reacts to A and to C. Written in the relation-edges columns.
const ACTS: [string, string, string, string | null, number, number, number][] = [
  [C, A, 'report', 'spam', 2, 1700000100, 1700000200],
  [C, B, 'report', 'nudity', 1, 1700000300, 1700000300],
  [C, A, 'report', null, 1, 1700000050, 1700000050],
  [B, A, 'reaction', null, 3, 1700000010, 1700000030],
  [B, C, 'reaction', null, 1, 1700000020, 1700000020],
]
const RELATIONS = {
  report: { graperank: { interpreter: 'nostr-1984', kind: 1984, tags: [['p', '{target}', '{attr}']] } },
  reaction: { graperank: { interpreter: 'nostr-7', kind: 7, tags: [['p', '{target}']] } },
}

// The fixture: A follows B and C (list L1), B follows A (L2), A mutes D (L3);
// C has no list. Written by DuckDB in the lake's column types and sort order.
const ROWS: [string, string, number, string, number][] = [
  [A, B, 3, L1, 1700000000],
  [A, C, 3, L1, 1700000000],
  [B, A, 3, L2, 1700000001],
  [A, D, 10000, L3, 1700000002],
]

let dir: string
let withManifest: LakeSource
let withoutManifest: LakeSource
let server: http.Server
let base: string
let overHttp: LakeSource

/**
 * A lake URL over `root`, the way Caddy and `nas serve` serve one: `/<sha256>`
 * by range (HEAD, GET, a single `Range`), the two manifests by name, 404 for
 * anything else.
 */
function serveLake(root: string): Promise<[http.Server, string]> {
  const named = new Set(['lists-manifest.json', 'relations-manifest.json', 'lake-info.json'])
  const srv = http.createServer((req, res) => {
    const name = (req.url ?? '/').slice(1).split('?')[0]
    const file = /^[0-9a-f]{64}$/.test(name) ? path.join(root, 'lake', name) : named.has(name) ? path.join(root, name) : undefined
    if (!file || !fs.existsSync(file)) {
      res.writeHead(404).end('not a file hash')
      return
    }
    const size = fs.statSync(file).size
    res.setHeader('Accept-Ranges', 'bytes')
    res.setHeader('Content-Type', named.has(name) ? 'application/json' : 'application/vnd.apache.parquet')
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
    let start = 0
    let end = size - 1
    if (range) {
      if (range[1] === '') start = Math.max(0, size - Number(range[2]))
      else {
        start = Number(range[1])
        if (range[2] !== '') end = Math.min(Number(range[2]), size - 1)
      }
      res.statusCode = 206
      res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`)
    }
    res.setHeader('Content-Length', end - start + 1)
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    fs.createReadStream(file, { start, end }).pipe(res)
  })
  return new Promise((resolve) =>
    srv.listen(0, '127.0.0.1', () => resolve([srv, `http://127.0.0.1:${(srv.address() as any).port}`]))
  )
}

async function writeFixture(file: string): Promise<void> {
  const instance = await DuckDBInstance.create(':memory:', { threads: '1' })
  const conn = await instance.connect()
  const values = ROWS.map(([s, t, k, l, c]) => `('${s}','${t}',${k},'${l}',${c})`).join(',')
  await conn.run(
    `COPY (SELECT unhex(s) AS source, unhex(t) AS target, CAST(k AS USMALLINT) AS kind,
                  unhex(l) AS list_id, CAST(c AS UBIGINT) AS list_created_at
           FROM (VALUES ${values}) v(s, t, k, l, c) ORDER BY source, kind, target)
     TO '${file}' (FORMAT PARQUET, COMPRESSION ZSTD, WRITE_BLOOM_FILTER false)`
  )
  // DuckDB 1.5.5 answers `col = x` wrongly on a column with a Bloom filter; make
  // sure the fixture does not quietly depend on that bug being absent.
  const meta = await conn.runAndReadAll(
    `SELECT count(*) FILTER (WHERE bloom_filter_offset IS NOT NULL) AS blooms FROM parquet_metadata('${file}')`
  )
  expect(Number(meta.getRowObjectsJS()[0].blooms)).toBe(0)
  conn.closeSync()
  instance.closeSync()
}

async function writeActs(file: string): Promise<void> {
  const instance = await DuckDBInstance.create(':memory:', { threads: '1' })
  const conn = await instance.connect()
  const values = ACTS.map(([s, t, r, a, n, f, l]) => `('${s}','${t}','${r}',${a === null ? 'NULL' : `'${a}'`},${n},${f},${l})`).join(',')
  await conn.run(
    `COPY (SELECT unhex(s) AS source, unhex(t) AS target, r AS relation, CAST(a AS VARCHAR) AS attr,
                  CAST(n AS UBIGINT) AS count, CAST(f AS UBIGINT) AS first_at, CAST(l AS UBIGINT) AS last_at
           FROM (VALUES ${values}) v(s, t, r, a, n, f, l) ORDER BY source, relation, target, attr)
     TO '${file}' (FORMAT PARQUET, COMPRESSION ZSTD, WRITE_BLOOM_FILTER false)`
  )
  conn.closeSync()
  instance.closeSync()
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'graperank-lake-'))
  fs.mkdirSync(path.join(dir, 'lake'))
  await writeFixture(path.join(dir, 'lake', FILE_SHA))
  await writeActs(path.join(dir, 'lake', ACTS_SHA))
  fs.writeFileSync(
    path.join(dir, 'relations-manifest.json'),
    JSON.stringify({
      format: 'nostr4/relations-manifest/1',
      runs: [
        { run: 'older', reference_time: 1, relations: RELATIONS, files: { source: [{ sha256: hex('00'), rows: 0 }], target: [] } },
        {
          run: '8a5a4d8645f55176',
          reference_time: 1791417674,
          relations: RELATIONS,
          files: {
            source: [{ sha256: ACTS_SHA, bytes: fs.statSync(path.join(dir, 'lake', ACTS_SHA)).size, rows: ACTS.length, min: B, max: C }],
            target: [{ sha256: hex('98'), rows: ACTS.length }],
          },
        },
      ],
    })
  )
  fs.writeFileSync(
    path.join(dir, 'lists-manifest.json'),
    JSON.stringify({
      format: 'nostr4/lists-manifest/1',
      sources: {},
      runs: [
        { run: 'older', reference_time: 1, edges: { source: [{ sha256: hex('00'), rows: 0 }], target: [] } },
        {
          run: '0bdc3fea3e667c39',
          reference_time: 1791417674,
          edges: {
            source: [{ sha256: FILE_SHA, bytes: fs.statSync(path.join(dir, 'lake', FILE_SHA)).size, rows: ROWS.length, min: A, max: B }],
            target: [{ sha256: hex('99'), rows: 4 }],
          },
        },
      ],
    })
  )
  withManifest = await createLakeSource({ dir, threads: 2 })
  const bare = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'graperank-lake-bare-'))
  fs.mkdirSync(path.join(bare, 'lake'))
  fs.copyFileSync(path.join(dir, 'lake', FILE_SHA), path.join(bare, 'lake', FILE_SHA))
  withoutManifest = await createLakeSource({ dir: bare, threads: 2 })
  ;[server, base] = await serveLake(dir)
  overHttp = await createLakeSource({ url: base, threads: 2 })
})

afterAll(async () => {
  setArchive(undefined)
  await withManifest?.close()
  await withoutManifest?.close()
  await overHttp?.close()
  server?.close()
})

function byPubkey(events: Set<NostrEvent>): Map<string, NostrEvent> {
  return new Map([...events].map((e) => [e.pubkey, e]))
}

describe('lake source over list-edges files', () => {
  test('the manifest names the files and the run: stats reflect the newest run', () => {
    const stats = withManifest.stats()
    expect(stats.files).toBe(1)
    expect(stats.rows).toBe(ROWS.length)
    expect(stats.run).toBe('0bdc3fea3e667c39')
    expect(stats.referenceTime).toBe(1791417674)
    expect(stats.where).toBe(dir)
    expect(stats.kinds).toEqual([3, 10000, 1984, 7])
    expect(withoutManifest.stats().kinds).toEqual([3, 10000])
  })

  test('one synthesised kind 3 event per author, p tags from the edges, id and time from the list', async () => {
    const events = await withManifest.source({ authors: [A], kinds: [3] })
    expect(events.size).toBe(1)
    const [event] = [...events]
    expect(event.pubkey).toBe(A)
    expect(event.kind).toBe(3)
    expect(event.id).toBe(L1)
    expect(event.created_at).toBe(1700000000)
    expect(event.tags.map((t) => t[0])).toEqual(['p', 'p'])
    expect(event.tags.map((t) => t[1]).sort()).toEqual([B, C])
    expect(event.content).toBe('')
    expect(typeof event.sig).toBe('string')
  })

  test('several authors in one filter give one event each; an author without a list gives none', async () => {
    const events = byPubkey(await withManifest.source({ authors: [A, B, C], kinds: [3] }))
    expect([...events.keys()].sort()).toEqual([A, B])
    expect(events.get(B)!.tags).toEqual([['p', A]])
    expect(events.get(B)!.id).toBe(L2)
  })

  test('mutes come from the same files, selected by kind', async () => {
    const events = [...(await withManifest.source({ authors: [A], kinds: [10000] }))]
    expect(events.length).toBe(1)
    expect(events[0].kind).toBe(10000)
    expect(events[0].id).toBe(L3)
    expect(events[0].tags).toEqual([['p', D]])
    const both = await withManifest.source({ authors: [A], kinds: [3, 10000] })
    expect([...both].map((e) => e.kind).sort((x, y) => x - y)).toEqual([3, 10000])
  })

  test('unknown authors, other kinds and filters the lake cannot answer give an empty set', async () => {
    expect((await withManifest.source({ authors: [hex('ee')], kinds: [3] })).size).toBe(0)
    expect((await withManifest.source({ authors: [A], kinds: [1] })).size).toBe(0)
    expect((await withManifest.source({ ids: [L1] })).size).toBe(0)
    expect((await withManifest.source({ authors: [A], kinds: [3], since: 1 })).size).toBe(0)
    expect((await withManifest.source({ authors: [], kinds: [3] })).size).toBe(0)
    expect((await withManifest.source({ authors: ['not hex'], kinds: [3] })).size).toBe(0)
  })

  test('a relay limit on the filter is ignored, not refused', async () => {
    expect((await withManifest.source({ authors: [A], kinds: [3], limit: 1000 })).size).toBe(1)
  })

  test('uppercase hex in the filter is found and comes back lowercase', async () => {
    const events = [...(await withManifest.source({ authors: [A.toUpperCase()], kinds: [3] }))]
    expect(events.length).toBe(1)
    expect(events[0].pubkey).toBe(A)
  })

  test('concurrent calls are batched into fewer queries and each gets only its own authors', async () => {
    const before = withManifest.stats().queries
    const [a, b, none] = await Promise.all([
      withManifest.source({ authors: [A], kinds: [3] }),
      withManifest.source({ authors: [B], kinds: [3] }),
      withManifest.source({ authors: [C], kinds: [3] }),
    ])
    expect([...a].map((e) => e.pubkey)).toEqual([A])
    expect([...b].map((e) => e.pubkey)).toEqual([B])
    expect(none.size).toBe(0)
    expect(withManifest.stats().queries - before).toBeLessThan(3)
  })

  test('the inline IN list (small frontiers) and the frontier table (large ones) give the same events', async () => {
    // inlineLimit 1 sends two authors through the table; the default (2000) keeps them inline
    const viaTable = await createLakeSource({ dir, threads: 1, inlineLimit: 1 })
    try {
      const shape = (events: Set<NostrEvent>) => [...events].map((e) => [e.pubkey, e.kind, e.id, e.created_at, e.tags]).sort()
      for (const kinds of [[3], [10000], [1984], [7], [3, 10000, 1984]]) {
        const inline = shape(await withManifest.source({ authors: [A, B, C], kinds }))
        expect(inline.length).toBeGreaterThan(0)
        expect(shape(await viaTable.source({ authors: [A, B, C], kinds }))).toEqual(inline)
      }
    } finally {
      await viaTable.close()
    }
  })

  test('without a manifest every file under lake/ is read', async () => {
    expect(withoutManifest.stats().run).toBeUndefined()
    expect(withoutManifest.stats().relations).toBeUndefined()
    expect((await withoutManifest.source({ authors: [C], kinds: [1984] })).size).toBe(0)
    const events = byPubkey(await withoutManifest.source({ authors: [A, B], kinds: [3] }))
    expect([...events.keys()].sort()).toEqual([A, B])
  })

  test('close() resolves and a closed source answers nothing', async () => {
    const bare = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'graperank-lake-close-'))
    fs.mkdirSync(path.join(bare, 'lake'))
    fs.copyFileSync(path.join(dir, 'lake', FILE_SHA), path.join(bare, 'lake', FILE_SHA))
    const source = await createLakeSource({ dir: bare, threads: 1 })
    await source.close()
    expect((await source.source({ authors: [A], kinds: [3] })).size).toBe(0)
  })
})

describe('lake source over relation-edges files', () => {
  test('the relations manifest names the files, the run and the declared relations', () => {
    const relations = withManifest.stats().relations!
    expect(relations.run).toBe('8a5a4d8645f55176')
    expect(relations.referenceTime).toBe(1791417674)
    expect(relations.files).toBe(1)
    expect(relations.rows).toBe(ACTS.length)
    expect(relations.declared.map((r) => [r.name, r.interpreter, r.kind])).toEqual([
      ['report', 'nostr-1984', 1984],
      ['reaction', 'nostr-7', 7],
    ])
  })

  test('one synthesised kind 1984 event per reporter, the type at tag[2], none where untyped', async () => {
    const events = [...(await withManifest.source({ authors: [C], kinds: [1984] }))]
    expect(events.length).toBe(1)
    const [event] = events
    expect(event.pubkey).toBe(C)
    expect(event.kind).toBe(1984)
    expect(event.id).toMatch(/^[0-9a-f]{64}$/)
    expect(event.created_at).toBe(1700000300) // the latest act
    expect(event.tags.map((t) => t.join(' ')).sort()).toEqual([`p ${A}`, `p ${A} spam`, `p ${B} nudity`].sort())
    expect(event.content).toBe('')
  })

  test('reactions are kind 7 events with one p tag per reacted author', async () => {
    const events = [...(await withManifest.source({ authors: [B], kinds: [7] }))]
    expect(events.length).toBe(1)
    expect(events[0].kind).toBe(7)
    expect(events[0].created_at).toBe(1700000030)
    expect(events[0].tags.map((t) => t[1]).sort()).toEqual([A, C])
    expect((await withManifest.source({ authors: [A], kinds: [7] })).size).toBe(0) // A reacted to nobody
  })

  test('lists and acts can be asked for in one filter', async () => {
    const events = await withManifest.source({ authors: [B], kinds: [3, 7] })
    expect([...events].map((e) => e.kind).sort((x, y) => x - y)).toEqual([3, 7])
    for (const event of events) expect(event.pubkey).toBe(B)
  })

  test('the same event id comes back every time for one reporter and run', async () => {
    const [first] = [...(await withManifest.source({ authors: [C], kinds: [1984] }))]
    const [again] = [...(await withManifest.source({ authors: [C], kinds: [1984] }))]
    expect(again.id).toBe(first.id)
  })
})

describe('the lake as an archive: what it holds, whether it is there, what it is', () => {
  test('covers: the held kinds with a filter it understands, nothing else', () => {
    expect(withManifest.covers({ authors: [A], kinds: [3] })).toBe(true)
    expect(withManifest.covers({ authors: [A], kinds: [3, 10000, 1984, 7], limit: 10 })).toBe(true)
    expect(withManifest.covers({ authors: [A], kinds: [3, 1] })).toBe(false) // one kind not held
    expect(withManifest.covers({ authors: [A], kinds: [] })).toBe(false)
    expect(withManifest.covers({ authors: [A], kinds: [3], '#d': ['x'] })).toBe(false) // a key the lake cannot answer
    expect(withoutManifest.covers({ authors: [A], kinds: [1984] })).toBe(false) // no relations manifest
  })

  test('ping and describe', async () => {
    expect(await withManifest.ping()).toBe(true)
    expect(withManifest.describe()).toBe(
      `lake ${dir}: lists run 0bdc3fea3e667c39 as of 2026-10-08 00:01 UTC; relations report,reaction run 8a5a4d8645f55176 as of 2026-10-08 00:01 UTC`
    )
    expect(withoutManifest.describe()).toBe(`lake ${withoutManifest.stats().where}: lists run ? as of ?; no relations`)
    const closed = await createLakeSource({ dir, threads: 1 })
    await closed.close()
    expect(await closed.ping()).toBe(false)
  })
})

describe('lake source over a lake URL', () => {
  test('the manifests and files come from the URL; stats say so', () => {
    const stats = overHttp.stats()
    expect(stats.where).toBe(base)
    expect(stats.run).toBe('0bdc3fea3e667c39')
    expect(stats.rows).toBe(ROWS.length)
    expect(stats.relations?.run).toBe('8a5a4d8645f55176')
    expect(stats.kinds).toEqual([3, 10000, 1984, 7])
    expect(overHttp.describe()).toContain(`lake ${base}: lists run 0bdc3fea3e667c39`)
  })

  test('the same answers as the directory copy, read by range over HTTP', async () => {
    const local = byPubkey(await withManifest.source({ authors: [A, B, C], kinds: [3, 10000, 1984, 7] }))
    const remote = byPubkey(await overHttp.source({ authors: [A, B, C], kinds: [3, 10000, 1984, 7] }))
    expect([...remote.keys()].sort()).toEqual([...local.keys()].sort())
    for (const [pubkey, event] of local) expect(remote.get(pubkey)).toEqual(event)
  })

  test('ping is a HEAD on the lists manifest: true while served, false once the server is gone', async () => {
    expect(await overHttp.ping()).toBe(true)
    const [gone, goneBase] = await serveLake(dir)
    const source = await createLakeSource({ url: goneBase, threads: 1, timeoutMs: 1000 })
    await new Promise<void>((resolve) => gone.close(() => resolve()))
    expect(await source.ping()).toBe(false)
    await source.close()
  })

  test('a URL without the manifests is not a lake', async () => {
    const [empty, emptyBase] = await serveLake(fs.mkdtempSync(path.join(os.tmpdir(), 'graperank-lake-empty-')))
    await expect(createLakeSource({ url: emptyBase, threads: 1 })).rejects.toThrow('no edge files')
    empty.close()
  })
})

describe('GrapeRank crawling the lake through the archive', () => {
  test('nostr-3 at two hops from A: ratings, frontiers and a calculation', async () => {
    NostrInterpreterClass.relays = []
    const seen: string[][] = []
    setArchive({
      ...withManifest,
      source: async (filter) => {
        seen.push([...(filter.authors ?? [])].sort())
        return withManifest.source(filter)
      },
    })
    const statuses: InterpreterStatus[] = []
    const controller = new InterpretationController(
      new InterpretersMap([InterpreterFactory]),
      async (status) => {
        statuses.push({ ...status, fetched: status.fetched && [...status.fetched], interpreted: status.interpreted && [...status.interpreted] } as InterpreterStatus)
        return true
      }
    )
    const output = await controller.interpret({ type: 'p', pov: [A], requests: [{ id: 'nostr-3', iterate: 2 }] })
    expect(output).toBeDefined()

    // hop 1 fetched A's list; hop 2 the lists of B and C, the pubkeys A rated
    expect(seen).toEqual([[A], [B, C]])

    const ratings = (output!.interactions as InteractionsList).map((i) => `${i.actor}>${i.subject}:${i.dos}`).sort()
    expect(ratings).toEqual([`${A}>${B}:1`, `${A}>${C}:1`, `${B}>${A}:2`])
    for (const i of output!.interactions) {
      expect(i.value).toBe(1)
      expect(i.confidence).toBe(0.5)
      expect(i.interpreterId).toBe('nostr-3')
    }

    const done = statuses.filter((s) => s.interpreted)
    expect(done.map((s) => [s.authors, s.fetched![0], s.interpreted![0]])).toEqual([
      [1, 1, 2], // hop 1: one author, one list, two ratings
      [2, 1, 1], // hop 2: two authors, one list (C has none), one rating
    ])

    const rankings = await new CalculationController(output!.pov, output!.interactions).calculate()
    const ranked = new Map(rankings)
    expect(ranked.has(B)).toBe(true)
    expect(ranked.has(C)).toBe(true)
    expect(ranked.get(B)!.rank).toBeGreaterThan(0)
  })

  test('follows, then reports and reactions over the actors found: typed report values, reaction ratings', async () => {
    NostrInterpreterClass.relays = []
    setArchive(withManifest)
    const controller = new InterpretationController(new InterpretersMap([InterpreterFactory]), async () => true)
    const output = await controller.interpret({
      type: 'p',
      pov: [A],
      requests: [
        { id: 'nostr-3', iterate: 2 },
        { id: 'nostr-1984', params: { spam: -1, nudity: -0.5 } as any },
        { id: 'nostr-7' },
      ],
    })
    expect(output).toBeDefined()
    const by = (id: string) =>
      (output!.interactions as InteractionsList)
        .filter((i) => i.interpreterId === id)
        .map((i) => `${i.actor}>${i.subject}=${i.value}`)
        .sort()
    // C (found by the follow crawl) reported A as spam and B as nudity: the
    // typed values from the request; A's untyped report is a repeat of the
    // same subject and is dropped by the interpreter
    expect(by('nostr-1984')).toEqual([`${C}>${A}=-1`, `${C}>${B}=-0.5`].sort())
    // B reacted to A and C: the reaction interpreter's default value
    expect(by('nostr-7')).toEqual([`${B}>${A}=1`, `${B}>${C}=1`].sort())
    expect(by('nostr-3').length).toBe(3)
  })

  test('one request, two choices: follows from the archive, reactions from the relays when the lake holds none', async () => {
    NostrInterpreterClass.relays = []
    setArchive(withoutManifest) // lists only: no relations manifest, so no reactions
    // the controller clears its interpreters when it is done, so the choice is
    // read while the run is on, from the status callback (as the service does)
    const interpreters = new InterpretersMap([InterpreterFactory])
    const choices = new Map<string, unknown>()
    const controller = new InterpretationController(interpreters, async (status) => {
      choices.set(status.interpreterId, (interpreters.get(status.interpreterId) as NostrInterpreterClass<any>).eventSource)
      return true
    })
    const output = await controller.interpret({ type: 'p', pov: [A], requests: [{ id: 'nostr-3', iterate: 2 }, { id: 'nostr-7' }] })
    expect(output).toBeDefined()
    expect(choices.get('nostr-3')).toEqual({ source: 'archive', reason: withoutManifest.describe() })
    expect(choices.get('nostr-7')).toEqual({ source: 'relays', reason: 'not held' })
    const by = (id: string) => (output!.interactions as InteractionsList).filter((i) => i.interpreterId === id)
    expect(by('nostr-3').length).toBe(3)
    expect(by('nostr-7')).toEqual([]) // the relays are empty here

    // liveNetwork on a request sends that interpreter to the relays even though the lake holds its kind
    const live = new InterpretersMap([InterpreterFactory])
    let liveChoice: unknown
    const liveOutput = await new InterpretationController(live, async (status) => {
      liveChoice = (live.get(status.interpreterId) as NostrInterpreterClass<any>).eventSource
      return true
    }).interpret({
      type: 'p',
      pov: [A],
      requests: [{ id: 'nostr-3', iterate: 2, liveNetwork: true }],
    })
    expect(liveChoice).toEqual({ source: 'relays', reason: 'liveNetwork' })
    expect(liveOutput!.interactions.length).toBe(0)
  })
})
