// dsh-cite-lens — selection that behaves like a text editor's.
//
// 1. No jumping. A pdf.js text layer is absolutely positioned spans with gaps
//    between them; dragging across a gap lets the browser snap the selection to
//    the whole page. pdf.js's own viewer fixes it with an `.endOfContent` box
//    that is moved next to the selection's moving end while you drag. That
//    logic (TextLayerBuilder, web/text_layer_builder.js) is ported here,
//    because the rest of pdf_viewer.mjs is not needed.
// 2. Handles. After a selection settles, a handle sits at each end; drag one
//    to grow or shrink that end, like the knobs on a Mac/iPad selection.
// 3. Keyboard. Shift+←/→ adjusts the moving end by a character,
//    Shift+⌥/Alt+←/→ by a word (Selection.modify).

let installed = 0;
let teardown = null;

/** The pdf.js end-of-content fix, installed once for every PDF view. */
export function attachSelectionFix(doc = document) {
  installed += 1;
  if (installed === 1) teardown = installGlobal(doc);
  return () => {
    installed -= 1;
    if (installed === 0) {
      teardown?.();
      teardown = null;
    }
  };
}

function layersOf(doc) {
  return doc.querySelectorAll('.dpa-page .textLayer');
}

function reset(layer) {
  const end = layer.querySelector(':scope > .endOfContent') ?? layer.querySelector('.endOfContent');
  if (end) {
    if (end.parentElement !== layer) layer.append(end);
    end.style.width = '';
    end.style.height = '';
    end.style.userSelect = '';
  }
  layer.classList.remove('selecting');
}

/**
 * Whether this browser needs the end-of-content box moved while dragging.
 * Firefox and Chromium 148+ select correctly without it, and moving the box
 * there can collapse the selection when the mouse is released — pdf.js's own
 * viewer skips it for exactly these browsers.
 */
export function needsEndMove(doc) {
  const win = doc.defaultView;
  const probe = doc.querySelector('.dpa-page .textLayer');
  if (probe && win?.getComputedStyle(probe).getPropertyValue('-moz-user-select') === 'none') return false;
  const nav = win?.navigator;
  const version = nav?.userAgentData?.brands?.find((b) => b.brand === 'Chromium')?.version
    ?? /\bChrome\/(\d+)\b/.exec(nav?.userAgent ?? '')?.[1];
  return !(version && Number.parseInt(version, 10) >= 148);
}

function installGlobal(doc) {
  const ac = new AbortController();
  let moveEnd;
  const opts = { signal: ac.signal };
  let pointerDown = false;
  let prevRange = null;

  doc.addEventListener('pointerdown', (event) => {
    pointerDown = true;
    const layer = event.target?.closest?.('.dpa-page .textLayer');
    if (layer) layer.classList.add('selecting');
  }, opts);
  doc.addEventListener('pointerup', () => {
    pointerDown = false;
    layersOf(doc).forEach(reset);
  }, opts);
  doc.defaultView?.addEventListener('blur', () => {
    pointerDown = false;
    layersOf(doc).forEach(reset);
  }, opts);
  doc.addEventListener('keyup', () => {
    if (!pointerDown) layersOf(doc).forEach(reset);
  }, opts);

  doc.addEventListener('selectionchange', () => {
    const selection = doc.getSelection();
    const layers = [...layersOf(doc)];
    if (!selection || selection.rangeCount === 0) {
      layers.forEach(reset);
      prevRange = null;
      return;
    }
    const range = selection.getRangeAt(0);
    for (const layer of layers) {
      if (range.intersectsNode(layer)) layer.classList.add('selecting');
      else reset(layer);
    }
    if (moveEnd === undefined) moveEnd = needsEndMove(doc);
    if (!moveEnd) return;
    // Move the end-of-content box next to the end being dragged, so the gap
    // after the last span on a line cannot capture the selection.
    const modifyStart = prevRange
      && (range.compareBoundaryPoints(Range.END_TO_END, prevRange) === 0
        || range.compareBoundaryPoints(Range.START_TO_END, prevRange) === 0);
    let anchor = modifyStart ? range.startContainer : range.endContainer;
    if (anchor.nodeType === Node.TEXT_NODE) anchor = anchor.parentNode;
    if (!modifyStart && range.endOffset === 0) {
      try {
        do {
          while (!anchor.previousSibling) anchor = anchor.parentNode;
          anchor = anchor.previousSibling;
        } while (!anchor.childNodes.length);
      } catch {
        prevRange = range.cloneRange();
        return;
      }
    }
    const layer = anchor?.parentElement?.closest?.('.dpa-page .textLayer');
    const end = layer?.querySelector('.endOfContent');
    if (layer && end && anchor.parentElement) {
      end.style.width = layer.style.width;
      end.style.height = layer.style.height;
      end.style.userSelect = 'text';
      anchor.parentElement.insertBefore(end, modifyStart ? anchor : anchor.nextSibling);
    }
    prevRange = range.cloneRange();
  }, opts);

  return () => ac.abort();
}

/* ---- handles and keyboard -------------------------------------------------- */

function caretAt(doc, x, y) {
  if (typeof doc.caretPositionFromPoint === 'function') {
    const pos = doc.caretPositionFromPoint(x, y);
    return pos ? { node: pos.offsetNode, offset: pos.offset } : null;
  }
  const range = doc.caretRangeFromPoint?.(x, y);
  return range ? { node: range.startContainer, offset: range.startOffset } : null;
}

/** The selection's two ends, as rectangles for the handles. */
export function selectionEnds(selection) {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const rects = [...range.getClientRects()].filter((r) => r.width > 0.5 && r.height > 0.5);
  if (rects.length === 0) return null;
  const first = rects[0];
  const last = rects[rects.length - 1];
  return {
    start: { x: first.left, top: first.top, bottom: first.bottom },
    end: { x: last.right, top: last.top, bottom: last.bottom },
  };
}

/**
 * Drag one end of the current selection to the text under the pointer.
 * @param which 'start' | 'end' — the end being moved; the other stays fixed.
 */
export function dragSelectionEnd(doc, which, x, y, root) {
  const selection = doc.getSelection();
  if (!selection || selection.rangeCount === 0) return false;
  const range = selection.getRangeAt(0);
  const caret = snapCaret(doc, x, y, root);
  if (!caret) return false;
  const fixedNode = which === 'start' ? range.endContainer : range.startContainer;
  const fixedOffset = which === 'start' ? range.endOffset : range.startOffset;
  // setBaseAndExtent keeps the fixed end as the anchor whichever way you drag,
  // so dragging past it flips the selection the way an editor does.
  selection.setBaseAndExtent(fixedNode, fixedOffset, caret.node, caret.offset);
  return true;
}

/**
 * The text position under a point, snapped to real text. Between lines or in
 * a margin the browser answers with an element, not a character; macOS snaps
 * to the nearest character on the nearest line, and so does this.
 */
export function snapCaret(doc, x, y, root) {
  const caret = caretAt(doc, x, y);
  if (caret?.node?.nodeType === Node.TEXT_NODE && root.contains(caret.node) && caret.node.parentElement?.closest('.textLayer')) {
    return caret;
  }
  const pageEl = doc.elementsFromPoint?.(x, y)?.find((el) => el.classList?.contains('dpa-page') && root.contains(el))
    ?? caret?.node?.parentElement?.closest?.('.dpa-page') ?? (caret?.node?.closest?.('.dpa-page'));
  const layer = pageEl?.querySelector('.textLayer');
  if (!layer) return null;
  let best = null;
  for (const span of layer.querySelectorAll('span')) {
    const text = span.firstChild;
    if (!text || text.nodeType !== Node.TEXT_NODE || !text.nodeValue) continue;
    const r = span.getBoundingClientRect();
    if (r.width < 0.5 || r.height < 0.5) continue;
    const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
    const score = dy * 4 + dx; // the nearest line matters more than the nearest column
    if (!best || score < best.score) best = { score, text, r };
  }
  if (!best) return null;
  const { text, r } = best;
  if (x <= r.left) return { node: text, offset: 0 };
  if (x >= r.right) return { node: text, offset: text.nodeValue.length };
  // Inside the span horizontally but off its line: proportional position.
  const offset = Math.round(((x - r.left) / r.width) * text.nodeValue.length);
  return { node: text, offset: Math.max(0, Math.min(text.nodeValue.length, offset)) };
}

/** Shift+Arrow adjusts the selection; returns true when it handled the key. */
export function adjustByKey(doc, event, root) {
  if (!event.shiftKey || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return false;
  const selection = doc.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return false;
  if (!root.contains(selection.focusNode)) return false;
  if (typeof selection.modify !== 'function') return false;
  const granularity = event.altKey || event.ctrlKey || event.metaKey ? 'word' : 'character';
  selection.modify('extend', event.key === 'ArrowRight' ? 'forward' : 'backward', granularity);
  return true;
}
