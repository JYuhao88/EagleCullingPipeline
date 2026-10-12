// View-only adjustments: rendered with an SVG filter on the displayed image; originals and scores never change.
export const ADJUSTMENT_RANGES = Object.freeze({ exposure: [-3, 3], contrast: [-1, 1], highlights: [-1, 1],
  shadows: [-1, 1], temperature: [-1, 1], tint: [-1, 1], saturation: [-1, 1] });
export const DEFAULT_ADJUSTMENTS = Object.freeze({ exposure: 0, contrast: 0, highlights: 0, shadows: 0,
  temperature: 0, tint: 0, saturation: 0 });
export const ADJUSTMENT_LABELS = Object.freeze({ exposure: '曝光', contrast: '对比度', highlights: '高光', shadows: '阴影',
  temperature: '色温', tint: '色调', saturation: '饱和度' });
const CURVE_POINTS = 33;

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

export function adjustmentsAreIdentity(value) { return Object.keys(normalizeAdjustments(value)).length === 0; }

// Tone curve on display-referred values: contrast is an S-curve; shadows/highlights bend the lower/upper thirds.
export function toneCurve(value = {}, points = CURVE_POINTS) {
  const a = { ...DEFAULT_ADJUSTMENTS, ...normalizeAdjustments(value) };
  const curve = [];
  let previous = 0;
  for (let i = 0; i < points; i++) {
    const x = i / (points - 1);
    let y = x - a.contrast * 0.12 * Math.sin(2 * Math.PI * x)
      + a.shadows * 0.45 * x * (1 - x) ** 2 + a.highlights * 0.45 * x ** 2 * (1 - x);
    y = Math.min(1, Math.max(previous, y));
    curve.push(previous = y);
  }
  return curve;
}

export function channelGains(value = {}) {
  const a = { ...DEFAULT_ADJUSTMENTS, ...normalizeAdjustments(value) };
  const exposure = 2 ** a.exposure;
  return { r: exposure * (1 + 0.25 * a.temperature), g: exposure * (1 - 0.2 * a.tint), b: exposure * (1 - 0.25 * a.temperature) };
}

const fixed = number => Number(number.toFixed(4));

export function adjustmentFilterMarkup(value = {}, id = 'ec-adjust') {
  const gains = channelGains(value);
  const curve = toneCurve(value).map(fixed).join(' ');
  const saturation = fixed(1 + clampAdjustment('saturation', value?.saturation));
  return `<filter id="${id}" x="0" y="0" width="100%" height="100%">`
    + `<feComponentTransfer color-interpolation-filters="linearRGB"><feFuncR type="linear" slope="${fixed(gains.r)}"/>`
    + `<feFuncG type="linear" slope="${fixed(gains.g)}"/><feFuncB type="linear" slope="${fixed(gains.b)}"/></feComponentTransfer>`
    + `<feColorMatrix type="saturate" values="${saturation}" color-interpolation-filters="linearRGB"/>`
    + `<feComponentTransfer color-interpolation-filters="sRGB"><feFuncR type="table" tableValues="${curve}"/>`
    + `<feFuncG type="table" tableValues="${curve}"/><feFuncB type="table" tableValues="${curve}"/></feComponentTransfer>`
    + `</filter>`;
}

const toLinear = v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;

// Median display luminance pushed to middle grey (18 % linear). Samples are 0..1 sRGB luma values.
export function autoExposure(samples = []) {
  const values = samples.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!values.length) return 0;
  const median = toLinear(Math.min(1, Math.max(0.002, values[Math.floor(values.length / 2)])));
  return Math.round(clampAdjustment('exposure', Math.log2(0.18 / median)) * 100) / 100;
}

export function lumaSamples(context, width, height, step = 4) {
  const data = context.getImageData(0, 0, width, height).data;
  const samples = [];
  for (let i = 0; i < data.length; i += 4 * step) samples.push((0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255);
  return samples;
}
