#!/usr/bin/env python3
"""Download a Bilibili collection (audio + video DASH streams, metadata) to Ceph as a Ray job.

Uses the public view/playurl APIs rather than the video web page, which returns HTTP 412 to
proxied crawlers. Streams are saved separately (no merge) so worker nodes need no ffmpeg.
Idempotent: finished files are skipped. Optional env BILI_COOKIE_FILE (a private file on Ceph,
mode 600) enables 1080p and AI subtitles; the 1080p stream is saved as video1080.m4s so the
480p video.m4s used by downstream jobs is left untouched.
"""
from __future__ import annotations

import sys as _private_sys
from pathlib import Path as _PrivatePath
if 'ml.common.private_env' not in _private_sys.modules:
    _private_sys.path.insert(0, str(_PrivatePath(__file__).resolve().parents[2]))
from ml.common.private_env import require_path
import json
import os
import random
import time
import urllib.request

import ray

OUT = os.environ.get("REF_OUT", require_path('ECP_CEPH_ROOT') + '/references/yidao')
MANIFEST = json.loads(os.environ["REF_MANIFEST"])
CONCURRENCY = max(1, min(4, int(os.environ.get("REF_CONCURRENCY", "4"))))
COOKIE_FILE = os.environ.get("BILI_COOKIE_FILE")
COOKIE = open(COOKIE_FILE).read().strip() if COOKIE_FILE and os.path.exists(COOKIE_FILE) else ""
VIDEO_NAME = "video1080" if COOKIE else "video"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"


def headers(bvid: str) -> dict:
    result = {"User-Agent": UA, "Referer": f"https://www.bilibili.com/video/{bvid}"}
    if COOKIE:
        result["Cookie"] = COOKIE
    return result


def api(url: str, bvid: str) -> dict:
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers(bvid)), timeout=30) as response:
        body = json.load(response)
    if body.get("code") != 0:
        raise RuntimeError(f"{url}: {body.get('code')} {body.get('message')}")
    return body["data"]


def download(urls: list[str], target: str, bvid: str) -> int:
    temp = target + ".part"
    for url in urls:
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=headers(bvid)), timeout=60) as response, open(temp, "wb") as f:
                while chunk := response.read(1 << 20):
                    f.write(chunk)
            os.replace(temp, target)
            return os.path.getsize(target)
        except Exception as error:  # try backup CDN url
            last = error
    raise RuntimeError(f"download failed: {last}")


@ray.remote(num_cpus=1, max_retries=1)
def fetch(video: dict) -> dict:
    bvid = video["bvid"]
    folder = f"{OUT}/raw/{bvid}"
    os.makedirs(folder, exist_ok=True)
    result = {"bvid": bvid}
    try:
        time.sleep(random.uniform(float(os.environ.get("REF_DELAY_MIN", "0.5")), float(os.environ.get("REF_DELAY_MAX", "2.0"))))
        view = api(f"https://api.bilibili.com/x/web-interface/view?bvid={bvid}", bvid)
        with open(f"{folder}/info.json", "w", encoding="utf-8") as f:
            json.dump(view, f, ensure_ascii=False)
        play = api(f"https://api.bilibili.com/x/player/playurl?bvid={bvid}&cid={view['cid']}&qn=80&fnval=16&fourk=0", bvid)
        dash = play["dash"]
        audio = max(dash["audio"], key=lambda s: s["bandwidth"])
        avc = [s for s in dash["video"] if s.get("codecs", "").startswith("avc")] or dash["video"]
        best = max(avc, key=lambda s: (s["height"], s["bandwidth"]))
        result["height"] = best["height"]
        if COOKIE:
            subtitle = api(f"https://api.bilibili.com/x/player/wbi/v2?bvid={bvid}&cid={view['cid']}", bvid).get("subtitle", {})
            zh = next((s for s in subtitle.get("subtitles", []) if s.get("lan") == "ai-zh"), None)
            target = f"{folder}/subtitle-ai-zh.json"
            if zh and zh.get("subtitle_url") and not os.path.exists(target):
                url = zh["subtitle_url"]
                download([url if url.startswith("http") else "https:" + url], target, bvid)
            result["subtitle"] = os.path.exists(target)
        for kind, name, stream in (("audio", "audio", audio), ("video", VIDEO_NAME, best)):
            target = f"{folder}/{name}.m4s"
            if os.path.exists(target):
                result[kind] = os.path.getsize(target)
                continue
            urls = [stream.get("baseUrl") or stream.get("base_url")] + (stream.get("backupUrl") or stream.get("backup_url") or [])
            result[kind] = download([u for u in urls if u], target, bvid)
    except Exception as error:
        result["error"] = str(error)[:400]
    return result


def main() -> None:
    ray.init(address="auto")
    os.makedirs(OUT, exist_ok=True)
    with open(f"{OUT}/manifest.json", "w", encoding="utf-8") as f:
        json.dump(MANIFEST, f, ensure_ascii=False, indent=1)
    pending, results = [], []
    for video in MANIFEST["videos"]:
        if len(pending) >= CONCURRENCY:
            ready, pending = ray.wait(pending, num_returns=1)
            results += ray.get(ready)
            print("DONE " + json.dumps(results[-1], ensure_ascii=False), flush=True)
        pending.append(fetch.remote(video))
    for item in ray.get(pending):
        results.append(item)
        print("DONE " + json.dumps(item, ensure_ascii=False), flush=True)
    with open(f"{OUT}/fetch-report.json", "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=1)
    failed = [r["bvid"] for r in results if r.get("error")]
    total = sum(r.get("audio", 0) + r.get("video", 0) for r in results if not r.get("error"))
    print("SUMMARY " + json.dumps({"total": len(results), "failed": failed, "gb": round(total / 1e9, 2)}), flush=True)
    if failed: raise SystemExit(1)


if __name__ == "__main__":
    main()
