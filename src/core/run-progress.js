// Cold-start budgets use the sampled Windows CPU run; completed runs refine them.
export const PROGRESS_WEIGHTS = {
  scanning: 0.12, metrics: 0.19, embedding: 0.02, faces: 0.055,
  pose: 0.30, focus: 0.305, grouping: 0.005, ranking: 0.005,
};
const stages = Object.keys(PROGRESS_WEIGHTS);

export function measuredWeights(runs = []) {
  const recent = runs.filter(run => run.status === 'completed' && !run.progress?.cached && stages.every(stage =>
    Number.isFinite(run.progress?.stageDurationsMs?.[stage]) && run.progress.stageDurationsMs[stage] > 0)).slice(0, 5);
  if (!recent.length) return null;
  const weights = Object.fromEntries(stages.map(stage => [stage, 0]));
  for (const run of recent) {
    const total = stages.reduce((sum, stage) => sum + run.progress.stageDurationsMs[stage], 0);
    for (const stage of stages) weights[stage] += run.progress.stageDurationsMs[stage] / total / recent.length;
  }
  return weights;
}

export class RunProgress {
  constructor({ now = () => performance.now(), weights = PROGRESS_WEIGHTS,
    windowMs = 30000, warmupMs = 5000, minCompleted = 3 } = {}) {
    this.now = now;
    this.started = now();
    this.weights = { ...PROGRESS_WEIGHTS, ...weights };
    this.stages = [...stages];
    const sum = Object.values(this.weights).reduce((a, b) => a + b, 0);
    for (const stage of stages) this.weights[stage] /= sum;
    this.windowMs = windowMs;
    this.warmupMs = warmupMs;
    this.minCompleted = minCompleted;
    this.durations = {};
    this.samples = [];
    this.overall = 0;
  }

  update(progress) {
    const now = this.now();
    if (progress.stage === 'observations' && !this.stages.includes('observations')) {
      this.stages.splice(this.stages.indexOf('grouping'), 0, 'observations');
      for (const stage of stages) this.weights[stage] *= .995;
      this.weights.observations = .005;
    }
    const index = this.stages.indexOf(progress.stage);
    if (this.stage !== progress.stage) {
      if (this.stage) this.durations[this.stage] = (this.durations[this.stage] || 0) + now - this.stageStarted;
      this.stage = progress.stage;
      this.stageStarted = now;
      this.samples = [];
      this.phase = progress.phase;
      this.total = progress.total;
    }
    // Scanning has multiple passes and totals; never mix their throughput samples.
    if (this.phase !== progress.phase || this.total !== progress.total) {
      this.samples = [];
      this.phase = progress.phase;
      this.total = progress.total;
    }
    const completed = Math.max(0, Number(progress.completed) || 0);
    const total = Math.max(0, Number(progress.total) || 0);
    const fraction = total ? Math.min(1, completed / total) : 0;
    const prefix = this.stages.slice(0, Math.max(0, index)).reduce((sum, stage) => sum + this.weights[stage], 0);
    const weighted = index < 0 ? 0 : prefix + this.weights[progress.stage] * fraction;
    this.overall = progress.stage === 'done' ? 1 : Math.max(this.overall, Math.min(0.999, weighted));
    if (this.samples.length && completed < this.samples.at(-1).completed) this.samples = [];
    this.samples.push({ at: now, completed });
    while (this.samples.length > 1 && this.samples[1].at <= now - this.windowMs) this.samples.shift();
    const first = this.samples[0];
    const delta = completed - first.completed;
    const span = now - first.at;
    const rate = span >= this.warmupMs && delta >= this.minCompleted ? delta / (span / 1000) : null;
    const remaining = rate && total && index >= 0 && completed < total
      ? (1 - weighted) / (this.weights[progress.stage] * rate / total) : null;
    const durations = { ...this.durations };
    if (index >= 0) durations[progress.stage] = (durations[progress.stage] || 0) + now - this.stageStarted;
    this.last = { ...progress, overallPercent: this.overall * 100,
      elapsedSeconds: (now - this.started) / 1000,
      stageRatePerSecond: progress.stage === 'done' ? null : rate,
      remainingSeconds: progress.stage === 'done' ? 0 : remaining == null ? null : Math.ceil(remaining),
      stageDurationsMs: durations, stageWeights: { ...this.weights } };
    return this.last;
  }

  snapshot() { return this.update(this.last || { stage: 'scanning', completed: 0, total: 0, cached: 0 }); }
}
