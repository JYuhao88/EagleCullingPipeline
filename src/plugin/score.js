const metrics = [
  ["sharpness", "清晰度"],
  ["exposure", "曝光"],
  ["eyesOpen", "睁眼"],
  ["quality", "质量"],
  ["aesthetic", "美学"]
];

export function percentScore(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
  return String(Math.round(Number(value) <= 1 ? Number(value) * 100 : Number(value)));
}

function eyesOpen(metrics) {
  if (!Number.isFinite(metrics.faces) || metrics.faces <= 0 || !Number.isFinite(metrics.eyesClosed)) return null;
  return Math.max(0, 1 - metrics.eyesClosed / metrics.faces);
}

export function scoreParts(result = {}) {
  const source = result.metrics || {};
  return metrics.map(([key, label]) => {
    const value = key === "eyesOpen" ? eyesOpen(source) : source[key] ?? null;
    return { key, label, value, display: percentScore(value) };
  });
}

export function formatTotalScore(value) {
  return value === null || value === undefined ? "—" : `${percentScore(value)} 分`;
}
