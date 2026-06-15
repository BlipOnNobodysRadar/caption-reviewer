# Caption Reviewer + Bounding Box Editor

Caption Reviewer is a local, browser-based tool for checking image captions, fixing them, and drawing or adjusting bounding boxes. It is designed for people preparing image datasets who want a clear, visual review workflow without editing JSON by hand.

It is currently built specifically for **Ideogram4-style structured captions**: each image should have a matching `.txt` caption file whose contents are Ideogram4 JSON-style caption data, including bounding boxes and element descriptions.

You run it on your own computer, open it in a web browser, and point it at a folder of images plus matching `.txt` caption files. Your images and captions stay on your machine.

## Who this is for

Use this tool if you need to:

- Quickly review a folder of image captions and mark which ones are good or need work.
- Fix structured captions using forms instead of raw JSON.
- Draw, move, resize, or check bounding boxes directly on top of each image.
- Compare one caption or image pass against another folder side by side.
- Keep original caption files safe while making edits.

## What you can do

### Review captions

Open a folder of images and matching `.txt` caption files. This tool expects those `.txt` files to contain Ideogram4 JSON-style captions. Then rate each item as:

- Excellent
- Good enough
- Needs work
- Bad
- Terrible
- Fixed

You can filter, sort, and search the list while reviewing. If an image/caption pair should not be part of the dataset, use **Remove pair** to move both files into a `removed/` folder, or **Delete pair** to permanently delete both files.

Review ratings are saved in `.caption_review_state.json`. They are not written into your caption files.

### Edit boxes visually

Bounding boxes appear directly over the image. You can:

- Click a box to select it.
- Drag a selected box to move it.
- Drag a box handle to resize it.
- Press **B** or click **Draw** to draw a new box.
- Use the arrow keys to nudge the selected box by 1 unit, or hold **Shift** for bigger 10-unit nudges.
- Scroll to zoom, hold **Space** and drag to pan, or press **F** to fit the image back into view.

The coordinate readout shows where your cursor is in caption coordinates.

### Edit caption fields without hand-writing JSON

For structured captions, the **Fields** tab shows friendly form fields for:

- High-level description
- Style details such as aesthetics, lighting, art style, and medium
- Background
- Each individual element, including type, description, color palette, and bounding box coordinates

Element cards and boxes are linked: selecting one selects the other. The **Raw JSON** tab is still available for advanced edits, and unknown caption fields are preserved when you save.

Plain-text captions still open and can be converted into a structured caption when needed.

### Compare two folders

Use **Compare against a second folder** when you want to review two versions side by side, such as:

- Old captions vs. new captions
- Original images vs. upscaled images
- One model run vs. another model run

The tool tries to match each primary image with the best image in the compare folder by:

1. Same filename stem, such as `cat.png` matching `cat.txt` or `cat.jpg`.
2. Same file contents, even if the file was renamed.
3. Same-looking image using a perceptual image hash, useful after resizing or re-encoding.

The second image is read-only. You can copy the compare caption into the editable caption as an unsaved change, then review and save it if it looks right.

The same-looking image match requires Pillow. If Pillow is not installed, filename and exact-file matching still work.

## Your folder should look like this

```text
my_dataset/
  image001.jpg
  image001.txt
  image002.png
  image002.txt
  .caption_review_state.json   # created automatically for ratings
  .caption_backups/            # created automatically before first caption save
  removed/                     # created if you remove image/caption pairs
```

Each image is matched with a caption file that has the same name before the extension. For example, `image001.jpg` uses `image001.txt`.

## Caption format

The tool is currently built around Ideogram4 JSON-style captions stored inside `.txt` files, like this:

```json
{
  "high_level_description": "...",
  "style_description": {
    "aesthetics": "...",
    "lighting": "..."
  },
  "compositional_deconstruction": {
    "background": "...",
    "elements": [
      {
        "type": "object",
        "desc": "...",
        "bbox": [y1, x1, y2, x2],
        "color_palette": ["#D4AF37"]
      }
    ]
  }
}
```

Bounding boxes are usually stored as `[y_min, x_min, y_max, x_max]` with numbers from `0` to `1000`. If your captions use a different order, change the **format** control in the toolbar before editing. If your coordinate range is not `1000`, change the **max** value.

When you save, the tool can write readable pretty JSON or compact minified JSON.

## Safety features

Caption Reviewer is built to avoid accidental data loss:

- The first time you save a caption, the original is copied into `.caption_backups/`.
- Box coordinates are checked, clamped to the valid range, and fixed when possible.
- Inverted box corners are corrected automatically when you choose to fix issues.
- Truncated structured JSON can often be repaired on load.
- **Ctrl+Z** and **Ctrl+Shift+Z** undo and redo structured edits before saving.

## Keyboard shortcuts

You can use the buttons, or move faster with shortcuts:

| Shortcut | Action |
| --- | --- |
| `1`–`6` | Rate the current item |
| `[` / `]` | Previous / next item |
| `Ctrl+S` | Save caption |
| `V` | Select, move, or resize boxes |
| `B` | Draw a new box |
| `Esc` | Close a panel, cancel drawing, or deselect |
| Arrow keys | Nudge the selected box |
| `Shift` + arrow keys | Nudge the selected box farther |
| `Delete` | Remove the selected element |
| Mouse wheel | Zoom |
| `Space` + drag, or middle mouse drag | Pan around the image |
| `F` | Fit image to the available space |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / redo |

Most toolbar and action buttons also show their shortcut in a tooltip if you hover over them.

## Install and run

### Recommended: uv

```bash
uv sync
uv run python app.py
```

Then open this address in your browser:

```text
http://localhost:5062/
```

The **Browse** panel opens automatically. Paste or type the path to your dataset folder and click **Open folder**.

### Plain pip

```bash
pip install flask pillow
python app.py
```

Pillow is optional unless you want same-looking-image matching in compare mode.

## First-time workflow

1. Start the app.
2. Open `http://localhost:5062/` in your browser.
3. In **Browse**, choose your image/caption folder.
4. Click an item in the list.
5. Review the image, caption, and boxes.
6. Rate it with the buttons or number keys.
7. Fix fields or boxes if needed.
8. Click **Save caption** or **Save + mark fixed**.
9. Use the next arrow or `]` to move on.
