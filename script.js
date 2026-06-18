/* script.js — Caption Reviewer + BBox Editor frontend.
 * Pure geometry/validation lives in bbox_core.js (window.BBoxCore).
 */
'use strict';
const C = window.BBoxCore;

/* ---------------- DOM ---------------- */
const $ = (id) => document.getElementById(id);
const targetFolder = $('targetFolder'), recursive = $('recursive'), openFolderBtn = $('openFolder'), pickFolderBtn = $('pickFolder');
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
const nextJsonIssueBtn = $('nextJsonIssue'), nextBoxIssueBtn = $('nextBoxIssue'), nextMissingCaptionBtn = $('nextMissingCaption');
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
const autofillPaletteBtn = $('autofillPalette'), pickPaletteBtn = $('pickPalette'), stripPaletteBtn = $('stripPalette'), stripAllPalettesBtn = $('stripAllPalettes');
const batchAutofillPalettesBtn = $('batchAutofillPalettes'), batchRepairJsonBtn = $('batchRepairJson');
const captionText = $('captionText'), captionPath = $('captionPath');
const rawApplyBtn = $('rawApplyBtn'), repairJsonBtn = $('repairJsonBtn'), rawStatus = $('rawStatus');
const saveFormat = $('saveFormat'), saveCaptionBtn = $('saveCaption'), saveFixedBtn = $('saveFixed');
const removePairBtn = $('removePair'), deletePairBtn = $('deletePair');
const saveStatus = $('saveStatus');
const saveNextBtn = $('saveNext'), advanceOnRate = $('advanceOnRate'), autoRepairJson = $('autoRepairJson');
const posIndicator = $('posIndicator'), recentFoldersList = $('recentFolders');
/* layout: app-bar toggles, slide-in drawers, floating hover tooltip */
const browseToggle = $('browseToggle'), editorToggle = $('editorToggle');
const browseClose = $('browseClose'), editorClose = $('editorClose');
const browseDrawer = $('browseDrawer'), editorDrawer = $('editorDrawer');
const bCol = $('bCol'), boxTip = $('boxTip');

/* ---------------- state ---------------- */
let items = [], activeRel = null, activeIndex = -1;
let originalText = '';
let doc = null, plain = false, parseError = null, parseRepaired = false, parseRepairKind = "";
let selectedIdx = -1, hoverIdx = -1;
let mode = 'select';            // 'select' | 'draw' | 'pickColor'
let drawSticky = false;         // B key keeps draw mode after one box
let pendingDrawIdx = null;      // next drawn rect goes to this element
let dirty = false, rawDirtyPending = false;
let activeTab = 'fields';
let view = { scale: 1, ox: 0, oy: 0 };
let img = new Image(), imgLoaded = false;
let drag = null, spaceHeld = false, lastPointer = null, lastKeyWasArrow = false;
let colorPickIdx = null;
let manualPaletteBboxes = new Set();
let undoStack = [], redoStack = [];

/* recent folders + last-session restore (persisted in localStorage prefs) */
let recentFolders = [];
let lastOpenedFolder = '';
let lastPrefs = {};

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
function paletteBboxKey(el) {
  if (!el || !Array.isArray(el.bbox) || el.bbox.length !== 4) return '';
  const norm = C.normalizeBbox(el.bbox, coordMax()) || el.bbox;
  return `${order()}|${coordMax()}|${norm.map((v) => Number(v)).join(',')}`;
}
function markPaletteManual(i) {
  const key = paletteBboxKey(elements()[i]);
  if (key) manualPaletteBboxes.add(key);
}
function manualPaletteList() { return Array.from(manualPaletteBboxes).sort(); }
function updateDirtyUi() {
  document.body.classList.toggle('dirty', dirty);
  renderList(false);
}
function markDirty() {
  if (!dirty) setMessage('Unsaved changes.');
  dirty = true;
  updateDirtyUi();
}

/* prefs */
const PREFS_KEY = 'caption_reviewer_prefs';
function loadPrefs() {
  let p = {};
  try { p = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}'); } catch (e) { p = {}; }
  lastPrefs = p || {};
  if (p.order) bboxFormat.value = p.order;
  if (p.coordMax) bboxCoordMax.value = p.coordMax;
  if (p.saveFormat) saveFormat.value = p.saveFormat;
  if (typeof p.backup === 'boolean') backupOriginals.checked = p.backup;
  if (typeof p.focus === 'boolean') focusMode.checked = p.focus;
  if (typeof p.showBboxes === 'boolean') showBboxes.checked = p.showBboxes;
  if (typeof p.bboxLabels === 'boolean') bboxLabels.checked = p.bboxLabels;
  if (typeof p.bboxFill === 'boolean') bboxFill.checked = p.bboxFill;
  if (typeof p.advanceOnRate === 'boolean') advanceOnRate.checked = p.advanceOnRate;
  if (typeof p.autoRepairJson === 'boolean') autoRepairJson.checked = p.autoRepairJson;
  if (p.statusFilter) statusFilter.value = p.statusFilter;
  if (p.sortBy) sortBy.value = p.sortBy;
  if (typeof p.recursive === 'boolean') recursive.checked = p.recursive;
  if (typeof p.search === 'string') searchBox.value = p.search;
  if (Array.isArray(p.recentFolders)) recentFolders = p.recentFolders.filter((x) => typeof x === 'string');
  if (p.lastFolder && !targetFolder.value) targetFolder.value = p.lastFolder;
  renderRecentFolders();
}
function writePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({
      order: bboxFormat.value, coordMax: bboxCoordMax.value, saveFormat: saveFormat.value,
      backup: backupOriginals.checked, focus: focusMode.checked,
      showBboxes: showBboxes.checked, bboxLabels: bboxLabels.checked, bboxFill: bboxFill.checked,
      advanceOnRate: advanceOnRate.checked,
      statusFilter: statusFilter.value, sortBy: sortBy.value, recursive: recursive.checked,
      search: searchBox.value, recentFolders: recentFolders.slice(0, 10),
      lastFolder: lastOpenedFolder || targetFolder.value || '', lastActiveRel: activeRel || '',
      autoRepairJson: autoRepairJson.checked, activeTab,
      browseOpen: browseDrawer.classList.contains('open'), editorOpen: editorDrawer.classList.contains('open'),
      ai: lastPrefs.ai || {}
    }));
  } catch (e) { /* ignore (private mode / quota) */ }
}
const savePrefs = debounce(writePrefs, 200);
function renderRecentFolders() {
  if (!recentFoldersList) return;
  recentFoldersList.innerHTML = '';
  for (const path of recentFolders) {
    const opt = document.createElement('option');
    opt.value = path;
    recentFoldersList.appendChild(opt);
  }
}
function rememberFolder(path) {
  if (!path) return;
  lastOpenedFolder = path;
  recentFolders = [path, ...recentFolders.filter((p) => p !== path)].slice(0, 10);
  renderRecentFolders();
  writePrefs();
}

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
/* the item list after status filter (server-side), compare filter, and search (client-side) */
function visibleItems() {
  const q = searchBox.value.trim().toLowerCase();
  let base = items;
  if (compareActive && compareFilter.value !== 'all') {
    base = items.filter((it) => compareFilter.value === 'matched' ? !!matchMap[it.rel] : !matchMap[it.rel]);
  }
  return q
    ? base.filter((it) => it.rel.toLowerCase().includes(q) || (it.caption_preview || '').toLowerCase().includes(q))
    : base;
}
function encRel(rel) { return rel.split('/').map(encodeURIComponent).join('/'); }
function relVersion(rel) {
  const it = items.find((x) => x.rel === rel);
  return Math.floor((it && it.image_mtime) || 0);   // cache key: changes only if the file changes
}
function mediaUrl(rel) { return '/media/' + encRel(rel) + '?v=' + relVersion(rel); }
function thumbUrl(rel) { return '/thumb/' + encRel(rel) + '?v=' + relVersion(rel); }
function updatePosIndicator() {
  if (!posIndicator) return;
  const vis = visibleItems();
  const i = activeRel ? vis.findIndex((x) => x.rel === activeRel) : -1;
  posIndicator.textContent = (i >= 0) ? `${i + 1} / ${vis.length}` : (vis.length ? `${vis.length}` : '');
}
function renderList(scrollActive = false) {
  listEl.innerHTML = '';
  const visible = visibleItems();
  listCountEl.textContent = (visible.length !== items.length) ? `${visible.length}/${items.length}` : String(items.length);
  updatePosIndicator();
  if (!visible.length) {
    const div = document.createElement('div');
    div.className = 'empty-list';
    div.textContent = items.length ? 'No items match the current filter or search.' : 'No matching images.';
    listEl.appendChild(div);
    return;
  }
  let activeEl = null;
  for (const item of visible) {
    const div = document.createElement('button');
    div.className = `item ${statusClasses[item.status] || ''}`;
    if (item.rel === activeRel) { div.classList.add('active'); activeEl = div; }
    if (dirty && item.rel === activeRel) div.classList.add('dirty');
    div.innerHTML = `
      <img class="item-thumb" loading="lazy" alt="" src="${thumbUrl(item.rel)}">
      <div class="item-body">
        <div class="item-main">
          <span class="name" title="${escapeText(item.rel)}">${escapeText(item.filename)}</span>
          <span class="badge">${escapeText(item.status_label)}</span>
        </div>
        <div class="sub" title="${escapeText(item.rel)}">${escapeText(item.folder)}</div>
        <div class="preview">${escapeText(item.caption_preview || '(no caption file)')}</div>
      </div>`;
    const thumbImg = div.querySelector('.item-thumb');
    if (thumbImg) thumbImg.addEventListener('error', () => { thumbImg.style.visibility = 'hidden'; });
    div.addEventListener('click', () => loadItem(item.rel));
    if (compareActive) {
      const m = matchMap[item.rel];
      const badge = document.createElement('span');
      badge.className = 'cmp-badge ' + (m ? 'ok' : 'no');
      badge.textContent = m
        ? (m.method === 'name' ? 'B' : m.method === 'bytes' ? 'B~' : 'B\u2248')
        : 'no B';
      badge.title = m ? ('B match: ' + m.b_rel + ' (' + m.method + ')') : 'no match in compare folder';
      const statusBadge = div.querySelector('.badge');
      if (statusBadge) statusBadge.after(badge);
    }
    listEl.appendChild(div);
  }
  if (scrollActive === true && activeEl) activeEl.scrollIntoView({ block: 'nearest' });
}

async function pickFolder() {
  if (dirty && !confirm('Caption has unsaved changes. Continue choosing a different folder?')) return;
  pickFolderBtn.disabled = true;
  pickFolderBtn.textContent = 'Picking…';
  try {
    const res = await fetch('/api/pick-folder', { method: 'POST' });
    const out = await res.json();
    if (out.error) throw new Error(out.error);
    if (out.path) {
      targetFolder.value = out.path;
      rememberFolder(out.path);
      await openFolder();
    }
  } catch (e) {
    alert('Folder picker error: ' + e.message);
  } finally {
    pickFolderBtn.disabled = false;
    pickFolderBtn.textContent = 'Pick folder…';
  }
}

async function openFolder(opts = {}) {
  const folder = targetFolder.value.trim();
  if (!folder) return;
  if (!opts.silent && dirty && !confirm('Caption has unsaved changes. Discard them and open a different folder?')) return;
  openFolderBtn.disabled = true;
  openFolderBtn.textContent = 'Opening...';
  try {
    const res = await fetch('/api/open-folder', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target_folder: folder, recursive: recursive.checked })
    });
    const out = await res.json();
    if (out.error) throw new Error(out.error);
    dirty = false; rawDirtyPending = false; updateDirtyUi();
    items = out.items || [];
    resetCompareForNewFolder();
    activeRel = null; activeIndex = -1;
    renderCounts(out.counts);
    rememberFolder(folder);
    // open-folder always returns the default (status-grouped, unfiltered) view, so
    // re-apply the persisted/selected status filter and sort when they differ.
    if (statusFilter.value !== 'all' || sortBy.value !== 'status') {
      await refreshList(false);
    } else {
      renderList();
    }
    const vis = visibleItems();
    let target = null;
    if (opts.preferRel) {
      target = vis.find((x) => x.rel === opts.preferRel) || items.find((x) => x.rel === opts.preferRel);
    }
    if (!target) target = vis[0] || items[0] || null;
    if (target) await loadItem(target.rel);
  } catch (e) {
    if (opts.silent) setMessage('Could not reopen the last folder (it may have moved).', true);
    else alert('Error: ' + e.message);
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
function jumpToVisibleIndex(idx) {
  const vis = visibleItems();
  if (!vis.length) return;
  idx = Math.max(0, Math.min(vis.length - 1, idx));
  if (vis[idx]) loadItem(vis[idx].rel);
}
function move(delta) {
  const vis = visibleItems();
  if (!vis.length) return;
  let idx = vis.findIndex((x) => x.rel === activeRel);
  idx = (idx < 0) ? 0 : Math.max(0, Math.min(vis.length - 1, idx + delta));
  jumpToVisibleIndex(idx);
}
function promptJumpToIndex() {
  const vis = visibleItems();
  if (!vis.length) return;
  const cur = Math.max(1, vis.findIndex((x) => x.rel === activeRel) + 1);
  const val = prompt(`Jump to item number (1-${vis.length})`, String(cur));
  if (val == null) return;
  const n = Number(val);
  if (Number.isFinite(n)) jumpToVisibleIndex(Math.round(n) - 1);
}

async function loadItemDataForRel(rel) {
  const res = await fetch('/api/item?rel=' + encodeURIComponent(rel));
  const out = await res.json();
  if (out.error) throw new Error(out.error);
  return out;
}
async function loadCaptionForRel(rel) {
  const out = await loadItemDataForRel(rel);
  return out.caption || '';
}
async function moveToNextProblem(kind) {
  const vis = visibleItems();
  if (!vis.length) return;
  const start = vis.findIndex((x) => x.rel === activeRel);
  setMessage(`Scanning for next ${kind.replace('-', ' ')}…`);
  for (let step = 1; step <= vis.length; step++) {
    const it = vis[((start < 0 ? -1 : start) + step) % vis.length];
    if (!it) continue;
    try {
      const text = await loadCaptionForRel(it.rel);
      if (kind === 'missing' && !text.trim()) { await loadItem(it.rel); return; }
      const parsed = C.parseCaptionDoc(text, { repair: autoRepairJson.checked });
      if (kind === 'json' && (parsed.error || parsed.repaired || parsed.plain)) { await loadItem(it.rel); return; }
      if (kind === 'box' && parsed.doc && C.validateDoc(parsed.doc, coordMax()).length) { await loadItem(it.rel); return; }
    } catch (e) {
      if (kind === 'json') { await loadItem(it.rel); return; }
    }
  }
  setMessage(`No ${kind.replace('-', ' ')} item found in the current list.`);
}

function moveToNextUnrated() {
  const vis = visibleItems();
  if (!vis.length) return;
  const start = vis.findIndex((x) => x.rel === activeRel);
  for (let step = 1; step <= vis.length; step++) {
    const it = vis[((start < 0 ? -1 : start) + step) % vis.length];
    if (it && it.status === 'unrated') { loadItem(it.rel); return; }
  }
  setMessage('No unrated items in the current list.');
}

/* ---------------- ratings ---------------- */
function updateButtons(status) {
  for (const btn of ratingButtons.querySelectorAll('button[data-status]')) {
    btn.classList.toggle('selected', btn.dataset.status === status);
  }
}
async function setStatus(status) {
  if (!activeRel) return;
  // Capture the next item up front: rating can re-sort the list (status grouping),
  // so "next" should mean the item that was after this one at rating time.
  let nextRel = null;
  if (advanceOnRate.checked) {
    const vis = visibleItems();
    const idx = vis.findIndex((x) => x.rel === activeRel);
    if (idx >= 0 && idx + 1 < vis.length) nextRel = vis[idx + 1].rel;
  }
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
  if (nextRel) loadItem(nextRel);
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
  renderList(true);
  updateButtons(out.status);

  manualPaletteBboxes = new Set(Array.isArray(out.meta && out.meta.manual_palette_bboxes) ? out.meta.manual_palette_bboxes : []);
  setCaptionState(out.caption || '');
  dirty = false; updateDirtyUi();
  setMessage(parseRepaired ? `Loaded with JSON repair${parseRepairKind ? ` (${parseRepairKind})` : ""}.` : '');

  imgLoaded = false;
  draw();
  const next = new Image();
  next.onload = () => { img = next; imgLoaded = true; resizeCanvas(); fitView(); draw(); };
  next.onerror = () => { imgLoaded = false; setMessage('Could not load image preview.', true); draw(); };
  next.src = mediaUrl(rel);

  // Prefetch the next visible image so advancing with ] / Save & next feels instant.
  const vis = visibleItems();
  const ci = vis.findIndex((x) => x.rel === rel);
  if (ci >= 0 && ci + 1 < vis.length) { const pf = new Image(); pf.src = mediaUrl(vis[ci + 1].rel); }

  savePrefs();   // remember the active item for next-session restore
  if (compareActive) loadCompareItem(rel);
}

function setCaptionState(text) {
  originalText = text;
  const r = C.parseCaptionDoc(text, { repair: autoRepairJson.checked });
  doc = r.doc; plain = r.plain; parseError = r.error; parseRepaired = r.repaired; parseRepairKind = r.repairKind || "";
  selectedIdx = -1; hoverIdx = -1; pendingDrawIdx = null;
  setMode('select');
  undoStack = []; redoStack = [];
  rawDirtyPending = false;
  captionText.value = r.repairedText || text;
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
function isHexColor(v) { return /^#[0-9a-f]{6}$/i.test(String(v || '').trim()); }
function normalizeHex(v) { return isHexColor(v) ? String(v).trim().toUpperCase() : ''; }
function renderPaletteChips(values, owner, onRemove) {
  const wrap = document.createElement('div');
  wrap.className = 'palette-chips';
  const vals = Array.isArray(values) ? values : textToPalette(values == null ? '' : String(values));
  vals.forEach((raw, idx) => {
    const hex = normalizeHex(raw);
    if (!hex) return;
    const chip = document.createElement(owner ? 'button' : 'span');
    chip.className = 'palette-swatch';
    chip.style.background = hex;
    chip.title = hex + (owner ? ' — click to remove' : '');
    chip.setAttribute('aria-label', hex);
    if (owner) chip.addEventListener('click', (ev) => { ev.stopPropagation(); onRemove(idx); });
    wrap.appendChild(chip);
  });
  return wrap;
}
function cleanPaletteValues(values) {
  const out = [];
  for (const v of values) {
    const clean = normalizeHex(v) || String(v).trim();
    if (clean && !out.includes(clean)) out.push(clean);
  }
  return out;
}
function setElementPalette(i, values) {
  const el = elements()[i];
  if (!el) return;
  const clean = cleanPaletteValues(values);
  if (clean.length) el.color_palette = clean;
  else delete el.color_palette;
}
function addElementPaletteColor(i, value) {
  const el = elements()[i];
  if (!el) return false;
  const clean = normalizeHex(value) || String(value || '').trim();
  if (!clean) return false;
  const vals = cleanPaletteValues(Array.isArray(el.color_palette) ? el.color_palette : []);
  if (!vals.includes(clean)) vals.push(clean);
  el.color_palette = vals;
  return true;
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
    fieldsNoticeText.textContent = `JSON was repaired on load${parseRepairKind ? ` (${parseRepairKind})` : ''} — saving writes the repaired version.`;
  }
  const sd = (doc && doc.style_description) || {};
  const comp = (doc && doc.compositional_deconstruction) || {};
  fldHld.value = doc ? String(doc.high_level_description || '') : '';
  fldAesthetics.value = String(sd.aesthetics || '');
  fldLighting.value = String(sd.lighting || '');
  fldArt.value = String(sd.art_style || '');
  fldMedium.value = String(sd.medium || '');
  fldStylePalette.value = paletteToText(sd.color_palette);
  const oldChips = fldStylePalette.parentElement.querySelector('.palette-chips');
  if (oldChips) oldChips.remove();
  fldStylePalette.insertAdjacentElement('afterend', renderPaletteChips(sd.color_palette));
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

  const palWrap = document.createElement('div');
  palWrap.className = 'palette-row';
  const pal = document.createElement('input');
  pal.className = 'el-pal';
  pal.placeholder = 'color_palette: #AABBCC, #DDEEFF';
  pal.value = paletteToText(el.color_palette);
  pal.addEventListener('focus', pushUndoMaybe);
  pal.addEventListener('input', () => { markPaletteManual(i); setElementPalette(i, textToPalette(pal.value)); markDirty(); });
  const chips = renderPaletteChips(el.color_palette, el, (idx) => {
    pushUndoMaybe();
    const vals = Array.isArray(el.color_palette) ? el.color_palette.slice() : [];
    vals.splice(idx, 1);
    markPaletteManual(i);
    setElementPalette(i, vals);
    markDirty(); renderElements();
  });
  palWrap.append(pal, chips);

  card.append(head, desc, bboxRow, palWrap);
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


function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')).join('').toUpperCase();
}
function rgbDistanceSq(a, b) {
  const dr = a.r - b.r, dg = a.g - b.g, db = a.b - b.b;
  return dr * dr + dg * dg + db * db;
}
function extractRectPixels(rect, sourceImg = img) {
  if (!sourceImg || !rect || rect.width <= 0 || rect.height <= 0) return null;
  const c = document.createElement('canvas');
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));
  c.width = w; c.height = h;
  const ictx = c.getContext('2d', { willReadFrequently: true });
  ictx.drawImage(sourceImg, rect.left, rect.top, rect.width, rect.height, 0, 0, w, h);
  return { data: ictx.getImageData(0, 0, w, h).data, w, h };
}
function sampleImageRectColors(rect, maxColors = 5, sourceImg = img) {
  const pixels = extractRectPixels(rect, sourceImg);
  if (!pixels) return [];
  const { data } = pixels;
  const bins = new Map();
  const stride = Math.max(4, Math.floor(data.length / 16000) & ~3);
  let total = 0;
  for (let i = 0; i < data.length; i += stride) {
    if (data[i + 3] < 8) continue;
    total++;
    const qr = data[i] >> 4, qg = data[i + 1] >> 4, qb = data[i + 2] >> 4;
    const key = `${qr},${qg},${qb}`;
    const bin = bins.get(key) || { r: 0, g: 0, b: 0, count: 0 };
    bin.r += data[i]; bin.g += data[i + 1]; bin.b += data[i + 2]; bin.count++;
    bins.set(key, bin);
  }
  if (!total) return [];
  const candidates = Array.from(bins.values())
    .map((bin) => ({ r: bin.r / bin.count, g: bin.g / bin.count, b: bin.b / bin.count, count: bin.count }))
    .filter((bin) => bin.count / total >= 0.015)
    .sort((a, b) => b.count - a.count);
  const picked = [];
  const minDistanceSq = 34 * 34;
  for (const c of candidates) {
    if (picked.every((p) => rgbDistanceSq(p, c) >= minDistanceSq)) picked.push(c);
    if (picked.length >= maxColors) break;
  }
  if (!picked.length && candidates.length) picked.push(candidates[0]);
  return picked.map((c) => rgbToHex(c.r, c.g, c.b));
}
function sampleImageRect(rect, sourceImg = img) {
  return sampleImageRectColors(rect, 1, sourceImg)[0] || '';
}
function colorAtCanvasPoint(p) {
  if (!imgLoaded || !p) return '';
  const ip = toImg(p);
  if (ip.x < 0 || ip.y < 0 || ip.x >= img.naturalWidth || ip.y >= img.naturalHeight) return '';
  return sampleImageRect({ left: Math.floor(ip.x), top: Math.floor(ip.y), width: 1, height: 1 });
}
function autofillPaletteForIndex(i) {
  const el = elements()[i];
  if (!el || !Array.isArray(el.bbox)) return false;
  const rect = rectOf(i);
  const colors = sampleImageRectColors(rect, 5, img);
  if (!colors.length) return false;
  setElementPalette(i, colors);
  return true;
}
function autofillSelectedPalette() {
  if (selectedIdx < 0) { setMessage('Select an element with a bbox before autofilling its palette.', true); return; }
  pushUndoMaybe();
  if (!autofillPaletteForIndex(selectedIdx)) { setMessage('Selected element has no usable bbox to sample.', true); return; }
  markDirty(); renderElements(); draw(); setMessage('Palette autofilled with distinct colors from selected bbox.');
}
function autofillAllPalettes() {
  if (!doc) return;
  pushUndoMaybe();
  let n = 0;
  elements().forEach((_, i) => { if (autofillPaletteForIndex(i)) n++; });
  if (!n) { setMessage('No element bboxes were available to sample.', true); return; }
  markDirty(); renderElements(); draw(); setMessage(`Autofilled ${n} palette${n === 1 ? '' : 's'} with distinct bbox colors.`);
}
function stripSelectedPalette() {
  const el = elements()[selectedIdx];
  if (!el || !Object.prototype.hasOwnProperty.call(el, 'color_palette')) return;
  pushUndoMaybe(); markPaletteManual(selectedIdx); delete el.color_palette; markDirty(); renderElements(); setMessage('Removed selected element palette.');
}
function stripAllPalettes() {
  if (!doc) return;
  pushUndoMaybe();
  let n = 0;
  elements().forEach((el, i) => { if (Object.prototype.hasOwnProperty.call(el, 'color_palette')) { markPaletteManual(i); delete el.color_palette; n++; } });
  markDirty(); renderElements(); setMessage(`Removed ${n} element palette${n === 1 ? '' : 's'}.`);
}

async function datasetItems() {
  const params = new URLSearchParams({ status: 'all', sort: 'filename', recursive: recursive.checked ? 'true' : 'false' });
  const res = await fetch('/api/list?' + params.toString());
  const out = await res.json();
  if (out.error) throw new Error(out.error);
  return out.items || [];
}
async function saveCaptionForRel(rel, text, opts = {}) {
  const body = { rel, caption: text, mark_fixed: false, backup: backupOriginals.checked };
  if (opts.manualPaletteBboxes) body.manual_palette_bboxes = opts.manualPaletteBboxes;
  const res = await fetch('/api/save-caption', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const out = await res.json();
  if (out.error) throw new Error(out.error);
  return out;
}
function loadImageForRel(rel) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Could not load image.'));
    image.src = mediaUrl(rel);
  });
}
function autofillDocPalettesFromImage(targetDoc, sourceImg, manualKeys = new Set()) {
  const arr = C.getElements(targetDoc) || [];
  let changed = 0;
  for (const el of arr) {
    const key = paletteBboxKey(el);
    if (key && manualKeys.has(key)) continue;
    const rect = C.bboxToRect(el.bbox, order(), coordMax(), sourceImg.naturalWidth, sourceImg.naturalHeight);
    if (!rect) continue;
    const colors = sampleImageRectColors(rect, 5, sourceImg);
    if (!colors.length) continue;
    const next = cleanPaletteValues(colors);
    if (JSON.stringify(el.color_palette || []) === JSON.stringify(next)) continue;
    el.color_palette = next;
    changed++;
  }
  return changed;
}
async function batchAutofillPalettes() {
  if (dirty && !confirm('Current caption has unsaved changes. Continue without saving them first?')) return;
  const all = await datasetItems();
  if (!all.length) { setMessage('No dataset items loaded.', true); return; }
  if (!confirm(`Autofill color_palette fields for all ${all.length} loaded dataset item(s)? Bboxes previously palette-edited by hand will be skipped. Other existing element palettes will be replaced when a bbox can be sampled. Original captions are backed up according to your backup setting.`)) return;
  batchAutofillPalettesBtn.disabled = true; batchRepairJsonBtn.disabled = true;
  let saved = 0, skipped = 0, failed = 0, changedElements = 0;
  try {
    for (let idx = 0; idx < all.length; idx++) {
      const rel = all[idx].rel;
      setMessage(`Autofilling palettes ${idx + 1}/${all.length}: ${rel}`);
      try {
        const itemData = await loadItemDataForRel(rel);
        const parsed = C.parseCaptionDoc(itemData.caption || '', { repair: autoRepairJson.checked });
        if (!parsed.doc) { skipped++; continue; }
        const sourceImg = await loadImageForRel(rel);
        const manualKeys = new Set(Array.isArray(itemData.meta && itemData.meta.manual_palette_bboxes) ? itemData.meta.manual_palette_bboxes : []);
        const changed = autofillDocPalettesFromImage(parsed.doc, sourceImg, manualKeys);
        if (!changed) { skipped++; continue; }
        await saveCaptionForRel(rel, C.serializeDoc(parsed.doc, saveFormat.value !== 'minified'));
        saved++; changedElements += changed;
      } catch (e) {
        console.warn('Palette batch failed for', rel, e);
        failed++;
      }
    }
  } finally {
    batchAutofillPalettesBtn.disabled = false; batchRepairJsonBtn.disabled = false;
  }
  await refreshList(true);
  if (activeRel) {
    dirty = false;
    await loadItem(activeRel);
    updateDirtyUi();
  }
  setMessage(`Dataset palette autofill saved ${saved} caption${saved === 1 ? '' : 's'} (${changedElements} element${changedElements === 1 ? '' : 's'} changed), skipped ${skipped}, failed ${failed}${failed ? ' — see console.' : ''}${failed ? '' : '.'}`, !!failed);
}
async function batchRepairJson() {
  if (dirty && !confirm('Current caption has unsaved changes. Continue without saving them first?')) return;
  const all = await datasetItems();
  if (!all.length) { setMessage('No dataset items loaded.', true); return; }
  if (!confirm(`Auto-repair and save JSON captions for all ${all.length} loaded dataset item(s)? Plain-text captions and unrepairable JSON will be skipped. Original captions are backed up according to your backup setting.`)) return;
  batchAutofillPalettesBtn.disabled = true; batchRepairJsonBtn.disabled = true;
  let saved = 0, skipped = 0, failed = 0;
  try {
    for (let idx = 0; idx < all.length; idx++) {
      const rel = all[idx].rel;
      setMessage(`Repairing JSON ${idx + 1}/${all.length}: ${rel}`);
      try {
        const text = await loadCaptionForRel(rel);
        const parsed = C.parseCaptionDoc(text, { repair: true });
        if (!parsed.doc || !parsed.repaired) { skipped++; continue; }
        await saveCaptionForRel(rel, C.serializeDoc(parsed.doc, saveFormat.value !== 'minified'));
        saved++;
      } catch (e) {
        console.warn('JSON repair batch failed for', rel, e);
        failed++;
      }
    }
  } finally {
    batchAutofillPalettesBtn.disabled = false; batchRepairJsonBtn.disabled = false;
  }
  await refreshList(true);
  if (activeRel) {
    dirty = false;
    await loadItem(activeRel);
    updateDirtyUi();
  }
  setMessage(`Dataset JSON repair saved ${saved} caption${saved === 1 ? '' : 's'}, skipped ${skipped}, failed ${failed}${failed ? ' — see console.' : ''}${failed ? '' : '.'}`, !!failed);
}
function startPalettePick() {
  if (selectedIdx < 0) { setMessage('Select an element, then click the image to pick its palette color.', true); return; }
  colorPickIdx = selectedIdx;
  setMode('pickColor');
  setMessage('Click the image to set the selected element palette color.');
}
function pickPaletteFromPoint(i, p) {
  const el = elements()[i];
  if (!el) return;
  const hex = colorAtCanvasPoint(p);
  if (!hex) { setMessage('Click inside the image to pick a palette color.', true); return; }
  pushUndoMaybe(); markPaletteManual(i); addElementPaletteColor(i, hex); markDirty(); renderElements(); selectIdx(i); setMessage(`Added ${hex} to element #${i + 1} palette. Click more colors, or press Esc/V when done.`);
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
  if (mode === 'draw' || mode === 'pickColor') { imageCanvas.style.cursor = 'crosshair'; return; }
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
  hideBoxTip();
  const p = getPos(e);
  imageCanvas.setPointerCapture(e.pointerId);
  if (e.button === 1 || spaceHeld) {
    drag = { kind: 'pan', startX: e.clientX, startY: e.clientY, ox: view.ox, oy: view.oy };
    imageCanvas.style.cursor = 'grabbing';
    e.preventDefault();
    return;
  }
  if (e.button !== 0) return;
  if (mode === 'pickColor') {
    const idx = colorPickIdx !== null ? colorPickIdx : selectedIdx;
    pickPaletteFromPoint(idx, p);
    e.preventDefault();
    return;
  }
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
    if (hoverIdx >= 0) showBoxTip(e.clientX, e.clientY, elements()[hoverIdx], hoverIdx);
    else hideBoxTip();
    if (mode === 'draw' || mode === 'pickColor') draw(); // crosshair follows
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
imageCanvas.addEventListener('pointerleave', () => { lastPointer = null; hoverIdx = -1; updateReadout(null); hideBoxTip(); draw(); });

function setMode(m) {
  mode = m;
  if (m !== 'draw') { drawSticky = false; pendingDrawIdx = null; }
  if (m !== 'pickColor') colorPickIdx = null;
  modeSelectBtn.classList.toggle('active', m === 'select');
  modeDrawBtn.classList.toggle('active', m === 'draw');
  if (pickPaletteBtn) pickPaletteBtn.classList.toggle('active', m === 'pickColor');
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
  const r = C.parseCaptionDoc(captionText.value, { repair: autoRepairJson.checked });
  if (r.doc) {
    pushUndoMaybe();
    doc = r.doc; plain = false; parseError = null; parseRepaired = r.repaired; parseRepairKind = r.repairKind || "";
    if (r.repairedText) captionText.value = r.repairedText;
    rawDirtyPending = false;
    rawStatus.textContent = r.repaired ? `Applied (${r.repairKind || 'repaired JSON'}).` : 'Applied.';
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
  const r = C.parseCaptionDoc(captionText.value, { repair: autoRepairJson.checked });
  if (r.doc) {
    doc = r.doc; plain = false; parseError = null; parseRepaired = r.repaired; parseRepairKind = r.repairKind || "";
    rawStatus.textContent = r.repaired ? `Valid after repair (${r.repairKind || 'JSON repair'}).` : 'Valid JSON.';
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
repairJsonBtn.addEventListener('click', () => {
  const fixed = C.repairJsonText(captionText.value);
  if (!fixed) { rawStatus.textContent = 'No safe repair found.'; rawStatus.className = 'raw-status error'; return; }
  captionText.value = fixed.text;
  rawDirtyPending = true;
  markDirty();
  rawStatus.textContent = fixed.kind ? `Repaired: ${fixed.kind}.` : 'Already valid JSON.';
  rawStatus.className = 'raw-status ok';
  tryApplyRaw();
});
convertBtn.addEventListener('click', () => {
  doc = C.ensureSkeleton(captionText.value);
  plain = false; parseError = null;
  undoStack = []; redoStack = [];
  markDirty();
  renderFieldsTop(); renderElements(); refreshIssues(); draw();
  setMessage('Converted to a structured caption template.');
});

/* ---------------- experimental AI edit ---------------- */
const DEFAULT_AI_PROMPT_TEMPLATE = `You edit Ideogram4 structured caption JSON for one image.

{response_format_instructions}

Visual inputs:
- original image = visual truth
- overlay image = current boxes/labels to fix or reference

Rules:
- Make only the requested change; preserve unrelated content.
- Bboxes are normalized grid coordinates, not pixels and not center/width/height.
- Active bbox format is {coordinate_format}, max {coordinate_max}; for Ideogram default this is [y_min, x_min, y_max, x_max].
- y values are vertical: top→bottom. x values are horizontal: left→right. Clamp to 0–{coordinate_max}; require y_min < y_max and x_min < x_max.
- If estimating from pixel xyxy, convert by image dimensions first: y=round(pixel_y/image_height*{coordinate_max}), x=round(pixel_x/image_width*{coordinate_max}), then output yxyx.
- Tight boxes are better than broad boxes; omit uncertain/diffuse boxes rather than guessing.
- For new obj elements include type, bbox, desc, and color_palette only if useful.
- For text elements include type="text", bbox, exact visible text, and desc; do not guess unreadable letters.
- Existing element field edits should use update_element with index and fields; set_field with element_index/field/value is accepted if needed.

Filename: {filename}
Selected element: {selected_element_summary}
Elements:
{element_summaries}
Validation issues: {validation_issues}

Current caption JSON:
{current_caption_json}

User request:
{user_request}`;

const aiEditRequest = $('aiEditRequest'), aiAskBtn = $('aiAskBtn'), aiApplyBtn = $('aiApplyBtn'), aiDiscardBtn = $('aiDiscardBtn');
const aiStatus = $('aiStatus'), aiRemoteWarning = $('aiRemoteWarning'), aiDiff = $('aiDiff'), aiRawWrap = $('aiRawWrap'), aiRawResponse = $('aiRawResponse');
const aiReview = $('aiReview'), aiBeforeCanvas = $('aiBeforeCanvas'), aiAfterCanvas = $('aiAfterCanvas'), aiChangeList = $('aiChangeList');
const aiSelectAllBtn = $('aiSelectAllBtn'), aiSelectNoneBtn = $('aiSelectNoneBtn');
const aiOverlayModal = $('aiOverlayModal'), aiOverlayBeforeCanvas = $('aiOverlayBeforeCanvas'), aiOverlayAfterCanvas = $('aiOverlayAfterCanvas'), aiOverlayTitle = $('aiOverlayTitle');
const aiOverlayZoomOut = $('aiOverlayZoomOut'), aiOverlayZoomIn = $('aiOverlayZoomIn'), aiOverlayFit = $('aiOverlayFit'), aiOverlayClose = $('aiOverlayClose'), aiOverlayZoomLabel = $('aiOverlayZoomLabel');
const aiEnabled = $('aiEnabled'), aiBaseUrl = $('aiBaseUrl'), aiEndpointPath = $('aiEndpointPath'), aiModel = $('aiModel'), aiResponseMode = $('aiResponseMode');
const aiMaxTokens = $('aiMaxTokens'), aiTemperature = $('aiTemperature'), aiTimeout = $('aiTimeout'), aiSendOriginal = $('aiSendOriginal');
const aiSendOverlay = $('aiSendOverlay'), aiAutoApply = $('aiAutoApply'), aiOverlayMax = $('aiOverlayMax');
const aiIncludeRawJson = $('aiIncludeRawJson'), aiIncludePrettyJson = $('aiIncludePrettyJson'), aiIncludePromptTemplate = $('aiIncludePromptTemplate');
const aiPromptTemplate = $('aiPromptTemplate'), aiResetPromptBtn = $('aiResetPromptBtn');
let pendingAiCaption = null;
let pendingAiBeforeCaption = null;
let pendingAiOps = null;
let aiOverlayState = { before: null, after: null, scale: 1, ox: 0, oy: 0, drag: null };

function aiSettingsFromUi() {
  return {
    base_url: aiBaseUrl.value.trim() || 'http://localhost:8080',
    endpoint_path: aiEndpointPath.value.trim() || '/v1/chat/completions',
    model: aiModel.value.trim() || 'local-model',
    max_tokens: Number(aiMaxTokens.value) || 8192,
    temperature: Number(aiTemperature.value) || 0.1,
    timeout_seconds: Number(aiTimeout.value) || 120,
    send_original_image: aiSendOriginal.checked,
    send_overlay_image: aiSendOverlay.checked,
    overlay_max_size: Number(aiOverlayMax.value) || 1400,
    include_raw_json: aiIncludeRawJson.checked,
    include_pretty_json: aiIncludePrettyJson.checked,
    include_current_prompt_template: aiIncludePromptTemplate.checked,
  };
}
function isLocalAiUrl() {
  try {
    const u = new URL(aiBaseUrl.value.trim() || 'http://localhost:8080', window.location.href);
    return ['localhost', '127.0.0.1', '::1'].includes(u.hostname);
  } catch (e) { return false; }
}
function updateAiRemoteWarning() { aiRemoteWarning.classList.toggle('hidden', isLocalAiUrl()); }
function saveAiPrefs() {
  const p = lastPrefs || {};
  p.ai = {
    enabled: aiEnabled.checked, baseUrl: aiBaseUrl.value, endpointPath: aiEndpointPath.value, model: aiModel.value,
    maxTokens: aiMaxTokens.value, temperature: aiTemperature.value, timeout: aiTimeout.value,
    sendOriginal: aiSendOriginal.checked, sendOverlay: aiSendOverlay.checked, autoApply: aiAutoApply.checked,
    overlayMax: aiOverlayMax.value, includeRawJson: aiIncludeRawJson.checked, includePrettyJson: aiIncludePrettyJson.checked,
    includePromptTemplate: aiIncludePromptTemplate.checked, responseMode: aiResponseMode.value, promptTemplate: aiPromptTemplate.value
  };
  lastPrefs = p;
  writePrefs();
}
function initAiPrefs() {
  const p = (lastPrefs && lastPrefs.ai) || {};
  aiPromptTemplate.value = p.promptTemplate || DEFAULT_AI_PROMPT_TEMPLATE;
  if (typeof p.enabled === 'boolean') aiEnabled.checked = p.enabled;
  if (p.baseUrl) aiBaseUrl.value = p.baseUrl;
  if (p.endpointPath) aiEndpointPath.value = p.endpointPath;
  if (p.model) aiModel.value = p.model;
  if (p.responseMode) aiResponseMode.value = p.responseMode;
  if (p.maxTokens) aiMaxTokens.value = p.maxTokens;
  if (p.temperature) aiTemperature.value = p.temperature;
  if (p.timeout) aiTimeout.value = p.timeout;
  if (typeof p.sendOriginal === 'boolean') aiSendOriginal.checked = p.sendOriginal;
  if (typeof p.sendOverlay === 'boolean') aiSendOverlay.checked = p.sendOverlay;
  if (typeof p.autoApply === 'boolean') aiAutoApply.checked = p.autoApply;
  if (p.overlayMax) aiOverlayMax.value = p.overlayMax;
  if (typeof p.includeRawJson === 'boolean') aiIncludeRawJson.checked = p.includeRawJson;
  if (typeof p.includePrettyJson === 'boolean') aiIncludePrettyJson.checked = p.includePrettyJson;
  if (typeof p.includePromptTemplate === 'boolean') aiIncludePromptTemplate.checked = p.includePromptTemplate;
  updateAiRemoteWarning();
}
function aiResponseFormatInstructions() {
  if (aiResponseMode.value === 'full') {
    return `IMPORTANT RESPONSE FORMAT:
Return ONLY one JSON object. First character must be { and last must be }.
Do not use markdown, code fences, comments, or explanation.
Return a complete edited caption JSON object. Preserve unrelated content.`;
  }
  return `IMPORTANT RESPONSE FORMAT:
Return ONLY one JSON object. First character must be { and last must be }.
Do not use markdown, code fences, comments, or explanation.
Prefer {"caption_edits":[...]} with only requested changes.
Use update_element/add_element/remove_element/set_field. Do not include unchanged or unrelated elements.
Full caption JSON is accepted only as a fallback.`;
}
function aiPromptForRequest() {
  const base = aiPromptTemplate.value || DEFAULT_AI_PROMPT_TEMPLATE;
  const instructions = aiResponseFormatInstructions();
  return base.includes('{response_format_instructions}')
    ? base.replaceAll('{response_format_instructions}', instructions)
    : instructions + '\n\n' + base;
}
function aiValidationIssues() {
  return doc ? C.validateDoc(doc, coordMax()).map((x) => `${x.label}: ${x.msg}`) : [];
}
function summarizeAiDiff(before, after) {
  const b = (before && C.getElements(before)) || [], a = (after && C.getElements(after)) || [];
  const lines = [];
  if (a.length > b.length) lines.push(`Added ${a.length - b.length} element(s).`);
  if (a.length < b.length) lines.push(`Removed ${b.length - a.length} element(s).`);
  const n = Math.min(a.length, b.length);
  let bboxChanged = 0, descChanged = 0, typeChanged = 0;
  for (let i = 0; i < n; i++) {
    if (JSON.stringify(a[i].bbox) !== JSON.stringify(b[i].bbox)) bboxChanged++;
    if (String(a[i].desc || '') !== String(b[i].desc || '')) descChanged++;
    if (String(a[i].type || '') !== String(b[i].type || '')) typeChanged++;
  }
  if (bboxChanged) lines.push(`Changed ${bboxChanged} bbox(es).`);
  if (descChanged) lines.push(`Changed ${descChanged} description(s).`);
  if (typeChanged) lines.push(`Changed ${typeChanged} element type(s).`);
  for (const k of ['high_level_description', 'style_description', 'compositional_deconstruction']) {
    if (JSON.stringify(before && before[k]) !== JSON.stringify(after && after[k]) && k !== 'compositional_deconstruction') lines.push(`Changed ${k}.`);
  }
  return lines.length ? lines.join('\n') : 'No obvious structural changes detected.';
}
function cloneJson(value) { return JSON.parse(JSON.stringify(value)); }
function aiElementLabel(el, i) {
  if (!el) return `element ${i + 1}`;
  const desc = String(el.desc || el.description || el.text || '').trim().replace(/\s+/g, ' ').slice(0, 90);
  return `#${i + 1} ${el.type || 'obj'}${desc ? ': ' + desc : ''}`;
}
function aiNonElementChanged(before, after) {
  if (!before || !after) return false;
  if (JSON.stringify(before.high_level_description) !== JSON.stringify(after.high_level_description)) return true;
  if (JSON.stringify(before.style_description) !== JSON.stringify(after.style_description)) return true;
  const bc = before.compositional_deconstruction || {}, ac = after.compositional_deconstruction || {};
  const stripElements = (obj) => {
    const copy = Object.assign({}, obj || {});
    delete copy.elements;
    return copy;
  };
  return JSON.stringify(stripElements(bc)) !== JSON.stringify(stripElements(ac));
}
function selectedAiChangeKeys() {
  return new Set(Array.from(aiChangeList.querySelectorAll('input[data-change-key]:checked')).map((el) => el.dataset.changeKey));
}
function mergeSelectedAiCaption(before, after) {
  if (!before || !after) return after;
  const selected = selectedAiChangeKeys();
  const merged = cloneJson(before);
  if (selected.has('top')) {
    if (Object.prototype.hasOwnProperty.call(after, 'high_level_description')) merged.high_level_description = cloneJson(after.high_level_description);
    if (Object.prototype.hasOwnProperty.call(after, 'style_description')) merged.style_description = cloneJson(after.style_description);
    if (after.compositional_deconstruction && typeof after.compositional_deconstruction === 'object') {
      if (!merged.compositional_deconstruction || typeof merged.compositional_deconstruction !== 'object') merged.compositional_deconstruction = {};
      for (const [k, v] of Object.entries(after.compositional_deconstruction)) {
        if (k !== 'elements') merged.compositional_deconstruction[k] = cloneJson(v);
      }
    }
  }
  const bEls = C.getElements(before) || [];
  const aEls = C.getElements(after) || [];
  const outEls = [];
  const n = Math.max(bEls.length, aEls.length);
  for (let i = 0; i < n; i++) {
    const b = bEls[i], a = aEls[i];
    if (b && a) outEls.push(selected.has('el-change-' + i) ? cloneJson(a) : cloneJson(b));
    else if (b && !a) { if (!selected.has('el-remove-' + i)) outEls.push(cloneJson(b)); }
    else if (!b && a) { if (selected.has('el-add-' + i)) outEls.push(cloneJson(a)); }
  }
  C.getElements(merged, { create: true }).splice(0, C.getElements(merged, { create: true }).length, ...outEls);
  return merged;
}
function drawCaptionOverlayAt(pctx, caption, geom, opts = {}) {
  const arr = (caption && C.getElements(caption)) || [];
  const labelFont = opts.labelFont || '700 11px system-ui';
  const lineWidth = opts.lineWidth || 2;
  pctx.textBaseline = 'top'; pctx.font = labelFont;
  for (let i = 0; i < arr.length; i++) {
    const r = C.bboxToRect(arr[i].bbox, order(), coordMax(), img.naturalWidth, img.naturalHeight);
    if (!r) continue;
    const color = C.colorForIndex(i);
    const x = geom.ox + r.left * geom.scale, y = geom.oy + r.top * geom.scale;
    const w = r.width * geom.scale, h = r.height * geom.scale;
    pctx.strokeStyle = color; pctx.lineWidth = lineWidth; pctx.strokeRect(x, y, w, h);
    const text = C.shortLabel(arr[i], i);
    const tw = Math.min(geom.width - x - 4, pctx.measureText(text).width + 8);
    const ly = Math.max(0, y - 15);
    pctx.fillStyle = color; pctx.fillRect(x, ly, Math.max(30, tw), 15);
    pctx.fillStyle = '#0c0e14'; pctx.fillText(text, x + 4, ly + 2);
  }
}
function elementDiffDetails(beforeEl, afterEl) {
  const fields = ['type', 'bbox', 'desc', 'description', 'text', 'color_palette'];
  const lines = [];
  for (const key of fields) {
    const bv = beforeEl ? beforeEl[key] : undefined;
    const av = afterEl ? afterEl[key] : undefined;
    if (JSON.stringify(bv) !== JSON.stringify(av)) {
      lines.push(`${key}: ${JSON.stringify(bv)} → ${JSON.stringify(av)}`);
    }
  }
  const extra = new Set([...Object.keys(beforeEl || {}), ...Object.keys(afterEl || {})]);
  for (const key of extra) {
    if (fields.includes(key)) continue;
    const bv = beforeEl ? beforeEl[key] : undefined;
    const av = afterEl ? afterEl[key] : undefined;
    if (JSON.stringify(bv) !== JSON.stringify(av)) lines.push(`${key}: ${JSON.stringify(bv)} → ${JSON.stringify(av)}`);
  }
  return lines;
}
function drawAiPreview(canvas, caption) {
  if (!canvas || !imgLoaded || !caption) return;
  const cssW = Math.max(220, canvas.clientWidth || 300), cssH = Math.max(160, canvas.clientHeight || 180);
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
  const pctx = canvas.getContext('2d');
  pctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  pctx.clearRect(0, 0, cssW, cssH);
  pctx.fillStyle = '#05070c'; pctx.fillRect(0, 0, cssW, cssH);
  const margin = 8;
  const scale = Math.min((cssW - margin * 2) / img.naturalWidth, (cssH - margin * 2) / img.naturalHeight);
  const ox = (cssW - img.naturalWidth * scale) / 2, oy = (cssH - img.naturalHeight * scale) / 2;
  pctx.drawImage(img, ox, oy, img.naturalWidth * scale, img.naturalHeight * scale);
  drawCaptionOverlayAt(pctx, caption, { ox, oy, scale, width: cssW, height: cssH });
}
function parseAiOpsFromRaw(raw) {
  let text = String(raw || '').trim();
  if (!text) return null;
  if (text.startsWith('```')) {
    const lines = text.split(/\r?\n/);
    if (lines.length >= 3 && ['```', '```json'].includes(lines[0].trim().toLowerCase()) && lines[lines.length - 1].trim() === '```') {
      text = lines.slice(1, -1).join('\n').trim();
    }
  }
  let obj = null;
  try { obj = JSON.parse(text); } catch (e) { return null; }
  const ops = obj && (obj.caption_edits || obj.edits || obj.operations);
  return Array.isArray(ops) ? ops.map(normalizeClientAiOp).filter(Boolean) : null;
}
function normalizeClientAiOp(op) {
  if (!op || typeof op !== 'object' || Array.isArray(op)) return null;
  if (op.op || op.type) return Object.assign({}, op, { op: String(op.op || op.type || '').toLowerCase() });
  const keys = ['update_element', 'add_element', 'remove_element', 'set_field', 'update', 'add', 'remove', 'set'].filter((k) => Object.prototype.hasOwnProperty.call(op, k));
  if (keys.length !== 1) return null;
  const key = keys[0], value = op[key];
  if ((key === 'add' || key === 'add_element') && value && typeof value === 'object') return { op: 'add_element', element: cloneJson(value) };
  if ((key === 'update' || key === 'update_element') && value && typeof value === 'object') return Object.assign({ op: 'update_element' }, cloneJson(value));
  if (key === 'remove' || key === 'remove_element') return { op: 'remove_element', index: Number.isInteger(value) ? value : value && value.index };
  if ((key === 'set' || key === 'set_field') && value && typeof value === 'object') {
    if (Number.isInteger(value.element_index) && typeof value.field === 'string') return { op: 'update_element', index: value.element_index, fields: { [value.field]: cloneJson(value.value) } };
    return Object.assign({ op: 'set_field' }, cloneJson(value));
  }
  return null;
}
function summarizeAiOps(ops) {
  const counts = { add: 0, update: 0, remove: 0, set: 0 };
  for (const op of ops || []) {
    const kind = String(op.op || '').toLowerCase();
    if (kind.includes('add')) counts.add++;
    else if (kind.includes('update') || kind.includes('modify')) counts.update++;
    else if (kind.includes('remove') || kind.includes('delete')) counts.remove++;
    else if (kind.includes('set')) counts.set++;
  }
  const lines = [];
  if (counts.add) lines.push(`Added ${counts.add} element(s).`);
  if (counts.update) lines.push(`Updated ${counts.update} element(s).`);
  if (counts.remove) lines.push(`Removed ${counts.remove} element(s).`);
  if (counts.set) lines.push(`Changed ${counts.set} non-element field(s).`);
  return lines.length ? lines.join('\n') : 'No edit operations returned.';
}
function renderAiChangeListFromOps(before, ops) {
  aiChangeList.innerHTML = '';
  const beforeEls = (before && C.getElements(before)) || [];
  const addItem = (key, title, detail, checked = true) => {
    const label = document.createElement('label');
    label.className = 'ai-change-item';
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = checked; cb.dataset.changeKey = key;
    const body = document.createElement('span');
    body.innerHTML = `${escapeText(title)}${detail ? `<span class="muted ai-change-detail">${escapeText(detail)}</span>` : ''}`;
    label.append(cb, body);
    aiChangeList.appendChild(label);
  };
  (ops || []).forEach((op, i) => {
    const key = 'op-' + i;
    const kind = String(op.op || '').toLowerCase();
    if (kind === 'add' || kind === 'add_element') addItem(key, `Add ${aiElementLabel(op.element, beforeEls.length + i)}`, `bbox=${JSON.stringify(op.element && op.element.bbox)}`);
    else if (kind === 'update' || kind === 'update_element' || kind === 'modify_element') addItem(key, `Update ${aiElementLabel(beforeEls[op.index], op.index)}`, Object.entries(op.fields || {}).map(([k, v]) => `${k}: ${JSON.stringify(beforeEls[op.index] && beforeEls[op.index][k])} → ${JSON.stringify(v)}`).join('\n'));
    else if (kind === 'remove' || kind === 'remove_element' || kind === 'delete_element') addItem(key, `Remove ${aiElementLabel(beforeEls[op.index], op.index)}`, `index=${op.index}`);
    else if (kind === 'set' || kind === 'set_field') addItem(key, `Set ${Array.isArray(op.path) ? op.path.join('.') : op.path}`, `value=${JSON.stringify(op.value)}`);
  });
  if (!aiChangeList.children.length) {
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.textContent = 'No edit operations detected.';
    aiChangeList.appendChild(empty);
  }
}
function mergeSelectedAiOps(before, ops) {
  const selected = selectedAiChangeKeys();
  const merged = cloneJson(before);
  const elems = C.getElements(merged, { create: true });
  const removals = [];
  (ops || []).forEach((op, i) => {
    if (!selected.has('op-' + i)) return;
    const kind = String(op.op || '').toLowerCase();
    if ((kind === 'add' || kind === 'add_element') && op.element) {
      const at = Number.isInteger(op.index) ? Math.max(0, Math.min(elems.length, op.index)) : elems.length;
      elems.splice(at, 0, cloneJson(op.element));
    } else if ((kind === 'update' || kind === 'update_element' || kind === 'modify_element') && Number.isInteger(op.index) && elems[op.index] && op.fields) {
      Object.assign(elems[op.index], cloneJson(op.fields));
    } else if ((kind === 'remove' || kind === 'remove_element' || kind === 'delete_element') && Number.isInteger(op.index)) {
      removals.push(op.index);
    } else if ((kind === 'set' || kind === 'set_field') && Number.isInteger(op.element_index) && typeof op.field === 'string' && elems[op.element_index]) {
      elems[op.element_index][op.field] = cloneJson(op.value);
    } else if ((kind === 'set' || kind === 'set_field') && op.path) {
      const parts = Array.isArray(op.path) ? op.path : String(op.path).split('.').filter(Boolean);
      if (!parts.includes('elements')) {
        let cur = merged;
        for (const part of parts.slice(0, -1)) {
          if (!cur[part] || typeof cur[part] !== 'object') cur[part] = {};
          cur = cur[part];
        }
        cur[parts[parts.length - 1]] = cloneJson(op.value);
      }
    }
  });
  for (const idx of [...new Set(removals)].sort((a, b) => b - a)) if (idx >= 0 && idx < elems.length) elems.splice(idx, 1);
  return merged;
}
function renderAiChangeList(before, after) {
  aiChangeList.innerHTML = '';
  const addItem = (key, title, detail, checked = true) => {
    const label = document.createElement('label');
    label.className = 'ai-change-item';
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = checked; cb.dataset.changeKey = key;
    const body = document.createElement('span');
    body.innerHTML = `${escapeText(title)}${detail ? `<span class="muted ai-change-detail">${escapeText(detail)}</span>` : ''}`;
    label.append(cb, body);
    aiChangeList.appendChild(label);
  };
  if (aiNonElementChanged(before, after)) addItem('top', 'High-level/style/background fields changed', 'Apply non-element caption field changes.');
  const b = (before && C.getElements(before)) || [], a = (after && C.getElements(after)) || [];
  const n = Math.max(b.length, a.length);
  for (let i = 0; i < n; i++) {
    if (b[i] && a[i] && JSON.stringify(b[i]) !== JSON.stringify(a[i])) addItem('el-change-' + i, `Changed ${aiElementLabel(a[i], i)}`, elementDiffDetails(b[i], a[i]).join('\n'));
    else if (!b[i] && a[i]) addItem('el-add-' + i, `Added ${aiElementLabel(a[i], i)}`, `bbox=${JSON.stringify(a[i].bbox)}`);
    else if (b[i] && !a[i]) addItem('el-remove-' + i, `Removed ${aiElementLabel(b[i], i)}`, `Original bbox=${JSON.stringify(b[i].bbox)}`);
  }
  if (!aiChangeList.children.length) {
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.textContent = 'No element-level differences detected.';
    aiChangeList.appendChild(empty);
  }
}
function fitAiOverlayModal() {
  if (!imgLoaded || !aiOverlayState.before || !aiOverlayState.after) return;
  const rect = aiOverlayBeforeCanvas.getBoundingClientRect();
  const margin = 32;
  aiOverlayState.scale = Math.min((rect.width - margin) / img.naturalWidth, (rect.height - margin) / img.naturalHeight);
  aiOverlayState.scale = Math.max(0.02, Math.min(32, aiOverlayState.scale));
  aiOverlayState.ox = (rect.width - img.naturalWidth * aiOverlayState.scale) / 2;
  aiOverlayState.oy = (rect.height - img.naturalHeight * aiOverlayState.scale) / 2;
  drawAiOverlayModal();
}
function drawAiOverlayModal() {
  if (aiOverlayModal.classList.contains('hidden') || !imgLoaded || !aiOverlayState.before || !aiOverlayState.after) return;
  const dpr = window.devicePixelRatio || 1;
  const drawPane = (canvas, caption) => {
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    const mctx = canvas.getContext('2d');
    mctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    mctx.clearRect(0, 0, rect.width, rect.height);
    mctx.fillStyle = '#05070c'; mctx.fillRect(0, 0, rect.width, rect.height);
    mctx.imageSmoothingEnabled = aiOverlayState.scale < 2.5;
    mctx.drawImage(img, aiOverlayState.ox, aiOverlayState.oy, img.naturalWidth * aiOverlayState.scale, img.naturalHeight * aiOverlayState.scale);
    drawCaptionOverlayAt(mctx, caption, {
      ox: aiOverlayState.ox, oy: aiOverlayState.oy, scale: aiOverlayState.scale,
      width: rect.width, height: rect.height
    }, { labelFont: '700 13px system-ui', lineWidth: 2.5 });
  };
  drawPane(aiOverlayBeforeCanvas, aiOverlayState.before);
  drawPane(aiOverlayAfterCanvas, aiOverlayState.after);
  aiOverlayZoomLabel.textContent = Math.round(aiOverlayState.scale * 100) + '%';
}
function openAiOverlayModal() {
  if (!pendingAiBeforeCaption || !pendingAiCaption || !imgLoaded) return;
  aiOverlayState = { before: pendingAiBeforeCaption, after: pendingAiCaption, scale: 1, ox: 0, oy: 0, drag: null };
  aiOverlayTitle.textContent = 'AI Edit before/after overlay comparison';
  aiOverlayModal.classList.remove('hidden');
  requestAnimationFrame(fitAiOverlayModal);
}
function closeAiOverlayModal() {
  aiOverlayModal.classList.add('hidden');
  aiOverlayState.drag = null;
  aiOverlayBeforeCanvas.classList.remove('dragging');
  aiOverlayAfterCanvas.classList.remove('dragging');
}
function zoomAiOverlay(factor, center) {
  if (!aiOverlayState.before || !aiOverlayState.after) return;
  const rect = aiOverlayBeforeCanvas.getBoundingClientRect();
  const p = center || { x: rect.width / 2, y: rect.height / 2 };
  const ix = (p.x - aiOverlayState.ox) / aiOverlayState.scale;
  const iy = (p.y - aiOverlayState.oy) / aiOverlayState.scale;
  aiOverlayState.scale = Math.max(0.02, Math.min(32, aiOverlayState.scale * factor));
  aiOverlayState.ox = p.x - ix * aiOverlayState.scale;
  aiOverlayState.oy = p.y - iy * aiOverlayState.scale;
  drawAiOverlayModal();
}
function renderAiReview(before, after, ops = null) {
  if (!before || !after) { aiReview.classList.add('hidden'); return; }
  if (ops && ops.length) renderAiChangeListFromOps(before, ops);
  else renderAiChangeList(before, after);
  aiReview.classList.remove('hidden');
  requestAnimationFrame(() => { drawAiPreview(aiBeforeCanvas, before); drawAiPreview(aiAfterCanvas, after); });
}
function applyAiCaption(caption) {
  if (!caption) return;
  pushUndoMaybe();
  doc = cloneJson(caption);
  plain = false; parseError = null; parseRepaired = false; parseRepairKind = '';
  rawDirtyPending = false;
  markDirty();
  renderFieldsTop(); renderElements(); refreshIssues();
  if (activeTab === 'raw') syncRawFromDoc();
  draw();
  setMessage('Applied AI result as an unsaved edit.');
}
function applySelectedAiChanges() {
  if (!pendingAiCaption) return;
  applyAiCaption(pendingAiOps && pendingAiOps.length ? mergeSelectedAiOps(pendingAiBeforeCaption, pendingAiOps) : mergeSelectedAiCaption(pendingAiBeforeCaption, pendingAiCaption));
}
async function askAiEdit() {
  if (!aiEnabled.checked) { aiStatus.textContent = 'AI Edit is disabled.'; aiStatus.className = 'raw-status error'; return; }
  if (!activeRel || !doc) { aiStatus.textContent = 'Open a structured caption first.'; aiStatus.className = 'raw-status error'; return; }
  const reqText = aiEditRequest.value.trim();
  if (!reqText) { aiStatus.textContent = 'Enter an edit request.'; aiStatus.className = 'raw-status error'; return; }
  updateAiRemoteWarning(); saveAiPrefs(); pendingAiCaption = null; pendingAiBeforeCaption = null; pendingAiOps = null;
  aiApplyBtn.classList.add('hidden'); aiDiscardBtn.classList.add('hidden'); aiDiff.classList.add('hidden'); aiRawWrap.classList.add('hidden'); aiReview.classList.add('hidden');
  aiAskBtn.disabled = true; aiStatus.textContent = 'Asking local model…'; aiStatus.className = 'raw-status';
  const before = cloneJson(doc);
  try {
    const res = await fetch('/api/ai-edit-caption', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image_path: activeRel, caption: doc, user_request: reqText, coordinate_format: order(), coordinate_max: coordMax(),
        selected_element_index: selectedIdx, validation_issues: aiValidationIssues(), settings: aiSettingsFromUi(),
        prompt_template: aiPromptForRequest()
      })
    });
    const out = await res.json();
    aiRawResponse.value = out.raw_model_response || '';
    aiRawWrap.classList.toggle('hidden', !out.raw_model_response);
    if (!out.ok) {
      const details = out.validation && Array.isArray(out.validation.errors) && out.validation.errors.length ? ': ' + out.validation.errors.join('; ') : '';
      throw new Error((out.error || 'AI edit failed') + details);
    }
    pendingAiCaption = out.caption;
    pendingAiBeforeCaption = before;
    pendingAiOps = out.debug && out.debug.response_mode === 'ops' ? parseAiOpsFromRaw(out.raw_model_response) : null;
    const modeLabel = out.debug && out.debug.response_mode ? ` (${out.debug.response_mode})` : '';
    aiStatus.textContent = (out.validation && out.validation.valid ? 'Received valid AI-edited caption' : 'Received AI result') + modeLabel + '.';
    aiStatus.className = 'raw-status ok';
    aiDiff.textContent = pendingAiOps && pendingAiOps.length ? summarizeAiOps(pendingAiOps) : summarizeAiDiff(before, pendingAiCaption);
    aiDiff.classList.remove('hidden');
    renderAiReview(before, pendingAiCaption, pendingAiOps);
    aiDiscardBtn.classList.remove('hidden');
    if (aiAutoApply.checked) applyAiCaption(pendingAiCaption);
    else aiApplyBtn.classList.remove('hidden');
  } catch (e) {
    aiStatus.textContent = e.message;
    aiStatus.className = 'raw-status error';
  } finally {
    aiAskBtn.disabled = false;
  }
}
aiAskBtn.addEventListener('click', askAiEdit);
aiApplyBtn.addEventListener('click', () => { applySelectedAiChanges(); aiApplyBtn.classList.add('hidden'); });
aiDiscardBtn.addEventListener('click', () => { pendingAiCaption = null; pendingAiBeforeCaption = null; pendingAiOps = null; aiApplyBtn.classList.add('hidden'); aiDiscardBtn.classList.add('hidden'); aiDiff.classList.add('hidden'); aiReview.classList.add('hidden'); aiStatus.textContent = 'AI result discarded.'; });
aiSelectAllBtn.addEventListener('click', () => { for (const cb of aiChangeList.querySelectorAll('input[type=checkbox]')) cb.checked = true; });
aiSelectNoneBtn.addEventListener('click', () => { for (const cb of aiChangeList.querySelectorAll('input[type=checkbox]')) cb.checked = false; });
aiBeforeCanvas.addEventListener('click', openAiOverlayModal);
aiAfterCanvas.addEventListener('click', openAiOverlayModal);
aiOverlayClose.addEventListener('click', closeAiOverlayModal);
aiOverlayFit.addEventListener('click', fitAiOverlayModal);
aiOverlayZoomIn.addEventListener('click', () => zoomAiOverlay(1.25));
aiOverlayZoomOut.addEventListener('click', () => zoomAiOverlay(0.8));
for (const modalCanvas of [aiOverlayBeforeCanvas, aiOverlayAfterCanvas]) {
  modalCanvas.addEventListener('dblclick', fitAiOverlayModal);
  modalCanvas.addEventListener('wheel', (ev) => { ev.preventDefault(); const r = modalCanvas.getBoundingClientRect(); zoomAiOverlay(ev.deltaY < 0 ? 1.12 : 0.89, { x: ev.clientX - r.left, y: ev.clientY - r.top }); }, { passive: false });
  modalCanvas.addEventListener('pointerdown', (ev) => { if (!aiOverlayState.before || !aiOverlayState.after) return; aiOverlayState.drag = { x: ev.clientX, y: ev.clientY, ox: aiOverlayState.ox, oy: aiOverlayState.oy }; modalCanvas.setPointerCapture(ev.pointerId); aiOverlayBeforeCanvas.classList.add('dragging'); aiOverlayAfterCanvas.classList.add('dragging'); });
  modalCanvas.addEventListener('pointermove', (ev) => { const d = aiOverlayState.drag; if (!d) return; aiOverlayState.ox = d.ox + ev.clientX - d.x; aiOverlayState.oy = d.oy + ev.clientY - d.y; drawAiOverlayModal(); });
  modalCanvas.addEventListener('pointerup', () => { aiOverlayState.drag = null; aiOverlayBeforeCanvas.classList.remove('dragging'); aiOverlayAfterCanvas.classList.remove('dragging'); });
  modalCanvas.addEventListener('pointercancel', () => { aiOverlayState.drag = null; aiOverlayBeforeCanvas.classList.remove('dragging'); aiOverlayAfterCanvas.classList.remove('dragging'); });
}
aiResetPromptBtn.addEventListener('click', () => { aiPromptTemplate.value = DEFAULT_AI_PROMPT_TEMPLATE; saveAiPrefs(); });
window.addEventListener('resize', () => { if (!aiOverlayModal.classList.contains('hidden')) drawAiOverlayModal(); });
for (const el of [aiEnabled, aiBaseUrl, aiEndpointPath, aiModel, aiResponseMode, aiMaxTokens, aiTemperature, aiTimeout, aiSendOriginal, aiSendOverlay, aiAutoApply, aiOverlayMax, aiIncludeRawJson, aiIncludePrettyJson, aiIncludePromptTemplate, aiPromptTemplate]) {
  el.addEventListener('change', () => { updateAiRemoteWarning(); saveAiPrefs(); });
  el.addEventListener('input', debounce(() => { updateAiRemoteWarning(); saveAiPrefs(); }, 300));
}

/* ---------------- save ---------------- */
function buildSaveText() {
  if (doc && (activeTab === 'fields' || !rawDirtyPending)) {
    return C.serializeDoc(doc, saveFormat.value !== 'minified');
  }
  return captionText.value;
}

async function removeActivePair(mode) {
  if (!activeRel) return;
  const verb = mode === 'delete' ? 'permanently delete' : 'move to removed/';
  const detail = mode === 'delete'
    ? 'This deletes the image and matching .txt caption from disk.'
    : 'This moves the image and matching .txt caption to the removed/ subfolder and drops review tracking.';
  if (dirty && !confirm('Caption has unsaved changes. Discard them and ' + verb + ' this pair?')) return;
  if (!confirm(detail + '\n\nContinue for ' + activeRel + '?')) return;

  const currentRel = activeRel;
  const currentIndex = activeIndex;
  const res = await fetch('/api/remove-pair', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rel: currentRel, mode })
  });
  const out = await res.json();
  if (out.error) { setMessage(out.error, true); return; }

  dirty = false; rawDirtyPending = false; updateDirtyUi(); activeRel = null; activeIndex = -1;
  setCaptionState('');
  imgLoaded = false;
  bImgLoaded = false; bText = ''; bDoc = null;
  draw(); bDraw();
  setMessage(mode === 'delete' ? 'Pair deleted and untracked.' : 'Pair moved to removed/ and untracked.');
  await refreshList(false);
  const next = items[Math.min(currentIndex, items.length - 1)];
  if (next) {
    await loadItem(next.rel);
  } else {
    activeName.textContent = 'No item loaded';
    captionPath.textContent = '';
    emptyState.classList.remove('hidden');
    reviewView.classList.add('hidden');
  }
}

async function saveCaption(markFixed = false) {
  if (!activeRel) return;
  const text = buildSaveText();
  const res = await fetch('/api/save-caption', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rel: activeRel, caption: text, mark_fixed: markFixed, backup: backupOriginals.checked, manual_palette_bboxes: manualPaletteList() })
  });
  const out = await res.json();
  if (out.error) { setMessage(out.error, true); return; }
  dirty = false; rawDirtyPending = false; updateDirtyUi();
  originalText = text;
  if (doc) captionText.value = text;
  const backupNote = out.backup ? ' Original backed up.' : '';
  setMessage((markFixed ? 'Saved and marked fixed.' : 'Saved.') + backupNote);
  await refreshList(true);
  if (markFixed) updateButtons('fixed');
}

async function saveAndNext(markFixed = false) {
  if (!activeRel) return;
  await saveCaption(markFixed);
  if (!dirty) move(1);   // saveCaption clears dirty on success; only advance then
}

/* ---------------- keyboard ---------------- */
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && aiOverlayModal && !aiOverlayModal.classList.contains('hidden')) { closeAiOverlayModal(); ev.preventDefault(); return; }
  if (ev.key === ' ' && !ev.target.matches('input, textarea, select, button')) {
    spaceHeld = true;
    setCanvasCursor(lastPointer);
    ev.preventDefault();
    return;
  }
  if (ev.ctrlKey || ev.metaKey) {
    const k = ev.key.toLowerCase();
    if (k === 's') { ev.preventDefault(); saveCaption(false); }
    else if (k === 'p') { ev.preventDefault(); setDrawer(browseDrawer, true); searchBox.focus(); searchBox.select(); }
    else if (k === 'enter') { ev.preventDefault(); saveAndNext(false); }
    else if (k === 'z') { ev.preventDefault(); ev.shiftKey ? redo() : undo(); }
    else if (k === 'y') { ev.preventDefault(); redo(); }
    return;
  }
  if (ev.target.matches('input, textarea, select, button') || ev.target.isContentEditable) {
    if (ev.key === 'Escape') ev.target.blur();
    lastKeyWasArrow = false;
    return;
  }
  const map = { '1': 'excellent', '2': 'good_enough', '3': 'needs_work', '4': 'bad', '5': 'terrible', '6': 'fixed' };
  const k = ev.key;
  if (map[k]) { setStatus(map[k]); }
  else if (k === '[') { move(ev.shiftKey ? -10 : -1); }
  else if (k === ']') { move(ev.shiftKey ? 10 : 1); }
  else if (k === 'Home') { ev.preventDefault(); jumpToVisibleIndex(0); }
  else if (k === 'End') { ev.preventDefault(); jumpToVisibleIndex(visibleItems().length - 1); }
  else if (k === 'PageUp') { ev.preventDefault(); move(-10); }
  else if (k === 'PageDown') { ev.preventDefault(); move(10); }
  else if (k === 'n' || k === 'N') { moveToNextUnrated(); }
  else if (k === 'v' || k === 'V') { setMode('select'); }
  else if (k === 'b' || k === 'B') { drawSticky = true; setMode('draw'); }
  else if (k === 'p' || k === 'P') { startPalettePick(); }
  else if (k === 'a' || k === 'A') { autofillSelectedPalette(); }
  else if (k === 'f' || k === 'F') { ev.preventDefault(); fitView(); draw(); }
  else if (k === 'Escape') {
    if (anyDrawerOpen()) closeDrawers();
    else if (mode === 'draw' || mode === 'pickColor') setMode('select');
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
openFolderBtn.addEventListener('click', () => openFolder());
pickFolderBtn.addEventListener('click', pickFolder);
targetFolder.addEventListener('keydown', (e) => { if (e.key === 'Enter') openFolder(); });
statusFilter.addEventListener('change', () => { refreshList(false); savePrefs(); });
sortBy.addEventListener('change', () => { refreshList(true); savePrefs(); });
recursive.addEventListener('change', () => { refreshList(true); savePrefs(); });
searchBox.addEventListener('input', () => { renderList(); savePrefs(); });
ratingButtons.addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-status]');
  if (btn) setStatus(btn.dataset.status);
});
clearStatusBtn.addEventListener('click', clearStatus);
nextJsonIssueBtn.addEventListener('click', () => moveToNextProblem('json'));
nextBoxIssueBtn.addEventListener('click', () => moveToNextProblem('box'));
nextMissingCaptionBtn.addEventListener('click', () => moveToNextProblem('missing'));
autofillPaletteBtn.addEventListener('click', (ev) => { ev.shiftKey ? autofillAllPalettes() : autofillSelectedPalette(); });
pickPaletteBtn.addEventListener('click', startPalettePick);
stripPaletteBtn.addEventListener('click', stripSelectedPalette);
stripAllPalettesBtn.addEventListener('click', () => { if (confirm('Remove color_palette from every element in this caption?')) stripAllPalettes(); });
batchAutofillPalettesBtn.addEventListener('click', () => batchAutofillPalettes().catch((e) => setMessage(e.message || String(e), true)));
batchRepairJsonBtn.addEventListener('click', () => batchRepairJson().catch((e) => setMessage(e.message || String(e), true)));
saveCaptionBtn.addEventListener('click', () => saveCaption(false));
saveNextBtn.addEventListener('click', () => saveAndNext(false));
saveFixedBtn.addEventListener('click', () => saveCaption(true));
advanceOnRate.addEventListener('change', savePrefs);
autoRepairJson.addEventListener('change', savePrefs);
removePairBtn.addEventListener('click', () => removeActivePair('move'));
deletePairBtn.addEventListener('click', () => removeActivePair('delete'));
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
  el.addEventListener('change', () => { draw(); bDraw(); savePrefs(); });
}
bboxFormat.addEventListener('change', () => { relabelCoordInputs(); refreshIssues(); draw(); bDraw(); savePrefs(); });
bboxCoordMax.addEventListener('change', () => { refreshIssues(); draw(); bDraw(); savePrefs(); });
saveFormat.addEventListener('change', savePrefs);
backupOriginals.addEventListener('change', savePrefs);
window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

function refitPrimaryCanvas() {
  resizeCanvas();
  fitView();
  draw();
}
function refitCanvasesAfterLayoutChange() {
  const delays = [0, 80, 220];
  for (const delay of delays) {
    setTimeout(() => {
      refitPrimaryCanvas();
      if (compareActive) { bResize(); bFit(); bDraw(); }
    }, delay);
  }
}
const ro = new ResizeObserver(() => { refitPrimaryCanvas(); });
ro.observe(imageWrap);

/* ---------------- drawers (collapsible side panels) ---------------- */
function updateLayoutClasses() {
  document.body.classList.toggle('browse-open', browseDrawer.classList.contains('open'));
  document.body.classList.toggle('editor-open', editorDrawer.classList.contains('open'));
  requestAnimationFrame(() => { resizeCanvas(); fitView(); draw(); bResize(); bDraw(); savePrefs(); });
}
function setDrawer(el, open) { el.classList.toggle('open', open); updateLayoutClasses(); }
function toggleDrawer(el) { setDrawer(el, !el.classList.contains('open')); }
function anyDrawerOpen() { return browseDrawer.classList.contains('open') || editorDrawer.classList.contains('open'); }
function closeDrawers() { setDrawer(browseDrawer, false); setDrawer(editorDrawer, false); }
browseToggle.addEventListener('click', () => toggleDrawer(browseDrawer));
editorToggle.addEventListener('click', () => toggleDrawer(editorDrawer));
browseClose.addEventListener('click', () => setDrawer(browseDrawer, false));
editorClose.addEventListener('click', () => setDrawer(editorDrawer, false));
posIndicator.addEventListener('click', promptJumpToIndex);

/* ---------------- floating per-box caption tooltip ---------------- *
 * Shared by both canvases: hover a box to read that object's full caption
 * without opening the editor. Positioned at the cursor, flips near edges.   */
function descOf(el) { return el ? String(el.desc || el.description || '') : ''; }
function showBoxTip(clientX, clientY, el, idx) {
  if (!el) { hideBoxTip(); return; }
  const type = el.type ? String(el.type) : 'box';
  const desc = descOf(el);
  const coords = Array.isArray(el.bbox) ? `[${el.bbox.join(', ')}]` : '';
  boxTip.innerHTML =
    `<div class="tip-label">${escapeText((idx + 1) + ' \u00b7 ' + type)}</div>` +
    (desc ? `<div class="tip-desc">${escapeText(desc)}</div>` : '<div class="tip-desc muted">(no description)</div>') +
    (coords ? `<div class="tip-coords">${escapeText(coords)}</div>` : '');
  boxTip.style.borderLeftColor = C.colorForIndex(idx);
  boxTip.classList.remove('hidden');
  const pad = 14;
  const tw = boxTip.offsetWidth, th = boxTip.offsetHeight;
  let x = clientX + pad, y = clientY + pad;
  if (x + tw + 6 > window.innerWidth) x = clientX - tw - pad;
  if (y + th + 6 > window.innerHeight) y = clientY - th - pad;
  boxTip.style.left = Math.max(6, x) + 'px';
  boxTip.style.top = Math.max(6, y) + 'px';
}
function hideBoxTip() { boxTip.classList.add('hidden'); }

/* ===================== compare mode (second folder) ===================== *
 * The A side above stays the full editor. This adds a read-only B side that
 * shows the matched image (with its boxes drawn) and caption from a second
 * folder, plus a manual-match override and a "copy B into the A editor" action.
 * Matching is done on the backend (name -> bytes -> perceptual hash).        */
const compareFolder = $('compareFolder'), compareRecursive = $('compareRecursive');
const compareMaxDist = $('compareMaxDist'), loadCompareBtn = $('loadCompare'), clearCompareBtn = $('clearCompare');
const compareFilter = $('compareFilter'), compareSummary = $('compareSummary');
const comparePane = $('comparePane'), cmpMatchInfo = $('cmpMatchInfo');
const bImageWrap = $('bImageWrap'), bCanvas = $('bCanvas');
const bctx = bCanvas.getContext('2d');
const bFitBtn = $('bFitBtn'), bCaptionPath = $('bCaptionPath');
const bCaptionText = $('bCaptionText'), bCaptionEmpty = $('bCaptionEmpty');
const copyBtoABtn = $('copyBtoA'), bPickToggle = $('bPickToggle'), bPickWrap = $('bPickWrap');
const bPickSearch = $('bPickSearch'), bPickList = $('bPickList'), bPickClear = $('bPickClear');

let compareActive = false;
let compareRoot = '';
let matchMap = {};            // a_rel -> { b_rel, method, distance }
let bImages = [];             // [{ rel, filename }] for the manual picker
let compareOverrides = {};    // { [compareRoot]: { [a_rel]: b_rel } }
let bText = '', bDoc = null;
let bImg = new Image(), bImgLoaded = false;
let bView = { scale: 1, ox: 0, oy: 0 };
let bDrag = null;
let bHoverIdx = -1;

/* manual overrides persist locally, keyed by compare-folder path */
function loadOverrides() {
  try { compareOverrides = JSON.parse(localStorage.getItem('caption_reviewer_compare_overrides') || '{}'); }
  catch (e) { compareOverrides = {}; }
}
function saveOverrides() {
  localStorage.setItem('caption_reviewer_compare_overrides', JSON.stringify(compareOverrides));
}
function overrideFor(aRel) {
  const m = compareOverrides[compareRoot];
  return (m && m[aRel]) || '';
}
function setOverride(aRel, bRel) {
  if (!compareOverrides[compareRoot]) compareOverrides[compareRoot] = {};
  if (bRel) compareOverrides[compareRoot][aRel] = bRel;
  else delete compareOverrides[compareRoot][aRel];
  saveOverrides();
}

/* Switch the stage between single-canvas (A) and side-by-side (A | B).
 * A's column changes width when B appears/disappears, so refit A once here
 * rather than on every B item load. */
function applyCompareLayout(on) {
  bCol.classList.toggle('hidden', !on);
  comparePane.classList.toggle('hidden', !on);   // B caption block in the editor drawer
  reviewView.classList.toggle('comparing', on);
  resizeCanvas(); fitView(); draw();
  if (on) bResize();
}

function resetCompareForNewFolder() {
  compareActive = false;
  matchMap = {}; bImages = []; compareRoot = '';
  applyCompareLayout(false);
  clearCompareBtn.classList.add('hidden');
  bPickWrap.classList.add('hidden');
  compareSummary.textContent = 'No compare folder loaded.';
  bText = ''; bDoc = null; bImgLoaded = false; bHoverIdx = -1;
}

async function loadCompareFolder() {
  const folder = compareFolder.value.trim();
  if (!folder) return;
  loadCompareBtn.disabled = true;
  loadCompareBtn.textContent = 'Matching\u2026';
  try {
    const res = await fetch('/api/open-compare-folder', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        compare_folder: folder,
        recursive: compareRecursive.checked,
        a_recursive: recursive.checked,
        max_distance: Number(compareMaxDist.value) || 12
      })
    });
    const out = await res.json();
    if (out.error) throw new Error(out.error);
    compareActive = true;
    compareRoot = out.compare_root;
    matchMap = out.matches || {};
    bImages = out.b_images || [];
    clearCompareBtn.classList.remove('hidden');
    applyCompareLayout(true);
    renderCompareSummary(out.summary, out.have_pil, out.max_distance);
    renderList();
    if (activeRel) await loadCompareItem(activeRel);
  } catch (e) {
    alert('Compare error: ' + e.message);
  } finally {
    loadCompareBtn.disabled = false;
    loadCompareBtn.textContent = 'Load compare folder';
  }
}

function renderCompareSummary(s, havePil, maxDist) {
  if (!s) { compareSummary.textContent = ''; return; }
  const bm = s.by_method || {};
  const how = [];
  if (bm.name) how.push(`${bm.name} by name`);
  if (bm.bytes) how.push(`${bm.bytes} by bytes`);
  if (bm.phash) how.push(`${bm.phash} by image`);
  let txt = `${s.matched} matched` + (how.length ? ` (${how.join(', ')})` : '') +
            ` \u00b7 ${s.a_only} only here \u00b7 ${s.b_only} only in B`;
  txt += havePil
    ? ` \u00b7 image matching on (dist \u2264 ${maxDist})`
    : ' \u00b7 image matching off \u2014 install Pillow to match renamed/resized files';
  compareSummary.textContent = txt;
}

async function clearCompare() {
  resetCompareForNewFolder();
  bDraw();
  try { await fetch('/api/compare-clear', { method: 'POST' }); } catch (e) { /* ignore */ }
  renderList();
}

function showComparePane() {
  if (!compareActive) return;
  bCol.classList.remove('hidden');
  comparePane.classList.remove('hidden');
  bResize();
}

async function loadCompareItem(aRel) {
  if (!compareActive) return;
  showComparePane();
  const ov = overrideFor(aRel);
  const url = '/api/compare-item?rel=' + encodeURIComponent(aRel) +
              (ov ? '&b_rel=' + encodeURIComponent(ov) : '');
  let out;
  try { out = await (await fetch(url)).json(); }
  catch (e) { out = { matched: false }; }

  bPickWrap.classList.add('hidden');
  bPickClear.classList.toggle('hidden', !ov);

  if (!out || !out.matched) {
    cmpMatchInfo.textContent = ov ? 'manual match not found in B' : 'no match in B';
    bCaptionPath.textContent = '';
    bCaptionEmpty.textContent = ov
      ? 'The manually chosen file is missing. Pick another, or clear the manual match.'
      : 'No matching image in the compare folder. Use \u201cPick match\u2026\u201d to choose one.';
    bCaptionEmpty.classList.remove('hidden');
    bCaptionText.classList.add('hidden');
    bText = ''; bDoc = null;
    copyBtoABtn.disabled = true;
    bImgLoaded = false; bDraw();
    return;
  }

  const tag = out.overridden ? 'manual match'
    : out.method === 'name' ? 'matched by name'
    : out.method === 'bytes' ? 'matched by bytes (renamed)'
    : `matched by image (distance ${out.distance})`;
  cmpMatchInfo.textContent = `${out.b_filename} \u00b7 ${tag}`;
  bCaptionPath.textContent = out.b_caption_path || '';

  bText = out.b_caption || '';
  const r = C.parseCaptionDoc(bText);
  bDoc = r.doc;
  bCaptionEmpty.classList.add('hidden');
  bCaptionText.classList.remove('hidden');
  bCaptionText.value = out.b_caption_exists
    ? (bDoc ? C.serializeDoc(bDoc, true) : bText)
    : '(no caption file next to this image)';
  copyBtoABtn.disabled = !out.b_caption_exists;

  bImgLoaded = false; bDraw();
  const next = new Image();
  next.onload = () => { bImg = next; bImgLoaded = true; bResize(); bFit(); bDraw(); };
  next.onerror = () => { bImgLoaded = false; bDraw(); };
  next.src = out.b_image_url + '?t=' + Date.now();
}

/* read-only B viewer (pan / zoom / fit; boxes drawn, no editing) */
function bResize() {
  const dpr = window.devicePixelRatio || 1;
  const cw = bImageWrap.clientWidth, ch = bImageWrap.clientHeight;
  bCanvas.width = Math.max(1, Math.round(cw * dpr));
  bCanvas.height = Math.max(1, Math.round(ch * dpr));
  bCanvas.style.width = cw + 'px';
  bCanvas.style.height = ch + 'px';
}
function bFit() {
  if (!bImgLoaded) return;
  const m = 12;
  const cw = bImageWrap.clientWidth, ch = bImageWrap.clientHeight;
  const s = Math.min((cw - 2 * m) / bImg.naturalWidth, (ch - 2 * m) / bImg.naturalHeight);
  bView.scale = Math.max(0.02, Math.min(16, s));
  bView.ox = (cw - bImg.naturalWidth * bView.scale) / 2;
  bView.oy = (ch - bImg.naturalHeight * bView.scale) / 2;
}
function bElements() { return (bDoc && C.getElements(bDoc)) || []; }
function bDraw() {
  const dpr = window.devicePixelRatio || 1;
  bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const cw = bCanvas.width / dpr, ch = bCanvas.height / dpr;
  bctx.clearRect(0, 0, cw, ch);
  bctx.fillStyle = '#0a0c11';
  bctx.fillRect(0, 0, cw, ch);
  if (!bImgLoaded) {
    if (compareActive) {
      bctx.fillStyle = '#8a90a6';
      bctx.font = '14px system-ui';
      bctx.fillText('No compare image for this item.', 18, 30);
    }
    return;
  }
  bctx.imageSmoothingEnabled = bView.scale < 2.5;
  bctx.drawImage(bImg, bView.ox, bView.oy, bImg.naturalWidth * bView.scale, bImg.naturalHeight * bView.scale);
  if (!showBboxes.checked) return;
  const arr = bElements();
  bctx.textBaseline = 'top';
  bctx.font = '700 12px system-ui';
  for (let i = 0; i < arr.length; i++) {
    const rect = C.bboxToRect(arr[i].bbox, order(), coordMax(), bImg.naturalWidth, bImg.naturalHeight);
    if (!rect) continue;
    const x = bView.ox + rect.left * bView.scale, y = bView.oy + rect.top * bView.scale;
    const w = rect.width * bView.scale, h = rect.height * bView.scale;
    const color = C.colorForIndex(i);
    const hov = i === bHoverIdx;
    if (bboxFill.checked || hov) { bctx.fillStyle = color + (hov ? '2e' : '1d'); bctx.fillRect(x, y, w, h); }
    bctx.lineWidth = hov ? 3 : 2;
    bctx.strokeStyle = color;
    bctx.strokeRect(x, y, w, h);
    if (bboxLabels.checked) {
      const text = C.shortLabel(arr[i], i);
      const tw = bctx.measureText(text).width;
      const lx = Math.max(0, Math.min(x, cw - tw - 10));
      let ly = y - 18; if (ly < 0) ly = y + 2;
      bctx.fillStyle = color;
      bctx.fillRect(lx, ly, tw + 10, 17);
      bctx.fillStyle = '#0c0e14';
      bctx.fillText(text, lx + 5, ly + 3);
    }
  }
}
/* hover hit-test for the read-only B canvas (smallest box under the cursor) */
function bGetPos(e) {
  const r = bCanvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}
function bHitBox(p) {
  if (!showBboxes.checked || !bImgLoaded) return -1;
  const ix = (p.x - bView.ox) / bView.scale, iy = (p.y - bView.oy) / bView.scale;
  const tol = 5 / bView.scale;
  let best = -1, bestArea = Infinity;
  const arr = bElements();
  for (let i = 0; i < arr.length; i++) {
    const r = C.bboxToRect(arr[i].bbox, order(), coordMax(), bImg.naturalWidth, bImg.naturalHeight);
    if (!r) continue;
    if (ix >= r.left - tol && ix <= r.left + r.width + tol &&
        iy >= r.top - tol && iy <= r.top + r.height + tol) {
      const area = r.width * r.height;
      if (area < bestArea) { bestArea = area; best = i; }
    }
  }
  return best;
}
bCanvas.addEventListener('wheel', (e) => {
  if (!bImgLoaded) return;
  e.preventDefault();
  const r = bCanvas.getBoundingClientRect();
  const p = { x: e.clientX - r.left, y: e.clientY - r.top };
  const ip = { x: (p.x - bView.ox) / bView.scale, y: (p.y - bView.oy) / bView.scale };
  const ns = Math.max(0.02, Math.min(16, bView.scale * Math.exp(-e.deltaY * 0.0016)));
  bView.scale = ns;
  bView.ox = p.x - ip.x * ns;
  bView.oy = p.y - ip.y * ns;
  bDraw();
}, { passive: false });
bCanvas.addEventListener('pointerdown', (e) => {
  if (!bImgLoaded) return;
  hideBoxTip();
  bCanvas.setPointerCapture(e.pointerId);
  bDrag = { x: e.clientX, y: e.clientY, ox: bView.ox, oy: bView.oy };
  bCanvas.style.cursor = 'grabbing';
});
bCanvas.addEventListener('pointermove', (e) => {
  if (bDrag) {
    bView.ox = bDrag.ox + (e.clientX - bDrag.x);
    bView.oy = bDrag.oy + (e.clientY - bDrag.y);
    hideBoxTip();
    bDraw();
    return;
  }
  const h = bHitBox(bGetPos(e));
  if (h !== bHoverIdx) { bHoverIdx = h; bDraw(); }
  if (h >= 0) { bCanvas.style.cursor = 'help'; showBoxTip(e.clientX, e.clientY, bElements()[h], h); }
  else { bCanvas.style.cursor = 'grab'; hideBoxTip(); }
});
bCanvas.addEventListener('pointerup', () => { bDrag = null; bCanvas.style.cursor = bHoverIdx >= 0 ? 'help' : 'grab'; });
bCanvas.addEventListener('pointerleave', () => { bHoverIdx = -1; hideBoxTip(); bDraw(); });
bCanvas.addEventListener('dblclick', () => { bFit(); bDraw(); });
bCanvas.style.cursor = 'grab';

/* copy B's caption into the A editor as unsaved changes */
copyBtoABtn.addEventListener('click', () => {
  if (!activeRel || copyBtoABtn.disabled) return;
  if (dirty && !confirm('The A editor has unsaved changes. Replace them with B\u2019s caption?')) return;
  setCaptionState(bText);
  dirty = true;
  rawDirtyPending = false;
  setMessage('Loaded B\u2019s caption into the A editor (unsaved \u2014 review the boxes, then Save).');
});

/* manual match picker */
bPickToggle.addEventListener('click', () => {
  bPickWrap.classList.toggle('hidden');
  if (!bPickWrap.classList.contains('hidden')) {
    bPickSearch.value = '';
    renderPickList('');
    bPickSearch.focus();
  }
});
bPickSearch.addEventListener('input', () => renderPickList(bPickSearch.value.trim().toLowerCase()));
function renderPickList(q) {
  bPickList.innerHTML = '';
  const cur = overrideFor(activeRel);
  const list = (q ? bImages.filter((b) => b.rel.toLowerCase().includes(q)) : bImages).slice(0, 200);
  if (!list.length) {
    const d = document.createElement('div');
    d.className = 'muted';
    d.textContent = 'No B files match.';
    bPickList.appendChild(d);
    return;
  }
  for (const b of list) {
    const btn = document.createElement('button');
    btn.textContent = b.rel;
    btn.title = b.rel;
    if (b.rel === cur) btn.classList.add('sel');
    btn.addEventListener('click', () => {
      setOverride(activeRel, b.rel);
      bPickWrap.classList.add('hidden');
      loadCompareItem(activeRel);
    });
    bPickList.appendChild(btn);
  }
}
bPickClear.addEventListener('click', () => {
  setOverride(activeRel, '');
  bPickClear.classList.add('hidden');
  loadCompareItem(activeRel);
});

loadCompareBtn.addEventListener('click', loadCompareFolder);
compareFolder.addEventListener('keydown', (e) => { if (e.key === 'Enter') loadCompareFolder(); });
clearCompareBtn.addEventListener('click', clearCompare);
compareFilter.addEventListener('change', renderList);
bFitBtn.addEventListener('click', () => { bFit(); bDraw(); });

const bResizeObserver = new ResizeObserver(() => { if (compareActive) { bResize(); bDraw(); } });
bResizeObserver.observe(bImageWrap);

/* ---------------- init ---------------- */
loadPrefs();
initAiPrefs();
if (typeof lastPrefs.browseOpen === 'boolean') browseDrawer.classList.toggle('open', lastPrefs.browseOpen);
if (typeof lastPrefs.editorOpen === 'boolean') editorDrawer.classList.toggle('open', lastPrefs.editorOpen);
if (lastPrefs.activeTab === 'raw') activeTab = 'raw';
updateLayoutClasses();
updateDirtyUi();
loadOverrides();
bindTopFields();
resizeCanvas();
draw();
bResize();
bDraw();

/* resume the previous session: reopen the last folder and re-select the last item */
if (lastPrefs && lastPrefs.lastFolder) {
  targetFolder.value = lastPrefs.lastFolder;
  openFolder({ preferRel: lastPrefs.lastActiveRel || '', silent: true });
}
