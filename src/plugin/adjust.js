export const ADJUSTMENT_RANGES = Object.freeze({ exposure: [-3, 3], contrast: [-1, 1], highlights: [-1, 1],
  shadows: [-1, 1], whites: [-1, 1], blacks: [-1, 1], temperature: [-1, 1], tint: [-1, 1], saturation: [-1, 1] });
export const DEFAULT_ADJUSTMENTS = Object.freeze({ exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0,
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

export const toLinear = v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
export const toSrgb = v => v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
const clamp01 = v => Math.min(1, Math.max(0, v));
// Full-scale white balance moves each channel by this many stops, with luminance held constant.
const WB_STOPS = 0.35;

// Per-channel gains on linear light: warmer raises red and lowers blue; positive tint (magenta) lowers green.
export function whiteBalanceGains({ temperature = 0, tint = 0 } = {}) {
  const r = 2 ** (WB_STOPS * temperature), g = 2 ** (-WB_STOPS * tint), b = 2 ** (-WB_STOPS * temperature);
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return [r / y, g / y, b / y];
}

// Global tone curve on sRGB-encoded values, in Lightroom's order: contrast about the middle, highlights and shadows as bumps
// centred on 2/3 and 1/3, then the white and black points. Every term keeps the curve non-decreasing at full scale.
export function toneCurve(v, { contrast = 0, highlights = 0, shadows = 0, whites = 0, blacks = 0 } = {}) {
  v += 0.6 * contrast * (v * v * (3 - 2 * v) - v);
  v += 0.25 * 6.75 * (shadows * v * (1 - v) ** 2 + highlights * v * v * (1 - v));
  const inBlack = Math.max(0, -0.1 * blacks), outBlack = Math.max(0, 0.1 * blacks);
  const inWhite = 1 - Math.max(0, 0.1 * whites), outWhite = 1 - Math.max(0, -0.1 * whites);
  return outBlack + (outWhite - outBlack) * clamp01((v - inBlack) / (inWhite - inBlack));
}

// One 256-entry table per channel maps each 8-bit sRGB input straight to its output, so the browser never stores
// linear light in 8 bits (which posterises the shadows). Exposure and white balance act on linear light; highlights a
// display-referred preview has already clipped stay clipped.
export function adjustmentTables(value = {}) {
  const adjustments = normalizeAdjustments(value);
  const gain = 2 ** (adjustments.exposure || 0);
  return whiteBalanceGains(adjustments).map(channel => Array.from({ length: 256 }, (_, i) =>
    clamp01(toneCurve(toSrgb(Math.min(1, toLinear(i / 255) * channel * gain)), adjustments))));
}

export const isNeutral = value => !Object.keys(normalizeAdjustments(value)).length;
