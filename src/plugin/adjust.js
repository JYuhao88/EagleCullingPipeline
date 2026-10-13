export const ADJUSTMENT_RANGES = Object.freeze({ exposure: [-3, 3], contrast: [-1, 1], highlights: [-1, 1],
  shadows: [-1, 1], temperature: [-1, 1], tint: [-1, 1], saturation: [-1, 1] });
export const DEFAULT_ADJUSTMENTS = Object.freeze({ exposure: 0, contrast: 0, highlights: 0, shadows: 0,
  temperature: 0, tint: 0, saturation: 0 });
export function clampAdjustment(name, value) {
  const range = ADJUSTMENT_RANGES[name] || [-1, 1];
  const number = Number(value);
  return Math.min(range[1], Math.max(range[0], Number.isFinite(number) ? number : 0));
}

export function normalizeAdjustments(value = {}) {
  const next = {};
  for (const name of Object.keys(DEFAULT_ADJUSTMENTS)) {
    const number = Math.round(clampAdjustment(name, value?.[name] ?? 0) * 100) / 100;
    if (number !== 0) next[name] = number;
  }
  return next;
}
