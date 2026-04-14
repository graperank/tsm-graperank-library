/**
 * Request Metrics Collection
 * 
 * Collects structured metrics throughout request processing for performance analysis
 */

export interface RelayMetrics {
  relay: string
  events: number
  time_ms: number
  error?: string
}

export interface DOSMetrics {
  dos: number
  actors: number
  events_fetched: number
  fetch_time_ms: number
  interactions_interpreted: number
  interpret_time_ms: number
  relays: RelayMetrics[]
}

export interface CalculatorIterationMetrics {
  iteration: number
  calculated: number
  uncalculated: number
  dos_breakdown: Record<number, { calculated: number; uncalculated: number; average_rank: number }>
}

export interface PhaseMetrics {
  phase: 'interpretation' | 'calculation' | 'output'
  start_time: number
  end_time?: number
  duration_ms?: number
}

export interface RequestMetrics {
  request_id: string
  start_time: number
  end_time?: number
  total_duration_ms?: number
  
  // Phase timing
  phases: PhaseMetrics[]
  
  // Interpretation metrics
  interpretation: {
    total_interactions: number
    total_interpreters: number
    dos_metrics: DOSMetrics[]
  }
  
  // Calculation metrics
  calculation: {
    total_rankings: number
    iterations: number
    iteration_metrics: CalculatorIterationMetrics[]
  }
  
  // Output metrics
  output: {
    total_pages: number
    total_rankings: number
  }
  
  // Infrastructure info
  infrastructure: {
    node_version: string
    heap_size_mb?: number
    total_memory_mb?: number
  }
}

export class MetricsCollector {
  private metrics: RequestMetrics
  private currentPhase?: PhaseMetrics

  constructor(requestId: string) {
    this.metrics = {
      request_id: requestId,
      start_time: Date.now(),
      phases: [],
      interpretation: {
        total_interactions: 0,
        total_interpreters: 0,
        dos_metrics: []
      },
      calculation: {
        total_rankings: 0,
        iterations: 0,
        iteration_metrics: []
      },
      output: {
        total_pages: 0,
        total_rankings: 0
      },
      infrastructure: {
        node_version: process.version,
        heap_size_mb: process.env.NODE_OPTIONS?.includes('--max-old-space-size')
          ? parseInt(process.env.NODE_OPTIONS.match(/--max-old-space-size=(\d+)/)?.[1] || '0') / 1024
          : undefined,
        total_memory_mb: process.env.TOTAL_MEMORY_MB ? parseInt(process.env.TOTAL_MEMORY_MB) : undefined
      }
    }
  }

  startPhase(phase: 'interpretation' | 'calculation' | 'output'): void {
    this.currentPhase = {
      phase,
      start_time: Date.now()
    }
    this.metrics.phases.push(this.currentPhase)
  }

  endPhase(): void {
    if (this.currentPhase) {
      this.currentPhase.end_time = Date.now()
      this.currentPhase.duration_ms = this.currentPhase.end_time - this.currentPhase.start_time
      this.currentPhase = undefined
    }
  }

  addDOSMetrics(metrics: DOSMetrics): void {
    this.metrics.interpretation.dos_metrics.push(metrics)
  }

  setInterpretationTotals(interactions: number, interpreters: number): void {
    this.metrics.interpretation.total_interactions = interactions
    this.metrics.interpretation.total_interpreters = interpreters
  }

  addCalculatorIteration(metrics: CalculatorIterationMetrics): void {
    this.metrics.calculation.iterations++
    this.metrics.calculation.iteration_metrics.push(metrics)
  }

  setCalculationTotals(rankings: number): void {
    this.metrics.calculation.total_rankings = rankings
  }

  setOutputTotals(pages: number, rankings: number): void {
    this.metrics.output.total_pages = pages
    this.metrics.output.total_rankings = rankings
  }

  finalize(): RequestMetrics {
    this.metrics.end_time = Date.now()
    this.metrics.total_duration_ms = this.metrics.end_time - this.metrics.start_time
    return this.metrics
  }

  toJSON(): string {
    return JSON.stringify(this.metrics)
  }

  getMetrics(): RequestMetrics {
    return this.metrics
  }
}
