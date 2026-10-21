import { createHash } from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { NostrEvent, NostrFilter } from '../../lib/nostr-tools'
import type { NostrEventArchive, NostrEventSource } from '../event-source'

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
 * Act relations (reports, reactions) come the same way from the lake's
 * `nas/derivation/interactions/relation-edges/source` files, one edge per
 * (relation, actor, target, attr) with a count and time span. The relations
 * manifest (`nas fetch-relations`) carries each relation's declaration from
 * nas-py's `relations.toml`: the interpreter it answers, the event kind, and
 * the tags of the synthesised event with `{target}` and `{attr}` substituted
 * (a report's type lands at tag[2], where the reports interpreter reads it).
 * One event per (actor, relation): its id is a hash of relation, actor and
 * run; its created_at the latest act.
 *
 * GrapeRank fires its 500-author chunks concurrently, so calls are queued and
 * served one query at a time over the union of their authors, and each call
 * gets back only the events of the authors it asked for. A small frontier is
 * matched with an inline IN list, which prunes row groups (see `inlineLimit`);
 * a large one scans the files once. DuckDB keeps what it read over HTTP in its
 * external file cache (within the memory limit), so a second query over the
 * same files in one process is cheap: one instance per service process.
 *
 * The lake is read where it is served: `url` names a lake URL that serves
 * `<url>/<sha256>` by range and the manifests at `<url>/lists-manifest.json`
 * and `<url>/relations-manifest.json` (nas-py's `docs/notes/lake-url-manifests.org`;
 * Caddy on the DO lake, `nas serve` in development). A directory copy
 * (`dir`) is the same layout on disk, for tests and local copies.
 *
 * The source is also an archive (event-source.ts): `covers` says which kinds
 * it holds, `ping` whether it is there, `describe` which runs it serves.
 *
 * DuckDB (`@duckdb/node-api`, an optional peer dependency) does the reading;
 * it is loaded only when a source is created.
 */

export type LakeSourceOptions = {
  /** A lake URL: files at `<url>/<sha256>`, manifests at `<url>/lists-manifest.json` and `<url>/relations-manifest.json`. */
  url?: string
  /** Directory with `lake/<sha256>` files and, if present, `lists-manifest.json` and `relations-manifest.json`. */
  dir?: string
  /** Explicit file paths or URLs; replaces the directory listing. */
  files?: string[]
  /** The lists manifest to read the file list and run from; default `<dir>/lists-manifest.json`. */
  manifest?: string
  /** The relations manifest (act relations: reports, reactions); default `<dir>/relations-manifest.json`, read if present. */
  relationsManifest?: string
  /** With `dir`: fetch the manifests' files from `<baseUrl>/<sha256>` instead of `<dir>/lake` (manifests still from `dir`). */
  baseUrl?: string
  /** Milliseconds a manifest fetch or a ping may take; default 10000. */
  timeoutMs?: number
  /** Kinds the files hold; default 3 and 10000. */
  kinds?: number[]
  /** DuckDB threads; default DuckDB's choice. */
  threads?: number
  /** DuckDB memory limit, e.g. '6GB'; default DuckDB's choice. */
  memoryLimit?: string
  /** Where DuckDB spills large aggregates; default a fresh directory under the OS temp dir. */
  tempDirectory?: string
  /**
   * Up to this many authors are matched with an inline `IN (unhex(..), ..)` list; more go through a
   * `frontier` table and a semi-join. The inline list is pushed into the parquet scan as a filter and
   * prunes row groups by their `source` statistics; the semi-join gets only a min/max dynamic filter,
   * which covers the whole key range for any spread of pubkeys and so reads every row group (measured
   * 2026-10-21 over the DO lake: 71 reporters cold, 22.9 s through the table, 7.3 s inline). Beyond
   * about 2,000 authors the scan is total either way and the table spares a multi-MB statement.
   * Default 2000.
   */
  inlineLimit?: number
}

export type LakeRelation = {
  name: string
  interpreter: string
  kind: number
  tags: string[][]
}

export type LakeSourceStats = {
  /** The lake URL, or the directory. */
  where: string
  /** Event kinds this lake answers: the list kinds when list files are there, plus the declared act kinds. */
  kinds: number[]
  files: number
  /** Rows according to the manifest; undefined without one. */
  rows: number | undefined
  run: string | undefined
  referenceTime: number | undefined
  /** The act relations served, with their run; undefined without a relations manifest. */
  relations: { run: string | undefined; referenceTime: number | undefined; files: number; rows: number | undefined; declared: LakeRelation[] } | undefined
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

export type LakeSource = NostrEventArchive & {
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

type ListsManifest = { run?: string; referenceTime?: number; files: ManifestFile[] }

function readManifest(file: string): ListsManifest | undefined {
  if (!fs.existsSync(file)) return undefined
  return parseManifest(JSON.parse(fs.readFileSync(file, 'utf8')))
}

function parseManifest(document: any): ListsManifest | undefined {
  const run = document?.runs?.[document.runs.length - 1]
  if (!run) return undefined
  const files: ManifestFile[] = (run.edges?.source ?? []).map((f: ManifestFile) => ({ sha256: f.sha256, rows: f.rows }))
  return { run: run.run, referenceTime: run.reference_time, files }
}

type RelationsManifest = {
  run?: string
  referenceTime?: number
  files: ManifestFile[]
  relations: LakeRelation[]
}

function readRelationsManifest(file: string): RelationsManifest | undefined {
  if (!fs.existsSync(file)) return undefined
  return parseRelationsManifest(JSON.parse(fs.readFileSync(file, 'utf8')))
}

function parseRelationsManifest(document: any): RelationsManifest | undefined {
  const run = document?.runs?.[document.runs.length - 1]
  if (!run) return undefined
  const files: ManifestFile[] = (run.files?.source ?? []).map((f: ManifestFile) => ({ sha256: f.sha256, rows: f.rows }))
  const relations: LakeRelation[] = Object.entries(run.relations ?? {})
    .map(([name, entry]: [string, any]) => ({
      name,
      interpreter: String(entry?.graperank?.interpreter ?? ''),
      kind: Number(entry?.graperank?.kind),
      tags: (entry?.graperank?.tags ?? []) as string[][],
    }))
    .filter((r) => r.interpreter && Number.isInteger(r.kind) && r.tags.length)
  return { run: run.run, referenceTime: run.reference_time, files, relations }
}

/** A named document from the lake URL: parsed JSON, or undefined when the lake does not serve it (404). */
async function fetchDocument(url: string, name: string, timeoutMs: number): Promise<any | undefined> {
  const response = await fetch(`${url}/${name}`, { signal: AbortSignal.timeout(timeoutMs) })
  if (response.status === 404) return undefined
  if (!response.ok) throw new Error(`createLakeSource: ${url}/${name} answered ${response.status}`)
  return response.json()
}

function when(seconds: number | undefined): string {
  return seconds === undefined ? 'as of ?' : `as of ${new Date(seconds * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

function quote(text: string): string {
  return "'" + text.replace(/'/g, "''") + "'"
}

function sumRows(files: ManifestFile[]): number | undefined {
  return files.every((f) => typeof f.rows === 'number') ? files.reduce((sum, f) => sum + (f.rows as number), 0) : undefined
}

/** A relation's tag template filled for one edge; from `{attr}` on, elements are dropped when the edge has no attr. */
function fillTags(template: string[][], target: string, attr: string | null): string[][] {
  const tags: string[][] = []
  for (const tag of template) {
    const filled: string[] = []
    for (const element of tag) {
      if (element === '{attr}') {
        if (attr === null || attr === undefined) break
        filled.push(attr)
      } else {
        filled.push(element.replace('{target}', target))
      }
    }
    tags.push(filled)
  }
  return tags
}

export async function createLakeSource(options: LakeSourceOptions): Promise<LakeSource> {
  const listSupported = options.kinds ?? [3, 10000]
  const inlineLimit = options.inlineLimit ?? 2000
  const timeoutMs = options.timeoutMs ?? 10000
  const url = options.url?.replace(/\/$/, '')
  const fileBase = url ?? options.baseUrl?.replace(/\/$/, '')
  const locate = (sha256: string): string => (fileBase ? `${fileBase}/${sha256}` : path.join(options.dir!, 'lake', sha256))

  // The files, and what the manifests say about them
  let files: string[]
  let rows: number | undefined
  let run: string | undefined
  let referenceTime: number | undefined
  let relationsRun: RelationsManifest | undefined
  if (options.files) {
    files = [...options.files]
  } else if (url) {
    const manifest = parseManifest(await fetchDocument(url, 'lists-manifest.json', timeoutMs))
    run = manifest?.run
    referenceTime = manifest?.referenceTime
    rows = manifest ? sumRows(manifest.files) : undefined
    files = (manifest?.files ?? []).map((f) => locate(f.sha256))
    relationsRun = parseRelationsManifest(await fetchDocument(url, 'relations-manifest.json', timeoutMs))
  } else {
    if (!options.dir) throw new Error('createLakeSource: give url, dir or files')
    const manifest = readManifest(options.manifest ?? path.join(options.dir, 'lists-manifest.json'))
    if (manifest) {
      run = manifest.run
      referenceTime = manifest.referenceTime
      rows = sumRows(manifest.files)
      files = manifest.files.map((f) => locate(f.sha256))
    } else {
      const lake = path.join(options.dir, 'lake')
      files = fs
        .readdirSync(lake)
        .sort()
        .map((name) => path.join(lake, name))
        .filter((file) => fs.statSync(file).isFile())
    }
  }
  // Act relations, when a relations manifest is there
  if (!url && (options.dir || options.relationsManifest)) {
    relationsRun = readRelationsManifest(options.relationsManifest ?? path.join(options.dir!, 'relations-manifest.json'))
  }
  const relations: LakeRelation[] = relationsRun?.relations ?? []
  const relationFiles: string[] = (relationsRun?.files ?? []).map((f) => locate(f.sha256))
  const byKind = new Map<number, LakeRelation[]>()
  for (const relation of relations) {
    const held = byKind.get(relation.kind)
    if (held) held.push(relation)
    else byKind.set(relation.kind, [relation])
  }
  const actKinds = [...byKind.keys()]
  const heldKinds = [...(files.length ? listSupported : []), ...actKinds]
  if (!files.length && !relationFiles.length) throw new Error(`createLakeSource: no edge files at ${url ?? options.dir}`)
  const remote = [...files, ...relationFiles].some((f) => /^(https?|s3):\/\//.test(f))
  for (const file of [...files, ...relationFiles]) {
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
  if (files.length) {
    await conn.run(
      `CREATE VIEW edges AS SELECT source, target, kind, list_id, list_created_at FROM read_parquet([${files.map(quote).join(', ')}])`
    )
  }
  if (relationFiles.length) {
    await conn.run(
      `CREATE VIEW acts AS SELECT source, target, relation, attr, count, first_at, last_at FROM read_parquet([${relationFiles.map(quote).join(', ')}])`
    )
  }

  const stats: LakeSourceStats = {
    where: url ?? options.dir ?? 'files',
    kinds: heldKinds,
    files: files.length,
    rows,
    run,
    referenceTime,
    relations: relationsRun
      ? { run: relationsRun.run, referenceTime: relationsRun.referenceTime, files: relationFiles.length, rows: sumRows(relationsRun.files), declared: relations }
      : undefined,
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

  // One query per batch of calls and table: events of every requested kind, by author
  async function query(authors: string[], kinds: number[]): Promise<Map<string, NostrEvent[]>> {
    const byAuthor = new Map<string, NostrEvent[]>()
    const started = Date.now()
    let converting = 0
    stats.queries++
    const add = (event: NostrEvent) => {
      const held = byAuthor.get(event.pubkey)
      if (held) held.push(event)
      else byAuthor.set(event.pubkey, [event])
      stats.events++
    }
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
      const listKinds = kinds.filter((k) => listSupported.includes(k))
      if (listKinds.length && files.length) {
        const sql = `SELECT lower(hex(source)) AS pubkey, kind, lower(hex(list_id)) AS id,
                            CAST(list_created_at AS DOUBLE) AS created_at,
                            list(lower(hex(target))) AS targets
                     FROM edges WHERE kind IN (${listKinds.join(', ')}) AND ${predicate}
                     GROUP BY ALL`
        const result = await conn.stream(sql)
        for (;;) {
          const chunk = await result.fetchChunk()
          if (!chunk || chunk.rowCount === 0) break
          const t0 = Date.now()
          for (const row of chunk.getRows() as any[][]) {
            const targets = (row[4]?.items ?? []) as string[]
            add({
              id: row[2] as string,
              pubkey: intern(row[0] as string),
              kind: Number(row[1]),
              created_at: Number(row[3]),
              tags: targets.map((t) => ['p', intern(t)]),
              content: '',
              sig: '',
            })
            stats.edges += targets.length
          }
          converting += Date.now() - t0
        }
      }
      const wanted = kinds.filter((k) => byKind.has(k)).flatMap((k) => byKind.get(k)!)
      if (wanted.length && relationFiles.length) {
        const sql = `SELECT lower(hex(source)) AS pubkey, relation,
                            list(lower(hex(target))) AS targets, list(attr) AS attrs,
                            CAST(max(last_at) AS DOUBLE) AS created_at
                     FROM acts WHERE relation IN (${wanted.map((r) => quote(r.name)).join(', ')}) AND ${predicate}
                     GROUP BY ALL`
        const result = await conn.stream(sql)
        for (;;) {
          const chunk = await result.fetchChunk()
          if (!chunk || chunk.rowCount === 0) break
          const t0 = Date.now()
          for (const row of chunk.getRows() as any[][]) {
            const pubkey = intern(row[0] as string)
            const name = row[1] as string
            const targets = (row[2]?.items ?? []) as string[]
            const attrs = (row[3]?.items ?? []) as (string | null)[]
            for (const relation of wanted.filter((r) => r.name === name)) {
              const tags: string[][] = []
              for (let i = 0; i < targets.length; i++) {
                for (const tag of fillTags(relation.tags, intern(targets[i]), attrs[i] ?? null)) tags.push(tag)
              }
              add({
                id: createHash('sha256').update(`${name}:${pubkey}:${relationsRun?.run ?? ''}`).digest('hex'),
                pubkey,
                kind: relation.kind,
                created_at: Number(row[4]),
                tags,
                content: '',
                sig: '',
              })
              stats.edges += targets.length
            }
          }
          converting += Date.now() - t0
        }
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
    const kinds = (filter.kinds ?? []).filter((k) => heldKinds.includes(k))
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

  // The archive side: what is held, whether it is there, what it is
  function covers(filter: NostrFilter): boolean {
    for (const key of Object.keys(filter)) {
      if (!FILTER_KEYS.has(key) && (filter as any)[key] !== undefined) return false
    }
    const kinds = filter.kinds ?? []
    return kinds.length > 0 && kinds.every((k) => heldKinds.includes(k))
  }

  async function ping(): Promise<boolean> {
    if (closed) return false
    if (url) {
      try {
        const name = files.length ? 'lists-manifest.json' : 'relations-manifest.json'
        const response = await fetch(`${url}/${name}`, { method: 'HEAD', signal: AbortSignal.timeout(timeoutMs) })
        return response.ok
      } catch {
        return false
      }
    }
    const first = files[0] ?? relationFiles[0]
    return /^(https?|s3):\/\//.test(first) ? true : fs.existsSync(first)
  }

  function describe(): string {
    const lists = files.length ? `lists run ${run ?? '?'} ${when(referenceTime)}` : 'no lists'
    const acts = relationsRun
      ? `relations ${relations.map((r) => r.name).join(',') || 'none'} run ${relationsRun.run ?? '?'} ${when(relationsRun.referenceTime)}`
      : 'no relations'
    return `lake ${stats.where}: ${lists}; ${acts}`
  }

  return { source, covers, ping, describe, close, stats: () => ({ ...stats, kinds: [...stats.kinds] }) }
}
