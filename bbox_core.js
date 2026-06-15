/* bbox_core.js — pure helpers for structured caption editing.
 *
 * No DOM access: loadable both in the browser (window.BBoxCore) and in node
 * (module.exports) so the geometry/validation logic is unit-testable.
 *
 * Caption convention (Ideogram-style): bbox = [y_min, x_min, y_max, x_max],
 * integers 0..coordMax (default 1000), relative to the original image.
 * The `order` parameter ('yxyx' | 'xyxy') controls interpretation at the
 * mapping boundary only; storage keeps whatever order the user selected.
 */
(function (root, factory) {
  const lib = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = lib;
  if (root) root.BBoxCore = lib;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const MAX_REPAIR_CLOSERS = 12;
  const CANONICAL_PATH = ['compositional_deconstruction', 'elements'];

  /* ---------- JSON repair (port of toolkit/bbox_caption_utils.py) ---------- */

  // Append missing trailing closers for output cut off before the final
  // brace(s). Refuses mismatched closers and truncation inside a string —
  // same semantics as the training-side repair, so the editor never accepts
  // something the dataloader would reject.
  function repairTruncatedJSON(text) {
    if (typeof text !== 'string') return null;
    const stack = [];
    let inString = false;
    let escaped = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') stack.push('}');
      else if (ch === '[') stack.push(']');
      else if (ch === '}' || ch === ']') {
        if (!stack.length || stack[stack.length - 1] !== ch) return null;
        stack.pop();
      }
    }
    if (inString || !stack.length || stack.length > MAX_REPAIR_CLOSERS) return null;
    return text + stack.reverse().join('');
  }

  function parseJsonObject(text) {
    const doc = JSON.parse(text);
    return (doc && typeof doc === 'object' && !Array.isArray(doc)) ? doc : null;
  }

  function repairJsonText(text) {
    const raw = String(text == null ? '' : text);
    const trimmed = raw.trim();
    const candidates = [];
    if (trimmed) candidates.push({ text: trimmed, kind: 'trimmed' });
    const firstBrace = trimmed.indexOf('{');
    if (firstBrace > 0) candidates.push({ text: trimmed.slice(firstBrace), kind: 'stripped leading text' });

    for (const cand of candidates) {
      try {
        const doc = parseJsonObject(cand.text);
        if (doc) return { text: cand.text, kind: cand.kind === 'trimmed' ? '' : cand.kind };
      } catch (e) { /* try other repairs */ }

      const fixed = repairTruncatedJSON(cand.text);
      if (fixed !== null) {
        try {
          const doc = parseJsonObject(fixed);
          if (doc) return { text: fixed, kind: cand.kind ? cand.kind + ' + closed truncation' : 'closed truncation' };
        } catch (e) { /* try trailing trim */ }
      }

      // Remove accidental text after a complete JSON object by repeatedly testing
      // closing braces from the end toward the beginning. This intentionally only
      // accepts a real JSON object; it does not invent structure in the middle.
      for (let i = cand.text.lastIndexOf('}'); i >= 0; i = cand.text.lastIndexOf('}', i - 1)) {
        const maybe = cand.text.slice(0, i + 1);
        try {
          const doc = parseJsonObject(maybe);
          if (doc) {
            const prefix = cand.kind && cand.kind !== 'trimmed' ? cand.kind + ' + ' : '';
            return { text: maybe, kind: prefix + 'stripped trailing text' };
          }
        } catch (e) { /* continue */ }
      }
    }
    return null;
  }

  // -> { doc, plain, repaired, repairKind, repairedText, error }
  //   doc      parsed object (or null)
  //   plain    true when the caption is not JSON at all (free text)
  //   repaired true when repair was needed and succeeded
  //   error    message when it looks like JSON but could not be parsed
  function parseCaptionDoc(text, opts) {
    opts = opts || {};
    const allowRepair = opts.repair !== false;
    const out = { doc: null, plain: false, repaired: false, repairKind: '', repairedText: null, error: null };
    const trimmed = String(text == null ? '' : text).trim();
    if (!trimmed.startsWith('{')) {
      if (allowRepair && trimmed.includes('{')) {
        const fixedLeading = repairJsonText(trimmed);
        if (fixedLeading) {
          out.doc = parseJsonObject(fixedLeading.text);
          out.repaired = !!fixedLeading.kind;
          out.repairKind = fixedLeading.kind;
          out.repairedText = fixedLeading.text;
          return out;
        }
      }
      out.plain = true;
      return out;
    }
    try {
      const doc = parseJsonObject(trimmed);
      if (doc) { out.doc = doc; return out; }
      out.error = 'Top-level JSON is not an object.';
      return out;
    } catch (e) { /* try repair */ }
    if (allowRepair) {
      const fixed = repairJsonText(trimmed);
      if (fixed) {
        out.doc = parseJsonObject(fixed.text);
        out.repaired = !!fixed.kind;
        out.repairKind = fixed.kind;
        out.repairedText = fixed.text;
        return out;
      }
    }
    out.error = allowRepair
      ? 'Caption looks like JSON but could not be parsed or safely repaired.'
      : 'Caption looks like JSON but could not be parsed. JSON auto-repair is off.';
    return out;
  }

  /* ---------- document access ---------- */

  function isBoxBearing(value) {
    return value && typeof value === 'object' && !Array.isArray(value) &&
      Array.isArray(value.bbox) && value.bbox.length === 4;
  }

  // Canonical path first; otherwise the first array (document order) that
  // contains at least one box-bearing object. With {create:true} the
  // canonical path is materialized.
  function getElements(doc, opts) {
    opts = opts || {};
    if (!doc || typeof doc !== 'object') return null;
    const comp = doc[CANONICAL_PATH[0]];
    if (comp && typeof comp === 'object' && Array.isArray(comp[CANONICAL_PATH[1]])) {
      return comp[CANONICAL_PATH[1]];
    }
    let found = null;
    (function walk(value) {
      if (found || !value || typeof value !== 'object') return;
      if (Array.isArray(value)) {
        if (value.some(isBoxBearing)) { found = value; return; }
        for (const item of value) walk(item);
        return;
      }
      for (const child of Object.values(value)) walk(child);
    })(doc);
    if (found) return found;
    if (opts.create) {
      if (!doc[CANONICAL_PATH[0]] || typeof doc[CANONICAL_PATH[0]] !== 'object') {
        doc[CANONICAL_PATH[0]] = {};
      }
      doc[CANONICAL_PATH[0]][CANONICAL_PATH[1]] = [];
      return doc[CANONICAL_PATH[0]][CANONICAL_PATH[1]];
    }
    return null;
  }

  function ensureSkeleton(text) {
    return {
      high_level_description: String(text || '').trim(),
      style_description: {
        aesthetics: '', lighting: '', art_style: '', medium: '', color_palette: []
      },
      compositional_deconstruction: { background: '', elements: [] }
    };
  }

  function makeElement(type) {
    return { type: type || 'obj', bbox: null, desc: '', color_palette: [] };
  }

  /* ---------- geometry ---------- */

  function idxMap(order) {
    // indices into the stored 4-array for each semantic coordinate
    return order === 'xyxy'
      ? { x1: 0, y1: 1, x2: 2, y2: 3 }
      : { y1: 0, x1: 1, y2: 2, x2: 3 };
  }

  function coordLabels(order) {
    return order === 'xyxy' ? ['x1', 'y1', 'x2', 'y2'] : ['y1', 'x1', 'y2', 'x2'];
  }

  // bbox (caption units) -> rect in image pixels, or null when malformed.
  function bboxToRect(bbox, order, coordMax, imgW, imgH) {
    if (!Array.isArray(bbox) || bbox.length !== 4) return null;
    const v = bbox.map(Number);
    if (!v.every(Number.isFinite)) return null;
    const m = idxMap(order);
    const max = Math.max(1, Number(coordMax) || 1000);
    const x1 = v[m.x1] / max * imgW, x2 = v[m.x2] / max * imgW;
    const y1 = v[m.y1] / max * imgH, y2 = v[m.y2] / max * imgH;
    return {
      left: Math.min(x1, x2),
      top: Math.min(y1, y2),
      width: Math.abs(x2 - x1),
      height: Math.abs(y2 - y1)
    };
  }

  // rect in image pixels -> bbox (caption units), rounded, clamped, ordered,
  // never zero-sized.
  function rectToBbox(rect, order, coordMax, imgW, imgH) {
    const max = Math.max(1, Number(coordMax) || 1000);
    const clamp = (v) => Math.max(0, Math.min(max, Math.round(v)));
    let y1 = clamp(rect.top / imgH * max);
    let y2 = clamp((rect.top + rect.height) / imgH * max);
    let x1 = clamp(rect.left / imgW * max);
    let x2 = clamp((rect.left + rect.width) / imgW * max);
    if (y2 < y1) { const t = y1; y1 = y2; y2 = t; }
    if (x2 < x1) { const t = x1; x1 = x2; x2 = t; }
    if (y2 === y1) { if (y2 < max) y2 += 1; else y1 -= 1; }
    if (x2 === x1) { if (x2 < max) x2 += 1; else x1 -= 1; }
    const m = idxMap(order);
    const out = [0, 0, 0, 0];
    out[m.y1] = y1; out[m.x1] = x1; out[m.y2] = y2; out[m.x2] = x2;
    return out;
  }

  // Round, clamp, and order an existing bbox in storage space. Pairs (0,2)
  // and (1,3) are min/max under both yxyx and xyxy, so this is order-free.
  // Returns a new array, or null when the value is not 4 finite numbers.
  function normalizeBbox(bbox, coordMax) {
    if (!Array.isArray(bbox) || bbox.length !== 4) return null;
    const v = bbox.map(Number);
    if (!v.every(Number.isFinite)) return null;
    const max = Math.max(1, Number(coordMax) || 1000);
    const c = v.map((n) => Math.max(0, Math.min(max, Math.round(n))));
    let a0 = Math.min(c[0], c[2]), a2 = Math.max(c[0], c[2]);
    let b1 = Math.min(c[1], c[3]), b3 = Math.max(c[1], c[3]);
    if (a2 === a0) { if (a2 < max) a2 += 1; else a0 -= 1; }
    if (b3 === b1) { if (b3 < max) b3 += 1; else b1 -= 1; }
    return [a0, b1, a2, b3];
  }

  function bboxEquals(a, b) {
    return Array.isArray(a) && Array.isArray(b) && a.length === 4 && b.length === 4 &&
      a.every((v, i) => Number(v) === Number(b[i]));
  }

  /* ---------- validation ---------- */

  // Every dict in the document carrying a `bbox` key, with its containing
  // array index when it lives in the resolved elements array.
  function collectBoxBearing(doc) {
    const elements = getElements(doc) || [];
    const out = [];
    const seen = new Set();
    elements.forEach((el, i) => {
      if (el && typeof el === 'object' && !Array.isArray(el)) {
        out.push({ obj: el, idx: i });
        seen.add(el);
      }
    });
    (function walk(value) {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) { value.forEach(walk); return; }
      if (Object.prototype.hasOwnProperty.call(value, 'bbox') && !seen.has(value)) {
        out.push({ obj: value, idx: null });
        seen.add(value);
      }
      Object.values(value).forEach(walk);
    })(doc);
    return out;
  }

  // -> [{ idx, label, msg, fixable }]
  function validateDoc(doc, coordMax) {
    const issues = [];
    if (!doc || typeof doc !== 'object') return issues;
    for (const { obj, idx } of collectBoxBearing(doc)) {
      const label = idx === null ? 'stray box' : 'element ' + (idx + 1);
      const bbox = obj.bbox;
      if (bbox === null || bbox === undefined) {
        if (idx !== null) issues.push({ idx, label, msg: 'no box drawn yet', fixable: false });
        continue;
      }
      const norm = normalizeBbox(bbox, coordMax);
      if (norm === null) {
        issues.push({ idx, label, msg: 'bbox is not 4 finite numbers', fixable: false });
        continue;
      }
      if (!bboxEquals(bbox, norm)) {
        const why = [];
        const nums = bbox.map(Number);
        const max = Math.max(1, Number(coordMax) || 1000);
        if (nums.some((n) => n !== Math.round(n))) why.push('non-integer');
        if (nums.some((n) => n < 0 || n > max)) why.push('out of 0\u2013' + max);
        if (Number(bbox[0]) > Number(bbox[2]) || Number(bbox[1]) > Number(bbox[3])) why.push('inverted corners');
        if (!why.length) why.push('degenerate (zero size)');
        issues.push({ idx, label, msg: why.join(', '), fixable: true });
      }
    }
    return issues;
  }

  // Apply normalizeBbox to every fixable box in place; -> count fixed.
  function fixDoc(doc, coordMax) {
    let fixed = 0;
    for (const { obj } of collectBoxBearing(doc)) {
      const bbox = obj.bbox;
      if (bbox === null || bbox === undefined) continue;
      const norm = normalizeBbox(bbox, coordMax);
      if (norm !== null && !bboxEquals(bbox, norm)) {
        obj.bbox = norm;
        fixed += 1;
      }
    }
    return fixed;
  }

  /* ---------- output ---------- */

  // Deep-clone with `bbox: null` keys removed (half-finished elements save
  // clean), then stringify pretty (indent 2) or minified.
  function serializeDoc(doc, pretty) {
    function clean(value) {
      if (Array.isArray(value)) return value.map(clean);
      if (value && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
          if (k === 'bbox' && v === null) continue;
          out[k] = clean(v);
        }
        return out;
      }
      return value;
    }
    return JSON.stringify(clean(doc), null, pretty ? 2 : 0);
  }

  /* ---------- presentation helpers ---------- */

  const COLORS = [
    '#ff4d6d', '#4cc9f0', '#80ed99', '#ffd60a', '#b983ff', '#ff9f1c',
    '#2ec4b6', '#ff70a6', '#aacc00', '#00bbf9', '#f15bb5', '#cdb4db'
  ];

  function colorForIndex(i) { return COLORS[((i % COLORS.length) + COLORS.length) % COLORS.length]; }

  function shortLabel(el, i) {
    const type = el && el.type ? String(el.type) : 'box';
    const desc = el ? String(el.desc || el.description || '') : '';
    const head = desc.split(/\s+/).slice(0, 3).join(' ');
    return (i + 1) + ' ' + type + (head ? ' \u00b7 ' + head : '');
  }

  return {
    MAX_REPAIR_CLOSERS,
    repairTruncatedJSON,
    repairJsonText,
    parseCaptionDoc,
    getElements,
    ensureSkeleton,
    makeElement,
    idxMap,
    coordLabels,
    bboxToRect,
    rectToBbox,
    normalizeBbox,
    bboxEquals,
    validateDoc,
    fixDoc,
    serializeDoc,
    colorForIndex,
    shortLabel
  };
});
