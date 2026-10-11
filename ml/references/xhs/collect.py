"""Merges exported xhs-*.json files into one JSONL, deduplicated by noteId (latest capture wins).

Usage: python collect.py [--src ~/Downloads] [--out data/cache/references/xhs/notes.jsonl]
"""
import argparse
import json
import pathlib

FORBIDDEN_KEYS = {"nickname", "userId", "user", "avatar", "profile", "author"}


def scrub(obj):
    if isinstance(obj, dict):
        return {k: scrub(v) for k, v in obj.items() if k not in FORBIDDEN_KEYS}
    if isinstance(obj, list):
        return [scrub(v) for v in obj]
    return obj


def merge(paths, existing):
    notes = {n["noteId"] or n["url"]: n for n in existing}
    for p in sorted(paths):
        n = scrub(json.loads(p.read_text(encoding="utf-8")))
        if n.get("source") != "xiaohongshu":
            continue
        key = n.get("noteId") or n["url"]
        old = notes.get(key)
        if old is None or n["capturedAt"] >= old["capturedAt"]:
            notes[key] = n
    return list(notes.values())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=str(pathlib.Path.home() / "Downloads"))
    ap.add_argument("--out", default="data/cache/references/xhs/notes.jsonl")
    args = ap.parse_args()
    out = pathlib.Path(args.out)
    existing = []
    if out.exists():
        existing = [json.loads(l) for l in out.read_text(encoding="utf-8").splitlines() if l.strip()]
    notes = merge(pathlib.Path(args.src).expanduser().glob("xhs-*.json"), existing)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("".join(json.dumps(n, ensure_ascii=False) + "\n" for n in notes), encoding="utf-8")
    total = sum(n.get("loadedComments", 0) for n in notes)
    print(f"{len(notes)} notes, {total} comments -> {out}")


if __name__ == "__main__":
    main()
