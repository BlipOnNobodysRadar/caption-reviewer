/* script.js — Caption Reviewer + BBox Editor frontend.
 * Pure geometry/validation lives in bbox_core.js (window.BBoxCore).
 */
'use strict';
const C = window.BBoxCore;

/* ---------------- DOM ---------------- */
const $ = (id) => document.getElementById(id);
const targetFolder = $('targetFolder'), recursive = $('recursive'), openFolderBtn = $('openFolder');
const backupOriginals = $('backupOriginals');
const statusFilter = $('statusFilter'), sortBy = $('sortBy'), searchBox = $('searchBox'), countsEl = $('counts');
const listEl = $('itemList'), listCountEl = $('listCount');
const emptyState = $('emptyState'), reviewView = $('reviewView');
const prevItemBtn = $('prevItem'), nextItemBtn = $('nextItem'), activeName = $('activeName');
const modeSelectBtn = $('modeSelectBtn'), modeDrawBtn = $('modeDrawBtn'), addElementBtn = $('addElementBtn');
const zoomOutBtn = $('zoomOutBtn'), zoomInBtn = $('zoomInBtn'), zoomLabel = $('zoomLabel'), fitBtn = $('fitBtn');
const showBboxes = $('showBboxes'), bboxLabels = $('bboxLabels'), bboxFill = $('bboxFill'), focusMode = $('focusMode');
const bboxFormat = $('bboxFormat'), bboxCoordMax = $('bboxCoordMax');
const coordReadout = $('coordReadout'), issuesChip = $('issuesChip');
const imageWrap = $('imageWrap'), imageCanvas = $('imageCanvas');
const ctx = imageCanvas.getContext('2d');
const ratingButtons = $('ratingButtons'), clearStatusBtn = $('clearStatus');
const tabFieldsBtn = $('tabFieldsBtn'), tabRawBtn = $('tabRawBtn');
const fieldsPanel = $('fieldsPanel'), rawPanel = $('rawPanel');
const fieldsNotice = $('fieldsNotice'), fieldsNoticeText = $('fieldsNoticeText'), convertBtn = $('convertBtn');
const fldHld = $('fld_hld'), fldAesthetics = $('fld_aesthetics'), fldLighting = $('fld_lighting');
const fldArt = $('fld_art'), fldMedium = $('fld_medium'), fldStylePalette = $('fld_stylePalette');
const fldBackground = $('fld_background');
const elementsCount = $('elementsCount'), elementsList = $('elementsList');
const captionText = $('captionText'), captionPath = $('captionPath');
const rawApplyBtn = $('rawApplyBtn'), rawStatus = $('rawStatus');
const saveFormat = $('saveFormat'), saveCaptionBtn = $('saveCaption'), saveFixedBtn = $('saveFixed');
const saveStatus = $('saveStatus');

/* ---------------- state ---------------- */
let items = [], activeRel = null, activeIndex = -1;
let originalText = '';
let doc = null, plain = false, parseError = null, parseRepaired = false;
let selectedIdx = -1, hoverIdx = -1;
let mode = 'select';            // 'select' | 'draw'
let drawSticky = false;         // B key keeps draw mode after one box
let pendingDrawIdx = null;      // next drawn rect goes to this element
let dirty = false, rawDirtyPending = false;
let activeTab = 'fields';
let view = { scale: 1, ox: 0, oy: 0 };
let img = new Image(), imgLoaded = false;
let drag = null, spaceHeld = false, lastPointer = null, lastKeyWasArrow = false;
let undoStack = [], redoStack = [];

const statusLabels = {
  all: 'All', unrated: 'Unrated', excellent: 'Excellent', good_enough: 'Good enough',
  needs_work: 'Needs work', bad: 'Bad', terrible: 'Terrible', fixed: 'Fixed'
};
const statusClasses = {
  unrated: 'st-unrated', excellent: 'st-excellent', good_enough: 'st-good-enough',
  needs_work: 'st-needs-work', bad: 'st-bad', terrible: 'st-terrible', fixed: 'st-fixed'
};

/* ---------------- small helpers ---------------- */
function setMessage(text, isError = false) {
  saveStatus.textContent = text;
  saveStatus.className = isError ? 'error' : '';
}
function escapeText(text) {
  const span = document.createElement('span');
  span.textContent = text;
  return span.innerHTML;
}
function debounce(fn, ms) {
  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
function order() { return bboxFormat.value === 'xyxy' ? 'xyxy' : 'yxyx'; }
function coordMax() { return Math.max(1, Number(bboxCoordMax.value) || 1000); }
function elements() { return (doc && C.getElements(doc)) || []; }
function markDirty() {
  if (!dirty) setMessage('Unsaved changes.');
  dirty = true;
}

/* prefs */
function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem('caption_reviewer_prefs') || '{}');
    if (p.order) bboxFormat.value = p.order;
    if (p.coordMax) bboxCoordMax.value = p.coordMax;
    if (p.saveFormat) saveFormat.value = p.saveFormat;
    if (typeof p.backup === 'boolean') backupOriginals.checked = p.backup;
    if (typeof p.focus === 'boolean') focusMode.checked = p.focus;
  } catch (e) { /* ignore */ }
}
const savePrefs = debounce(() => {
  localStorage.setItem('caption_reviewer_prefs', JSON.stringify({
    order: bboxFormat.value, coordMax: bboxCoordMax.value,
    saveFormat: saveFormat.value, backup: backupOriginals.checked, focus: focusMode.checked
  }));
}, 200);

/* ---------------- undo / redo ---------------- */
function snapshot() { return doc ? JSON.stringify(doc) : null; }
function pushUndoMaybe() {
  const s = snapshot();
  if (s === null) return;
  if (undoStack.length && undoStack[undoStack.length - 1] === s) return;
  undoStack.push(s);
  if (undoStack.length > 100) undoStack.shift();
  redoStack = [];
}
function restoreSnapshot(s) {
  doc = JSON.parse(s);
  plain = false; parseError = null;
  selectedIdx = Math.min(selectedIdx, elements().length - 1);
  markDirty();
  renderFieldsTop(); renderElements(); refreshIssues();
  if (activeTab === 'raw') syncRawFromDoc();
  draw();
}
function undo() {
  if (!undoStack.length) { setMessage('Nothing to undo.'); return; }
  const cur = snapshot();
  if (cur !== null) redoStack.push(cur);
  restoreSnapshot(undoStack.pop());
  setMessage('Undid change.');
}
function redo() {
  if (!redoStack.length) { setMessage('Nothing to redo.'); return; }
  const cur = snapshot();
  if (cur !== null) undoStack.push(cur);
  restoreSnapshot(redoStack.pop());
  setMessage('Redid change.');
}

/* ---------------- list / counts (review workflow) ---------------- */
function renderCounts(counts) {
  if (!counts) { countsEl.textContent = 'No folder loaded.'; return; }
  const parts = ['all', 'unrated', 'excellent', 'good_enough', 'needs_work', 'bad', 'terrible', 'fixed']
    .map((k) => `${statusLabels[k]}: ${counts[k] || 0}`);
  countsEl.textContent = parts.join(' \u00b7 ');
}
function renderList() {
  listEl.innerHTML = '';
  const q = searchBox.value.trim().toLowerCase();
  const visible = q
    ? items.filter((it) => it.rel.toLowerCase().includes(q) || (it.caption_preview || '').toLowerCase().includes(q))
    : items;
  listCountEl.textContent = q ? `${visible.length}/${items.length}` : String(items.length);
  if (!visible.length) {
    const div = document.createElement('div');
    div.className = 'empty-list';
    div.textContent = items.length ? 'No items match the search.' : 'No matching images.';
    listEl.appendChild(div);
    return;
  }
  for (const item of visible) {
    const div = document.createElement('button');
    div.className = `item ${statusClasses[item.status] || ''}`;
    if (item.rel === activeRel) div.classList.add('active');
    div.innerHTML = `
      <div class="item-main">
        <span class="name" title="${escapeText(item.rel)}">${escapeText(item.filename)}</span>
        <span class="badge">${escapeText(item.status_label)}</span>
      </div>
      <div class="sub" title="${escapeText(item.rel)}">${escapeText(item.folder)}</div>
      <div class="preview">${escapeText(item.caption_preview || '(no caption file)')}</div>`;
    div.addEventListener('click', () => loadItem(item.rel));
    listEl.appendChild(div);
  }
}
async function openFolder() {
  const folder = targetFolder.value.trim();
  if (!folder) return;
  openFolderBtn.disabled = true;
  openFolderBtn.textContent = 'Opening...';
  try {
    const res = await fetch('/api/open-folder', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target_folder: folder, recursive: recursive.checked })
    });
    const out = await res.json();
    if (out.error) throw new Error(out.error);
    items = out.items || [];
    activeRel = null; activeIndex = -1;
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
    status: statusFilter.value, sort: sortBy.value,
    recursive: recursive.checked ? 'true' : 'false'
  });
  const res = await fetch('/api/list?' + params.toString());
  const out = await res.json();
  if (out.error) { alert('Error: ' + out.error); return; }
  items = out.items || [];
  renderCounts(out.counts);
  if (keepActive && activeRel) activeIndex = items.findIndex((x) => x.rel === activeRel);
  renderList();
}
function move(delta) {
  if (!items.length) return;
  const idx = activeIndex >= 0 ? activeIndex : 0;
  const next = Math.max(0, Math.min(items.length - 1, idx + delta));
  if (items[next]) loadItem(items[next].rel);
}

/* ---------------- ratings ---------------- */
function updateButtons(status) {
  for (const btn of ratingButtons.querySelectorAll('button[data-status]')) {
    btn.classList.toggle('selected', btn.dataset.status === status);
  }
}
async function setStatus(status) {
  if (!activeRel) return;
  const res = await fetch('/api/status', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rel: activeRel, status })
  });
  const out = await res.json();
  if (out.error) { setMessage(out.error, true); return; }
  setMessage(`Marked ${out.status_label}.`);
  await refreshList(true);
  updateButtons(status);
  activeName.textContent = `${activeRel.split('/').pop()} \u2014 ${out.status_label}`;
}
async function clearStatus() {
  if (!activeRel) return;
  const res = await fetch('/api/clear-status', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rel: activeRel })
  });
  const out = await res.json();
  if (out.error) { setMessage(out.error, true); return; }
  setMessage('Status cleared.');
  await refreshList(true);
  updateButtons('unrated');
}

/* ---------------- item loading ---------------- */
async function loadItem(rel) {
  if (dirty && !confirm('Caption has unsaved changes. Discard them?')) return;
  const res = await fetch('/api/item?rel=' + encodeURIComponent(rel));
  const out = await res.json();
  if (out.error) { alert('Error: ' + out.error); return; }

  activeRel = rel;
  activeIndex = items.findIndex((x) => x.rel === rel);
  activeName.textContent = `${out.filename} \u2014 ${out.status_label}`;
  captionPath.textContent = out.caption_path || '';
  emptyState.classList.add('hidden');
  reviewView.classList.remove('hidden');
  renderList();
  updateButtons(out.status);

  setCaptionState(out.caption || '');
  dirty = false;
  setMessage(parseRepaired ? 'Loaded with truncated-JSON repair.' : '');

  imgLoaded = false;
  draw();
  const next = new Image();
  next.onload = () => { img = next; imgLoaded = true; resizeCanvas(); fitView(); draw(); };
  next.onerror = () => { imgLoaded = false; setMessage('Could not load image preview.', true); draw(); };
  next.src = out.image_url + '?t=' + Date.now();
}

function setCaptionState(text) {
  originalText = text;
  const r = C.parseCaptionDoc(text);
  doc = r.doc; plain = r.plain; parseError = r.error; parseRepaired = r.repaired;
  selectedIdx = -1; hoverIdx = -1; pendingDrawIdx = null;
  setMode('select');
  undoStack = []; redoStack = [];
  rawDirtyPending = false;
  captionText.value = text;
  rawStatus.textContent = '';
  switchTab(doc ? 'fields' : 'raw', true);
  renderFieldsTop(); renderElements(); refreshIssues();
}

/* ---------------- structured fields ---------------- */
function ensureStyle() {
  if (!doc.style_description || typeof doc.style_description !== 'object') doc.style_description = {};
  return doc.style_description;
}
function ensureComp() {
  if (!doc.compositional_deconstruction || typeof doc.compositional_deconstruction !== 'object') {
    doc.compositional_deconstruction = {};
  }
  return doc.compositional_deconstruction;
}
function paletteToText(v) { return Array.isArray(v) ? v.join(', ') : (v == null ? '' : String(v)); }
function textToPalette(s) {
  return s.split(',').map((x) => x.trim()).filter(Boolean);
}

function renderFieldsTop() {
  const enabled = !!doc;
  for (const el of [fldHld, fldAesthetics, fldLighting, fldArt, fldMedium, fldStylePalette, fldBackground]) {
    el.disabled = !enabled;
  }
  addElementBtn.disabled = !enabled;
  fieldsNotice.classList.add('hidden');
  convertBtn.classList.add('hidden');
  fieldsNotice.classList.remove('warn');
  if (parseError) {
    fieldsNotice.classList.remove('hidden');
    fieldsNotice.classList.add('warn');
    fieldsNoticeText.textContent = 'JSON error: ' + parseError + ' Fix it in the Raw JSON tab.';
  } else if (plain) {
    fieldsNotice.classList.remove('hidden');
    fieldsNoticeText.textContent = 'This caption is plain text, not structured JSON.';
    convertBtn.classList.remove('hidden');
  } else if (parseRepaired) {
    fieldsNotice.classList.remove('hidden');
    fieldsNoticeText.textContent = 'Truncated JSON was repaired on load \u2014 saving writes the complete version.';
  }
  const sd = (doc && doc.style_description) || {};
  const comp = (doc && doc.compositional_deconstruction) || {};
  fldHld.value = doc ? String(doc.high_level_description || '') : '';
  fldAesthetics.value = String(sd.aesthetics || '');
  fldLighting.value = String(sd.lighting || '');
  fldArt.value = String(sd.art_style || '');
  fldMedium.value = String(sd.medium || '');
  fldStylePalette.value = paletteToText(sd.color_palette);
  fldBackground.value = String(comp.background || '');
}

function bindTopFields() {
  const fieldEdit = (apply) => () => {
    if (!doc) return;
    apply();
    markDirty();
  };
  for (const el of [fldHld, fldAesthetics, fldLighting, fldArt, fldMedium, fldStylePalette, fldBackground]) {
    el.addEventListener('focus', pushUndoMaybe);
  }
  fldHld.addEventListener('input', fieldEdit(() => { doc.high_level_description = fldHld.value; }));
  fldAesthetics.addEventListener('input', fieldEdit(() => { ensureStyle().aesthetics = fldAesthetics.value; }));
  fldLighting.addEventListener('input', fieldEdit(() => { ensureStyle().lighting = fldLighting.value; }));
  fldArt.addEventListener('input', fieldEdit(() => { ensureStyle().art_style = fldArt.value; }));
  fldMedium.addEventListener('input', fieldEdit(() => { ensureStyle().medium = fldMedium.value; }));
  fldStylePalette.addEventListener('input', fieldEdit(() => { ensureStyle().color_palette = textToPalette(fldStylePalette.value); }));
  fldBackground.addEventListener('input', fieldEdit(() => { ensureComp().background = fldBackground.value; }));
}

/* element cards */
function renderElements() {
  elementsList.innerHTML = '';
  const arr = elements();
  elementsCount.textContent = String(arr.length);
  arr.forEach((el, i) => elementsList.appendChild(buildCard(el, i)));
  syncCardSelection();
}
function buildCard(el, i) {
  const card = document.createElement('div');
  card.className = 'el-card';
  card.dataset.idx = String(i);
  const color = C.colorForIndex(i);

  const head = document.createElement('div');
  head.className = 'el-head';
  const chip = document.createElement('span');
  chip.className = 'chip';
  chip.style.background = color;
  const idxLabel = document.createElement('span');
  idxLabel.className = 'el-idx';
  idxLabel.textContent = '#' + (i + 1);
  const typeSel = document.createElement('select');
  for (const t of ['obj', 'text']) {
    const o = document.createElement('option');
    o.value = t; o.textContent = t;
    typeSel.appendChild(o);
  }
  typeSel.value = el.type === 'text' ? 'text' : 'obj';
  typeSel.addEventListener('change', () => { pushUndoMaybe(); el.type = typeSel.value; markDirty(); draw(); });
  const spacer = document.createElement('span');
  spacer.className = 'spacer';
  const drawBtn = document.createElement('button');
  drawBtn.className = 'mini';
  drawBtn.textContent = el.bbox ? 'Redraw box' : 'Draw box';
  drawBtn.title = 'Drag on the image to place this element\u2019s box';
  drawBtn.addEventListener('click', (ev) => { ev.stopPropagation(); selectIdx(i); startDrawFor(i); });
  const dupBtn = document.createElement('button');
  dupBtn.className = 'mini';
  dupBtn.textContent = 'Dup';
  dupBtn.title = 'Duplicate element';
  dupBtn.addEventListener('click', (ev) => { ev.stopPropagation(); duplicateElement(i); });
  const delBtn = document.createElement('button');
  delBtn.className = 'mini danger';
  delBtn.textContent = '\u2715';
  delBtn.title = 'Delete element';
  delBtn.addEventListener('click', (ev) => { ev.stopPropagation(); removeElement(i); });
  head.append(chip, idxLabel, typeSel, spacer, drawBtn, dupBtn, delBtn);

  const desc = document.createElement('textarea');
  desc.className = 'el-desc';
  desc.rows = 2;
  desc.placeholder = 'Description';
  desc.value = String(el.desc || '');
  desc.addEventListener('focus', pushUndoMaybe);
  desc.addEventListener('input', () => { el.desc = desc.value; markDirty(); });

  const bboxRow = document.createElement('div');
  bboxRow.className = 'bbox-row';
  const labels = C.coordLabels(order());
  if (Array.isArray(el.bbox) && el.bbox.length === 4) {
    for (let k = 0; k < 4; k++) {
      const wrap = document.createElement('label');
      wrap.className = 'coord';
      const tag = document.createElement('span');
      tag.textContent = labels[k];
      const inp = document.createElement('input');
      inp.type = 'number';
      inp.step = '1';
      inp.value = String(el.bbox[k]);
      inp.dataset.k = String(k);
      inp.addEventListener('focus', pushUndoMaybe);
      inp.addEventListener('change', () => {
        el.bbox[k] = Number(inp.value);
        const norm = C.normalizeBbox(el.bbox, coordMax());
        if (norm) el.bbox = norm;
        syncCardBbox(i);
        markDirty(); refreshIssues(); draw();
      });
      wrap.append(tag, inp);
      bboxRow.appendChild(wrap);
    }
  } else {
    const note = document.createElement('span');
    note.className = 'no-box';
    note.textContent = 'no box \u2014 use Draw box';
    bboxRow.appendChild(note);
  }

  const pal = document.createElement('input');
  pal.className = 'el-pal';
  pal.placeholder = 'color_palette: #AABBCC, #DDEEFF';
  pal.value = paletteToText(el.color_palette);
  pal.addEventListener('focus', pushUndoMaybe);
  pal.addEventListener('input', () => { el.color_palette = textToPalette(pal.value); markDirty(); });

  card.append(head, desc, bboxRow, pal);
  card.addEventListener('click', () => selectIdx(i));
  return card;
}
function cardAt(i) { return elementsList.querySelector(`.el-card[data-idx="${i}"]`); }
function syncCardSelection() {
  for (const card of elementsList.querySelectorAll('.el-card')) {
    card.classList.toggle('selected', Number(card.dataset.idx) === selectedIdx);
  }
  const card = cardAt(selectedIdx);
  if (card) card.scrollIntoView({ block: 'nearest' });
}
function syncCardBbox(i) {
  const el = elements()[i];
  const card = cardAt(i);
  if (!el || !card) return;
  const inputs = card.querySelectorAll('.bbox-row input');
  if (Array.isArray(el.bbox) && inputs.length === 4) {
    inputs.forEach((inp) => { inp.value = String(el.bbox[Number(inp.dataset.k)]); });
  } else {
    renderElements(); // structure changed (box added/removed)
  }
}
function relabelCoordInputs() {
  const labels = C.coordLabels(order());
  for (const card of elementsList.querySelectorAll('.el-card')) {
    card.querySelectorAll('.bbox-row .coord span').forEach((tag, k) => { tag.textContent = labels[k]; });
  }
}

/* element ops */
function ensureElementsArray() { return C.getElements(doc, { create: true }); }
function addElement() {
  if (!doc) return;
  pushUndoMaybe();
  const arr = ensureElementsArray();
  arr.push(C.makeElement('obj'));
  markDirty();
  renderElements();
  selectIdx(arr.length - 1);
  startDrawFor(arr.length - 1);
}
function duplicateElement(i) {
  const arr = elements();
  if (!arr[i]) return;
  pushUndoMaybe();
  const clone = JSON.parse(JSON.stringify(arr[i]));
  if (Array.isArray(clone.bbox)) {
    const max = coordMax();
    clone.bbox = clone.bbox.map((v) => Math.min(max, Number(v) + 10));
    clone.bbox = C.normalizeBbox(clone.bbox, max) || clone.bbox;
  }
  arr.splice(i + 1, 0, clone);
  markDirty();
  renderElements();
  selectIdx(i + 1);
  refreshIssues(); draw();
}
function removeElement(i) {
  const arr = elements();
  if (!arr[i]) return;
  pushUndoMaybe();
  arr.splice(i, 1);
  if (selectedIdx >= arr.length) selectedIdx = arr.length - 1;
  markDirty();
  renderElements();
  refreshIssues(); draw();
  setMessage('Element removed (Ctrl+Z to undo).');
}
function selectIdx(i) {
  selectedIdx = i;
  syncCardSelection();
  draw();
}
function startDrawFor(i) {
  pendingDrawIdx = i;
  setMode('draw');
  drawSticky = false;
  setMessage(`Drag on the image to place the box for element ${i + 1}.`);
}

/* ---------------- issues ---------------- */
function refreshIssues() {
  const list = doc ? C.validateDoc(doc, coordMax()) : [];
  if (!list.length) {
    issuesChip.classList.add('hidden');
    return;
  }
  const fixable = list.filter((x) => x.fixable).length;
  issuesChip.classList.remove('hidden');
  issuesChip.textContent = `${list.length} issue${list.length === 1 ? '' : 's'}` + (fixable ? ' \u00b7 fix' : '');
  issuesChip.title = list.map((x) => `${x.label}: ${x.msg}`).join('\n');
  issuesChip.disabled = !fixable;
}
issuesChip.addEventListener('click', () => {
  if (!doc) return;
  pushUndoMaybe();
  const n = C.fixDoc(doc, coordMax());
  markDirty();
  renderElements();
  refreshIssues(); draw();
  setMessage(`Fixed ${n} box${n === 1 ? '' : 'es'}.`);
});

/* ---------------- canvas engine ---------------- */
function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const cw = imageWrap.clientWidth, ch = imageWrap.clientHeight;
  imageCanvas.width = Math.max(1, Math.round(cw * dpr));
  imageCanvas.height = Math.max(1, Math.round(ch * dpr));
  imageCanvas.style.width = cw + 'px';
  imageCanvas.style.height = ch + 'px';
}
function fitView() {
  if (!imgLoaded) return;
  const m = 14;
  const cw = imageWrap.clientWidth, ch = imageWrap.clientHeight;
  const s = Math.min((cw - 2 * m) / img.naturalWidth, (ch - 2 * m) / img.naturalHeight);
  view.scale = Math.max(0.02, Math.min(16, s));
  view.ox = (cw - img.naturalWidth * view.scale) / 2;
  view.oy = (ch - img.naturalHeight * view.scale) / 2;
}
function toImg(p) { return { x: (p.x - view.ox) / view.scale, y: (p.y - view.oy) / view.scale }; }
function rectToCss(r) {
  return { x: view.ox + r.left * view.scale, y: view.oy + r.top * view.scale, w: r.width * view.scale, h: r.height * view.scale };
}
function rectOf(i) {
  const el = elements()[i];
  if (!el || !imgLoaded) return null;
  return C.bboxToRect(el.bbox, order(), coordMax(), img.naturalWidth, img.naturalHeight);
}
function handlePoints(c) {
  return {
    nw: [c.x, c.y], n: [c.x + c.w / 2, c.y], ne: [c.x + c.w, c.y],
    e: [c.x + c.w, c.y + c.h / 2], se: [c.x + c.w, c.y + c.h],
    s: [c.x + c.w / 2, c.y + c.h], sw: [c.x, c.y + c.h], w: [c.x, c.y + c.h / 2]
  };
}
const HANDLE_CURSOR = {
  nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize',
  n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize'
};
function handleHit(p) {
  if (selectedIdx < 0) return null;
  const r = rectOf(selectedIdx);
  if (!r) return null;
  const c = rectToCss(r);
  const pts = handlePoints(c);
  for (const [id, [hx, hy]] of Object.entries(pts)) {
    if (Math.abs(p.x - hx) <= 7 && Math.abs(p.y - hy) <= 7) return id;
  }
  return null;
}
function hitBox(p) {
  if (!showBboxes.checked || !imgLoaded) return -1;
  const ip = toImg(p);
  const tol = 5 / view.scale;
  let best = -1, bestArea = Infinity;
  const arr = elements();
  for (let i = 0; i < arr.length; i++) {
    const r = rectOf(i);
    if (!r) continue;
    if (ip.x >= r.left - tol && ip.x <= r.left + r.width + tol &&
        ip.y >= r.top - tol && ip.y <= r.top + r.height + tol) {
      const area = r.width * r.height;
      if (area < bestArea) { bestArea = area; best = i; }
    }
  }
  return best;
}
function draw() {
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const cw = imageCanvas.width / dpr, ch = imageCanvas.height / dpr;
  ctx.clearRect(0, 0, cw, ch);
  ctx.fillStyle = '#0a0c11';
  ctx.fillRect(0, 0, cw, ch);
  zoomLabel.textContent = Math.round(view.scale * 100) + '%';
  if (!imgLoaded) {
    ctx.fillStyle = '#8a90a6';
    ctx.font = '15px system-ui';
    ctx.fillText('Open an item to start editing.', 22, 36);
    return;
  }
  ctx.imageSmoothingEnabled = view.scale < 2.5;
  ctx.drawImage(img, view.ox, view.oy, img.naturalWidth * view.scale, img.naturalHeight * view.scale);

  const arr = elements();
  if (showBboxes.checked) {
    ctx.textBaseline = 'top';
    ctx.font = '700 12px system-ui';
    for (let i = 0; i < arr.length; i++) {
      const r = rectOf(i);
      if (!r) continue;
      const c = rectToCss(r);
      const color = C.colorForIndex(i);
      const isSel = i === selectedIdx;
      const dim = focusMode.checked && selectedIdx >= 0 && !isSel;
      ctx.save();
      ctx.globalAlpha = dim ? 0.22 : 1;
      if (bboxFill.checked || isSel) {
        ctx.fillStyle = color + (isSel ? '2e' : '1d');
        ctx.fillRect(c.x, c.y, c.w, c.h);
      }
      ctx.lineWidth = isSel ? 3 : (i === hoverIdx ? 2.5 : 2);
      ctx.strokeStyle = color;
      ctx.strokeRect(c.x, c.y, c.w, c.h);
      if (bboxLabels.checked) {
        const text = C.shortLabel(arr[i], i);
        const tw = ctx.measureText(text).width;
        const lx = Math.max(0, Math.min(c.x, cw - tw - 10));
        let ly = c.y - 18;
        if (ly < 0) ly = c.y + 2;
        ctx.fillStyle = color;
        ctx.fillRect(lx, ly, tw + 10, 17);
        ctx.fillStyle = '#0c0e14';
        ctx.fillText(text, lx + 5, ly + 3);
      }
      ctx.restore();
    }
    if (selectedIdx >= 0) {
      const r = rectOf(selectedIdx);
      if (r) {
        const pts = handlePoints(rectToCss(r));
        for (const [hx, hy] of Object.values(pts)) {
          ctx.fillStyle = '#ffffff';
          ctx.strokeStyle = C.colorForIndex(selectedIdx);
          ctx.lineWidth = 1.5;
          ctx.fillRect(hx - 3.5, hy - 3.5, 7, 7);
          ctx.strokeRect(hx - 3.5, hy - 3.5, 7, 7);
        }
      }
    }
  }
  if (drag && drag.kind === 'draw') {
    const a = drag.startImg, b = drag.curImg;
    const c = rectToCss({ left: Math.min(a.x, b.x), top: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) });
    ctx.save();
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#ffffff';
    ctx.strokeRect(c.x, c.y, c.w, c.h);
    ctx.restore();
  }
  if (mode === 'draw' && lastPointer && !drag) {
    ctx.save();
    ctx.globalAlpha = 0.3;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(lastPointer.x, 0); ctx.lineTo(lastPointer.x, ch);
    ctx.moveTo(0, lastPointer.y); ctx.lineTo(cw, lastPointer.y);
    ctx.stroke();
    ctx.restore();
  }
}
function updateReadout(p) {
  if (!imgLoaded || !p) { coordReadout.textContent = ''; return; }
  const ip = toImg(p);
  const max = coordMax();
  const uy = Math.round(Math.max(0, Math.min(max, ip.y / img.naturalHeight * max)));
  const ux = Math.round(Math.max(0, Math.min(max, ip.x / img.naturalWidth * max)));
  let s = `y ${uy} \u00b7 x ${ux}`;
  const el = elements()[selectedIdx];
  if (el && Array.isArray(el.bbox)) s += `   sel [${el.bbox.join(', ')}]`;
  coordReadout.textContent = s;
}
function setCanvasCursor(p) {
  if (drag) return;
  if (spaceHeld) { imageCanvas.style.cursor = 'grab'; return; }
  if (mode === 'draw') { imageCanvas.style.cursor = 'crosshair'; return; }
  const h = p ? handleHit(p) : null;
  if (h) { imageCanvas.style.cursor = HANDLE_CURSOR[h]; return; }
  imageCanvas.style.cursor = hoverIdx >= 0 ? 'move' : 'default';
}
function getPos(e) {
  const r = imageCanvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

/* pointer interactions */
imageCanvas.addEventListener('pointerdown', (e) => {
  if (!imgLoaded) return;
  const p = getPos(e);
  imageCanvas.setPointerCapture(e.pointerId);
  if (e.button === 1 || spaceHeld) {
    drag = { kind: 'pan', startX: e.clientX, startY: e.clientY, ox: view.ox, oy: view.oy };
    imageCanvas.style.cursor = 'grabbing';
    e.preventDefault();
    return;
  }
  if (e.button !== 0) return;
  if (mode === 'draw') {
    pushUndoMaybe();
    const ip = toImg(p);
    drag = { kind: 'draw', startImg: ip, curImg: ip };
    return;
  }
  const h = handleHit(p);
  if (h) {
    pushUndoMaybe();
    const r = rectOf(selectedIdx);
    drag = { kind: 'resize', handle: h, idx: selectedIdx, orig: { l: r.left, t: r.top, rr: r.left + r.width, b: r.top + r.height } };
    return;
  }
  const hit = hitBox(p);
  if (hit >= 0) {
    selectIdx(hit);
    pushUndoMaybe();
    const r = rectOf(hit);
    const ip = toImg(p);
    drag = { kind: 'move', idx: hit, dx: ip.x - r.left, dy: ip.y - r.top, w: r.width, h: r.height, moved: false };
  } else {
    selectIdx(-1);
  }
});
imageCanvas.addEventListener('pointermove', (e) => {
  const p = getPos(e);
  lastPointer = p;
  if (!drag) {
    const newHover = mode === 'select' ? hitBox(p) : -1;
    if (newHover !== hoverIdx) { hoverIdx = newHover; draw(); }
    setCanvasCursor(p);
    updateReadout(p);
    if (mode === 'draw') draw(); // crosshair follows
    return;
  }
  if (drag.kind === 'pan') {
    view.ox = drag.ox + (e.clientX - drag.startX);
    view.oy = drag.oy + (e.clientY - drag.startY);
    draw(); updateReadout(p);
    return;
  }
  const ip = toImg(p);
  if (drag.kind === 'draw') {
    drag.curImg = ip;
    draw(); updateReadout(p);
    return;
  }
  const el = elements()[drag.idx];
  if (!el) { drag = null; return; }
  if (drag.kind === 'move') {
    drag.moved = true;
    const left = Math.max(-drag.w * 0.9, Math.min(img.naturalWidth - drag.w * 0.1, ip.x - drag.dx));
    const top = Math.max(-drag.h * 0.9, Math.min(img.naturalHeight - drag.h * 0.1, ip.y - drag.dy));
    el.bbox = C.rectToBbox({ left, top, width: drag.w, height: drag.h }, order(), coordMax(), img.naturalWidth, img.naturalHeight);
  } else if (drag.kind === 'resize') {
    const o = drag.orig;
    let l = o.l, t = o.t, rr = o.rr, b = o.b;
    if (drag.handle.includes('w')) l = ip.x;
    if (drag.handle.includes('e')) rr = ip.x;
    if (drag.handle.includes('n')) t = ip.y;
    if (drag.handle.includes('s')) b = ip.y;
    el.bbox = C.rectToBbox(
      { left: Math.min(l, rr), top: Math.min(t, b), width: Math.abs(rr - l), height: Math.abs(b - t) },
      order(), coordMax(), img.naturalWidth, img.naturalHeight
    );
  }
  markDirty();
  draw(); updateReadout(p);
});
imageCanvas.addEventListener('pointerup', (e) => {
  if (!drag) return;
  const finished = drag;
  drag = null;
  if (finished.kind === 'pan') { setCanvasCursor(lastPointer); return; }
  if (finished.kind === 'draw') {
    const a = finished.startImg, b = finished.curImg;
    const wpx = Math.abs(b.x - a.x) * view.scale, hpx = Math.abs(b.y - a.y) * view.scale;
    if (wpx < 3 || hpx < 3) { draw(); return; } // too small: treat as a stray click
    const bbox = C.rectToBbox(
      { left: Math.min(a.x, b.x), top: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) },
      order(), coordMax(), img.naturalWidth, img.naturalHeight
    );
    let idx;
    if (pendingDrawIdx !== null && elements()[pendingDrawIdx]) {
      elements()[pendingDrawIdx].bbox = bbox;
      idx = pendingDrawIdx;
    } else {
      const arr = ensureElementsArray();
      const el = C.makeElement('obj');
      el.bbox = bbox;
      arr.push(el);
      idx = arr.length - 1;
    }
    pendingDrawIdx = null;
    if (!drawSticky) setMode('select');
    markDirty();
    renderElements();
    selectIdx(idx);
    refreshIssues();
    setMessage('Box placed \u2014 add a description on its card.');
    const card = cardAt(idx);
    if (card) {
      const d = card.querySelector('.el-desc');
      if (d && !d.value) d.focus();
    }
    return;
  }
  // move / resize commit
  const el = elements()[finished.idx];
  if (el && Array.isArray(el.bbox)) {
    const norm = C.normalizeBbox(el.bbox, coordMax());
    if (norm) el.bbox = norm;
    syncCardBbox(finished.idx);
  }
  refreshIssues();
  draw();
});
imageCanvas.addEventListener('wheel', (e) => {
  if (!imgLoaded) return;
  e.preventDefault();
  const p = getPos(e);
  const ip = toImg(p);
  const factor = Math.exp(-e.deltaY * 0.0016);
  const ns = Math.max(0.02, Math.min(16, view.scale * factor));
  view.scale = ns;
  view.ox = p.x - ip.x * ns;
  view.oy = p.y - ip.y * ns;
  draw(); updateReadout(p);
}, { passive: false });
imageCanvas.addEventListener('dblclick', () => { fitView(); draw(); });
imageCanvas.addEventListener('pointerleave', () => { lastPointer = null; hoverIdx = -1; updateReadout(null); draw(); });

function setMode(m) {
  mode = m;
  if (m !== 'draw') { drawSticky = false; pendingDrawIdx = null; }
  modeSelectBtn.classList.toggle('active', m === 'select');
  modeDrawBtn.classList.toggle('active', m === 'draw');
  setCanvasCursor(lastPointer);
  draw();
}
function nudgeSelected(dxUnits, dyUnits) {
  const el = elements()[selectedIdx];
  if (!el || !Array.isArray(el.bbox)) return;
  if (!lastKeyWasArrow) pushUndoMaybe();
  const m = C.idxMap(order());
  const max = coordMax();
  const b = el.bbox.map(Number);
  const h = b[m.y2] - b[m.y1], w = b[m.x2] - b[m.x1];
  let ny1 = Math.max(0, Math.min(max - h, b[m.y1] + dyUnits));
  let nx1 = Math.max(0, Math.min(max - w, b[m.x1] + dxUnits));
  b[m.y1] = ny1; b[m.y2] = ny1 + h;
  b[m.x1] = nx1; b[m.x2] = nx1 + w;
  el.bbox = b;
  markDirty();
  syncCardBbox(selectedIdx);
  refreshIssues(); draw(); updateReadout(lastPointer);
}

/* ---------------- raw tab ---------------- */
function syncRawFromDoc() {
  if (doc) captionText.value = C.serializeDoc(doc, saveFormat.value !== 'minified');
  rawDirtyPending = false;
}
function switchTab(tab, force = false) {
  if (tab === activeTab && !force) return;
  if (tab === 'fields' && rawDirtyPending) {
    if (!tryApplyRaw()) return; // blocked by parse error
  }
  activeTab = tab;
  tabFieldsBtn.classList.toggle('active', tab === 'fields');
  tabRawBtn.classList.toggle('active', tab === 'raw');
  fieldsPanel.classList.toggle('hidden', tab !== 'fields');
  rawPanel.classList.toggle('hidden', tab !== 'raw');
  if (tab === 'raw' && doc && !rawDirtyPending) syncRawFromDoc();
}
function tryApplyRaw() {
  const r = C.parseCaptionDoc(captionText.value);
  if (r.doc) {
    pushUndoMaybe();
    doc = r.doc; plain = false; parseError = null; parseRepaired = r.repaired;
    rawDirtyPending = false;
    rawStatus.textContent = r.repaired ? 'Applied (repaired truncation).' : 'Applied.';
    rawStatus.className = 'raw-status ok';
    renderFieldsTop(); renderElements(); refreshIssues(); draw();
    return true;
  }
  if (r.plain) {
    doc = null; plain = true; parseError = null;
    rawDirtyPending = false;
    rawStatus.textContent = 'Plain text caption (no JSON).';
    rawStatus.className = 'raw-status';
    renderFieldsTop(); renderElements(); refreshIssues(); draw();
    return true;
  }
  rawStatus.textContent = r.error || 'Parse failed.';
  rawStatus.className = 'raw-status error';
  return false;
}
const liveRawParse = debounce(() => {
  const r = C.parseCaptionDoc(captionText.value);
  if (r.doc) {
    doc = r.doc; plain = false; parseError = null; parseRepaired = r.repaired;
    rawStatus.textContent = r.repaired ? 'Valid after truncation repair.' : 'Valid JSON.';
    rawStatus.className = 'raw-status ok';
    refreshIssues(); draw();
  } else if (r.plain) {
    rawStatus.textContent = 'Plain text caption.';
    rawStatus.className = 'raw-status';
  } else {
    rawStatus.textContent = r.error;
    rawStatus.className = 'raw-status error';
  }
}, 350);
captionText.addEventListener('input', () => {
  markDirty();
  rawDirtyPending = true;
  liveRawParse();
});
rawApplyBtn.addEventListener('click', () => { if (tryApplyRaw()) switchTab('fields'); });
convertBtn.addEventListener('click', () => {
  doc = C.ensureSkeleton(captionText.value);
  plain = false; parseError = null;
  undoStack = []; redoStack = [];
  markDirty();
  renderFieldsTop(); renderElements(); refreshIssues(); draw();
  setMessage('Converted to a structured caption template.');
});

/* ---------------- save ---------------- */
function buildSaveText() {
  if (doc && (activeTab === 'fields' || !rawDirtyPending)) {
    return C.serializeDoc(doc, saveFormat.value !== 'minified');
  }
  return captionText.value;
}
async function saveCaption(markFixed = false) {
  if (!activeRel) return;
  const text = buildSaveText();
  const res = await fetch('/api/save-caption', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rel: activeRel, caption: text, mark_fixed: markFixed, backup: backupOriginals.checked })
  });
  const out = await res.json();
  if (out.error) { setMessage(out.error, true); return; }
  dirty = false; rawDirtyPending = false;
  originalText = text;
  if (doc) captionText.value = text;
  const backupNote = out.backup ? ' Original backed up.' : '';
  setMessage((markFixed ? 'Saved and marked fixed.' : 'Saved.') + backupNote);
  await refreshList(true);
  if (markFixed) updateButtons('fixed');
}

/* ---------------- keyboard ---------------- */
document.addEventListener('keydown', (ev) => {
  if (ev.key === ' ' && !ev.target.matches('input, textarea, select, button')) {
    spaceHeld = true;
    setCanvasCursor(lastPointer);
    ev.preventDefault();
    return;
  }
  if (ev.ctrlKey || ev.metaKey) {
    const k = ev.key.toLowerCase();
    if (k === 's') { ev.preventDefault(); saveCaption(false); }
    else if (k === 'z') { ev.preventDefault(); ev.shiftKey ? redo() : undo(); }
    else if (k === 'y') { ev.preventDefault(); redo(); }
    return;
  }
  if (ev.target.matches('input, textarea, select')) {
    if (ev.key === 'Escape') ev.target.blur();
    lastKeyWasArrow = false;
    return;
  }
  const map = { '1': 'excellent', '2': 'good_enough', '3': 'needs_work', '4': 'bad', '5': 'terrible', '6': 'fixed' };
  const k = ev.key;
  if (map[k]) { setStatus(map[k]); }
  else if (k === '[') { move(-1); }
  else if (k === ']') { move(1); }
  else if (k === 'v' || k === 'V') { setMode('select'); }
  else if (k === 'b' || k === 'B') { drawSticky = true; setMode('draw'); }
  else if (k === 'f' || k === 'F') { fitView(); draw(); }
  else if (k === 'Escape') {
    if (mode === 'draw') setMode('select');
    else selectIdx(-1);
  } else if ((k === 'Delete' || k === 'Backspace') && selectedIdx >= 0) {
    ev.preventDefault();
    removeElement(selectedIdx);
  } else if (k.startsWith('Arrow') && selectedIdx >= 0) {
    ev.preventDefault();
    const d = ev.shiftKey ? 10 : 1;
    if (k === 'ArrowUp') nudgeSelected(0, -d);
    else if (k === 'ArrowDown') nudgeSelected(0, d);
    else if (k === 'ArrowLeft') nudgeSelected(-d, 0);
    else if (k === 'ArrowRight') nudgeSelected(d, 0);
    lastKeyWasArrow = true;
    return;
  }
  lastKeyWasArrow = false;
});
document.addEventListener('keyup', (ev) => {
  if (ev.key === ' ') { spaceHeld = false; setCanvasCursor(lastPointer); }
});

/* ---------------- wiring ---------------- */
openFolderBtn.addEventListener('click', openFolder);
targetFolder.addEventListener('keydown', (e) => { if (e.key === 'Enter') openFolder(); });
statusFilter.addEventListener('change', () => refreshList(false));
sortBy.addEventListener('change', () => refreshList(true));
recursive.addEventListener('change', () => refreshList(true));
searchBox.addEventListener('input', renderList);
ratingButtons.addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-status]');
  if (btn) setStatus(btn.dataset.status);
});
clearStatusBtn.addEventListener('click', clearStatus);
saveCaptionBtn.addEventListener('click', () => saveCaption(false));
saveFixedBtn.addEventListener('click', () => saveCaption(true));
prevItemBtn.addEventListener('click', () => move(-1));
nextItemBtn.addEventListener('click', () => move(1));
modeSelectBtn.addEventListener('click', () => setMode('select'));
modeDrawBtn.addEventListener('click', () => { drawSticky = true; setMode('draw'); });
addElementBtn.addEventListener('click', addElement);
fitBtn.addEventListener('click', () => { fitView(); draw(); });
zoomInBtn.addEventListener('click', () => zoomCenter(1.25));
zoomOutBtn.addEventListener('click', () => zoomCenter(0.8));
function zoomCenter(f) {
  if (!imgLoaded) return;
  const p = { x: imageWrap.clientWidth / 2, y: imageWrap.clientHeight / 2 };
  const ip = toImg(p);
  view.scale = Math.max(0.02, Math.min(16, view.scale * f));
  view.ox = p.x - ip.x * view.scale;
  view.oy = p.y - ip.y * view.scale;
  draw();
}
tabFieldsBtn.addEventListener('click', () => switchTab('fields'));
tabRawBtn.addEventListener('click', () => switchTab('raw'));
for (const el of [showBboxes, bboxLabels, bboxFill, focusMode]) {
  el.addEventListener('change', () => { draw(); savePrefs(); });
}
bboxFormat.addEventListener('change', () => { relabelCoordInputs(); refreshIssues(); draw(); savePrefs(); });
bboxCoordMax.addEventListener('change', () => { refreshIssues(); draw(); savePrefs(); });
saveFormat.addEventListener('change', savePrefs);
backupOriginals.addEventListener('change', savePrefs);
window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

const ro = new ResizeObserver(() => { resizeCanvas(); draw(); });
ro.observe(imageWrap);

/* ---------------- init ---------------- */
loadPrefs();
bindTopFields();
resizeCanvas();
draw();
