#!/usr/bin/env python3
"""在临时 Python 环境离线计算 CLIP 文本向量；运行时无需 Python 或文本模型。"""

import hashlib
import json
from pathlib import Path
import sys

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer


REVISION = "d15189d7028b43f1d3e65039190477f6af591c2a"
VOCABULARY = [
  ("海边", ["a photo of the seaside coastline", "a photo of the ocean shore"]),
  ("沙滩", ["a photo of a sandy beach", "a photo of people on a beach"]),
  ("街道", ["a photo of a city street", "a street photography photo"]),
  ("老街", ["a photo of a traditional old street", "a photo of a historic Chinese street"]),
  ("市集", ["a photo of a busy outdoor market", "a photo of market stalls"]),
  ("建筑", ["an architectural photograph of a building", "a photo of building architecture"]),
  ("寺庙", ["a photo of a Buddhist temple", "a photo of a Chinese temple"]),
  ("室内", ["a photo of an indoor room", "a photo of an interior space"]),
  ("餐厅", ["a photo inside a restaurant", "a photo of a cafe interior"]),
  ("美食", ["a close-up photo of food", "a photo of a meal on a plate"]),
  ("夜景", ["a photo of a city at night", "a night street photograph"]),
  ("灯光", ["a photo of colorful lights at night", "a photo of illuminated neon lights"]),
  ("天空", ["a photo of a blue sky with clouds", "a photo of the cloudy sky"]),
  ("日落", ["a photo of an orange sunset", "a photo of the setting sun"]),
  ("雨天", ["a photo of a rainy street", "a photo of people with umbrellas in the rain"]),
  ("自然风光", ["a photo of a natural landscape", "a scenic photograph of nature"]),
  ("山", ["a photo of mountains", "a photo of a mountain landscape"]),
  ("树木花草", ["a photo of trees and plants", "a photo of flowers and greenery"]),
  ("动物", ["a photo of an animal", "a wildlife photograph"]),
  ("猫", ["a photo of a cat", "a photo of a kitten"]),
  ("狗", ["a photo of a dog", "a photo of a puppy"]),
  ("车辆", ["a photo of cars on the road", "a photo of a motor vehicle"]),
  ("自行车", ["a photo of a bicycle", "a photo of someone riding a bicycle"]),
  ("儿童", ["a photo of a young child", "a photo of children playing"]),
  ("老人", ["a photo of an elderly person", "a portrait of an elderly man or woman"]),
  ("人群", ["a photo of a crowd of people", "a photo of many people in a busy public place"]),
  ("骑楼", ["a photo of traditional Chinese shophouses with covered arcades", "a photo of a covered arcade street"]),
  ("招牌文字", ["a photo of shop signs with Chinese writing", "a photo of storefront signs and lettering"]),
  ("水面", ["a photo of a lake or river", "a photo of reflections on water"]),
  ("桥梁", ["a photo of a bridge", "an architectural photograph of a bridge"]),
  ("人像", ["a portrait photograph of a person", "a photo of a person posing for a portrait"]),
  ("花", ["a close-up photo of flowers", "a photo of blooming flowers"]),
]


def main():
  work = Path(sys.argv[1])
  output = Path(sys.argv[2] if len(sys.argv) > 2 else "src/core/scene-tags.json")
  tokenizer = Tokenizer.from_file(str(work / "tokenizer.json"))
  tokenizer.enable_padding(pad_id=1, pad_token="<|endoftext|>")
  options = ort.SessionOptions()
  options.intra_op_num_threads = 2
  session = ort.InferenceSession(str(work / "text_model.onnx"), options, providers=["CPUExecutionProvider"])
  labels = []
  for tag, prompts in VOCABULARY:
    encoded = tokenizer.encode_batch(prompts)
    ids = np.asarray([entry.ids for entry in encoded], dtype=np.int64)
    mask = np.asarray([entry.attention_mask for entry in encoded], dtype=np.int64)
    feeds = {"input_ids": ids, "attention_mask": mask}
    feeds = {entry.name: feeds[entry.name] for entry in session.get_inputs()}
    vectors = session.run(["text_embeds"], feeds)[0]
    vectors /= np.linalg.norm(vectors, axis=1, keepdims=True)
    vector = vectors.mean(axis=0)
    vector /= np.linalg.norm(vector)
    labels.append({"tag": "AI·" + tag, "prompts": prompts, "threshold": 0.27 if tag == "猫" else 0.28,
                   "vector": [round(float(value), 8) for value in vector]})
  document = {
    "model": "Xenova/clip-vit-base-patch32",
    "version": REVISION + ":scene-v1",
    "license": "MIT",
    "dimensions": 512,
    "modelFile": "models/clip/vision_model_quantized.onnx",
    "modelSha256": "583fd1110a514667812fee7d684952aaf82a99b959760c8d7dca7e0ab9839299",
    "textModelSha256": hashlib.sha256((work / "text_model.onnx").read_bytes()).hexdigest(),
    "preprocess": {"size": 224, "mean": [0.48145466, 0.4578275, 0.40821073],
                   "std": [0.26862954, 0.26130258, 0.27577711]},
    "maxTags": 3,
    "labels": labels,
  }
  output.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n")
  print(f"已导出 {len(labels)} 个标签，每个向量 {document['dimensions']} 维")


if __name__ == "__main__":
  main()
