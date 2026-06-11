const targetFolder = document.getElementById('targetFolder');
const recursive = document.getElementById('recursive');
const openFolderBtn = document.getElementById('openFolder');
const statusFilter = document.getElementById('statusFilter');
const sortBy = document.getElementById('sortBy');
const countsEl = document.getElementById('counts');
const listEl = document.getElementById('itemList');
const listCountEl = document.getElementById('listCount');
const emptyState = document.getElementById('emptyState');
const reviewView = document.getElementById('reviewView');
const imageWrap = document.getElementById('imageWrap');
const imageCanvas = document.getElementById('imageCanvas');
const ctx = imageCanvas.getContext('2d');
const activeName = document.getElementById('activeName');
const captionText = document.getElementById('captionText');
const captionPath = document.getElementById('captionPath');
const saveStatus = document.getElementById('saveStatus');
const saveCaptionBtn = document.getElementById('saveCaption');
const saveFixedBtn = document.getElementById('saveFixed');
const prevItemBtn = document.getElementById('prevItem');
const nextItemBtn = document.getElementById('nextItem');
const clearStatusBtn = document.getElementById('clearStatus');
const ratingButtons = document.getElementById('ratingButtons');
const showBboxes = document.getElementById('showBboxes');
const bboxLabels = document.getElementById('bboxLabels');
const bboxFill = document.getElementById('bboxFill');
const bboxFormat = document.getElementById('bboxFormat');
const bboxCoordMax = document.getElementById('bboxCoordMax');
const bboxStatus = document.getElementById('bboxStatus');

let items = [];
let activeRel = null;
let activeIndex = -1;
let dirty = false;
let activeImg = new Image();
let activeImgLoaded = false;
let bboxElements = [];
let bboxParseError = '';
let imageObjectUrl = null;

const bboxColors = [
  '#ff4d6d', '#4cc9f0', '#80ed99', '#ffd60a', '#b983ff', '#ff9f1c',
  '#2ec4b6', '#ff70a6', '#aacc00', '#00bbf9', '#f15bb5', '#cdb4db'
];

const statusLabels = {
  all: 'All',
  unrated: 'Unrated',
  excellent: 'Excellent',
  good_enough: 'Good enough',
  needs_work: 'Needs work',
  bad: 'Bad',
  terrible: 'Terrible',
  fixed: 'Fixed'
};

const statusClasses = {
  unrated: 'st-unrated',
  excellent: 'st-excellent',
  good_enough: 'st-good-enough',
  needs_work: 'st-needs-work',
  bad: 'st-bad',
  terrible: 'st-terrible',
  fixed: 'st-fixed'
};

function setMessage(text, isError = false) {
  saveStatus.textContent = text;
  saveStatus.className = isError ? 'error' : '';
}

function renderCounts(counts) {
  if (!counts) {
    countsEl.textContent = 'No folder loaded.';
    return;
  }
  const parts = ['all', 'unrated', 'excellent', 'good_enough', 'needs_work', 'bad', 'terrible', 'fixed']
    .map(k => `${statusLabels[k]}: ${counts[k] || 0}`);
  countsEl.textContent = parts.join(' · ');
}

function escapeText(text) {
  const span = document.createElement('span');
  span.textContent = text;
  return span.innerHTML;
}

function renderList() {
  listEl.innerHTML = '';
  listCountEl.textContent = String(items.length);

  if (!items.length) {
    const div = document.createElement('div');
    div.className = 'empty-list';
    div.textContent = 'No matching images.';
    listEl.appendChild(div);
    return;
  }

  for (const item of items) {
    const div = document.createElement('button');
    div.className = `item ${statusClasses[item.status] || ''}`;
    if (item.rel === activeRel) div.classList.add('active');
    div.innerHTML = `
      <div class="item-main">
        <span class="name" title="${escapeText(item.rel)}">${escapeText(item.filename)}</span>
        <span class="badge">${escapeText(item.status_label)}</span>
      </div>
      <div class="sub" title="${escapeText(item.rel)}">${escapeText(item.folder)}</div>
      <div class="preview">${escapeText(item.caption_preview || '(no caption file)')}</div>
    `;
    div.addEventListener('click', () => loadItem(item.rel));
    listEl.appendChild(div);
  }
}

function extractJSON(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('No caption text.');
  try {
    return JSON.parse(trimmed);
  } catch (_) {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
  }
  throw new Error('No parseable JSON object found.');
}

function findBoxes(obj) {
  const direct = obj?.compositional_deconstruction?.elements;
  if (Array.isArray(direct)) return direct;

  const out = [];
  function walk(value) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (Array.isArray(value.bbox) && value.bbox.length === 4) out.push(value);
    for (const child of Object.values(value)) walk(child);
  }
  walk(obj);
  return out;
}

function labelForBox(box, i) {
  const desc = String(box.desc || box.description || '').toLowerCase();
  if (box.label) return String(box.label);
  if (box.name) return String(box.name);
  if (box.type === 'text') return 'text';
  if (desc.includes('woman') || desc.includes('girl')) return 'woman';
  if (desc.includes('man') || desc.includes('boy')) return 'man';
  if (desc.includes('face')) return 'face';
  if (desc.includes('eye')) return 'eyes';
  if (desc.includes('hair')) return 'hair';
  if (desc.includes('armor')) return 'armor';
  if (desc.includes('jewelry') || desc.includes('necklace') || desc.includes('earring')) return 'jewelry';
  if (desc.includes('flower') || desc.includes('rose') || desc.includes('bouquet')) return 'flowers';
  if (desc.includes('crowd') || desc.includes('people')) return 'crowd';
  if (desc.includes('window') || desc.includes('stained glass')) return 'window';
  if (desc.includes('polearm') || desc.includes('spear') || desc.includes('staff')) return 'weapon';
  return `${box.type || 'box'} ${i + 1}`;
}

function parseBboxesFromCaption() {
  bboxElements = [];
  bboxParseError = '';

  const text = captionText.value || '';
  if (!text.trim().includes('{')) {
    updateBboxStatus();
    drawImageAndBboxes();
    return;
  }

  try {
    const parsed = extractJSON(text);
    bboxElements = findBoxes(parsed)
      .filter(box => Array.isArray(box.bbox) && box.bbox.length === 4 && box.bbox.every(Number.isFinite))
      .map((box, i) => ({
        ...box,
        _label: labelForBox(box, i),
        _color: bboxColors[i % bboxColors.length]
      }));
  } catch (e) {
    bboxParseError = e.message || String(e);
  }

  updateBboxStatus();
  drawImageAndBboxes();
}

function updateBboxStatus() {
  if (bboxParseError) {
    bboxStatus.textContent = `BBox JSON parse failed: ${bboxParseError}`;
    bboxStatus.classList.add('error');
    return;
  }
  bboxStatus.classList.remove('error');
  bboxStatus.textContent = bboxElements.length === 1 ? '1 box' : `${bboxElements.length} boxes`;
}

function bboxToImagePixels(bbox) {
  const maxCoord = Math.max(1, Number(bboxCoordMax.value) || 1000);
  let x1, y1, x2, y2;
  if (bboxFormat.value === 'yxyx') {
    [y1, x1, y2, x2] = bbox;
  } else {
    [x1, y1, x2, y2] = bbox;
  }

  x1 = x1 / maxCoord * activeImg.naturalWidth;
  x2 = x2 / maxCoord * activeImg.naturalWidth;
  y1 = y1 / maxCoord * activeImg.naturalHeight;
  y2 = y2 / maxCoord * activeImg.naturalHeight;

  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  const width = Math.abs(x2 - x1);
  const height = Math.abs(y2 - y1);
  return {left, top, width, height};
}

function drawImageAndBboxes() {
  if (!activeImgLoaded) {
    imageCanvas.width = 900;
    imageCanvas.height = 520;
    ctx.fillStyle = '#08090c';
    ctx.fillRect(0, 0, imageCanvas.width, imageCanvas.height);
    ctx.fillStyle = '#8a90a6';
    ctx.font = '20px system-ui';
    ctx.fillText('Open an item to preview it.', 28, 50);
    return;
  }

  const pad = 24;
  const wrapWidth = Math.max(280, imageWrap.clientWidth - pad);
  const wrapHeight = Math.max(280, imageWrap.clientHeight - pad);
  const scale = Math.min(1, wrapWidth / activeImg.naturalWidth, wrapHeight / activeImg.naturalHeight);
  const canvasWidth = Math.max(1, Math.round(activeImg.naturalWidth * scale));
  const canvasHeight = Math.max(1, Math.round(activeImg.naturalHeight * scale));

  imageCanvas.width = canvasWidth;
  imageCanvas.height = canvasHeight;

  ctx.save();
  ctx.scale(scale, scale);
  ctx.drawImage(activeImg, 0, 0);

  if (showBboxes.checked && bboxElements.length) {
    const lineWidth = Math.max(2, 4 / scale);
    const fontSize = Math.max(12, 16 / scale);
    ctx.textBaseline = 'top';
    ctx.font = `700 ${fontSize}px system-ui`;

    bboxElements.forEach((box) => {
      const {left, top, width, height} = bboxToImagePixels(box.bbox);
      const color = box._color;
      ctx.save();
      ctx.lineWidth = lineWidth;
      ctx.strokeStyle = color;
      if (bboxFill.checked) {
        ctx.fillStyle = color + '22';
        ctx.fillRect(left, top, width, height);
      }
      ctx.strokeRect(left, top, width, height);

      if (bboxLabels.checked) {
        const text = box._label;
        const metrics = ctx.measureText(text);
        const labelPad = 5 / scale;
        const labelWidth = metrics.width + labelPad * 2;
        const labelHeight = fontSize + labelPad * 2;
        const labelX = Math.max(0, Math.min(left, activeImg.naturalWidth - labelWidth));
        let labelY = top - labelHeight;
        if (labelY < 0) labelY = top;
        ctx.fillStyle = color;
        ctx.fillRect(labelX, labelY, labelWidth, labelHeight);
        ctx.fillStyle = '#fff';
        ctx.fillText(text, labelX + labelPad, labelY + labelPad);
      }
      ctx.restore();
    });
  }

  ctx.restore();
}

async function openFolder() {
  const folder = targetFolder.value.trim();
  if (!folder) return;
  openFolderBtn.disabled = true;
  openFolderBtn.textContent = 'Opening...';
  try {
    const res = await fetch('/api/open-folder', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({target_folder: folder, recursive: recursive.checked})
    });
    const out = await res.json();
    if (out.error) throw new Error(out.error);
    items = out.items || [];
    activeRel = null;
    activeIndex = -1;
    renderCounts(out.counts);
    renderList();
    if (items.length) await loadItem(items[0].rel);
  } catch (e) {
    alert('Error: ' + e.message);
  } finally {
    openFolderBtn.disabled = false;
    openFolderBtn.textContent = 'Open folder';
  }
}

async function refreshList(keepActive = true) {
  const params = new URLSearchParams({
    status: statusFilter.value,
    sort: sortBy.value,
    recursive: recursive.checked ? 'true' : 'false'
  });
  const res = await fetch('/api/list?' + params.toString());
  const out = await res.json();
  if (out.error) {
    alert('Error: ' + out.error);
    return;
  }
  items = out.items || [];
  renderCounts(out.counts);
  if (keepActive && activeRel) {
    activeIndex = items.findIndex(x => x.rel === activeRel);
  }
  renderList();
}

async function loadItem(rel) {
  if (dirty) {
    const ok = confirm('Caption has unsaved changes. Discard them?');
    if (!ok) return;
  }
  const res = await fetch('/api/item?rel=' + encodeURIComponent(rel));
  const out = await res.json();
  if (out.error) {
    alert('Error: ' + out.error);
    return;
  }

  activeRel = rel;
  activeIndex = items.findIndex(x => x.rel === rel);
  activeName.textContent = `${out.filename} — ${out.status_label}`;
  captionText.value = out.caption || '';
  captionPath.textContent = out.caption_path || '';
  dirty = false;
  setMessage('');
  emptyState.classList.add('hidden');
  reviewView.classList.remove('hidden');
  renderList();
  updateButtons(out.status);
  parseBboxesFromCaption();

  activeImgLoaded = false;
  drawImageAndBboxes();
  const nextImg = new Image();
  nextImg.onload = () => {
    activeImg = nextImg;
    activeImgLoaded = true;
    drawImageAndBboxes();
  };
  nextImg.onerror = () => {
    activeImgLoaded = false;
    setMessage('Could not load image preview.', true);
    drawImageAndBboxes();
  };
  nextImg.src = out.image_url + '?t=' + Date.now();
}

function updateButtons(status) {
  for (const btn of ratingButtons.querySelectorAll('button[data-status]')) {
    btn.classList.toggle('selected', btn.dataset.status === status);
  }
}

async function setStatus(status) {
  if (!activeRel) return;
  const res = await fetch('/api/status', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({rel: activeRel, status})
  });
  const out = await res.json();
  if (out.error) {
    setMessage(out.error, true);
    return;
  }
  setMessage(`Marked ${out.status_label}.`);
  await refreshList(true);
  updateButtons(status);
  activeName.textContent = `${activeRel.split('/').pop()} — ${out.status_label}`;
}

async function clearStatus() {
  if (!activeRel) return;
  const res = await fetch('/api/clear-status', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({rel: activeRel})
  });
  const out = await res.json();
  if (out.error) {
    setMessage(out.error, true);
    return;
  }
  setMessage('Status cleared.');
  await refreshList(true);
  updateButtons('unrated');
}

async function saveCaption(markFixed = false) {
  if (!activeRel) return;
  const res = await fetch('/api/save-caption', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({rel: activeRel, caption: captionText.value, mark_fixed: markFixed})
  });
  const out = await res.json();
  if (out.error) {
    setMessage(out.error, true);
    return;
  }
  dirty = false;
  setMessage(markFixed ? 'Saved and marked fixed.' : 'Saved.');
  await refreshList(true);
  if (markFixed) updateButtons('fixed');
}

function move(delta) {
  if (!items.length) return;
  const idx = activeIndex >= 0 ? activeIndex : 0;
  const next = Math.max(0, Math.min(items.length - 1, idx + delta));
  if (items[next]) loadItem(items[next].rel);
}

openFolderBtn.addEventListener('click', openFolder);
statusFilter.addEventListener('change', () => refreshList(false));
sortBy.addEventListener('change', () => refreshList(true));
recursive.addEventListener('change', () => refreshList(true));

ratingButtons.addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-status]');
  if (!btn) return;
  setStatus(btn.dataset.status);
});

clearStatusBtn.addEventListener('click', clearStatus);
saveCaptionBtn.addEventListener('click', () => saveCaption(false));
saveFixedBtn.addEventListener('click', () => saveCaption(true));
prevItemBtn.addEventListener('click', () => move(-1));
nextItemBtn.addEventListener('click', () => move(1));
captionText.addEventListener('input', () => {
  dirty = true;
  setMessage('Unsaved changes.');
  parseBboxesFromCaption();
});

for (const el of [showBboxes, bboxLabels, bboxFill, bboxFormat, bboxCoordMax]) {
  el.addEventListener('input', drawImageAndBboxes);
  el.addEventListener('change', drawImageAndBboxes);
}

window.addEventListener('resize', drawImageAndBboxes);

imageCanvas.addEventListener('dblclick', () => {
  showBboxes.checked = !showBboxes.checked;
  drawImageAndBboxes();
});

document.addEventListener('keydown', (ev) => {
  if (ev.ctrlKey && ev.key.toLowerCase() === 's') {
    ev.preventDefault();
    saveCaption(false);
    return;
  }
  if (ev.target === captionText) return;
  const map = {
    '1': 'excellent',
    '2': 'good_enough',
    '3': 'needs_work',
    '4': 'bad',
    '5': 'terrible',
    '6': 'fixed'
  };
  if (map[ev.key]) {
    setStatus(map[ev.key]);
  } else if (ev.key === '[') {
    move(-1);
  } else if (ev.key === ']') {
    move(1);
  }
});

drawImageAndBboxes();
