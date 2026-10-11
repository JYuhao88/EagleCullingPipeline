#!/usr/bin/env python3
"""Parallel multi-facet search over the derived title/head index of the internal paper corpus (not public).

Runs as a Ray job. Each facet has its own EN/ZH lexicon plus an optional context
pattern that must also match, which suppresses generic-word noise ("pareto" in
materials science, "portrait" in avatar generation). Read-only on the corpus.
"""
from __future__ import annotations

import sys as _private_sys
from pathlib import Path as _PrivatePath
if 'ml.common.private_env' not in _private_sys.modules:
    _private_sys.path.insert(0, str(_PrivatePath(__file__).resolve().parents[2]))
from ml.common.private_env import setting, require_path
CORPUS = require_path('ECP_CORPUS_ROOT') + '/derived'
OUT = require_path('ECP_CEPH_ROOT') + '/research/facets'
import glob
import json
import os
import re
import time
from collections import defaultdict

import ray

# Index layout is private deployment configuration.
SOURCES = json.loads(setting("ECP_CORPUS_FACET_PATTERNS", '["index/en/*.parquet", "*.parquet"]'))
COLUMNS = ["title", "meta_title", "head", "dois", "arxiv", "origin", "sub_label", "id"]
PHOTO = r"photo|image|picture|aesthetic|camera|album|摄影|照片|图像|图片|美学|相册"

FACETS = {
    "series_selection": ([
        "photo triage", "triage", "photo series", "series photo", "burst photo", "burst image selection", "best shot", "best-shot",
        "photo selection", "image selection", "near-duplicate photo", "photo culling", "culling",
        "key photo", "representative photo", "连拍", "选片", "照片筛选", "最佳照片",
    ], PHOTO),
    "theme_aesthetics": ([
        "theme-aware", "theme aware", "category-aware", "content-aware aesthetic", "scene-aware aesthetic",
        "semantic-aware aesthetic", "genre", "photographic style", "style-specific", "content-adaptive aesthetic",
        "tad66k", "主题感知", "场景感知", "类别感知", "摄影风格",
    ], r"aesthetic|美学"),
    "aesthetic_attributes": ([
        "aesthetic attribute", "attribute-aware", "multi-attribute", "aadb", "para dataset", "eva dataset",
        "composition assessment", "cadb", "rule of thirds", "explainable aesthetic", "aesthetic caption",
        "美学属性", "构图评价", "可解释美学",
    ], r"aesthetic|composition|美学|构图"),
    "personalized_aesthetics": ([
        "personalized aesthetic", "personalized image aesthetic", "piaa", "user preference", "user-specific",
        "few-shot aesthetic", "meta-learning aesthetic", "preference learning", "个性化美学", "用户偏好",
    ], PHOTO),
    "portrait_face_quality": ([
        "portrait aesthetic", "portrait quality", "face quality", "facial expression", "smile", "eye blink",
        "closed eye", "eye closure", "facial attractiveness", "face image quality", "人像美学", "人脸质量",
        "表情", "闭眼",
    ], r"photo|image|portrait|aesthetic|quality|照片|图像|人像|美学"),
    "blur_defocus": ([
        "defocus", "bokeh", "depth of field", "motion blur", "blur detection", "intentional blur",
        "focus map", "out-of-focus", "blur map", "离焦", "景深", "运动模糊", "模糊检测",
    ], PHOTO),
    "multi_objective_selection": ([
        "pareto", "skyline", "multi-objective", "multi-criteria", "non-dominated", "diverse subset",
        "determinantal point process", "submodular", "diversity", "多目标", "帕累托", "多样性",
    ], PHOTO),
    "album_curation": ([
        "album summarization", "photo summarization", "photo curation", "event summarization",
        "personal photo collection", "photo collection", "photo book", "相册摘要", "照片管理", "相册",
    ], PHOTO),
    "iqa_aesthetic_models": ([
        "nima", "musiq", "topiq", "clip-iqa", "laion aesthetic", "q-align", "image aesthetic assessment",
        "no-reference image quality", "blind image quality", "aesthetic quality assessment",
        "图像美学评价", "无参考图像质量",
    ], None),
    "efficient_distillation": ([
        "knowledge distillation", "lightweight", "mobile", "on-device", "efficient", "linear probe",
        "frozen backbone", "dinov2", "clip embedding", "轻量", "蒸馏", "端侧",
    ], r"aesthetic|image quality|iqa|美学|图像质量"),
    "feedback_continual": ([
        "relevance feedback", "active learning", "continual learning", "incremental learning",
        "preference drift", "concept drift", "online learning", "human-in-the-loop", "interactive",
        "主动学习", "持续学习", "增量学习", "人机协同",
    ], r"aesthetic|photo|image quality|preference|美学|偏好|照片"),
    "lora_vlm_ranking": ([
        "lora", "low-rank adaptation", "adapter", "multimodal large language model", "vision-language",
        "mllm", "vlm", "reward model", "pairwise comparison", "visualquality-r1", "compare2score",
        "多模态大模型", "奖励模型",
    ], r"aesthetic|image quality|photo|iqa|preference|美学|图像质量|照片"),
    "pose_body_aesthetics": ([
        "human pose", "body pose", "posing", "pose recommendation", "pose guidance", "pose-aware", "body language",
        "body posture", "hand pose", "hand gesture", "hand quality", "keypoint", "skeleton", "full-body",
        "姿态", "体态", "摆姿", "手势", "人体关键点",
    ], r"aesthetic|photograph|portrait|composition|photo quality|美学|摄影|人像|构图"),
    "portrait_framing_crop": ([
        "image cropping", "aesthetic cropping", "photo cropping", "portrait cropping", "human-centric cropping",
        "headroom", "framing", "limb truncation", "amputation", "cut-off", "gaic", "fcdb", "cpc dataset",
        "composition-aware", "human-centric composition", "subject placement", "裁切", "裁剪", "取景", "构图",
    ], r"photo|image|portrait|aesthetic|composition|照片|图像|人像|美学"),
    "photography_technique": ([
        "photography technique", "photographic rule", "photographic technique", "professional photographer",
        "photography guidance", "photography assistant", "shooting guidance", "view recommendation",
        "viewpoint recommendation", "camera guidance", "photography knowledge", "photography skill",
        "photography education", "expert photographer", "摄影技巧", "摄影指导", "构图建议", "专业摄影", "摄影知识",
    ], PHOTO),
    "human_centric_aesthetics": ([
        "human-centric aesthetic", "human image aesthetic", "portrait photography", "people photo", "person image",
        "fashion photo", "street photography", "wedding photo", "headshot", "人像摄影", "街拍", "婚纱",
    ], r"aesthetic|quality|assessment|evaluation|美学|质量|评价"),
    "aesthetic_critique_vlm": ([
        "aesthetic critique", "photo critique", "aesthetic comment", "dpc-captions", "aesthetic description",
        "aesthetic reasoning", "aesthetic explanation", "aesthetic feedback", "photo feedback", "critique generation",
        "美学评论", "摄影点评", "美学解释",
    ], r"aesthetic|photo|photograph|美学|摄影"),
}
if os.environ.get("FACETS_ONLY"):
    FACETS = {name: FACETS[name] for name in os.environ["FACETS_ONLY"].split(",")}
    OUT = f"{OUT}-{os.environ.get('FACETS_TAG', 'subset')}"
COMPILED = {
    name: (re.compile("|".join(re.escape(t) for t in sorted(terms, key=len, reverse=True)), re.I),
           re.compile(ctx, re.I) if ctx else None)
    for name, (terms, ctx) in FACETS.items()
}


@ray.remote(num_cpus=1, max_retries=2)
def scan(index: int, files: list[str]) -> tuple[int, dict]:
    import pyarrow.parquet as pq
    hits: dict[str, list] = defaultdict(list)
    rows = 0
    for path in files:
        try:
            pf = pq.ParquetFile(path)
            cols = [c for c in COLUMNS if c in pf.schema_arrow.names]
            for batch in pf.iter_batches(columns=cols, batch_size=4096):
                for row in batch.to_pylist():
                    rows += 1
                    title = str(row.get("title") or row.get("meta_title") or "")
                    head = str(row.get("head") or "")[:3000]
                    text = f"{title}\n{head}"
                    for name, (pattern, ctx) in COMPILED.items():
                        matched = sorted({m.lower() for m in pattern.findall(text)})
                        if not matched or (ctx and not ctx.search(text)):
                            continue
                        in_title = len({m.lower() for m in pattern.findall(title)})
                        score = len(matched) + 2 * in_title + (2 if ctx and ctx.search(title) else 0)
                        hits[name].append({
                            "score": score, "title": title[:300], "terms": matched,
                            "arxiv": row.get("arxiv"), "dois": str(row.get("dois") or "")[:120],
                            "origin": row.get("origin"), "head": head[:400],
                        })
        except Exception as error:  # keep scanning other files
            hits["_errors"].append({"file": path, "error": str(error)[:200]})
    for name in list(hits):
        if name != "_errors":
            hits[name] = sorted(hits[name], key=lambda h: -h["score"])[:200]
    os.makedirs(f"{OUT}/parts", exist_ok=True)
    with open(f"{OUT}/parts/{index:05d}.json", "w", encoding="utf-8") as f:
        json.dump({"rows": rows, "hits": hits}, f, ensure_ascii=False)
    return rows, dict(hits)


def merge(merged: dict[str, list], total: int, files: int, started: float) -> None:
    os.makedirs(OUT, exist_ok=True)
    summary = {"rows": total, "files": files, "elapsed_s": round(time.time() - started, 1), "facets": {}}
    for name, items in merged.items():
        if name == "_errors":
            summary["facets"][name] = {"hits": len(items), "sample": items[:5]}
            continue
        seen, unique = set(), []
        for h in sorted(items, key=lambda h: -h["score"]):
            key = (h["title"].lower().strip(), json.dumps(h.get("arxiv"), sort_keys=True, default=str))
            if key in seen or not h["title"].strip():
                continue
            seen.add(key)
            unique.append(h)
        with open(f"{OUT}/{name}.jsonl", "w", encoding="utf-8") as f:
            for h in unique:
                f.write(json.dumps(h, ensure_ascii=False, default=str) + "\n")
        summary["facets"][name] = {"hits": len(unique)}
        print("FACET " + json.dumps({"facet": name, "hits": len(unique), "top": [
            {k: h[k] for k in ("score", "title", "arxiv", "dois", "terms")} for h in unique[:40]
        ]}, ensure_ascii=False, default=str), flush=True)
    with open(f"{OUT}/summary.json", "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2, default=str)
    print("SUMMARY " + json.dumps(summary, ensure_ascii=False, default=str), flush=True)


def merge_parts(started: float) -> None:
    merged: dict[str, list] = defaultdict(list)
    total = 0
    parts = sorted(glob.glob(f"{OUT}/parts/*.json"))
    for path in parts:
        with open(path, encoding="utf-8") as f:
            part = json.load(f)
        total += part["rows"]
        for name, items in part["hits"].items():
            merged[name].extend(items)
    merge(merged, total, len(parts), started)


def main() -> None:
    started = time.time()
    if os.environ.get("FACETS_MERGE_ONLY"):
        merge_parts(started)
        return
    ray.init(address="auto")
    files = sorted(f for pattern in SOURCES for f in glob.glob(f"{CORPUS}/{pattern}"))
    chunk = 5
    chunks = [files[i:i + chunk] for i in range(0, len(files), chunk)]
    print(json.dumps({"files": len(files), "tasks": len(chunks)}), flush=True)
    pending = [scan.remote(i, c) for i, c in enumerate(chunks)]
    merged: dict[str, list] = defaultdict(list)
    total = done = 0
    while pending:
        ready, pending = ray.wait(pending, num_returns=1)
        for rows, hits in ray.get(ready):
            total += rows
            for name, items in hits.items():
                merged[name].extend(items)
        done += len(ready)
        if done % 20 == 0 or not pending:
            print(json.dumps({"done": done, "rows": total, "elapsed": round(time.time() - started)}), flush=True)
    merge(merged, total, len(files), started)


if __name__ == "__main__":
    main()
