import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { NostrEvent, NostrFilter } from '../../lib/nostr-tools'
import type { NostrEventSource } from '../event-source'

/**
 * An event source over the nas lake's follow and mute edges.
 *
 * The lake's `nas/derivation/events/list-edges/source` files hold, per pubkey,
 * the p tags of its current kind 3 and kind 10000 lists as rows
 * (source, target, kind, list_id, list_created_at), sorted by source. One
 * source's rows of one kind are exactly one list, so a filter
 * `{authors, kinds}` is answered by grouping those rows back into one
 * synthesised event per (author, kind): the list's id and created_at, the
 * targets as p tags, no content and no signature. The interpreters read
 * nothing else. The lake validated the events when it was built; nothing is
 * re-checked here.
 *
 * GrapeRank fires its 500-author chunks concurrently, so calls are queued and
 * served one query at a time over the union of their authors, and each call
 * gets back only the events of the authors it asked for.
 *
 * DuckDB (`@duckdb/node-api`, an optional peer dependency) does the reading;
 * it is loaded only when a source is created.
 */

export type LakeSourceOptions = {
  /** Directory with `lake/<sha256>` files and, if present, `lists-manifest.json`. */
  dir?: string
  /** Explicit file paths or URLs; replaces the directory listing. */
  files?: string[]
  /** The lists manifest to read the file list and run from; default `<dir>/lists-manifest.json`. */
  manifest?: string
  /** Fetch the manifest's files from `<baseUrl>/<sha256>` instead of `<dir>/lake`, e.g. a `nas serve` URL. */
  baseUrl?: string
  /** Kinds the files hold; default 3 and 10000. */
  kinds?: number[]
  /** DuckDB threads; default DuckDB's choice. */
  threads?: number
  /** DuckDB memory limit, e.g. '6GB'; default DuckDB's choice. */
  memoryLimit?: string
  /** Where DuckDB spills large aggregates; default a fresh directory under the OS temp dir. */
  tempDirectory?: string
  /** Up to this many authors are matched with an inline IN list, which prunes row groups; more go through a table. Default 32. */
  inlineLimit?: number
}

export type LakeSourceStats = {
  files: number
  /** Rows according to the manifest; undefined without one. */
  rows: number | undefined
  run: string | undefined
  referenceTime: number | undefined
  /** Calls to the source, queries run (fewer, when calls were batched). */
  calls: number
  queries: number
  /** Time in DuckDB (query and fetch) and in building events. */
  queryMs: number
  convertMs: number
  events: number
  edges: number
  errors: number
}

export type LakeSource = {
  source: NostrEventSource
  close(): Promise<void>
  stats(): LakeSourceStats
}

const HEX64 = /^[0-9a-fA-F]{64}$/
const FILTER_KEYS = new Set(['authors', 'kinds', 'limit'])

type Call = {
  authors: string[]
  kinds: number[]
  resolve: (events: Set<NostrEvent>) => void
}

type ManifestFile = { sha256: string; rows?: number }

function readManifest(file: string): { run?: string; referenceTime?: number; files: ManifestFile[] } | undefined {
  if (!fs.existsSync(file)) return undefined
  const document = JSON.parse(fs.readFileSync(file, 'utf8'))
  const run = document.runs?.[document.runs.length - 1]
  if (!run) return undefined
  const files: ManifestFile[] = (run.edges?.source ?? []).map((f: ManifestFile) => ({ sha256: f.sha256, rows: f.rows }))
  return { run: run.run, referenceTime: run.reference_time, files }
}

function quote(text: string): string {
  return "'" + text.replace(/'/g, "''") + "'"
}

export async function createLakeSource(options: LakeSourceOptions): Promise<LakeSource> {
  const supported = options.kinds ?? [3, 10000]
  const inlineLimit = options.inlineLimit ?? 32

  // The files, and what the manifest says about them
  let files: string[]
  let rows: number | undefined
  let run: string | undefined
  let referenceTime: number | undefined
  if (options.files) {
    files = [...options.files]
  } else {
    if (!options.dir) throw new Error('createLakeSource: give dir or files')
    const manifest = readManifest(options.manifest ?? path.join(options.dir, 'lists-manifest.json'))
    if (manifest) {
      run = manifest.run
      referenceTime = manifest.referenceTime
      rows = manifest.files.every((f) => typeof f.rows === 'number')
        ? manifest.files.reduce((sum, f) => sum + (f.rows as number), 0)
        : undefined
      files = manifest.files.map((f) =>
        options.baseUrl ? `${options.baseUrl.replace(/\/$/, '')}/${f.sha256}` : path.join(options.dir!, 'lake', f.sha256)
      )
    } else {
      const lake = path.join(options.dir, 'lake')
      files = fs
        .readdirSync(lake)
        .sort()
        .map((name) => path.join(lake, name))
        .filter((file) => fs.statSync(file).isFile())
    }
  }
  if (!files.length) throw new Error('createLakeSource: no edge files')
  const remote = files.some((f) => /^(https?|s3):\/\//.test(f))
  for (const file of files) {
    if (!/^(https?|s3):\/\//.test(file) && !fs.existsSync(file)) throw new Error(`createLakeSource: missing ${file}`)
  }

  // DuckDB, loaded only now
  const loaded: any = await import('@duckdb/node-api')
  const api: any = loaded.DuckDBInstance ? loaded : loaded.default
  const config: Record<string, string> = {}
  if (options.threads) config.threads = String(options.threads)
  if (options.memoryLimit) config.memory_limit = options.memoryLimit
  config.temp_directory = options.tempDirectory ?? fs.mkdtempSync(path.join(os.tmpdir(), 'graperank-lake-duckdb-'))
  const instance = await api.DuckDBInstance.create(':memory:', config)
  const conn = await instance.connect()
  if (remote) {
    try {
      await conn.run('LOAD httpfs')
    } catch {
      await conn.run('INSTALL httpfs; LOAD httpfs')
    }
  }
  await conn.run(
    `CREATE VIEW edges AS SELECT source, target, kind, list_id, list_created_at FROM read_parquet([${files.map(quote).join(', ')}])`
  )

  const stats: LakeSourceStats = {
    files: files.length,
    rows,
    run,
    referenceTime,
    calls: 0,
    queries: 0,
    queryMs: 0,
    convertMs: 0,
    events: 0,
    edges: 0,
    errors: 0,
  }

  // One copy of every pubkey string: targets repeat across lists
  const strings = new Map<string, string>()
  const intern = (text: string): string => {
    const held = strings.get(text)
    if (held !== undefined) return held
    strings.set(text, text)
    return text
  }

  // One query for a batch of calls: events of every requested kind, by author
  async function query(authors: string[], kinds: number[]): Promise<Map<string, NostrEvent[]>> {
    const byAuthor = new Map<string, NostrEvent[]>()
    const started = Date.now()
    let converting = 0
    stats.queries++
    try {
      let predicate: string
      if (authors.length <= inlineLimit) {
        predicate = `source IN (${authors.map((a) => `unhex('${a}')`).join(', ')})`
      } else {
        await conn.run('CREATE OR REPLACE TABLE frontier(pubkey BLOB)')
        const appender = await conn.createAppender('frontier')
        for (const author of authors) {
          appender.appendBlob(Buffer.from(author, 'hex'))
          appender.endRow()
        }
        appender.flushSync()
        appender.closeSync()
        predicate = 'source IN (SELECT pubkey FROM frontier)'
      }
      const sql = `SELECT lower(hex(source)) AS pubkey, kind, lower(hex(list_id)) AS id,
                          CAST(list_created_at AS DOUBLE) AS created_at,
                          list(lower(hex(target))) AS targets
                   FROM edges WHERE kind IN (${kinds.join(', ')}) AND ${predicate}
                   GROUP BY ALL`
      const result = await conn.stream(sql)
      for (;;) {
        const chunk = await result.fetchChunk()
        if (!chunk || chunk.rowCount === 0) break
        const t0 = Date.now()
        for (const row of chunk.getRows() as any[][]) {
          const pubkey = intern(row[0] as string)
          const targets = (row[4]?.items ?? []) as string[]
          const event: NostrEvent = {
            id: row[2] as string,
            pubkey,
            kind: Number(row[1]),
            created_at: Number(row[3]),
            tags: targets.map((t) => ['p', intern(t)]),
            content: '',
            sig: '',
          }
          const held = byAuthor.get(pubkey)
          if (held) held.push(event)
          else byAuthor.set(pubkey, [event])
          stats.events++
          stats.edges += targets.length
        }
        converting += Date.now() - t0
      }
    } catch (error) {
      stats.errors++
      console.error('lake source: query failed:', error instanceof Error ? error.message : error)
    }
    stats.queryMs += Date.now() - started - converting
    stats.convertMs += converting
    return byAuthor
  }

  // Single flight: calls that arrive while a query runs form the next batch
  let pending: Call[] = []
  let running = false
  let closed = false

  async function pump(): Promise<void> {
    if (running) return
    running = true
    try {
      while (pending.length) {
        const batch = pending
        pending = []
        if (closed) {
          for (const call of batch) call.resolve(new Set())
          continue
        }
        const authors = [...new Set(batch.flatMap((c) => c.authors))]
        const kinds = [...new Set(batch.flatMap((c) => c.kinds))]
        const byAuthor = await query(authors, kinds)
        for (const call of batch) {
          const events = new Set<NostrEvent>()
          for (const author of call.authors) {
            for (const event of byAuthor.get(author) ?? []) {
              if (call.kinds.includes(event.kind)) events.add(event)
            }
          }
          call.resolve(events)
        }
      }
    } finally {
      running = false
    }
  }

  const source: NostrEventSource = (filter: NostrFilter) => {
    stats.calls++
    for (const key of Object.keys(filter)) {
      if (!FILTER_KEYS.has(key) && (filter as any)[key] !== undefined) return Promise.resolve(new Set<NostrEvent>())
    }
    const authors = [...new Set((filter.authors ?? []).filter((a) => HEX64.test(a)).map((a) => a.toLowerCase()))]
    const kinds = (filter.kinds ?? []).filter((k) => supported.includes(k))
    if (closed || !authors.length || !kinds.length) return Promise.resolve(new Set<NostrEvent>())
    return new Promise<Set<NostrEvent>>((resolve) => {
      pending.push({ authors, kinds, resolve })
      void pump()
    })
  }

  async function close(): Promise<void> {
    closed = true
    try {
      conn.closeSync?.()
    } catch {}
    try {
      instance.closeSync?.()
    } catch {}
  }

  return { source, close, stats: () => ({ ...stats }) }
}
