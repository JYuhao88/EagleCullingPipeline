import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import sharp from "sharp";

let landmarkerPromise;
const require = createRequire(import.meta.url);

export async function createFaceLandmarker({ modelPath = process.env.EAGLE_FACE_MODEL || "models/mediapipe/face_landmarker.task" } = {}) {
  if (!landmarkerPromise) {
    landmarkerPromise = import("@mediapipe/tasks-vision").then(async ({ FaceLandmarker, FilesetResolver }) => {
      if (typeof globalThis.ImageData === "undefined") {
        globalThis.ImageData = class ImageData {
          constructor(data, width, height) { this.data = data; this.width = width; this.height = height; }
        };
      }
      const wasmPath = path.dirname(pathToFileURL(require.resolve("@mediapipe/tasks-vision/vision_wasm_internal.wasm")).pathname);
      const vision = await FilesetResolver.forVisionTasks(pathToFileURL(wasmPath).href);
      return FaceLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: path.resolve(modelPath) },
        runningMode: "IMAGE",
        numFaces: 10,
        outputFaceBlendshapes: true,
      });
    });
  }
  return landmarkerPromise;
}

export async function detectFaces(filePath, options = {}) {
  let landmarker;
  try {
    landmarker = await createFaceLandmarker(options);
  } catch (error) {
    return { available: false, faceCount: null, faces: [], error: error.message };
  }
  const image = await sharp(filePath).resize({ width: 1024, height: 1024, fit: "inside" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const rgba = new Uint8ClampedArray(image.info.width * image.info.height * 4);
  for (let i = 0, j = 0; i < image.data.length; i += image.info.channels, j += 4) {
    rgba[j] = image.data[i]; rgba[j + 1] = image.data[i + 1]; rgba[j + 2] = image.data[i + 2]; rgba[j + 3] = 255;
  }
  const result = landmarker.detect(new ImageData(rgba, image.info.width, image.info.height));
  return {
    available: true,
    faceCount: result.faceLandmarks?.length || 0,
    faces: (result.faceLandmarks || []).map((landmarks, index) => ({
      index,
      landmarkCount: landmarks.length,
      blendshapes: result.faceBlendshapes?.[index]?.categories?.filter((x) => /eyeBlink|jawOpen|mouthSmile/.test(x.categoryName)).map((x) => ({ name: x.categoryName, score: x.score })) || [],
    })),
  };
}
