// Read-only audit through Eagle Web API; never saves items or opens photo files.
import { EagleApi } from "../src/eagle-api.js";
import { buildCaptureIndex } from "../src/plugin/capture-units.js";
import { reviewStateFromTags } from "../src/plugin/review-model.js";
import { planCaptureAnalysis } from "../src/plugin/capture-analysis.js";

const api = new EagleApi();
const startedAt = performance.now();
const catalogue = [];
// This installed Eagle returns HTTP 500 "fields.forEach is not a function"
// for the documented GET fields syntax. Paginate without fields and project
// in memory instead; still never read image contents or mutate the library.
for await (const item of api.items({ limit: 1000 })) {
  const { id, name, ext, folders, tags, modificationTime } = item;
  catalogue.push({ id, name, ext, folders, tags, modifiedAt: modificationTime });
}
const byId = new Map(catalogue.map((item) => [item.id, item]));
const index = buildCaptureIndex(catalogue);
const units = [...new Map([...index.values()].map((unit) => [unit.id, unit])).values()];
const paired = units.filter((unit) => unit.status === "paired");
const mismatches = paired.filter((unit) => new Set(unit.itemIds.map((id) => reviewStateFromTags(byId.get(id).tags))).size > 1);
const imageExtensions = new Set(["jpg","jpeg","png","webp","gif","heic","heif","3fr","arw","dng","cr2","cr3","nef","raf","orf","rw2","tif","tiff"]);
const imageItems = catalogue.filter((item) => imageExtensions.has(String(item.ext).toLowerCase()));
const analysisUnits = planCaptureAnalysis(catalogue,imageItems).length;
console.log(JSON.stringify({
  items: catalogue.length,
  pairedUnits: paired.length,
  uncertainUnits: units.filter((unit) => unit.status === "uncertain").length,
  pairedStateMismatches: mismatches.length,
  imageFiles: imageItems.length,
  plannedAnalysisUnits: analysisUnits,
  avoidedDuplicateAnalyses: imageItems.length-analysisUnits,
  elapsedMs: Math.round(performance.now() - startedAt),
  mismatchIds: mismatches.map((unit) => unit.itemIds),
}, null, 2));
