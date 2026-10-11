"""Slowly browses Xiaohongshu in the user's own running Edge (via AppleScript) and saves note text + comments.

Requires Edge: View > Developer > Allow JavaScript from Apple Events.
Opens one background tab in the front window (focus stays on the user's tab), stops at the first security/login page.

Usage: python browse_edge.py --keywords "人像摄影 点评,风光摄影 构图" --notes-per-keyword 6
"""
import argparse
import json
import pathlib
import random
import re
import subprocess
import signal
import time
import urllib.parse

HERE = pathlib.Path(__file__).parent
EXPORT_JS = (HERE / "export_note.js").read_text(encoding="utf-8")
BLOCK_MARKERS = ("website-login/error", "/login", "captcha", "verify")


def osa(script):
    try:
        r = subprocess.run(["osascript", "-"], input=script, capture_output=True, text=True, timeout=60)
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("osascript timed out") from exc
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip())
    return r.stdout.strip()


def as_str(s):
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


class EdgeTab:
    """One background tab in the user's front Edge window; the user's active tab is restored right away."""

    def __init__(self, url):
        self.win, self.id = osa(
            'tell application "Microsoft Edge"\n'
            'set w to window 1\nset keep to active tab index of w\n'
            f'set t to make new tab at end of tabs of w with properties {{URL:{as_str(url)}}}\n'
            'set active tab index of w to keep\n'
            'return (id of w as text) & "," & (id of t as text)\nend tell').split(",")

    def tab(self):
        return f'(tab id {self.id} of window id {self.win})'

    def goto(self, url):
        osa(f'tell application "Microsoft Edge" to set URL of {self.tab()} to {as_str(url)}')
        self.wait_loaded()

    def wait_loaded(self, timeout=40):
        end = time.time() + timeout
        time.sleep(1.5)
        while time.time() < end:
            if osa(f'tell application "Microsoft Edge" to get loading of {self.tab()}') == "false":
                return
            time.sleep(1)

    def url(self):
        return osa(f'tell application "Microsoft Edge" to get URL of {self.tab()}')

    def js(self, code):
        return osa(f'tell application "Microsoft Edge" to execute {self.tab()} javascript {as_str(code)}')

    def close(self):
        osa(f'tell application "Microsoft Edge" to close {self.tab()}')


def pause(lo, hi):
    time.sleep(random.uniform(lo, hi))


def check_blocked(win):
    url = win.url()
    if any(m in url for m in BLOCK_MARKERS):
        raise SystemExit(f"stopped: security/login page {url.split('?')[0]}")


def human_scroll(win, container_sel, steps):
    for _ in range(steps):
        dy = random.randint(350, 900)
        win.js(f"(() => {{ const s = document.querySelector('{container_sel}');"
               f" (s || window).scrollBy({{top: {dy}, behavior: 'instant'}}); return 1; }})()")
        pause(2.5, 6)


def search_links(win, keyword, want):
    win.goto("https://www.xiaohongshu.com/search_result?keyword=" + urllib.parse.quote(keyword) + "&type=51")
    pause(5, 9)
    check_blocked(win)
    links = []
    for _ in range(6):
        found = json.loads(win.js(
            "JSON.stringify(Array.from(document.querySelectorAll('section.note-item a'))"
            ".map(a => a.href).filter(h => /\\/(explore|search_result)\\/[0-9a-f]+\\?.*xsec_token/.test(h)))") or "[]")
        for h in found:
            if h not in links:
                links.append(h)
        if len(links) >= want * 2:
            break
        human_scroll(win, "#global", 1)
    random.shuffle(links)
    return links[:want]


def read_note(win, url, scroll_steps):
    win.goto(url)
    pause(6, 12)
    check_blocked(win)
    human_scroll(win, ".note-scroller", scroll_steps)
    raw = win.js("window.__xhsExportReturn = 1;\n" + EXPORT_JS)
    return json.loads(raw) if raw else {"error": "empty"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--keywords", required=True)
    ap.add_argument("--notes-per-keyword", type=int, default=6)
    ap.add_argument("--scroll-steps", type=int, default=5)
    ap.add_argument("--out", default="data/cache/references/xhs/raw")
    args = ap.parse_args()
    out = pathlib.Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(SystemExit("terminated")))
    win = EdgeTab("https://www.xiaohongshu.com/explore")
    try:
        win.wait_loaded()
        pause(6, 10)
        check_blocked(win)
        human_scroll(win, "#global", 2)
        for kw in [k.strip() for k in args.keywords.split(",") if k.strip()]:
            try:
                links = search_links(win, kw, args.notes_per_keyword)
            except RuntimeError as exc:
                print(f"[{kw}] search error {str(exc)[:120]}", flush=True)
                pause(30, 60)
                continue
            print(f"[{kw}] {len(links)} notes", flush=True)
            failures = 0
            for link in links:
                note_id = (re.search(r"/([0-9a-f]{24})\?", link) or [None, None])[1]
                if note_id and any(out.glob(f"xhs-{note_id}-*.json")):
                    continue
                try:
                    note = read_note(win, link, args.scroll_steps)
                    failures = 0
                except RuntimeError as exc:
                    failures += 1
                    print("  error", str(exc)[:120], flush=True)
                    if failures >= 2:
                        raise SystemExit("stopped: repeated Edge errors")
                    pause(30, 60)
                    continue
                if note.get("error"):
                    print("  skip", note["error"], flush=True)
                else:
                    note["keyword"] = kw
                    (out / f"xhs-{note['noteId']}-{int(time.time() * 1000)}.json").write_text(
                        json.dumps(note, ensure_ascii=False, indent=2), encoding="utf-8")
                    print(f"  {note['noteId']} {note['title'][:20]!r} comments={note['loadedComments']}", flush=True)
                pause(15, 30)
            pause(30, 60)
    finally:
        try:
            win.close()
        except RuntimeError:
            print("could not close the browsing tab", flush=True)


if __name__ == "__main__":
    main()
