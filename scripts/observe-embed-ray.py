#!/usr/bin/env python3
"""Extract and collect local CLIP/DINOv2 face embeddings for the Open Images manifest."""

import argparse
import base64
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import random
import re
import shutil
import subprocess
import sys
import time
import urllib.request
import uuid
import zipfile

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ml.common.private_env import dashboard_url, require_path, setting  # noqa: E402


ROOT = Path(__file__).resolve().parents[1]
PREFIX = "w31-embed-"
LOCK = Path("/tmp/w29-ray.lock")
TERMINAL = ("SUCCEEDED", "FAILED", "STOPPED")
ORT_VERSION = "1.24.3"
CLIP_SHA256 = "583fd1110a514667812fee7d684952aaf82a99b959760c8d7dca7e0ab9839299"
ASSET_CHUNK_BYTES = 48 * 1024 ** 2
ARTIFACT_RE = re.compile(r"(?:clip-face|dino-face)\.npz|embedding-results\.json|parity-[0-9a-f]{16}\.jpg")
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _probe_module():
    path = ROOT / "scripts" / "observe-probe-ray.py"
    spec = importlib.util.spec_from_file_location("observe_probe_ray", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load shared Ray helpers")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


SHARED = _probe_module()


def request(path, body=None, method=None, data=None, timeout=120):
    payload = data if data is not None else None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(dashboard_url() + path, data=payload, method=method,
                                 headers={"Content-Type": "application/json"})
    with OPENER.open(req, timeout=timeout) as response:
        value = response.read()
    return json.loads(value) if value else None


def checked_job(job: str) -> str:
    if not re.fullmatch(PREFIX + r"[0-9a-f]{12}", job):
        raise ValueError("an explicit own embed job id is required")
    return job


def wait(job: str) -> dict:
    checked_job(job)
    previous = None
    while True:
        state = request("/api/jobs/" + job)
        status = state.get("status")
        if status != previous:
            print(json.dumps({"job": job, "status": status}), flush=True)
            previous = status
        if status in TERMINAL:
            return state
        time.sleep(10)


def acquire_lock() -> None:
    while True:
        try:
            LOCK.mkdir()
            (LOCK / "owner.json").write_text(json.dumps({"line": PREFIX, "pid": os.getpid()}))
            return
        except FileExistsError:
            time.sleep(10)


def release_lock() -> None:
    marker = LOCK / "owner.json"
    try:
        if marker.exists() and json.loads(marker.read_text()).get("line") == PREFIX:
            marker.unlink()
            LOCK.rmdir()
    except (FileNotFoundError, OSError, ValueError):
        pass


def package(manifest: Path, config: dict) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_STORED) as archive:
        for source in ("ml/__init__.py", "ml/observe/__init__.py", "ml/observe/embed.py",
                       "ml/observe/probe_ray.py", "ml/observe/embed_ray.py"):
            path = ROOT / source
            if path.exists():
                archive.write(path, source)
            elif source.endswith("__init__.py"):
                archive.writestr(source, "")
            else:
                raise FileNotFoundError(source)
        archive.write(manifest, "manifest.jsonl")
        archive.writestr("embed-config.json", json.dumps(config))
    return buffer.getvalue()


def parity_ids(manifest: Path, seed: int) -> list[str]:
    rows = [json.loads(line) for line in manifest.read_text().splitlines() if line.strip()]
    if len(rows) < 5:
        raise ValueError("manifest must contain at least five rows")
    return [row["id"] for row in random.Random(seed).sample(rows, 5)]


def submit(args, output: Path) -> str:
    manifest = Path(args.manifest)
    rows = [line for line in manifest.read_text().splitlines() if line.strip()]
    if len(rows) != args.count:
        raise ValueError(f"manifest has {len(rows)} rows; expected {args.count}")
    ceph_root = require_path("ECP_CEPH_ROOT")
    if args.workers < 1 or args.workers > 4:
        raise ValueError("workers must be between 1 and 4")
    if not 60 <= args.timeout <= 21600:
        raise ValueError("timeout must be between 60 and 21600 seconds")
    models = {"clip": "models/clip/vision_model_quantized.onnx", "dino": "models/dinov2-small/model.onnx"}
    model_sha256 = {name: SHARED.digest(ROOT / relative) for name, relative in models.items()}
    if model_sha256["clip"] != CLIP_SHA256:
        raise ValueError("local CLIP model checksum does not match the contract")
    config = {"models": models, "model_sha256": model_sha256, "workers": args.workers,
              "expected_count": args.count, "parity_ids": parity_ids(manifest, args.seed),
              "seed": args.seed}
    model_assets, config["model_chunks"] = SHARED.model_packages(models)
    content = package(manifest, config)
    package_name = "_ray_pkg_" + hashlib.sha256(content).hexdigest()[:16] + ".zip"
    request("/api/packages/gcs/" + package_name, method="PUT", data=content, timeout=300)
    del content
    model_uris = []
    for model_name, model_data in model_assets:
        request("/api/packages/gcs/" + model_name, method="PUT", data=model_data, timeout=300)
        model_uris.append("gcs://" + model_name)
    job = PREFIX + uuid.uuid4().hex[:12]
    proxy = setting("ECP_HTTP_PROXY", "")
    runtime = {"working_dir": "gcs://" + package_name, "py_modules": model_uris,
               "pip": ["onnxruntime==" + ORT_VERSION, "pyvips==3.2.0", "pyvips-binary==8.18.7"],
               "env_vars": {"HTTP_PROXY": proxy, "HTTPS_PROXY": proxy, "ECP_CEPH_ROOT": ceph_root,
                             "CUDA_VISIBLE_DEVICES": "", "ECP_RAY_WORKER": "1", "PROBE_PACKAGE_URI": "gcs://" + package_name,
                             "OMP_NUM_THREADS": "2", "OPENBLAS_NUM_THREADS": "2", "MKL_NUM_THREADS": "2"}}
    body = {"submission_id": job,
            "entrypoint": "timeout --signal=TERM --kill-after=20s %ds python -m ml.observe.embed_ray" % args.timeout,
            "entrypoint_num_cpus": args.workers * 2, "entrypoint_num_gpus": 0,
            "entrypoint_memory": 12 * 1024 ** 3, "runtime_env": runtime}
    response = request("/api/jobs/", body)
    output.mkdir(parents=True, exist_ok=True)
    (output / "job.json").write_text(json.dumps({"job": job, "package": package_name,
                                                   "model_packages": [name for name, _ in model_assets],
                                                   "response": response, "config": config}, indent=2) + "\n")
    return job


def collect_artifacts(job: str, output: Path) -> tuple[list[dict], dict]:
    checked_job(job)
    logs = request("/api/jobs/" + job + "/logs")["logs"]
    output.mkdir(parents=True, exist_ok=True)
    (output / "job.log").write_text(logs)
    chunks, reports = {}, []
    for line in logs.splitlines():
        if line.startswith("PROBE_REPORT "):
            reports.append(json.loads(line[len("PROBE_REPORT "):]))
        if not line.startswith("PROBE_ARTIFACT "):
            continue
        row = json.loads(line[len("PROBE_ARTIFACT "):])
        name = row.get("name", "")
        if Path(name).name != name or not ARTIFACT_RE.fullmatch(name):
            raise ValueError("unexpected embedding artifact: " + str(name))
        previous = chunks.setdefault(name, {"count": row["count"], "sha256": row["sha256"], "parts": {}})
        if previous["count"] != row["count"] or previous["sha256"] != row["sha256"]:
            raise ValueError("inconsistent embedding artifact chunks")
        previous["parts"][row["index"]] = row["data"]
    written = []
    for name, record in chunks.items():
        if set(record["parts"]) != set(range(record["count"])):
            raise ValueError("incomplete embedding artifact: " + name)
        content = base64.b64decode("".join(record["parts"][index] for index in range(record["count"])), validate=True)
        if hashlib.sha256(content).hexdigest() != record["sha256"]:
            raise ValueError("embedding artifact checksum mismatch: " + name)
        temporary = output / (name + ".part")
        temporary.write_bytes(content)
        temporary.replace(output / name)
        written.append({"name": name, "bytes": len(content), "sha256": record["sha256"]})
    collection = {"job": job, "artifacts": written, "reports": reports}
    (output / "collection.json").write_text(json.dumps(collection, indent=2) + "\n")
    return reports, collection


def _cosine(left, right) -> float:
    left, right = np.asarray(left, dtype=np.float64), np.asarray(right, dtype=np.float64)
    return float(np.dot(left, right) / max(1e-12, np.linalg.norm(left) * np.linalg.norm(right)))


def run_parity(output: Path, job: str) -> dict:
    details = json.loads((output / "embedding-results.json").read_text())
    files = {path.name.removeprefix("parity-").removesuffix(".jpg"): path
             for path in output.glob("parity-*.jpg")}
    ids = details.get("parity_ids", [])
    if set(files) != set(ids):
        result = {"n": len(files), "expected": 5, "error": "Ray did not return all five parity images", "ids": sorted(files)}
        (output / "parity.json").write_text(json.dumps(result, indent=2) + "\n")
        return result
    temporary = Path("/tmp") / ("w31-oi-embed-parity-" + job)
    temporary.mkdir(parents=True, exist_ok=False)
    try:
        rows = []
        for item_id in sorted(ids):
            name = item_id + ".jpg"
            shutil.copyfile(files[item_id], temporary / name)
            rows.append({"id": item_id, "images": {"face": name}})
        items = temporary / "items.jsonl"
        items.write_text("".join(json.dumps(row) + "\n" for row in rows))
        command = ["nice", "-n", "15", "node", "scripts/observe-embed-reference.mjs", str(items), str(temporary)]
        completed = subprocess.run(command, cwd=ROOT, check=True, capture_output=True, text=True)
        reference = json.loads(completed.stdout.strip().splitlines()[-1])
        clip = np.load(output / "clip-face.npz", allow_pickle=False)
        dino = np.load(output / "dino-face.npz", allow_pickle=False)
        clip_by_id = dict(zip(clip["ids"].astype(str), clip["features"]))
        dino_by_id = dict(zip(dino["ids"].astype(str), dino["features"]))
        rows_result = []
        for row in reference["rows"]:
            item_id = Path(row["path"]).stem
            rows_result.append({"id": item_id,
                                "clip_cosine": _cosine(clip_by_id[item_id], row["clip"]),
                                "dino_cosine": _cosine(dino_by_id[item_id], row["dino"])})
        result = {"n": len(rows_result), "ids": [row["id"] for row in rows_result], "rows": rows_result,
                  "clip_cosine_min": min(row["clip_cosine"] for row in rows_result),
                  "clip_cosine_mean": sum(row["clip_cosine"] for row in rows_result) / len(rows_result),
                  "dino_cosine_min": min(row["dino_cosine"] for row in rows_result),
                  "dino_cosine_mean": sum(row["dino_cosine"] for row in rows_result) / len(rows_result),
                  "clip_model_sha256": reference.get("clipModelSha256"),
                  "dino_model_sha256": reference.get("dinoModelSha256")}
    except Exception as error:
        result = {"n": 0, "expected": 5, "error": type(error).__name__ + ": " + str(error)[:300]}
    finally:
        shutil.rmtree(temporary, ignore_errors=True)
    (output / "parity.json").write_text(json.dumps(result, indent=2) + "\n")
    return result


def validate_outputs(output: Path) -> dict:
    clip = np.load(output / "clip-face.npz", allow_pickle=False)
    dino = np.load(output / "dino-face.npz", allow_pickle=False)
    clip_ids, clip_features = clip["ids"].astype(str), clip["features"]
    dino_ids, dino_features = dino["ids"].astype(str), dino["features"]
    if clip_features.dtype != np.float32 or clip_features.ndim != 2 or clip_features.shape[1] != 512:
        raise ValueError("invalid CLIP output shape or dtype")
    if dino_features.dtype != np.float32 or dino_features.ndim != 2 or dino_features.shape[1] != 384:
        raise ValueError("invalid DINOv2 output shape or dtype")
    if not np.array_equal(clip_ids, dino_ids) or len(set(clip_ids)) != len(clip_ids):
        raise ValueError("CLIP and DINOv2 ids differ or repeat")
    return {"count": int(len(clip_ids)), "clip_shape": list(clip_features.shape), "dino_shape": list(dino_features.shape)}


def write_metadata(output: Path, job: str, state: dict, parity: dict, validation: dict) -> None:
    details = json.loads((output / "embedding-results.json").read_text())
    metadata = {"format": "numpy npz; allow_pickle=False; ids and features arrays",
                "job_id": job, "job_status": state.get("status"), "count": validation["count"],
                "manifest_count": details["count"], "failures": details["failures"],
                "model_sha256": details["model_sha256"], "onnxruntime": details["versions"].get("onnxruntime"),
                "versions": details["versions"], "elapsed_s": details["elapsed_s"],
                "dimensions": details["dimensions"], "normalised": details["normalised"],
                "parity": parity,
                "reading": "np.load(path, allow_pickle=False)['ids'/'features']; ids follow manifest order for successful rows",
                "validation": validation}
    (output / "embeddings.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n")


def finish(job: str, output: Path, state: dict) -> dict:
    _, collection = collect_artifacts(job, output)
    validation = validate_outputs(output)
    parity = run_parity(output, job)
    write_metadata(output, job, state, parity, validation)
    print(json.dumps({"job": job, "status": state.get("status"), "validation": validation,
                      "parity": parity, "artifacts": collection["artifacts"]}, ensure_ascii=False), flush=True)
    return parity


def run(args) -> None:
    output = Path(args.output)
    acquire_lock()
    job = None
    try:
        if SHARED.active_count() >= 2:
            raise RuntimeError("two project Ray jobs are already active")
        job = submit(args, output)
        state = wait(job)
        if state.get("status") != "SUCCEEDED":
            try:
                collect_artifacts(job, output)
            finally:
                raise RuntimeError("embedding job failed; inspect job.log")
        finish(job, output, state)
    finally:
        if job:
            state = request("/api/jobs/" + checked_job(job))
            if state.get("status") not in TERMINAL:
                request("/api/jobs/" + job + "/stop", body={})
                wait(job)
        release_lock()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("run", "status", "collect"))
    parser.add_argument("job", nargs="?")
    parser.add_argument("--manifest", type=Path, default=ROOT / "data/cache/observe-oi/manifest.jsonl")
    parser.add_argument("--output", type=Path, default=ROOT / "data/cache/observe-oi/embeddings")
    parser.add_argument("--count", type=int, default=8000)
    parser.add_argument("--seed", type=int, default=20261016)
    parser.add_argument("--workers", type=int, choices=range(1, 5), default=4)
    parser.add_argument("--timeout", type=int, default=21600)
    args = parser.parse_args()
    if args.action == "run":
        run(args)
        return
    if not args.job:
        parser.error("status/collect require an explicit job id")
    checked_job(args.job)
    state = request("/api/jobs/" + args.job)
    if args.action == "status":
        print(json.dumps({key: state.get(key) for key in ("submission_id", "status", "message")}))
    else:
        if state.get("status") != "SUCCEEDED":
            raise SystemExit("collect requires a succeeded job")
        finish(args.job, args.output, state)


if __name__ == "__main__":
    main()
