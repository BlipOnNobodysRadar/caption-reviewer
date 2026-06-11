# Caption Reviewer

A tiny local web tool for manually reviewing image captions.

It lets you:

- Open a folder of images and matching `.txt` captions.
- Rate each caption as `excellent`, `good enough`, `needs work`, `bad`, `terrible`, or `fixed`.
- Filter and sort by status, including `unrated`.
- Edit the caption text directly and save it back to the `.txt` file.
- Preview bounding boxes over the image when the caption text contains JSON objects with `bbox` arrays.
- Store review status separately in `.caption_review_state.json`, not inside the caption files.

The caption files remain clean for training. The sidecar state file is only for review workflow metadata.

## Expected folder layout

```text
my_dataset/
  image001.jpg
  image001.txt
  image002.png
  image002.txt
  .caption_review_state.json   # created by this tool
```

Captions are matched by stem: `image001.jpg` uses `image001.txt`.

## Bounding box preview

If a caption file contains parseable JSON with `bbox` arrays, the reviewer overlays those boxes on the image while you edit. The default format is `[y_min, x_min, y_max, x_max]` with coordinates scaled from `0` to `1000`, matching the Ideogram-style captions this was built around. You can switch the viewer to `[x_min, y_min, x_max, y_max]` and change the coordinate max in the UI.

The overlay is only a preview. Review status still lives in `.caption_review_state.json`, and the caption text file only changes when you save the caption editor.

## Install with uv

Install `uv` if needed:

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

On Windows PowerShell:

```powershell
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
```

Then run:

```bash
uv sync
uv run python app.py
```

Open:

```text
http://localhost:5062/
```

## Fallback install without uv

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python app.py
```

On Windows:

```powershell
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
python app.py
```

## Keyboard shortcuts

- `1`: Excellent
- `2`: Good enough
- `3`: Needs work
- `4`: Bad
- `5`: Terrible
- `6`: Fixed
- `Ctrl+S`: Save caption
- `[` / `]`: Previous / next item
- Double-click image preview: Toggle bounding box overlay

## Notes

This is a local-only convenience tool. It serves image files from whatever folder you open, so do not expose it to the public internet.
