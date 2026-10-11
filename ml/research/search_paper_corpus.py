#!/usr/bin/env python3
"""Search the internal paper corpus (not public) for photo-culling/IQA literature.

The script is intentionally read-only with respect to the corpus.  It writes a
JSONL evidence file and a compact top-results JSON under the Eagle Ceph root.
Run on Ray because the corpus is mounted there, not on the Mac.
"""
from __future__ import annotations

import sys as _private_sys
from pathlib import Path as _PrivatePath
if 'ml.common.private_env' not in _private_sys.modules:
    _private_sys.path.insert(0, str(_PrivatePath(__file__).resolve().parents[2]))
from ml.common.private_env import setting, require_path
import argparse
import json
import os
import re
import time
from pathlib import Path

import pyarrow.parquet as pq

CORPUS = Path(require_path('ECP_CORPUS_ROOT'))
CEPH = Path(require_path('ECP_CEPH_ROOT'))
TERMS = [
    "photo triage", "series photo selection", "burst photo selection",
    "best shot selection", "photo culling", "near-duplicate photo selection",
    "image aesthetic assessment", "personalized aesthetics",
    "image quality assessment", "no-reference image quality",
    "pairwise preference", "ranking for photos", "eye blink",
    "closed eyes", "comparative photo composition", "cpc", "gaic",
    "q-align", "q-instruct", "deqa", "q-insight", "visualquality-r1",
    "compare2score", "flickr-aes", "real-cur", "spaq", "koniq",
    "paq-2-piq", "flive", "photo series", "best photo",
]
PATTERNS = [(term, re.compile(re.escape(term), re.I)) for term in TERMS]


def matches(title: str, text: str) -> list[str]:
    haystack = f"{title}\n{text[:20000]}"
    return [term for term, pattern in PATTERNS if pattern.search(haystack)]


def row_to_hit(row: dict, terms: list[str]) -> dict:
    text = str(row.get("text") or "")
    title = str(row.get("title") or row.get("meta") or "").strip()
    return {
        "title": title[:500],
        "year": row.get("year"),
        "venue": row.get("venue") or row.get("source"),
        "source_id": row.get("source_id") or row.get("id"),
        "matched_keywords": terms,
        "abstract": text[:1500],
    }


def scan_file(path: Path, columns: list[str], limit: int | None = None) -> tuple[list[dict], int]:
    hits: list[dict] = []
    rows = 0
    pf = pq.ParquetFile(path)
    for rg in range(pf.num_row_groups):
        table = pf.read_row_group(rg, columns=columns)
        for row in table.to_pylist():
            rows += 1
            title = str(row.get("title") or row.get("meta") or "")
            text = str(row.get("text") or "")
            terms = matches(title, text)
            if terms:
                hits.append(row_to_hit(row, terms))
            if limit and rows >= limit:
                return hits, rows
        if rg % 10 == 0:
            print(json.dumps({"file": str(path), "row_groups_done": rg, "rows": rows}, ensure_ascii=False), flush=True)
    return hits, rows


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--d4-sample", type=int, default=0, help="rows per d4 parquet (0 disables)")
    ap.add_argument("--zh-files", type=int, default=25, help="number of Chinese parquet files (0 disables)")
    ap.add_argument("--top", type=int, default=200)
    args = ap.parse_args()
    started = time.time()
    derived = sorted((CORPUS / "derived").glob("*.parquet"))
    zh = sorted(CORPUS.glob(setting("ECP_CORPUS_ZH_PATTERN", "papers/zh/*.parquet")))
    d4 = sorted(CORPUS.glob(setting("ECP_CORPUS_EN_PATTERN", "papers/en/*.parquet")))
    all_hits: list[dict] = []
    scanned = 0
    print(json.dumps({"phase": "inventory", "derived": len(derived), "zh": len(zh), "d4": len(d4)}, ensure_ascii=False), flush=True)
    for path in derived:
        h, n = scan_file(path, ["source_id", "title", "venue", "year", "text"])
        all_hits.extend(h); scanned += n
    for path in zh[: args.zh_files]:
        h, n = scan_file(path, ["id", "text", "source", "meta"])
        all_hits.extend(h); scanned += n
    d4_scanned = 0
    if args.d4_sample:
        for path in d4:
            h, n = scan_file(path, ["id", "text", "source", "meta"], args.d4_sample)
            all_hits.extend(h); d4_scanned += n
    # Deduplicate by source id/title and rank by number of matched terms.
    unique: dict[tuple[str, str], dict] = {}
    for hit in all_hits:
        key = (str(hit.get("source_id")), hit["title"])
        if key not in unique or len(hit["matched_keywords"]) > len(unique[key]["matched_keywords"]):
            unique[key] = hit
    hits = list(unique.values())
    hits.sort(key=lambda x: (-len(x["matched_keywords"]), str(x.get("year") or ""), x["title"]))
    out_dir = CEPH / "research"
    out_dir.mkdir(parents=True, exist_ok=True)
    with (out_dir / "culling_hits.jsonl").open("w", encoding="utf-8") as f:
        for hit in hits:
            f.write(json.dumps(hit, ensure_ascii=False) + "\n")
    top = hits[: args.top]
    (out_dir / "culling_hits_top.json").write_text(json.dumps(top, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"scanned_derived_zh_rows": scanned, "scanned_d4_sample_rows": d4_scanned,
                      "hit_rows_before_dedup": len(all_hits), "unique_hits": len(hits),
                      "top_written": len(top), "elapsed_s": round(time.time() - started, 1),
                      "jsonl": str(out_dir / "culling_hits.jsonl"), "top": top}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
