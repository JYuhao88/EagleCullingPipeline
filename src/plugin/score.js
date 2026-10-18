export function percentScore(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
  return String(Math.round(Number(value) <= 1 ? Number(value) * 100 : Number(value)));
}
