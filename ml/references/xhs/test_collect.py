import json

from collect import merge


def note(nid, at, **extra):
    return {"source": "xiaohongshu", "noteId": nid, "url": f"u/{nid}", "capturedAt": at,
            "comments": [], "loadedComments": 0, **extra}


def test_latest_capture_wins_and_identity_fields_scrubbed(tmp_path):
    (tmp_path / "xhs-a-1.json").write_text(json.dumps(note("a", "2026-01-01", desc="old")))
    (tmp_path / "xhs-a-2.json").write_text(json.dumps(note("a", "2026-01-02", desc="new",
        comments=[{"text": "构图好", "nickname": "x", "replies": []}])))
    (tmp_path / "xhs-b-1.json").write_text(json.dumps(note("b", "2026-01-01")))
    (tmp_path / "other.json").write_text(json.dumps({"source": "other"}))
    notes = {n["noteId"]: n for n in merge(tmp_path.glob("xhs-*.json"), [note("c", "2025-12-31")])}
    assert set(notes) == {"a", "b", "c"}
    assert notes["a"]["desc"] == "new"
    assert "nickname" not in notes["a"]["comments"][0]
