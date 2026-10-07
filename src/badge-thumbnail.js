import { mkdir } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const STATUS_LABELS = new Map([
  ["AI精选", { text: "精选", color: "#1f9d68" }],
  ["AI候选", { text: "候选", color: "#b98016" }],
  ["待复核", { text: "待复核", color: "#b94b52" }],
]);
const ISSUE_LABELS = new Map([
  ["AI闭眼", "闭眼"],
  ["AI过曝", "过曝"],
  ["AI欠曝", "欠曝"],
  ["AI可能模糊", "模糊"],
  ["AI低分辨率", "低分辨率"],
]);

function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[character]));
}

export function badgeLabels(tags = []) {
  const status = tags.map((tag) => STATUS_LABELS.get(tag)).find(Boolean) || null;
  const issues = [...new Set(tags.map((tag) => ISSUE_LABELS.get(tag)).filter(Boolean))];
  return { status, issues };
}

export function badgeSvg(tags = []) {
  const { status, issues } = badgeLabels(tags);
  const labels = [];
  if (status) labels.push({ text: status.text, color: status.color });
  for (const issue of issues.slice(0, 2)) labels.push({ text: issue, color: "#596675" });
  if (!labels.length) return null;
  const widths = labels.map(({ text }) => Math.max(62, 22 + text.length * 18));
  const width = widths.reduce((sum, value) => sum + value + 6, 8);
  const chips = labels.map(({ text, color }, index) => {
    const x = widths.slice(0, index).reduce((sum, value) => sum + value + 6, 8);
    return `<rect x="${x}" y="8" width="${widths[index]}" height="32" rx="7" fill="${color}" fill-opacity=".94"/><text x="${x + widths[index] / 2}" y="30" text-anchor="middle" fill="#fff" font-family="Microsoft YaHei, Noto Sans CJK SC, sans-serif" font-size="16" font-weight="700">${escapeXml(text)}</text>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="48"><rect width="${width}" height="48" rx="9" fill="#111820" fill-opacity=".58"/>${chips}</svg>`;
}

export async function createBadgeThumbnail({ sourcePath, outputPath, tags }) {
  if (!sourcePath || !outputPath) throw new Error("sourcePath and outputPath are required");
  const overlay = badgeSvg(tags);
  if (!overlay) return { outputPath: null, skipped: true };
  await mkdir(path.dirname(outputPath), { recursive: true });
  const source = sharp(sourcePath, { failOn: "none" });
  const metadata = await source.metadata();
  const overlayWidth = Number(overlay.match(/width="(\d+)"/)?.[1] || 320);
  const maxOverlayWidth = Math.max(40, Math.min(overlayWidth, (metadata.width || 1200) - 28));
  const overlayBuffer = maxOverlayWidth < overlayWidth
    ? await sharp(Buffer.from(overlay)).resize({ width: maxOverlayWidth }).png().toBuffer()
    : Buffer.from(overlay);
  await source
    .resize({ width: 1200, height: 1200, fit: "inside", withoutEnlargement: true })
    .composite([{ input: overlayBuffer, gravity: "southwest" }])
    .png()
    .toFile(outputPath);
  return { outputPath, skipped: false };
}

export { ISSUE_LABELS, STATUS_LABELS };
