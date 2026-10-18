import { ruleObservations } from './observations-rules.js';

export const observationBox = box => Array.isArray(box) && box.length === 4
  && box.every(value => Number.isFinite(value) && value >= 0 && value <= 1) && box[2] > box[0] && box[3] > box[1];

export function validObservation(item) {
  return typeof item?.id === 'string' && item.id.length > 0 && typeof item.text === 'string' && item.text.trim().length > 0
    && [...item.text].length <= 12 && ['good', 'bad', 'neutral'].includes(item.tone) && ['rule', 'model'].includes(item.source)
    && (item.source !== 'model' || Number.isFinite(item.confidence) && item.confidence >= 0 && item.confidence <= 1)
    && (item.box === undefined || observationBox(item.box));
}

// Closed eyes decide a pick most often, then the learned expression observations; the other rules fill the rest.
const LEAD_RULES = new Set(['eyes-closed']);

export function observationsFor(result = {}, { rules = ruleObservations } = {}) {
  const seen = new Set();
  const ruleItems = rules(result).filter(item => item?.source === 'rule');
  const ruleIds = new Set(ruleItems.map(item => item.id));
  const model = (Array.isArray(result.observations?.items) ? result.observations.items : [])
    .filter(item => item?.source === 'model' && !ruleIds.has(item.id));
  return [...ruleItems.filter(item => LEAD_RULES.has(item.id)), ...model,
    ...ruleItems.filter(item => !LEAD_RULES.has(item.id))].filter(item => {
    if (!validObservation(item) || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  }).slice(0, 4);
}
