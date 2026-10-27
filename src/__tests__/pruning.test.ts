import { resolvePruneSettings, selectActorsToExpand, isPruningEnabled } from '../graperank/pruning'

describe('pruning between degrees of separation', () => {
  test('is off unless a fraction with a positive minimum, or a cap, is given', () => {
    expect(isPruningEnabled(resolvePruneSettings(undefined, { minimum: 0.1 }))).toBe(false)
    expect(isPruningEnabled(resolvePruneSettings({ minimumFraction: 0.5 }, { minimum: 0 }))).toBe(false)
    expect(isPruningEnabled(resolvePruneSettings({ minimumFraction: 0.5 }, { minimum: 0.2 }))).toBe(true)
    expect(isPruningEnabled(resolvePruneSettings({ maxActors: 10 }, undefined))).toBe(true)
  })

  test('threshold is the fraction of the calculator minimum', () => {
    expect(resolvePruneSettings({ minimumFraction: 0.5 }, { minimum: 0.0001 }).threshold).toBeCloseTo(0.00005, 10)
    expect(resolvePruneSettings({ maxActors: 2.7 }, undefined).cap).toBe(2)
  })

  test('drops candidates below the threshold and keeps the rest', () => {
    const kept = selectActorsToExpand(
      [['a', 0.5], ['b', 0.05], ['c', 0.0001], ['d', 0]],
      { threshold: 0.05, cap: 0 },
    )
    expect([...kept].sort()).toEqual(['a', 'b'])
  })

  test('cap keeps the highest interim ranks with a deterministic tie-break', () => {
    const kept = selectActorsToExpand(
      [['z', 0.3], ['y', 0.3], ['x', 0.9], ['w', 0.1], ['v', 0.3]],
      { threshold: 0, cap: 3 },
    )
    expect([...kept].sort()).toEqual(['v', 'x', 'y'])
  })

  test('threshold applies before the cap', () => {
    const kept = selectActorsToExpand(
      [['a', 0.9], ['b', 0.8], ['c', 0.01], ['d', 0.02]],
      { threshold: 0.05, cap: 3 },
    )
    expect([...kept].sort()).toEqual(['a', 'b'])
  })

  test('cap is a no-op when fewer candidates than the cap', () => {
    const kept = selectActorsToExpand([['a', 0.1], ['b', 0.2]], { threshold: 0, cap: 5 })
    expect(kept.size).toBe(2)
  })
})
