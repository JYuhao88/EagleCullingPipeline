const RAW = new Set(["arw", "dng", "nef", "cr2", "cr3", "raf", "orf", "rw2", "3fr"]);
const PREVIEW = new Set(["jpg", "jpeg", "heic", "heif"]);
const extension = (item) => String(item.ext || "").toLowerCase().replace(/^\./, "");
const nameKey = (item) => {
  const name = String(item.name || "").trim().toLowerCase();
  const suffix = `.${extension(item)}`;
  return name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;
};

// Whole-library names and folder compatibility are conservative pairing evidence,
// not proof from camera EXIF. Ambiguous names never trigger paired writes.
export function buildCaptureIndex(items) {
  const names = new Map();
  const byId = new Map();
  for (const item of items) {
    byId.set(item.id, { id: `single:${item.id}`, itemIds: [item.id], status: "single" });
    if ((!RAW.has(extension(item)) && !PREVIEW.has(extension(item))) || !nameKey(item)) continue;
    const key = nameKey(item);
    if (!names.has(key)) names.set(key, []);
    names.get(key).push(item);
  }
  for (const [name, members] of names) {
    const raw = members.filter((item) => RAW.has(extension(item)));
    const preview = members.filter((item) => PREVIEW.has(extension(item)));
    if (!raw.length || !preview.length) continue;
    const commonFolder = !raw[0].folders?.length || !preview[0].folders?.length || raw[0].folders.some((folder) => preview[0].folders.includes(folder));
    const compatible = preview.length === 1 && (["jpg", "jpeg"].includes(extension(preview[0])) || extension(raw[0]) === "3fr");
    const paired = members.length === 2 && raw.length === 1 && preview.length === 1 && commonFolder && compatible;
    const unit = { id: `capture:${name}`, itemIds: members.map((item) => item.id), status: paired ? "paired" : "uncertain", formats: members.map(extension) };
    for (const item of members) byId.set(item.id, unit);
  }
  return byId;
}
