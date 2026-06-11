# Caption Reviewer + BBox Editor

A local web tool for reviewing **and editing** image captions — including full
visual editing of bounding boxes for Ideogram-style structured JSON captions
(`[y_min, x_min, y_max, x_max]`, coordinates 0–1000).

## What it does

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
`V` select mode · `B` draw mode · `Esc` cancel / deselect ·
arrows nudge box (Shift = ×10) · `Delete` remove selected element ·
scroll zoom · Space-drag / middle-drag pan · `F` fit ·
`Ctrl+Z` / `Ctrl+Shift+Z` undo / redo.

## Install with uv

```bash
uv sync
uv run python app.py
```

Open `http://localhost:5062/`, paste your dataset folder path, hit
**Open folder**.

(Plain pip works too: `pip install flask`, then `python app.py`.)
