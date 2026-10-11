// Supplementary function-level calibration; never presented as browser actions.
import { fitPreferenceHead, driftReport } from '../src/core/preference-head.js';
export function calibrateDrift({ trials = 200, seed = 919 } = {}) {
  let state = seed;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
  const group = (i, agreement) => ({ id: `g-${i}`, time: i, signal: 'explicit', winners: [agreement ? `d-${i}` : `b-${i}`],
    candidates: [{ hash: `d-${i}`, feature: { metrics: { brightness: 0.2 } }, baselineScore: 0.2 },
      { hash: `b-${i}`, feature: { metrics: { brightness: 0.8 } }, baselineScore: 0.8 }] });
  const head = fitPreferenceHead(Array.from({ length: 60 }, (_, i) => group(i, true)));
  return { method: 'function-level independent stationary Bernoulli windows; not UI or deployment FPR', seed, trials,
    conditions: [0.24, 0.6, 0.9].map(agreement => {
      let falseAlarms = 0;
      for (let t = 0; t < trials; t++) {
        const groups = Array.from({ length: 50 }, (_, i) => group(i, random() < agreement));
        if (driftReport(groups, head).detected) falseAlarms++;
      }
      return { agreement, falseAlarms, windows: trials, falseAlarmRate: falseAlarms / trials };
    }) };
}
