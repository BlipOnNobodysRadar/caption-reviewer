# Caption Reviewer + BBox Editor

A local web tool for reviewing **and editing** image captions — including full
visual editing of bounding boxes for Ideogram-style structured JSON captions
(`[y_min, x_min, y_max, x_max]`, coordinates 0–1000).

## What it does

The screen is built to **maximize image space**: a slim top bar, a one-line
canvas toolbar, and the image(s) filling everything below. The item list (with
folder + compare setup, filters, and search) lives in a collapsible **Browse**
panel on the left, and the rating + caption editor lives in a collapsible
**Editor** panel on the right. Toggle either with its button in the top bar (or
close with `Esc`); use ←/→ in the bar — or `[` / `]` — to move between items
with both panels shut and the image full-bleed.

**Review** (the original workflow): open a folder of images and matching
`.txt` captions, rate each (`excellent` … `terrible`, `fixed`), filter and
sort by status. Review state lives in a sidecar `.caption_review_state.json`,
never inside caption files.

**Edit boxes on the image** (new): boxes are drawn over the image and are
fully interactive — click to select (smallest box wins, so tiny text boxes
are reachable under full-frame ones), drag to move, pull the 8 handles to
resize, press `B` and drag to draw a new box. Scroll to zoom, hold Space (or
middle mouse) to pan, `F` to refit. A live crosshair readout shows the cursor
in caption coordinates at all times, and arrow keys nudge the selected box by
1 unit (Shift = 10).

**Edit the caption as structured fields** (new): the Fields tab renders
`high_level_description`, `style_description`, the scene `background`, and an
element card for every entry in `compositional_deconstruction.elements` —
type, description, color palette, and the four bbox numbers (labeled in the
caption's own y-first order). Cards and canvas boxes select each other. Add,
duplicate, and delete elements; "Draw box" on a card binds the next drawn
rectangle to that element. The Raw JSON tab is always available and stays in
sync. Plain-text captions still work exactly as before.

**Keep files safe** (new): every edit goes through validation (coordinates
clamped to range, inverted corners swapped, floats rounded — one click fixes
all). Truncated JSON from cut-off captioner output is repaired automatically
on load using the same algorithm as the training pipeline. The first save of
any caption stores the untouched original under `.caption_backups/`, and
Ctrl+Z / Ctrl+Shift+Z undo and redo structured edits.

**Compare against a second folder** (new): in the **Browse** panel, point the
compare field at a second folder to line the two up **side by side**, each in
its own large canvas — useful for diffing an old caption pass against a new
one, or an upscaled image set against the originals. The two folders do **not**
have to use the same filenames. Each primary image is matched to its
counterpart with a three-step cascade, stopping at the first hit:

1. **Same name** — same filename stem (`cat.png` ↔ `cat.txt`/`cat.jpg`).
2. **Same bytes** — identical file content, so pure renames still line up
   (`cat.png` ↔ `renamed_4412.png`).
3. **Same picture** — a perceptual hash (dHash) matches images that *look* the
   same even after re-encoding, resizing, or a format change
   (`cat.png` ↔ `IMG_8831.jpg`). A tolerance slider controls how strict this
   is; anything still unmatched is reported as "only here" / "only in B" so
   nothing is silently dropped.

The second image (B) is shown **read-only** beside the editable one (A); both
support pan, zoom, and fit, and hovering any box on either side pops that
object's full caption. Two actions bridge the sides — **Copy B → A** drops the
second folder's caption into the editor as unsaved changes (review before
saving), and a **Pick…** match picker lets you override the automatic pairing
for any image, in case the look-alike step guesses wrong on near-duplicate
frames. B's full caption text sits in the Editor panel, and match overrides are
remembered per compare-folder in the browser.

The "same picture" step needs **Pillow** (`pip install pillow`); without it the
first two steps still work and the tool says so rather than failing.

## Expected folder layout

```text
my_dataset/
  image001.jpg
  image001.txt
  image002.png
  image002.txt
  .caption_review_state.json   # created by this tool
  .caption_backups/            # originals, created on first save
```

Captions are matched by stem: `image001.jpg` uses `image001.txt`.

## Caption format

The editor is built around Ideogram-style structured captions:

```json
{
  "high_level_description": "...",
  "style_description": { "aesthetics": "...", "lighting": "...", "...": "..." },
  "compositional_deconstruction": {
    "background": "...",
    "elements": [
      { "type": "obj", "bbox": [y1, x1, y2, x2], "desc": "...", "color_palette": ["#D4AF37"] }
    ]
  }
}
```

`bbox` values are integers from 0 to the coordinate max (default 1000),
relative to the original image, stored `[y_min, x_min, y_max, x_max]`. The
toolbar lets you switch the *interpretation* to `xyxy` and change the
coordinate max if your captions differ; whatever is selected is used
consistently for both display and editing. Saving from the Fields tab writes
pretty-printed JSON by default (a minified option is next to Save); unknown
keys in your captions are preserved untouched.

## Keyboard shortcuts

`1`–`6` rate · `[` / `]` previous / next · `Ctrl+S` save ·
`V` select mode · `B` draw mode · `Esc` close panel / cancel / deselect ·
arrows nudge box (Shift = ×10) · `Delete` remove selected element ·
scroll zoom · Space-drag / middle-drag pan · `F` fit ·
`Ctrl+Z` / `Ctrl+Shift+Z` undo / redo.

## Install with uv

```bash
uv sync
uv run python app.py
```

Open `http://localhost:5062/`. The **Browse** panel is open by default — put
your dataset folder path in it and hit **Open folder**.

(Plain pip works too: `pip install flask pillow`, then `python app.py`.
Pillow is only needed for the "same picture" step of compare mode; everything
else runs without it.)
