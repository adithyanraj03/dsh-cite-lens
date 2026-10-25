// dsh-cite-lens — PDF citations in chat replies as links.
//
//   [p.7]                          a page of the PDF you are reading
//   [main.pdf p.7]                 that PDF, that page — opened if it is not open
//   [main.pdf "exact words"]       that PDF, wherever the words are; highlighted
//   [main.pdf p.7 "exact words"]   the same, searching page 7 first
//
// The chat is rendered by React and re-rendered as replies stream in, so its
// DOM is never edited here: wrapping text nodes in elements React did not
// create would break its next update. Citations are found as text ranges,
// painted with the CSS Custom Highlight API (::highlight), and a click is
// hit-tested against those ranges with caretPositionFromPoint.

import { findPageCitations } from './chat.js';

export const HIGHLIGHT = 'dsh-cite-lens-cite';
const QUICK = /\[[^\]\n]{0,420}?(?:p{1,2}\.?\s?\d|\.pdf)/i;

const norm = (path) => String(path ?? '').replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();

const LAST_KEY = 'dsh-cite-lens:last-pdf';

/** Open PDF views, most recently used last; also remembers the last PDF across reloads. */
export class ViewerRegistry {
  constructor(storage = (() => { try { return globalThis.localStorage; } catch { return undefined; } })()) {
    this.entries = new Map(); // key -> { key, file, path, view, quotes: Map<page, boxes[]>, at }
    this.listeners = new Set();
    this.storage = storage;
  }
  /** The last PDF opened in a view, even if it is closed now: { key, file, path } or undefined. */
  lastOpened() {
    try {
      // dsh-pdf-ask (the name before 0.2.0) stored it under its own key.
      const raw = this.storage?.getItem(LAST_KEY) ?? this.storage?.getItem('dsh-pdf-ask:last-pdf');
      const last = raw ? JSON.parse(raw) : undefined;
      return last?.key ? last : undefined;
    } catch {
      return undefined;
    }
  }
  rememberLast(entry) {
    try {
      this.storage?.setItem(LAST_KEY, JSON.stringify({ key: entry.key, file: entry.file, path: entry.path }));
    } catch { /* storage is a convenience */ }
  }
  /**
   * @param key  the Files-tab address (also what reopens it)
   * @param file the file name
   * @param path the path the address names (workspace-relative or absolute), for matching
   */
  add(key, file, view, path = file) {
    const entry = { key, file, path, view, quotes: new Map(), at: Date.now() };
    this.entries.set(key, entry);
    this.rememberLast(entry);
    this.emit();
    return () => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
      this.emit();
    };
  }
  touch(key) {
    const entry = this.entries.get(key);
    if (entry) {
      entry.at = Date.now();
      this.rememberLast(entry);
    }
  }
  remember(key, page, boxes) {
    const entry = this.entries.get(key);
    if (entry && boxes?.length) entry.quotes.set(page, boxes);
  }
  get size() {
    return this.entries.size;
  }
  /** The open view for a cited file: its path ends with what was cited (so `main.pdf` matches `paper/main.pdf`). */
  find(file) {
    const want = norm(file);
    if (!want) return undefined;
    const matches = [...this.entries.values()].filter((e) => {
      const path = norm(e.path);
      return path === want || path.endsWith(`/${want}`) || want.endsWith(`/${path}`) || norm(e.file) === want;
    });
    return matches.sort((a, b) => b.at - a.at)[0];
  }
  /** The most recently used view. */
  latest() {
    return [...this.entries.values()].sort((a, b) => b.at - a.at)[0];
  }
  /** The view a citation points at: the named file if open, else (no file named) the last one used. */
  target(file) {
    if (file) return this.find(file) ?? (this.entries.size ? this.latest() : undefined);
    return this.latest();
  }
  /** Resolve when a view for this file is registered (and loaded), or undefined after a timeout. */
  waitFor(file, timeoutMs = 12000) {
    const now = this.find(file);
    if (now) return Promise.resolve(now);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        off();
        resolve(undefined);
      }, timeoutMs);
      const off = this.on(() => {
        const found = this.find(file);
        if (found) {
          clearTimeout(timer);
          off();
          resolve(found);
        }
      });
    });
  }
  on(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit() {
    for (const listener of [...this.listeners]) listener();
  }
}

/** Text nodes worth scanning: visible prose, not inputs, code, or the PDF itself. */
function acceptNode(node) {
  const text = node.nodeValue;
  if (!text || !QUICK.test(text)) return NodeFilter.FILTER_REJECT;
  const parent = node.parentElement;
  if (!parent) return NodeFilter.FILTER_REJECT;
  if (parent.closest('[contenteditable="true"], textarea, input, pre, .dpa-root, script, style')) return NodeFilter.FILTER_REJECT;
  return NodeFilter.FILTER_ACCEPT;
}

/** Every citation in the document as { range, node, start, end, page?, file?, quote? }. */
export function scanCitations(doc) {
  const out = [];
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, { acceptNode });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    for (const hit of findPageCitations(node.nodeValue)) {
      const range = doc.createRange();
      range.setStart(node, hit.index);
      range.setEnd(node, hit.index + hit.length);
      out.push({ range, node, start: hit.index, end: hit.index + hit.length, page: hit.page, file: hit.file, quote: hit.quote });
    }
  }
  return out;
}

function caretAt(doc, x, y) {
  if (typeof doc.caretPositionFromPoint === 'function') {
    const pos = doc.caretPositionFromPoint(x, y);
    return pos ? { node: pos.offsetNode, offset: pos.offset } : null;
  }
  if (typeof doc.caretRangeFromPoint === 'function') {
    const range = doc.caretRangeFromPoint(x, y);
    return range ? { node: range.startContainer, offset: range.startOffset } : null;
  }
  return null;
}

/** The citation under a point, if any. */
export function citationAt(citations, doc, x, y) {
  const caret = caretAt(doc, x, y);
  if (!caret) return undefined;
  return citations.find((c) => c.node === caret.node && caret.offset >= c.start && caret.offset <= c.end
    && (() => {
      // caret offsets snap to the nearest character edge; confirm the point is inside the box.
      const r = c.range.getBoundingClientRect();
      return x >= r.left - 1 && x <= r.right + 1 && y >= r.top - 1 && y <= r.bottom + 1;
    })());
}

/** A short note near where the user clicked. */
function toast(doc, text, x, y) {
  const el = doc.createElement('div');
  el.className = 'dpa-toast';
  el.textContent = text;
  const width = Math.min(360, doc.defaultView.innerWidth - 16);
  el.style.maxWidth = `${width}px`;
  el.style.left = `${Math.max(8, Math.min(doc.defaultView.innerWidth - width - 8, x - width / 2))}px`;
  el.style.top = `${Math.max(8, y + 14)}px`;
  doc.body.appendChild(el);
  setTimeout(() => el.classList.add('dpa-toast-out'), 3600);
  setTimeout(() => el.remove(), 4000);
}

/**
 * Follow one citation: open the PDF if needed, find the words, highlight them.
 * @param open (file) => true when an open was requested, false when the file cannot be addressed
 */
export async function followCitation(cite, { registry, open, notify }) {
  const shortQuote = cite.quote && cite.quote.length > 48 ? `${cite.quote.slice(0, 45)}…` : cite.quote;
  let entry = cite.file ? registry.find(cite.file) : registry.latest();
  if (cite.file) {
    // Always ask dsh to open/reveal it: it may be open in a tab that is not showing.
    const requested = open(entry?.key ?? cite.file);
    if (!entry) {
      if (!requested) {
        notify(`Couldn't open ${cite.file} — open a chat first, so the path can be resolved against its workspace`);
        return;
      }
      entry = await registry.waitFor(cite.file);
      if (!entry) {
        notify(`Couldn't open ${cite.file} — check the path (relative to the workspace)`);
        return;
      }
    }
  } else if (!entry) {
    // A bare [p.N] with nothing open: reopen the last PDF this browser showed.
    const last = registry.lastOpened();
    if (!last || !open(last.key)) {
      notify('Open the PDF first — or cite it by name, like [main.pdf p.7]');
      return;
    }
    entry = await registry.waitFor(last.path);
    if (!entry) {
      notify(`Couldn't reopen ${last.file}`);
      return;
    }
  }
  registry.touch(entry.key);
  const view = entry.view;
  if (cite.quote) {
    const found = await view.locate(cite.quote, cite.page);
    if (found) {
      view.reveal(found.page, found.boxes);
      return;
    }
    if (cite.page) view.reveal(cite.page, entry.quotes.get(cite.page) ?? []);
    notify(`"${shortQuote}" isn't in ${entry.file}${cite.page ? ` (showing p.${cite.page})` : ''} — if it was just edited, rebuild the PDF`);
    return;
  }
  if (cite.page) {
    if (cite.page > view.numPages) {
      notify(`${entry.file} has ${view.numPages} pages — there is no p.${cite.page}`);
      return;
    }
    view.reveal(cite.page, entry.quotes.get(cite.page) ?? []);
  }
}

/**
 * Turn citations into links.
 * @param opts.open (fileOrAddress) => boolean — ask dsh to open/reveal a PDF
 * @returns a disposer.
 */
export function installPageLinks(registry, doc = document, { open = () => false } = {}) {
  const win = doc.defaultView;
  const highlights = win?.CSS?.highlights;
  const HighlightCtor = win?.Highlight;
  let citations = [];
  let timer = null;
  let frame = 0;
  let selecting = false;

  // A named PDF can be opened from a link; a bare [p.N] needs an open PDF.
  // A named PDF can be opened from a link; a bare [p.N] needs an open PDF or one opened before.
  const live = (c) => Boolean(c.file) || registry.size > 0 || Boolean(registry.lastOpened());

  // Only citations on screen are painted. Chrome repaints every highlight
  // range in the document on each selection change, so painting a long
  // chat's worth of citation ranges made drag-selecting in the PDF crawl.
  //
  // Painting covers a band a screen above and below the view, and is redone
  // only once scrolling pauses: measuring every citation on every scroll frame
  // made long, link-heavy answers stutter.
  const MAX_PAINTED = 160;
  let painted = [];
  const repaint = () => {
    frame = 0;
    if (!highlights || !HighlightCtor) return;
    if (selecting || citations.length === 0) {
      if (painted.length) highlights.delete(HIGHLIGHT);
      painted = [];
      return;
    }
    const height = win.innerHeight;
    const width = win.innerWidth;
    const next = [];
    for (const c of citations) {
      if (!c.node.isConnected || !live(c)) continue;
      const r = c.range.getBoundingClientRect();
      if (r.bottom >= -height && r.top <= height * 2 && r.right >= 0 && r.left <= width && r.width > 0) {
        next.push(c.range);
        if (next.length >= MAX_PAINTED) break;
      }
    }
    // Unchanged set: leave the highlight alone (re-setting it repaints the page).
    if (next.length === painted.length && next.every((r, i) => r === painted[i])) return;
    painted = next;
    if (next.length === 0) highlights.delete(HIGHLIGHT);
    else highlights.set(HIGHLIGHT, new HighlightCtor(...next));
  };
  const repaintSoon = () => {
    if (!frame) frame = win.requestAnimationFrame(repaint);
  };
  let scrollTimer = null;
  const repaintAfterScroll = () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(repaintSoon, 140);
  };

  const scan = () => {
    timer = null;
    citations = scanCitations(doc);
    repaintSoon();
  };
  const scheduleScan = () => {
    if (timer === null) timer = setTimeout(scan, 350);
  };

  // Changes inside the PDF view itself (pages rendering, the selection's
  // end-of-content box moving) never touch the chat: skip them.
  const observer = new win.MutationObserver((records) => {
    for (const record of records) {
      const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
      if (!target?.closest?.('.dpa-root, .dpa-toast')) {
        scheduleScan();
        return;
      }
    }
  });
  observer.observe(doc.body, { childList: true, subtree: true, characterData: true });
  const offRegistry = registry.on(repaintSoon);

  const onScroll = () => repaintAfterScroll();
  const onPointerDown = (event) => {
    if (event.target?.closest?.('.dpa-root')) {
      selecting = true;
      repaintSoon();
    }
  };
  const onPointerUp = () => {
    if (selecting) {
      selecting = false;
      repaintSoon();
    }
  };
  // A release outside the window never sends pointerup; never stay stuck "selecting".
  const onPointerCancel = onPointerUp;

  const onClick = (event) => {
    if (event.button !== 0 || citations.length === 0) return;
    if (!doc.getSelection()?.isCollapsed) return; // the user is selecting text, not clicking a link
    const hit = citationAt(citations, doc, event.clientX, event.clientY);
    if (!hit || !live(hit)) return;
    event.preventDefault();
    event.stopPropagation();
    const { clientX: x, clientY: y } = event;
    followCitation(hit, { registry, open, notify: (text) => toast(doc, text, x, y) })
      .catch((error) => toast(doc, `Couldn't follow that link: ${error?.message ?? error}`, x, y));
  };
  let lastMove = 0;
  let pointing = false;
  const onMove = (event) => {
    if (selecting && !event.buttons) onPointerUp();
    if (selecting || event.buttons) return;
    const now = Date.now();
    if (now - lastMove < 80) return;
    lastMove = now;
    const hit = citations.length > 0 ? citationAt(citations, doc, event.clientX, event.clientY) : undefined;
    const over = Boolean(hit && live(hit));
    if (over !== pointing) {
      pointing = over;
      doc.documentElement.style.cursor = over ? 'pointer' : '';
    }
  };
  doc.addEventListener('click', onClick, true);
  doc.addEventListener('mousemove', onMove, { passive: true });
  doc.addEventListener('scroll', onScroll, { capture: true, passive: true });
  doc.addEventListener('pointerdown', onPointerDown, true);
  doc.addEventListener('pointerup', onPointerUp, true);
  doc.addEventListener('pointercancel', onPointerCancel, true);
  win.addEventListener('blur', onPointerCancel);
  win.addEventListener('resize', onScroll);
  scheduleScan();

  return () => {
    observer.disconnect();
    offRegistry();
    if (timer !== null) clearTimeout(timer);
    if (frame) win.cancelAnimationFrame(frame);
    clearTimeout(scrollTimer);
    doc.removeEventListener('click', onClick, true);
    doc.removeEventListener('mousemove', onMove);
    doc.removeEventListener('scroll', onScroll, true);
    doc.removeEventListener('pointerdown', onPointerDown, true);
    doc.removeEventListener('pointerup', onPointerUp, true);
    doc.removeEventListener('pointercancel', onPointerCancel, true);
    win.removeEventListener('blur', onPointerCancel);
    win.removeEventListener('resize', onScroll);
    highlights?.delete(HIGHLIGHT);
    if (pointing) doc.documentElement.style.cursor = '';
  };
}
