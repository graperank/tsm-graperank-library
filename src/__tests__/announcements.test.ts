import { generateServiceAnnouncement } from '../tsm/announcements'
import { setArchive } from '../nostr-interpreters/event-source'

describe('the service announcement tells about the archive-first mode', () => {
  afterEach(() => setArchive(undefined))

  test('the liveNetwork config is always announced, default false', () => {
    const event = generateServiceAnnouncement({ identifier: 'graperank' })
    const config = event.tags.find((t) => t[0] === 'config' && t[1] === 'liveNetwork')
    expect(config).toBeDefined()
    expect(config![2]).toBe('boolean')
    expect(config![4]).toBe('false')
    expect(event.tags.find((t) => t[0] === 'info' && t[1] === 'archive')).toBeUndefined()
  })

  test('with an archive registered, an info tag describes it', () => {
    setArchive({ source: async () => new Set(), covers: () => true, ping: async () => true, describe: () => 'lake http://lake.test: lists run r1 as of 2026-09-29 01:34 UTC; no relations' })
    const event = generateServiceAnnouncement({ identifier: 'graperank' })
    expect(event.tags).toContainEqual(['info', 'archive', 'lake http://lake.test: lists run r1 as of 2026-09-29 01:34 UTC; no relations'])
  })
})
