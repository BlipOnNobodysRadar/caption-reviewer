import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
from io import BytesIO
from pathlib import Path
from typing import Any

from flask import Flask, jsonify, request, send_file, render_template

# Pillow is optional. Without it, comparison still matches by filename stem and
# by exact file bytes; only the perceptual (renamed/resized) tier is disabled.
try:
    from PIL import Image
    HAVE_PIL = True
except Exception:  # pragma: no cover - environment dependent
    Image = None
    HAVE_PIL = False

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

# Optional second folder for side-by-side comparison. COMPARE_CACHE holds the
# last computed match result so /api/compare-item and /media-b don't recompute.
COMPARE_ROOT: Path | None = None
COMPARE_RECURSIVE = False
COMPARE_CACHE: dict[str, Any] = {}
DEFAULT_MATCH_DISTANCE = 12


def now_ts() -> float:
    return time.time()


def allowed_image(path: Path) -> bool:
    return path.suffix.lower() in ALLOWED_IMG_EXTS


def normalize_status(status: str | None) -> str | None:
    if not status:
        return None
    status = status.strip().lower()
    return status if status in STATUS_OPTIONS else None



def run_windows_folder_picker() -> str | None:
    """Use the Windows shell folder browser instead of Tkinter."""
    if sys.platform != "win32":
        return None
    powershell = shutil.which("powershell.exe") or shutil.which("powershell") or shutil.which("pwsh")
    if not powershell:
        return None
    script = r'''
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Choose caption-review dataset folder'
$dialog.ShowNewFolderButton = $true
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Out.Write($dialog.SelectedPath)
}
'''
    cmd = [powershell, "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script]
    # Windows PowerShell supports -Sta, which keeps WinForms dialogs reliable.
    if Path(powershell).name.lower().startswith("powershell"):
        cmd.insert(1, "-Sta")
    proc = subprocess.run(cmd, text=True, capture_output=True, check=False)
    if proc.returncode == 0:
        selected = proc.stdout.strip()
        return selected or None
    return None


def run_macos_folder_picker() -> str | None:
    """Use macOS Finder's native folder picker when running on macOS."""
    if sys.platform != "darwin" or not shutil.which("osascript"):
        return None
    proc = subprocess.run(
        ["osascript", "-e", 'POSIX path of (choose folder with prompt "Choose caption-review dataset folder")'],
        text=True,
        capture_output=True,
        check=False,
    )
    if proc.returncode == 0:
        selected = proc.stdout.strip()
        return selected or None
    return None


def run_linux_folder_picker() -> str | None:
    """Use a native Linux desktop folder picker command when one is available."""
    if sys.platform != "linux" or not (os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")):
        return None

    commands = [
        ["zenity", "--file-selection", "--directory", "--title=Choose caption-review dataset folder"],
        ["kdialog", "--getexistingdirectory", str(Path.home()), "Choose caption-review dataset folder"],
        ["yad", "--file-selection", "--directory", "--title=Choose caption-review dataset folder"],
    ]
    for cmd in commands:
        if not shutil.which(cmd[0]):
            continue
        proc = subprocess.run(cmd, text=True, capture_output=True, check=False)
        if proc.returncode == 0:
            selected = proc.stdout.strip()
            return selected or None
        # Common cancel codes mean the user intentionally closed the picker.
        if proc.returncode in {1, 130, 252}:
            return None
    return None


def run_external_folder_picker() -> str | None:
    """Use the host OS's native folder picker before falling back to Tkinter."""
    return run_windows_folder_picker() or run_macos_folder_picker() or run_linux_folder_picker()


def choose_folder_dialog() -> str | None:
    """Open a native OS directory picker on the local server machine."""
    selected = run_external_folder_picker()
    if selected:
        return selected

    # Last-resort fallback for environments without a native OS picker command. This is
    # less native-looking on some desktops, so prefer the native pickers above.
    try:
        import tkinter as tk
        from tkinter import filedialog
    except Exception as exc:  # pragma: no cover - depends on desktop env
        raise RuntimeError(f"OS folder picker is unavailable: {exc}") from exc

    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    try:
        selected = filedialog.askdirectory(title="Choose caption-review dataset folder")
    finally:
        root.destroy()
    return selected or None

def require_root() -> Path:
    if ACTIVE_ROOT is None:
        raise RuntimeError("No target folder is open yet.")
    return ACTIVE_ROOT


def safe_resolve_under(root: Path, rel_path: str) -> Path:
    root = root.resolve()
    candidate = (root / rel_path).resolve()
    if root != candidate and root not in candidate.parents:
        raise RuntimeError("Path escaped target folder.")
    return candidate


def safe_resolve_under_root(rel_path: str) -> Path:
    return safe_resolve_under(require_root(), rel_path)


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


BACKUP_DIRNAME = ".caption_backups"
REMOVED_DIRNAME = "removed"


def backup_original_caption(root: Path, caption_path: Path) -> Path | None:
    """One-time copy of the pre-edit caption into .caption_backups/<rel>.

    Only the first save of a given caption file creates a backup, so the
    backup always holds the original (pre-tool) text."""
    if not caption_path.exists():
        return None
    rel = caption_path.relative_to(root)
    dest = root / BACKUP_DIRNAME / rel
    if dest.exists():
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(caption_path.read_bytes())
    return dest


def caption_preview(text: str, limit: int = 180) -> str:
    text = " ".join(text.strip().split())
    if len(text) <= limit:
        return text
    return text[: limit - 1] + "…"


# ---------------------------------------------------------------------------
# Cross-folder image matching (for compare mode).
#
# Images in the two folders may not share names, so matches are found in three
# tiers, each applied only to whatever is still unmatched:
#   1. filename stem   -> img001.jpg pairs with img001.png
#   2. exact bytes     -> same file, renamed
#   3. perceptual hash -> same picture, re-encoded / resized / renamed (Pillow)
# ---------------------------------------------------------------------------

def file_sha256(path: Path) -> str | None:
    try:
        h = hashlib.sha256()
        with path.open("rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        return h.hexdigest()
    except Exception:
        return None


def _lanczos_filter():
    # Pillow >= 9.1 moved the resampling constants under Image.Resampling.
    resampling = getattr(Image, "Resampling", None)
    if resampling is not None and hasattr(resampling, "LANCZOS"):
        return resampling.LANCZOS
    return getattr(Image, "LANCZOS", 1)


def perceptual_hash(path: Path, hash_size: int = 8) -> int | None:
    """64-bit difference hash (dHash). Robust to scaling and re-compression."""
    if not HAVE_PIL:
        return None
    try:
        with Image.open(path) as im:
            small = im.convert("L").resize((hash_size + 1, hash_size), _lanczos_filter())
            px = list(small.getdata())
    except Exception:
        return None
    bits = 0
    width = hash_size + 1
    for row in range(hash_size):
        base = row * width
        for col in range(hash_size):
            bits = (bits << 1) | (1 if px[base + col] > px[base + col + 1] else 0)
    return bits


def hamming_distance(a: int, b: int) -> int:
    # bin().count is portable across Python versions (no int.bit_count needed).
    return bin(a ^ b).count("1")


def compute_matches(
    root_a: Path, rec_a: bool, root_b: Path, rec_b: bool, max_distance: int
) -> dict[str, Any]:
    imgs_a = scan_images(root_a, rec_a)
    imgs_b = scan_images(root_b, rec_b)
    rels_a = [p.relative_to(root_a).as_posix() for p in imgs_a]
    rels_b = [p.relative_to(root_b).as_posix() for p in imgs_b]
    path_a = dict(zip(rels_a, imgs_a))
    path_b = dict(zip(rels_b, imgs_b))

    matches: dict[str, dict[str, Any]] = {}   # a_rel -> {b_rel, method, distance}
    used_b: set[str] = set()

    # Tier 1: filename stem.
    b_by_stem: dict[str, list[str]] = {}
    for r in rels_b:
        b_by_stem.setdefault(Path(r).stem.lower(), []).append(r)
    for r in rels_a:
        for cand in b_by_stem.get(Path(r).stem.lower(), []):
            if cand not in used_b:
                matches[r] = {"b_rel": cand, "method": "name", "distance": 0}
                used_b.add(cand)
                break

    rem_a = [r for r in rels_a if r not in matches]
    rem_b = [r for r in rels_b if r not in used_b]

    # Tier 2: exact file bytes (catches pure renames).
    if rem_a and rem_b:
        b_hash: dict[str, str] = {}
        for r in rem_b:
            digest = file_sha256(path_b[r])
            if digest:
                b_hash.setdefault(digest, r)
        for r in rem_a:
            digest = file_sha256(path_a[r])
            if digest and digest in b_hash and b_hash[digest] not in used_b:
                target = b_hash[digest]
                matches[r] = {"b_rel": target, "method": "bytes", "distance": 0}
                used_b.add(target)
        rem_a = [r for r in rem_a if r not in matches]
        rem_b = [r for r in rels_b if r not in used_b]

    # Tier 3: perceptual hash (same picture, re-encoded / resized).
    if HAVE_PIL and rem_a and rem_b:
        ah = {r: h for r in rem_a if (h := perceptual_hash(path_a[r])) is not None}
        bh = {r: h for r in rem_b if (h := perceptual_hash(path_b[r])) is not None}
        pairs: list[tuple[int, str, str]] = []
        for ar, av in ah.items():
            for br, bv in bh.items():
                d = hamming_distance(av, bv)
                if d <= max_distance:
                    pairs.append((d, ar, br))
        pairs.sort()
        for d, ar, br in pairs:
            if ar in matches or br in used_b:
                continue
            matches[ar] = {"b_rel": br, "method": "phash", "distance": d}
            used_b.add(br)

    by_method = {"name": 0, "bytes": 0, "phash": 0}
    for m in matches.values():
        by_method[m["method"]] = by_method.get(m["method"], 0) + 1

    return {
        "matches": matches,
        "rels_b": rels_b,
        "summary": {
            "a_total": len(rels_a),
            "b_total": len(rels_b),
            "matched": len(matches),
            "a_only": len(rels_a) - len(matches),
            "b_only": len(rels_b) - len(used_b),
            "by_method": by_method,
        },
        "have_pil": HAVE_PIL,
        "max_distance": max_distance,
    }


def scan_images(root: Path, recursive: bool) -> list[Path]:
    iterator = root.rglob("*") if recursive else root.iterdir()
    out = [
        p for p in iterator
        if (
            p.is_file()
            and allowed_image(p)
            and BACKUP_DIRNAME not in p.parts
            and REMOVED_DIRNAME not in p.relative_to(root).parts
        )
    ]
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



@app.route("/api/pick-folder", methods=["POST"])
def pick_folder():
    try:
        selected = choose_folder_dialog()
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500
    if not selected:
        return jsonify({"ok": True, "path": ""})
    path = Path(selected).expanduser().resolve()
    if not path.exists() or not path.is_dir():
        return jsonify({"error": "Selected path is not a directory."}), 400
    return jsonify({"ok": True, "path": str(path)})

@app.route("/api/open-folder", methods=["POST"])
def open_folder():
    global ACTIVE_ROOT, LAST_RECURSIVE, COMPARE_ROOT, COMPARE_CACHE
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
    # A new primary folder invalidates any prior comparison.
    COMPARE_ROOT = None
    COMPARE_CACHE = {}

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

    backed_up = None
    if bool(data.get("backup", True)):
        try:
            backed_up = backup_original_caption(root, image_to_caption_path(image_path))
        except Exception:
            backed_up = None

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
            "backup": str(backed_up) if backed_up else None,
        }
    )


def remove_pair(root: Path, image_path: Path, mode: str) -> dict[str, Any]:
    """Delete or move an image and its matching caption out of the review set."""
    rel = image_path.relative_to(root).as_posix()
    caption_path = image_to_caption_path(image_path)
    paths = [image_path]
    if caption_path.exists():
        paths.append(caption_path)

    if mode == "delete":
        removed_paths: list[str] = []
        for path in paths:
            path.unlink()
            removed_paths.append(str(path))
        destination = None
    elif mode == "move":
        removed_paths = []
        destination = root / REMOVED_DIRNAME / image_path.relative_to(root)
        for path in paths:
            dest = root / REMOVED_DIRNAME / path.relative_to(root)
            dest.parent.mkdir(parents=True, exist_ok=True)
            if dest.exists():
                suffix = int(now_ts())
                dest = dest.with_name(f"{dest.stem}_{suffix}{dest.suffix}")
            shutil.move(str(path), str(dest))
            removed_paths.append(str(dest))
    else:
        raise RuntimeError("Invalid removal mode.")

    state = load_state(root)
    state.setdefault("items", {}).pop(rel, None)
    save_state(root, state)
    return {
        "rel": rel,
        "mode": mode,
        "paths": removed_paths,
        "destination": str(destination) if destination else None,
    }


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


@app.route("/api/remove-pair", methods=["POST"])
def remove_caption_image_pair():
    root = require_root()
    data = request.get_json(force=True)
    rel = data.get("rel", "")
    mode = (data.get("mode") or "move").strip().lower()
    if mode not in {"move", "delete"}:
        return jsonify({"error": "Removal mode must be 'move' or 'delete'."}), 400
    image_path = safe_resolve_under_root(rel)
    if not image_path.exists() or not image_path.is_file() or not allowed_image(image_path):
        return jsonify({"error": "Image not found."}), 404
    if REMOVED_DIRNAME in image_path.relative_to(root).parts:
        return jsonify({"error": "Item is already in the removed folder."}), 400
    try:
        result = remove_pair(root, image_path, mode)
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500
    return jsonify({"ok": True, **result, "counts": build_counts(root, LAST_RECURSIVE)})


@app.route("/media/<path:rel>")
def media(rel: str):
    image_path = safe_resolve_under_root(rel)
    if not image_path.exists() or not image_path.is_file() or not allowed_image(image_path):
        return jsonify({"error": "Image not found."}), 404
    return send_file(image_path)


# Small thumbnails for the item list. Generated with Pillow and cached in memory,
# keyed by (rel, mtime) so an edited/replaced image refreshes automatically. If
# Pillow is unavailable or an image cannot be decoded, the full image is served
# instead, so the list still works (just heavier).
THUMB_MAX_EDGE = 96
_THUMB_CACHE: dict[str, tuple[float, bytes, str]] = {}
_THUMB_CACHE_LIMIT = 2048


def make_thumbnail(path: Path) -> tuple[bytes, str] | None:
    if not HAVE_PIL:
        return None
    try:
        with Image.open(path) as im:
            im = im.convert("RGB")
            im.thumbnail((THUMB_MAX_EDGE, THUMB_MAX_EDGE), _lanczos_filter())
            buf = BytesIO()
            im.save(buf, format="JPEG", quality=80)
            return buf.getvalue(), "image/jpeg"
    except Exception:
        return None


@app.route("/thumb/<path:rel>")
def thumb(rel: str):
    image_path = safe_resolve_under_root(rel)
    if not image_path.exists() or not image_path.is_file() or not allowed_image(image_path):
        return jsonify({"error": "Image not found."}), 404
    try:
        mtime = image_path.stat().st_mtime
    except OSError:
        mtime = 0.0
    cached = _THUMB_CACHE.get(rel)
    if cached and cached[0] == mtime:
        return app.response_class(cached[1], mimetype=cached[2])
    made = make_thumbnail(image_path)
    if made is None:
        return send_file(image_path)
    data, mimetype = made
    if len(_THUMB_CACHE) >= _THUMB_CACHE_LIMIT:
        _THUMB_CACHE.clear()
    _THUMB_CACHE[rel] = (mtime, data, mimetype)
    return app.response_class(data, mimetype=mimetype)


@app.route("/api/state-file", methods=["GET"])
def get_state_file():
    root = require_root()
    return jsonify({"state_file": str(state_path(root)), "state": load_state(root)})


@app.route("/api/open-compare-folder", methods=["POST"])
def open_compare_folder():
    global COMPARE_ROOT, COMPARE_RECURSIVE, COMPARE_CACHE
    if ACTIVE_ROOT is None:
        return jsonify({"error": "Open a primary folder first."}), 400
    data = request.get_json(force=True)
    folder = (data.get("compare_folder") or "").strip()
    recursive = bool(data.get("recursive", False))
    a_recursive = bool(data.get("a_recursive", LAST_RECURSIVE))
    try:
        max_distance = int(data.get("max_distance", DEFAULT_MATCH_DISTANCE))
    except (TypeError, ValueError):
        max_distance = DEFAULT_MATCH_DISTANCE
    max_distance = max(0, min(64, max_distance))

    if not folder:
        return jsonify({"error": "Compare folder is required."}), 400
    root_b = Path(folder).expanduser().resolve()
    if not root_b.exists() or not root_b.is_dir():
        return jsonify({"error": "Compare folder does not exist or is not a directory."}), 400
    if root_b == ACTIVE_ROOT.resolve():
        return jsonify({"error": "Compare folder is the same as the primary folder."}), 400

    COMPARE_ROOT = root_b
    COMPARE_RECURSIVE = recursive
    result = compute_matches(ACTIVE_ROOT, a_recursive, root_b, recursive, max_distance)
    COMPARE_CACHE = {
        "a_root": str(ACTIVE_ROOT.resolve()),
        "b_root": str(root_b),
        "result": result,
    }
    return jsonify(
        {
            "ok": True,
            "compare_root": str(root_b),
            "recursive": recursive,
            "have_pil": result["have_pil"],
            "max_distance": max_distance,
            "summary": result["summary"],
            "matches": result["matches"],
            "b_images": [{"rel": r, "filename": Path(r).name} for r in result["rels_b"]],
        }
    )


@app.route("/api/compare-item", methods=["GET"])
def compare_item():
    if COMPARE_ROOT is None:
        return jsonify({"error": "No compare folder is open."}), 400
    a_rel = request.args.get("rel", "")
    override = request.args.get("b_rel", "").strip()
    result = COMPARE_CACHE.get("result") or {}
    matches = result.get("matches", {})

    if override:
        b_rel, method, distance, overridden = override, "manual", None, True
    else:
        m = matches.get(a_rel)
        if not m:
            return jsonify({"matched": False, "overridden": False})
        b_rel, method, distance, overridden = m["b_rel"], m["method"], m["distance"], False

    try:
        b_path = safe_resolve_under(COMPARE_ROOT, b_rel)
    except RuntimeError:
        return jsonify({"matched": False, "overridden": overridden, "error": "Bad path."})
    if not b_path.exists() or not b_path.is_file() or not allowed_image(b_path):
        return jsonify({"matched": False, "overridden": overridden, "error": "Matched image not found."})

    caption_path = image_to_caption_path(b_path)
    return jsonify(
        {
            "matched": True,
            "overridden": overridden,
            "method": method,
            "distance": distance,
            "b_rel": b_rel,
            "b_filename": b_path.name,
            "b_image_url": f"/media-b/{b_rel}",
            "b_caption": read_caption(b_path),
            "b_caption_path": str(caption_path),
            "b_caption_exists": caption_path.exists(),
        }
    )


@app.route("/api/compare-clear", methods=["POST"])
def compare_clear():
    global COMPARE_ROOT, COMPARE_CACHE
    COMPARE_ROOT = None
    COMPARE_CACHE = {}
    return jsonify({"ok": True})


@app.route("/media-b/<path:rel>")
def media_b(rel: str):
    if COMPARE_ROOT is None:
        return jsonify({"error": "No compare folder is open."}), 404
    try:
        image_path = safe_resolve_under(COMPARE_ROOT, rel)
    except RuntimeError:
        return jsonify({"error": "Image not found."}), 404
    if not image_path.exists() or not image_path.is_file() or not allowed_image(image_path):
        return jsonify({"error": "Image not found."}), 404
    return send_file(image_path)


if __name__ == "__main__":
    # Local-only by default. This tool reads and writes files anywhere on your
    # machine and has no authentication, so it must not be reachable from the
    # network. Binding to 0.0.0.0 and/or enabling Flask's debugger would expose
    # an arbitrary-code-execution surface to anyone who can reach the port. Only
    # opt in if you understand that, e.g. on a trusted LAN:
    #   CAPTION_REVIEWER_HOST=0.0.0.0 CAPTION_REVIEWER_DEBUG=1 python app.py
    host = os.environ.get("CAPTION_REVIEWER_HOST", "127.0.0.1")
    port = int(os.environ.get("CAPTION_REVIEWER_PORT", "5062"))
    debug = os.environ.get("CAPTION_REVIEWER_DEBUG", "").strip().lower() in ("1", "true", "yes", "on")
    app.run(host=host, port=port, debug=debug)
