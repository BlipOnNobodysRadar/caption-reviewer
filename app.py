import json
import os
import time
from pathlib import Path
from typing import Any

from flask import Flask, jsonify, request, send_file, render_template

APP_TITLE = "Caption Reviewer"
ALLOWED_IMG_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif"}
STATE_FILENAME = ".caption_review_state.json"

STATUS_OPTIONS = [
    "excellent",
    "good_enough",
    "needs_work",
    "bad",
    "terrible",
    "fixed",
]

STATUS_LABELS = {
    "unrated": "Unrated",
    "excellent": "Excellent",
    "good_enough": "Good enough",
    "needs_work": "Needs work",
    "bad": "Bad",
    "terrible": "Terrible",
    "fixed": "Fixed",
}

STATUS_SORT_ORDER = {
    "unrated": 0,
    "needs_work": 1,
    "bad": 2,
    "terrible": 3,
    "fixed": 4,
    "good_enough": 5,
    "excellent": 6,
}

app = Flask(__name__, template_folder=".", static_folder=".", static_url_path="/static")

# Local-only tool state. This is intentionally simple: one active folder at a time.
ACTIVE_ROOT: Path | None = None
LAST_RECURSIVE = False


def now_ts() -> float:
    return time.time()


def allowed_image(path: Path) -> bool:
    return path.suffix.lower() in ALLOWED_IMG_EXTS


def normalize_status(status: str | None) -> str | None:
    if not status:
        return None
    status = status.strip().lower()
    return status if status in STATUS_OPTIONS else None


def require_root() -> Path:
    if ACTIVE_ROOT is None:
        raise RuntimeError("No target folder is open yet.")
    return ACTIVE_ROOT


def safe_resolve_under_root(rel_path: str) -> Path:
    root = require_root().resolve()
    candidate = (root / rel_path).resolve()
    if root != candidate and root not in candidate.parents:
        raise RuntimeError("Path escaped target folder.")
    return candidate


def state_path(root: Path) -> Path:
    return root / STATE_FILENAME


def load_state(root: Path) -> dict[str, Any]:
    path = state_path(root)
    if not path.exists():
        return {"version": 1, "items": {}}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        # Do not destroy a broken state file automatically.
        return {"version": 1, "items": {}}
    if not isinstance(data, dict):
        return {"version": 1, "items": {}}
    data.setdefault("version", 1)
    data.setdefault("items", {})
    if not isinstance(data["items"], dict):
        data["items"] = {}
    return data


def save_state(root: Path, state: dict[str, Any]) -> None:
    path = state_path(root)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(state, indent=2, sort_keys=True), encoding="utf-8")
    os.replace(tmp, path)


def image_to_caption_path(image_path: Path) -> Path:
    return image_path.with_suffix(".txt")


def read_caption(image_path: Path) -> str:
    caption_path = image_to_caption_path(image_path)
    if not caption_path.exists():
        return ""
    return caption_path.read_text(encoding="utf-8", errors="replace")


def write_caption(image_path: Path, caption: str) -> Path:
    caption_path = image_to_caption_path(image_path)
    caption_path.write_text(caption.rstrip() + "\n", encoding="utf-8")
    return caption_path


def caption_preview(text: str, limit: int = 180) -> str:
    text = " ".join(text.strip().split())
    if len(text) <= limit:
        return text
    return text[: limit - 1] + "…"


def scan_images(root: Path, recursive: bool) -> list[Path]:
    iterator = root.rglob("*") if recursive else root.iterdir()
    out = [p for p in iterator if p.is_file() and allowed_image(p)]
    out.sort(key=lambda p: str(p.relative_to(root)).lower())
    return out


def build_items(root: Path, recursive: bool, status_filter: str = "all", sort_by: str = "status") -> list[dict[str, Any]]:
    state = load_state(root)
    state_items = state.get("items", {})
    items: list[dict[str, Any]] = []

    for image_path in scan_images(root, recursive=recursive):
        rel = image_path.relative_to(root).as_posix()
        meta = state_items.get(rel, {}) if isinstance(state_items.get(rel, {}), dict) else {}
        status = normalize_status(meta.get("status")) or "unrated"

        if status_filter != "all" and status != status_filter:
            continue

        caption_path = image_to_caption_path(image_path)
        cap_text = read_caption(image_path) if caption_path.exists() else ""
        items.append(
            {
                "rel": rel,
                "filename": image_path.name,
                "folder": image_path.parent.relative_to(root).as_posix() if image_path.parent != root else ".",
                "status": status,
                "status_label": STATUS_LABELS.get(status, status),
                "caption_exists": caption_path.exists(),
                "caption_preview": caption_preview(cap_text),
                "image_mtime": image_path.stat().st_mtime,
                "caption_mtime": caption_path.stat().st_mtime if caption_path.exists() else None,
                "updated_at": meta.get("updated_at"),
            }
        )

    if sort_by == "filename":
        items.sort(key=lambda x: x["rel"].lower())
    elif sort_by == "modified":
        items.sort(key=lambda x: x.get("caption_mtime") or x.get("image_mtime") or 0, reverse=True)
    else:
        items.sort(key=lambda x: (STATUS_SORT_ORDER.get(x["status"], 99), x["rel"].lower()))

    return items


def build_counts(root: Path, recursive: bool) -> dict[str, int]:
    counts = {"all": 0, "unrated": 0}
    for status in STATUS_OPTIONS:
        counts[status] = 0

    state = load_state(root)
    state_items = state.get("items", {})
    for image_path in scan_images(root, recursive=recursive):
        rel = image_path.relative_to(root).as_posix()
        meta = state_items.get(rel, {}) if isinstance(state_items.get(rel, {}), dict) else {}
        status = normalize_status(meta.get("status")) or "unrated"
        counts["all"] += 1
        counts[status] = counts.get(status, 0) + 1
    return counts


@app.route("/")
def index():
    return render_template("index.html", app_title=APP_TITLE)


@app.route("/api/open-folder", methods=["POST"])
def open_folder():
    global ACTIVE_ROOT, LAST_RECURSIVE
    data = request.get_json(force=True)
    folder = (data.get("target_folder") or "").strip()
    recursive = bool(data.get("recursive", False))
    if not folder:
        return jsonify({"error": "Target folder is required."}), 400
    root = Path(folder).expanduser().resolve()
    if not root.exists() or not root.is_dir():
        return jsonify({"error": "Target folder does not exist or is not a directory."}), 400

    ACTIVE_ROOT = root
    LAST_RECURSIVE = recursive

    # Ensure the state file exists, but never write state into caption files.
    state = load_state(root)
    if not state_path(root).exists():
        save_state(root, state)

    items = build_items(root, recursive=recursive)
    return jsonify(
        {
            "ok": True,
            "root": str(root),
            "recursive": recursive,
            "state_file": str(state_path(root)),
            "counts": build_counts(root, recursive=recursive),
            "items": items,
        }
    )


@app.route("/api/list", methods=["GET"])
def list_items():
    root = require_root()
    recursive = request.args.get("recursive", str(LAST_RECURSIVE)).lower() in ("1", "true", "yes", "on")
    status_filter = request.args.get("status", "all")
    if status_filter != "all" and status_filter not in ["unrated", *STATUS_OPTIONS]:
        status_filter = "all"
    sort_by = request.args.get("sort", "status")
    items = build_items(root, recursive=recursive, status_filter=status_filter, sort_by=sort_by)
    return jsonify({"root": str(root), "counts": build_counts(root, recursive=recursive), "items": items})


@app.route("/api/item", methods=["GET"])
def get_item():
    root = require_root()
    rel = request.args.get("rel", "")
    image_path = safe_resolve_under_root(rel)
    if not image_path.exists() or not image_path.is_file() or not allowed_image(image_path):
        return jsonify({"error": "Image not found."}), 404

    state = load_state(root)
    meta = state.get("items", {}).get(rel, {})
    status = normalize_status(meta.get("status")) or "unrated"
    caption_path = image_to_caption_path(image_path)

    return jsonify(
        {
            "rel": rel,
            "filename": image_path.name,
            "status": status,
            "status_label": STATUS_LABELS.get(status, status),
            "caption": read_caption(image_path),
            "caption_path": str(caption_path),
            "caption_exists": caption_path.exists(),
            "image_url": f"/media/{rel}",
            "meta": meta,
        }
    )


@app.route("/api/status", methods=["POST"])
def set_status():
    root = require_root()
    data = request.get_json(force=True)
    rel = data.get("rel", "")
    status = normalize_status(data.get("status"))
    if not status:
        return jsonify({"error": "Invalid status."}), 400
    image_path = safe_resolve_under_root(rel)
    if not image_path.exists() or not allowed_image(image_path):
        return jsonify({"error": "Image not found."}), 404

    state = load_state(root)
    items = state.setdefault("items", {})
    entry = items.setdefault(rel, {})
    entry["status"] = status
    entry["updated_at"] = now_ts()
    save_state(root, state)
    return jsonify({"ok": True, "rel": rel, "status": status, "status_label": STATUS_LABELS[status]})


@app.route("/api/save-caption", methods=["POST"])
def save_caption():
    root = require_root()
    data = request.get_json(force=True)
    rel = data.get("rel", "")
    caption = data.get("caption", "")
    mark_fixed = bool(data.get("mark_fixed", False))

    image_path = safe_resolve_under_root(rel)
    if not image_path.exists() or not allowed_image(image_path):
        return jsonify({"error": "Image not found."}), 404

    caption_path = write_caption(image_path, caption)

    state = load_state(root)
    items = state.setdefault("items", {})
    entry = items.setdefault(rel, {})
    entry["caption_saved_at"] = now_ts()
    if mark_fixed:
        entry["status"] = "fixed"
        entry["updated_at"] = now_ts()
    save_state(root, state)

    return jsonify(
        {
            "ok": True,
            "rel": rel,
            "caption_path": str(caption_path),
            "status": normalize_status(entry.get("status")) or "unrated",
        }
    )


@app.route("/api/clear-status", methods=["POST"])
def clear_status():
    root = require_root()
    data = request.get_json(force=True)
    rel = data.get("rel", "")
    image_path = safe_resolve_under_root(rel)
    if not image_path.exists() or not allowed_image(image_path):
        return jsonify({"error": "Image not found."}), 404

    state = load_state(root)
    items = state.setdefault("items", {})
    if rel in items:
        items[rel].pop("status", None)
        items[rel]["updated_at"] = now_ts()
    save_state(root, state)
    return jsonify({"ok": True, "rel": rel, "status": "unrated"})


@app.route("/media/<path:rel>")
def media(rel: str):
    image_path = safe_resolve_under_root(rel)
    if not image_path.exists() or not image_path.is_file() or not allowed_image(image_path):
        return jsonify({"error": "Image not found."}), 404
    return send_file(image_path)


@app.route("/api/state-file", methods=["GET"])
def get_state_file():
    root = require_root()
    return jsonify({"state_file": str(state_path(root)), "state": load_state(root)})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5062, debug=True)
