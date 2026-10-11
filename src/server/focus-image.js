import path from "node:path";
import { completeEyeRois } from "../core/eye-roi.js";
import { nativeCrop, normalizedRect } from "../core/native-image.js";

export function focusRegionBox(face, region) {
  if (region === "face") return normalizedRect(face?.box, 1, 1) ? face.box : null;
  if (region !== "eyes") return null;
  const explicit = face?.eyeBox || face?.eyesBox;
  if (normalizedRect(explicit, 1, 1)) return explicit;
  const eyes = face?.eyes || face?.eyeBoxes;
  const boxes = (Array.isArray(eyes) ? eyes : []).map(eye => eye?.box || eye)
    .filter(box => normalizedRect(box, 1, 1));
  if (!boxes.length) return null;
  return [Math.min(...boxes.map(b => b[0])), Math.min(...boxes.map(b => b[1])),
    Math.max(...boxes.map(b => b[2])), Math.max(...boxes.map(b => b[3]))];
}

export async function focusCropImage(store, id, unitId, faceIndex, region, state) {
  const unit = state.units?.find(item => item.id === unitId);
  const result = state.results?.find(item => item.unitId === unitId);
  const face = completeEyeRois(result?.faces, result?.signals?.persons)[faceIndex];
  const box = focusRegionBox(face, region);
  if (!box) return { available: false, naReason: region === "eyes" ? "eye-landmarks-unavailable" : "face-unavailable" };
  const items = state.items?.filter(item => (unit?.itemIds || [unit?.primaryItemId]).includes(item.id)) || [];
  const primary = items.find(item => item.id === unit?.primaryItemId);
  if (!primary) return { available: false, naReason: "native-source-unavailable" };
  return nativeCrop(primary, box, { pairedItems: items.filter(item => item !== primary),
    cacheDir: path.join(store.root || path.dirname(store.dir(id)), "focus-crops") });
}
