"""Ray worker for extracting local CLIP/DINOv2 face embeddings from Open Images."""

from __future__ import annotations

import concurrent.futures
import importlib.metadata
import json
import os
from pathlib import Path
import re
import shutil
import signal
import time

import numpy as np

from ml.observe.embed import CLIP_VERSION, DINO_VERSION, Encoder
from ml.observe.probe_ray import digest, export, materialize_models, report, remove_package_blob


IMAGE_ROOT = "photography/eagle-culling/observe/openimages-v1"
ID_PATTERN = re.compile(r"^[0-9a-f]{16}$")


def relative_path(value: str, label: str = "path") -> Path:
    """Validate a slash-separated relative path before joining it to a trusted root."""
    if (not isinstance(value, str) or not value or "\\" in value or Path(value).is_absolute()
            or any(part in ("", ".", "..") for part in value.split("/"))):
        raise ValueError(f"{label} must be a relative path without traversal")
    return Path(value)


def ceph_image_path(name: str, *, ceph_root: str | Path | None = None,
                    image_root: str = IMAGE_ROOT) -> Path:
    """Resolve one manifest path while keeping it below the configured Ceph directory."""
    relative = relative_path(name, "manifest image path")
    if relative.suffix.lower() != ".jpg":
        raise ValueError("manifest image path must end in .jpg")
    configured = ceph_root if ceph_root is not None else os.environ.get("ECP_CEPH_ROOT")
    if not configured or not Path(configured).is_absolute():
        raise ValueError("ECP_CEPH_ROOT must be an absolute path")
    root = Path(configured).resolve()
    subdirectory = relative_path(image_root, "imageRoot")
    images = (root / subdirectory).resolve()
    if images != root and root not in images.parents:
        raise ValueError("imageRoot outside Ceph root")
    file = (images / relative).resolve()
    if images not in file.parents:
        raise ValueError("image outside image root")
    return file


def normalise_embedding(value: np.ndarray, dimension: int) -> np.ndarray:
    """Flatten, validate and L2-normalise one model output as float32."""
    vector = np.asarray(value).reshape(-1).astype(np.float32)
    if vector.size != dimension or not np.isfinite(vector).all():
        raise ValueError(f"embedding must be finite with dimension {dimension}")
    norm = np.linalg.norm(vector.astype(np.float64))
    if not np.isfinite(norm) or norm <= 0:
        raise ValueError("embedding has an invalid norm")
    return np.ascontiguousarray(vector.astype(np.float64) / norm, dtype=np.float32)


def read_manifest(path: str | Path) -> list[dict]:
    rows = [json.loads(line) for line in Path(path).read_text().splitlines() if line.strip()]
    ids = [row.get("id") for row in rows]
    if any(not isinstance(value, str) or not ID_PATTERN.fullmatch(value) for value in ids):
        raise ValueError("manifest ids must be unique 16-character hex strings")
    if len(set(ids)) != len(ids):
        raise ValueError("manifest ids must be unique")
    for row in rows:
        if not isinstance(row.get("face"), str):
            raise ValueError("manifest row is missing face path")
        relative_path(row["face"], "manifest face path")
    return rows


def assemble_results(manifest: list[dict], successful: dict[str, dict], failures: list[dict], *, include_dino: bool = True) -> dict:
    """Arrange successful rows in manifest order and retain every failure explicitly."""
    ids = [row["id"] for row in manifest]
    unknown = set(successful) - set(ids)
    if unknown:
        raise ValueError("embedding result has an id absent from the manifest")
    failure_by_id = {row["id"]: row for row in failures}
    if len(failure_by_id) != len(failures):
        raise ValueError("duplicate embedding failure id")
    ordered_ids = [value for value in ids if value in successful]
    clip = np.asarray([successful[value]["clip"] for value in ordered_ids], dtype=np.float32)
    if clip.size and clip.shape != (len(ordered_ids), 512):
        raise ValueError("CLIP result shape must be N x 512")
    result = {
        "ids": np.asarray(ordered_ids, dtype=str),
        "clip": clip.reshape((len(ordered_ids), 512)),
        "failures": [failure_by_id[value] for value in ids if value in failure_by_id],
    }
    if include_dino:
        dino = np.asarray([successful[value]["dino"] for value in ordered_ids], dtype=np.float32)
        if dino.size and dino.shape != (len(ordered_ids), 384):
            raise ValueError("DINOv2 result shape must be N x 384")
        result["dino"] = dino.reshape((len(ordered_ids), 384))
    return result


def _versions() -> dict[str, str]:
    names = ("numpy", "Pillow", "onnxruntime", "pyvips")
    result = {}
    for name in names:
        try:
            result[name] = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            result[name] = "importable-without-distribution-metadata"
    return result


def _error(error: BaseException) -> str:
    message = str(error).replace("\n", " ").strip()
    return (type(error).__name__ + (": " + message if message else ""))[:400]


def run(config: dict) -> None:
    root = Path.cwd()
    output = Path("output")
    output.mkdir(exist_ok=True)
    started = time.monotonic()
    materialize_models(config)
    for name, expected in config["model_sha256"].items():
        actual = digest(root / config["models"][name])
        if actual != expected:
            raise RuntimeError("model checksum mismatch: " + name)
    versions = _versions()
    report({"stage": "verified", "model_sha256": config["model_sha256"], "versions": versions,
            "onnxruntime_import": versions["onnxruntime"], "cpu_workers": config["workers"],
            "onnx_threads_per_worker": 2})
    manifest = read_manifest(root / "manifest.jsonl")
    expected_count = int(config.get("expected_count", len(manifest)))
    if len(manifest) != expected_count:
        raise ValueError(f"manifest count {len(manifest)} != expected {expected_count}")
    parity_ids = set(config.get("parity_ids", []))
    if len(parity_ids) != 5 or not parity_ids.issubset({row["id"] for row in manifest}):
        raise ValueError("parity_ids must contain five manifest ids")
    ceph_root = os.environ.get("ECP_CEPH_ROOT")
    if not ceph_root or not Path(ceph_root).is_absolute():
        raise ValueError("ECP_CEPH_ROOT must be an absolute path")
    encoders = {"clip": Encoder("clip", config["models"]["clip"], threads=2),
                "dino": Encoder("dino", config["models"]["dino"], threads=2)}
    successful: dict[str, dict] = {}
    failures: list[dict] = []

    def one(row: dict) -> tuple[str, dict | None, dict | None]:
        try:
            image = ceph_image_path(row["face"], ceph_root=ceph_root)
            clip = normalise_embedding(encoders["clip"].embed(image), 512)
            dino = normalise_embedding(encoders["dino"].embed(image), 384)
            return row["id"], {"clip": clip, "dino": dino}, None
        except Exception as error:  # Keep one bad source from hiding the other 7,999 rows.
            return row["id"], None, {"id": row["id"], "face": row["face"], "error": _error(error)}

    workers = max(1, int(config.get("workers", 4)))
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(one, row) for row in manifest]
        for index, future in enumerate(concurrent.futures.as_completed(futures), 1):
            item_id, vector, failure = future.result()
            if failure:
                failures.append(failure)
            else:
                successful[item_id] = vector
            if index % 100 == 0 or index == len(manifest):
                report({"stage": "embedding", "completed": index, "total": len(manifest),
                        "successes": len(successful), "failures": len(failures),
                        "elapsed_s": round(time.monotonic() - started, 1)})
    result = assemble_results(manifest, successful, failures)
    np.savez_compressed(output / "clip-face.npz", ids=result["ids"], features=result["clip"])
    np.savez_compressed(output / "dino-face.npz", ids=result["ids"], features=result["dino"])
    for row in manifest:
        if row["id"] not in parity_ids:
            continue
        try:
            source = ceph_image_path(row["face"], ceph_root=ceph_root)
            parity_file = output / ("parity-" + row["id"] + ".jpg")
            shutil.copyfile(source, parity_file)
            export(parity_file)
        except Exception as error:
            report({"stage": "parity-file", "id": row["id"], "error": _error(error)})
    details = {"count": len(manifest), "successes": len(result["ids"]), "failures": result["failures"],
               "elapsed_s": round(time.monotonic() - started, 1), "parity_ids": sorted(parity_ids),
               "model_sha256": config["model_sha256"], "versions": versions,
               "embedding_versions": {"clip": CLIP_VERSION, "dino": DINO_VERSION},
               "dimensions": {"clip": 512, "dino": 384}, "normalised": True}
    (output / "embedding-results.json").write_text(json.dumps(details, ensure_ascii=False, indent=2) + "\n")
    export(output / "clip-face.npz")
    export(output / "dino-face.npz")
    export(output / "embedding-results.json")
    report({"stage": "complete", "count": len(manifest), "successes": len(result["ids"]),
            "failures": len(result["failures"]), "elapsed_s": details["elapsed_s"]})


def main() -> None:
    signal.signal(signal.SIGTERM, lambda _signum, _frame: (_ for _ in ()).throw(SystemExit(143)))
    config = json.loads(Path("embed-config.json").read_text())
    try:
        run(config)
    finally:
        remove_package_blob()


if __name__ == "__main__":
    main()
