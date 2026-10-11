#!/usr/bin/env python3
"""Probe public dataset landing pages from the Ray egress network.

No image archive is downloaded by default.  This produces auditable HTTP
status, redirect and content-type evidence for docs/research-culling.md.
"""
from __future__ import annotations
import sys as _private_sys
from pathlib import Path as _PrivatePath
if 'ml.common.private_env' not in _private_sys.modules:
    _private_sys.path.insert(0, str(_PrivatePath(__file__).resolve().parents[2]))
from ml.common.private_env import require_path
import os
import json, os, time
from pathlib import Path
from urllib.request import Request, urlopen

CEPH = Path(require_path('ECP_CEPH_ROOT'))
URLS = {
    "photo_triage_http": "http://phototriage.cs.princeton.edu/",
    "photo_triage_https": "https://phototriage.cs.princeton.edu/",
    "cpc_home": "https://www3.cs.stonybrook.edu/~cvl/projects/wei2018goods/VPN_CVPR2018s.html",
    "gaic_repo": "https://github.com/HuiZeng/GAIC",
    "aadb_repo": "https://github.com/cs-chan/Deep-Image-Aesthetics-Datasets",
    "flickr_aes_search": "https://huggingface.co/api/datasets?search=FLICKR-AES&limit=5",
    "real_cur_search": "https://huggingface.co/api/datasets?search=REAL-CUR&limit=5",
    "spaq_repo": "https://github.com/zwx8981/SPAQ",
    "kon_iq_repo": "https://github.com/huaxiaoman7/konIQ-10k",
    "paq2piq_repo": "https://github.com/ys-zong/PaQ-2-PiQ",
    "cew_search": "https://huggingface.co/api/datasets?search=closed%20eyes&limit=5",
    "cadb_repo": "https://github.com/bcmi/Image-Composition-Assessment-Dataset-CADB",
    "series_selection_repo": "https://github.com/zhenshen-mla/Series-Photo-Selection",
}

def probe(url: str) -> dict:
    req = Request(url, headers={"User-Agent": "eagle-culling-research/1"})
    try:
        with urlopen(req, timeout=45) as r:
            return {"url": url, "status": r.status, "final_url": r.geturl(),
                    "content_type": r.headers.get("Content-Type"),
                    "content_length": r.headers.get("Content-Length")}
    except Exception as exc:
        return {"url": url, "status": None, "error": f"{type(exc).__name__}: {exc}"}

def main() -> None:
    result = {"timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
              "proxy": os.environ.get("HTTPS_PROXY"),
              "results": {name: probe(url) for name, url in URLS.items()}}
    out = CEPH / "research" / "dataset_download_probes.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2), flush=True)

if __name__ == "__main__": main()
