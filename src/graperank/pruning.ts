import type { actorId, CalculatorParams, PruneParams } from './types'

/**
 * Effective settings for pruning newly discovered actors between degrees
 * of separation. `threshold` is an absolute interim-rank cutoff derived
 * from `prune.minimumFraction * calculatorParams.minimum`; `cap` is the
 * maximum number of actors to expand per iteration. 0 means "off".
 */
export type PruneSettings = {
  threshold: number
  cap: number
}

export function resolvePruneSettings(
  prune?: PruneParams,
  calculatorParams?: Partial<CalculatorParams>,
): PruneSettings {
  const minimum = calculatorParams?.minimum ?? 0
  const fraction = prune?.minimumFraction ?? 0
  const threshold = fraction > 0 && minimum > 0 ? fraction * minimum : 0
  const cap = prune?.maxActors && prune.maxActors > 0 ? Math.floor(prune.maxActors) : 0
  return { threshold, cap }
}

export function isPruningEnabled(settings: PruneSettings): boolean {
  return settings.threshold > 0 || settings.cap > 0
}

/**
 * Choose which candidate actors to expand at the next degree of
 * separation. Candidates are `[actorId, interimRank]`; actors without an
 * interim rank should be passed with rank 0.
 *
 * 1. Drop candidates below `threshold` (when > 0).
 * 2. If more than `cap` remain (when > 0), keep the `cap` highest ranks;
 *    ties are broken by actor id so the selection is deterministic.
 *
 * Returns the kept actor ids in no particular order.
 */
export function selectActorsToExpand(
  candidates: Array<[actorId, number]>,
  settings: PruneSettings,
): Set<actorId> {
  let kept = settings.threshold > 0
    ? candidates.filter(([, rank]) => rank >= settings.threshold)
    : [...candidates]

  if (settings.cap > 0 && kept.length > settings.cap) {
    kept.sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    kept = kept.slice(0, settings.cap)
  }

  return new Set(kept.map(([actor]) => actor))
}
