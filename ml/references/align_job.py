#!/usr/bin/env python3
"""Align ASR sentences to photo intervals and produce portable QA/report artifacts.

Run locally or as a Ray Jobs entrypoint: this stage needs one CPU and no GPU.
REF_MANIFEST is the JSON manifest (or a path); REF_OUT points at the shared root.
REF_BVIDS selects a subset, REF_QA_BVIDS selects contact sheets, REF_FORCE=1
rebuilds critiques, and REF_EXPORT=1 emits QA/report as EXPORT JSON log chunks.
"""
from __future__ import annotations

import sys as _private_sys
from pathlib import Path as _PrivatePath
if 'ml.common.private_env' not in _private_sys.modules:
    _private_sys.path.insert(0, str(_PrivatePath(__file__).resolve().parents[2]))
from ml.common.private_env import require_path
import base64
import hashlib
import html
import io
import json
import os
from pathlib import Path
import time

DEFAULT_OUT = require_path('ECP_CEPH_ROOT') + '/references/yidao'
VERSION = 2


def atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + f".{os.getpid()}.tmp")
    temporary.write_text(content, encoding="utf-8")
    os.replace(temporary, path)


def read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def intervals(segment: dict) -> list[dict]:
    return segment.get("intervals") or [segment]


def overlap(a: dict, b: dict) -> float:
    return sum(max(0.0, min(float(a["end"]), float(i["end"])) - max(float(a["start"]), float(i["start"]))) for i in intervals(b))


def allocate(sentences: list[dict], segments: list[dict]) -> tuple[list[list[dict]], list[dict]]:
    """Assign each original sentence once; ties prefer its midpoint then earlier interval."""
    assigned: list[list[dict]] = [[] for _ in segments]
    unassigned = []
    for sentence in sorted(sentences, key=lambda s: (float(s["start"]), float(s["end"]))):
        if float(sentence["end"]) < float(sentence["start"]):
            raise ValueError(f"ASR sentence has reversed interval: {sentence}")
        middle = (float(sentence["start"]) + float(sentence["end"])) / 2
        candidates = [(overlap(sentence, s), any(float(i["start"]) <= middle < float(i["end"]) for i in intervals(s)), -i, i)
                      for i, s in enumerate(segments)]
        best = max(candidates, default=None)
        if best and (best[0] > 0 or (float(sentence["end"]) == float(sentence["start"]) and best[1])):
            assigned[best[3]].append(sentence)
        else:
            unassigned.append(sentence)
    return assigned, unassigned


def union_duration(segments: list[dict]) -> float:
    total, end = 0.0, 0.0
    for s in sorted([i for segment in segments for i in intervals(segment)], key=lambda s: float(s["start"])):
        start, stop = max(0.0, float(s["start"])), float(s["end"])
        total += max(0.0, stop - max(start, end))
        end = max(end, stop)
    return total


def validate_segments(segments: list[dict], out: Path) -> None:
    seen = set()
    previous_end = 0.
    for s in sorted(segments, key=lambda s: float(s["start"])):
        if s["index"] in seen:
            raise ValueError(f"duplicate segment index {s['index']}")
        seen.add(s["index"])
        if float(s["start"]) < 0 or float(s["end"]) <= float(s["start"]):
            raise ValueError(f"invalid segment interval {s}")
        if float(s["start"]) < previous_end - .01:
            raise ValueError('overlapping temporal segments')
        previous_end = float(s["end"])
        for interval in intervals(s):
            if not float(s['start']) <= float(interval['start']) < float(interval['end']) <= float(s['end'])+.01:
                raise ValueError('invalid visible-photo interval')
        if s.get("kind") not in {"photo", "compare", "other"}:
            raise ValueError(f"invalid segment kind {s.get('kind')}")
        if s["kind"] != "other":
            frame = (out / s["frame"]).resolve()
            if not frame.is_relative_to((out / "frames").resolve()) or not frame.is_file():
                raise ValueError(f"missing or invalid frame: {s['frame']}")


def align_video(video: dict, out: Path, force: bool = False) -> tuple[dict, list[dict], list[list[dict]]]:
    started = time.monotonic()
    bvid = video["bvid"]
    asr_path, segment_path = out / "asr" / f"{bvid}.jsonl", out / "segments" / f"{bvid}.json"
    sentences = read_jsonl(asr_path)
    if not sentences:
        raise ValueError("ASR file has no sentences")
    segments = json.loads(segment_path.read_text(encoding="utf-8"))
    if isinstance(segments, dict):
        segments = segments["segments"]
    validate_segments(segments, out)
    if not any(s["kind"] in {"photo", "compare"} for s in segments):
        raise ValueError("No photo or comparison segments; requires review")
    if not sentences:
        raise ValueError('ASR is empty')
    if any(not isinstance(r.get('text'), str) or not 0 <= float(r['start']) < float(r['end']) for r in sentences):
        raise ValueError('invalid ASR sentence')
    stage_stats = {}
    for stage in ("asr", "segments"):
        stats_path = out / stage / f"{bvid}.stats.json"
        if stats_path.exists():
            stage_stats[stage] = json.loads(stats_path.read_text(encoding="utf-8"))
    if stage_stats.get("asr", {}).get("error"):
        raise ValueError('ASR stage recorded failure')
    if "segments" in stage_stats and stage_stats["segments"].get("status") != "complete":
        raise ValueError('segmentation stage is incomplete')
    assigned, unassigned = allocate(sentences, segments)
    rows = []
    for s, transcript in zip(segments, assigned):
        if s["kind"] == "other":
            continue
        rows.append({"contractVersion": 1, "source": os.environ.get("REF_SOURCE", "yidao"), "bvid": bvid,
                     "segment": {k: s[k] for k in ("index", "start", "end")},
                     "frame": s["frame"], "kind": s["kind"], "phash": s.get("phash"),
                     "photo_id": s.get("photo_id"), "intervals": s.get("intervals", [{"start": s["start"], "end": s["end"]}]),
                     "tier": None, "verdict": None, "issues": [], "praises": [], "topics": [],
                     "transcript": "".join(t["text"] for t in transcript),
                     "transcript_segments": transcript})
    target = out / "critiques" / f"{bvid}.jsonl"
    signature = hashlib.sha256(asr_path.read_bytes() + segment_path.read_bytes() + (str(VERSION)+(os.environ.get("REF_SOURCE", "yidao") if os.environ.get("REF_SOURCE", "yidao") != "yidao" else "")).encode()).hexdigest()
    sidecar = target.with_suffix(".meta.json")
    skipped = False
    if not force and target.exists() and sidecar.exists():
        metadata = json.loads(sidecar.read_text(encoding="utf-8"))
        skipped = metadata.get("input_sha256") == signature and metadata.get("output_sha256") == hashlib.sha256(target.read_bytes()).hexdigest()
    if not skipped:
        atomic_write(target, "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows))
        atomic_write(sidecar, json.dumps({"input_sha256": signature, "output_sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
                                        "version": VERSION, "wall_seconds": time.monotonic() - started}))
    photo_segments = [s for s in segments if s["kind"] != "other"]
    duration = float(stage_stats.get("asr", {}).get("duration", 0) or video.get("duration", 0)) or max([float(s["end"]) for s in segments] + [0])
    covered = union_duration(photo_segments)
    stats = {"bvid": bvid, "title": video.get("title"), "status": "success", "duration_seconds": duration,
             "segments": len(segments), "photo_segments": sum(s["kind"] == "photo" for s in segments),
             "compare_segments": sum(s["kind"] == "compare" for s in segments),
             "other_segments": sum(s["kind"] == "other" for s in segments),
             "critique_count": len(rows), "unique_photo_ids": len({s.get("photo_id") for s in photo_segments if s.get("photo_id")}), "photo_coverage_seconds": covered,
             "photo_coverage_ratio": covered / duration if duration else 0,
             "segments_without_transcript": sum(not r["transcript"].strip() for r in rows),
             "asr_sentences": len(sentences), "unassigned_asr_sentences": len(unassigned),
             "asr_sentences_assigned_to_other": sum(len(t) for s, t in zip(segments, assigned) if s["kind"] == "other"),
             "wall_seconds": time.monotonic() - started, "skipped": skipped}
    stats["stage_stats"] = stage_stats
    atomic_write(out / "critiques" / f"{bvid}.stats.json", json.dumps(stats, ensure_ascii=False, indent=2))
    return stats, segments, assigned


def thumbnail(path: Path) -> str:
    try:
        from PIL import Image
        with Image.open(path) as im:
            im.thumbnail((480, 300))
            stream = io.BytesIO()
            im.convert("RGB").save(stream, format="JPEG", quality=80)
            raw = stream.getvalue()
    except ImportError:
        raw = path.read_bytes()
    return "data:image/jpeg;base64," + base64.b64encode(raw).decode("ascii")


def contact_sheet(video: dict, segments: list[dict], assigned: list[list[dict]], out: Path) -> Path:
    cards = {"photo": [], "other": []}
    for s, transcript in zip(segments, assigned):
        text = "".join(t["text"] for t in transcript)[:80]
        frame = out / s.get("frame", "")
        picture = f'<img src="{thumbnail(frame)}" alt="segment {s["index"]}">' if frame.is_file() else '<div class="missing">无截图</div>'
        card = f'<article>{picture}<b>#{s["index"]} {s["start"]:.1f}–{s["end"]:.1f}s · {html.escape(s["kind"])}</b><p>{html.escape(text)}</p></article>'
        cards["other" if s["kind"] == "other" else "photo"].append(card)
    body = '<!doctype html><html lang="zh"><meta charset="utf-8"><title>衣刀照片分段质检</title><style>body{font:16px system-ui;margin:24px;background:#eee}section{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:14px}article{background:white;padding:12px}img{width:100%;height:240px;object-fit:contain}b{display:block}p{line-height:1.6}.missing{height:240px}</style>'
    if os.environ.get('REF_SOURCE') == 'wulin': body = body.replace('衣刀照片分段质检', '武林照片分段质检')
    body += f'<h1>{html.escape(video.get("title", video["bvid"]))}</h1><p>{video["bvid"]} · 缩略图已内嵌，可离线打开。文字为对应转写前80字。</p>'
    body += '<h2>照片及比较段</h2><section>' + ''.join(cards['photo']) + '</section>'
    body += '<h2>其他画面（被排除）</h2><section>' + ''.join(cards['other']) + '</section></html>'
    target = out / "qa" / f"{video['bvid']}.html"
    atomic_write(target, body)
    return target


def export_file(path: Path, out: Path) -> None:
    relative = str(path.relative_to(out))
    raw = path.read_bytes()
    encoded = base64.b64encode(raw).decode("ascii")
    for i in range(0, len(encoded), 32000):
        print("EXPORT " + json.dumps({"path": relative, "data": encoded[i:i + 32000]}), flush=True)



def main() -> None:
    started = time.monotonic()
    out = Path(os.environ.get("REF_OUT", DEFAULT_OUT))
    manifest_text = os.environ.get("REF_MANIFEST")
    if not manifest_text:
        manifest_text = Path(__file__).with_name("yidao_portrait_critique_manifest.json").read_text(encoding="utf-8")
    elif not manifest_text.lstrip().startswith(("{", "[")):
        manifest_text = Path(manifest_text).read_text(encoding="utf-8")
    manifest = json.loads(manifest_text)
    videos = manifest["videos"] if isinstance(manifest, dict) else manifest
    selection = set(filter(None, os.environ.get("REF_BVIDS", "").split(",")))
    videos = [v for v in videos if not selection or v["bvid"] in selection]
    qa_ids = set(filter(None, os.environ.get("REF_QA_BVIDS", "").split(",")))
    if not qa_ids and videos:
        qa_ids = {videos[i]["bvid"] for i in (0, len(videos) // 2, len(videos) - 1)}
    stats, exports = [], []
    for video in videos:
        try:
            result, segments, assigned = align_video(video, out, os.environ.get("REF_FORCE") == "1")
            if video["bvid"] in qa_ids:
                exports.append(contact_sheet(video, segments, assigned, out))
        except Exception as error:
            result = {"bvid": video["bvid"], "status": "failed", "error": f"{type(error).__name__}: {error}"}
        stats.append(result)
        print(json.dumps(result, ensure_ascii=False), flush=True)
    good = [s for s in stats if s["status"] == "success"]
    total_duration = sum(s["duration_seconds"] for s in good)
    coverage = sum(s["photo_coverage_seconds"] for s in good)
    report = {"version": VERSION, "generated_at_unix": time.time(), "expected_videos": len(videos),
              "successful_videos": len(good), "failed_videos": len(stats) - len(good),
              "failures": [s for s in stats if s["status"] != "success"], "videos": stats,
              "totals": {"duration_seconds": total_duration, "photo_coverage_seconds": coverage,
                         "photo_coverage_ratio": coverage / total_duration if total_duration else 0,
                         "critique_count": sum(s["critique_count"] for s in good),
                         "segments_without_transcript": sum(s["segments_without_transcript"] for s in good)},
              "alignment": {"method": "sentence maximum interval overlap; once only; other excluded", "wall_seconds": time.monotonic() - started,
                            "resources": {"cpus": 1, "gpus": 0}},
              "qa_files": [str(p.relative_to(out)) for p in exports],
              "known_limitations": ["Sentences crossing a boundary are kept whole and assigned to one interval.",
                                    "Photo identity and layout classification are heuristic; contact sheets require human review.",
                                    "One FPS misses subsecond cuts; scenes shorter than three seconds may be excluded.",
                                    "Extreme crops, high-key images and static hosts may be misclassified.",
                                    "Selected editor tab prefix can collide across different filenames.",
                                    "Compare panels remain a single segment; repeated returns share photo_id."]}
    report["totals"]["unassigned_asr_sentences"] = sum(s["unassigned_asr_sentences"] for s in good)
    report["totals"]["asr_sentences_assigned_to_other"] = sum(s["asr_sentences_assigned_to_other"] for s in good)
    report["totals"]["asr_sentences"] = sum(s["asr_sentences"] for s in good)
    report["totals"]["unique_photo_ids"] = sum(s["unique_photo_ids"] for s in good)
    report["zero_photo_videos"] = [s["bvid"] for s in good if not s["critique_count"]]
    report["terminology_samples"] = {}
    terms = {"直闪": ["直闪"], "套头": ["套头"], "色温": ["色温"], "逆光": ["逆光"],
             "35mm": ["35", "三十五", "三五"], "85mm": ["85", "八十五", "八五"]}
    report["terminology_samples"] = {term: {"matching_sentences": 0, "examples": []} for term in terms}
    for video in videos:
        asr = out / "asr" / f"{video['bvid']}.jsonl"
        if not asr.exists(): continue
        for sentence in read_jsonl(asr):
            for term, forms in terms.items():
                if any(form in sentence["text"] for form in forms):
                    sample = report["terminology_samples"][term]
                    sample["matching_sentences"] += 1
                    if len(sample["examples"]) < 5: sample["examples"].append({"bvid": video["bvid"], **sentence})
    if os.environ.get("REF_RUN_METADATA"):
        report["ray_jobs"] = json.loads(os.environ["REF_RUN_METADATA"])
    report["stage_totals"] = {}
    for stage in ("asr", "segments"):
        per_video = [s["stage_stats"][stage] for s in good if stage in s.get("stage_stats", {})]
        report["stage_totals"][stage] = {
            "videos_with_stats": len(per_video),
            "worker_seconds": sum(float(s.get("seconds", s.get("wall_seconds", 0))) for s in per_video),
            "models": sorted({str(s.get("model")) for s in per_video if s.get("model")}),
            "resources": [s.get("resource") or {k: s[k] for k in ("gpu", "gpus", "cpus") if k in s} for s in per_video[:1]],
        }
        candidates = [out / stage / "run-report.json", out / stage / "report.json", out / f"{stage}-report.json"]
        for candidate in candidates:
            if candidate.exists():
                report[stage] = json.loads(candidate.read_text(encoding="utf-8"))
                break
    report_path = out / "pipeline-report.json"
    atomic_write(report_path, json.dumps(report, ensure_ascii=False, indent=2))
    exports.append(report_path)
    print("PIPELINE_SUMMARY " + json.dumps({"successful_videos": len(good), "failed_videos": len(stats)-len(good), "totals": report["totals"], "zero_photo_videos": report["zero_photo_videos"]}, ensure_ascii=False), flush=True)
    if os.environ.get("REF_EXPORT") == "1":
        for path in exports:
            export_file(path, out)
    print(f"ALIGN_DONE success={len(good)} failed={len(stats) - len(good)} wall_seconds={time.monotonic() - started:.3f}", flush=True)
    if len(good) != len(stats):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
