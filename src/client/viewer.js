// dsh-cite-lens — the PDF view: pages drawn by pdf.js with its text layer on
// top, so text can be selected. No React here; the body component owns one.
//
// Built to stay smooth on long papers:
//  - page positions are computed from page sizes, never measured per scroll
//    event; the current page is a binary search, at most once per frame;
//  - ONE page renders at a time, nearest to the reading position first, and
//    a page that scrolls away before its turn is dropped from the queue;
//  - the text layer is built in idle time after the page image;
//  - pages far from view are freed and re-rendered when they come back;
//  - zoom stretches the current images at once, then re-renders them sharp.

import * as pdfjs from 'pdfjs-dist';
import { attachSelectionFix } from './selection.js';
import { findInItems, boxesFor, searchOrder } from './textsearch.js';

let sharedWorker; // undefined: not made yet; null: none (tests)

/**
 * One long-lived pdf.js worker for every PDF view, passed to each document
 * explicitly.
 *
 * It used to be installed as GlobalWorkerOptions.workerPort. Then closing one
 * view (following a link to another PDF unmounts the old one) destroyed that
 * shared worker while the new view was already creating a document on it:
 * "PDFWorker.create - the worker is being destroyed". pdf.js never destroys
 * a worker it was handed via getDocument({ worker }), so this one outlives
 * every document.
 */
function getWorker() {
  if (sharedWorker !== undefined) return sharedWorker;
  // eslint-disable-next-line no-undef
  const source = typeof __DSH_CITE_LENS_WORKER__ === 'string' ? __DSH_CITE_LENS_WORKER__ : null;
  if (source === null) {
    sharedWorker = null; // tests: pdf.js falls back to its fake worker
    return sharedWorker;
  }
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  const port = new Worker(url, { type: 'module', name: 'dsh-cite-lens' });
  sharedWorker = new pdfjs.PDFWorker({ port, name: 'dsh-cite-lens' });
  return sharedWorker;
}

function ensureWorker() {
  getWorker();
}

export const ZOOM_STEPS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const GAP = 14; // px between pages (matches .dpa-pages gap)
const PAD_TOP = 16; // px above the first page (matches .dpa-pages padding)
const KEEP = 6; // pages either side of the reading position kept rendered
const PRELOAD = 2; // pages either side rendered ahead of time
const MAX_CANVAS_PIXELS = 16_777_216;
const SETTLE_MS = 140; // scroll quiet this long before sharp re-renders
const FAST_PX_PER_MS = 2.5; // above this the scroll is a fling: hold new renders

const idle = (fn) => (typeof requestIdleCallback === 'function' ? requestIdleCallback(fn, { timeout: 250 }) : setTimeout(fn, 16));

export class PdfView {
  /**
   * @param container where the pages are stacked (owned by this view)
   * @param scroller  the element that scrolls — the container's own root, or the Files tab's scroll area
   * @param opts.onPage called with the page most in view
   */
  constructor(container, scroller, { onPage } = {}) {
    ensureWorker();
    this.container = container;
    this.scroller = scroller;
    this.onPage = onPage;
    this.pages = [];
    this.tops = [];
    this.doc = null;
    this.zoom = 'fit';
    this.scale = 1;
    this.currentPage = 1;
    this.disposed = false;
    this.active = null; // the page being rendered right now
    this.queue = []; // page numbers waiting to render, nearest first
    this.frame = 0;
    this.lastScroll = { y: 0, t: 0, speed: 0 };
    this.settleTimer = null;

    this.resizeObserver = new ResizeObserver(() => {
      if (this.zoom === 'fit') this.relayout();
    });
    this.resizeObserver.observe(container);
    this.onScroll = () => {
      const now = performance.now();
      const y = this.scroller.scrollTop;
      const dt = Math.max(1, now - this.lastScroll.t);
      this.lastScroll = { y, t: now, speed: Math.abs(y - this.lastScroll.y) / dt };
      clearTimeout(this.settleTimer);
      this.settleTimer = setTimeout(() => {
        this.lastScroll.speed = 0;
        this.schedule();
      }, SETTLE_MS);
      if (this.frame) return;
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        this.trackPage();
        this.schedule();
      });
    };
    scroller.addEventListener('scroll', this.onScroll, { passive: true });
    this.detachSelection = attachSelectionFix();
  }

  async open(bytes) {
    // pdf.js transfers the buffer to its worker; give it a copy so the tab's
    // own bytes stay usable for a reload.
    const data = bytes.slice ? bytes.slice() : new Uint8Array(bytes);
    const worker = getWorker();
    this.task = pdfjs.getDocument({ data, isEvalSupported: false, enableXfa: false, ...(worker ? { worker } : {}) });
    const doc = await this.task.promise;
    if (this.disposed) return;
    this.doc = doc;
    const first = await doc.getPage(1);
    if (this.disposed) return;
    this.baseSize = first.getViewport({ scale: 1 });
    this.build();
    // Real page sizes arrive in the background, so mixed portrait/landscape
    // papers settle without blocking the first paint.
    this.loadSizes();
  }

  get numPages() {
    return this.doc?.numPages ?? 0;
  }

  computeScale() {
    if (this.zoom !== 'fit') return this.zoom;
    const width = Math.max(200, this.container.clientWidth - 32);
    return Math.max(0.25, Math.min(4, width / this.baseSize.width));
  }

  build() {
    this.scale = this.computeScale();
    const frag = document.createDocumentFragment();
    for (let n = 1; n <= this.doc.numPages; n += 1) {
      const el = document.createElement('div');
      el.className = 'dpa-page dpa-pending';
      el.dataset.page = String(n);
      const label = document.createElement('div');
      label.className = 'dpa-pageno';
      label.textContent = String(n);
      el.appendChild(label);
      frag.appendChild(el);
      this.pages.push({ n, el, size: { width: this.baseSize.width, height: this.baseSize.height }, rendered: 0, canvas: null, text: null, task: null, textTask: null });
    }
    this.container.appendChild(frag);
    this.applySizes();
    this.trackPage(true);
    this.schedule();
  }

  async loadSizes() {
    for (const page of this.pages) {
      if (this.disposed) return;
      if (page.n === 1) continue;
      try {
        const p = await this.doc.getPage(page.n);
        const v = p.getViewport({ scale: 1 });
        if (Math.abs(v.width - page.size.width) > 0.5 || Math.abs(v.height - page.size.height) > 0.5) {
          page.size = { width: v.width, height: v.height };
          this.applySizes(true);
        }
      } catch { /* keep the first page's size */ }
    }
  }

  /** Size every page box for the current scale and recompute their positions. */
  applySizes(keepPosition = false) {
    const anchor = this.currentPage;
    const within = keepPosition ? this.offsetWithin(anchor) : 0;
    const s = this.scale;
    let top = PAD_TOP;
    this.tops = [];
    for (const page of this.pages) {
      const w = Math.floor(page.size.width * s);
      const h = Math.floor(page.size.height * s);
      const style = page.el.style;
      style.width = `${w}px`;
      style.height = `${h}px`;
      style.setProperty('--scale-factor', String(s));
      style.setProperty('--total-scale-factor', String(s));
      style.setProperty('--scale-round-x', '1px');
      style.setProperty('--scale-round-y', '1px');
      page.h = h;
      this.tops.push(top);
      top += h + GAP;
    }
    this.containerOffset = this.container.getBoundingClientRect().top - this.scroller.getBoundingClientRect().top + this.scroller.scrollTop;
    if (keepPosition) this.scrollToPage(anchor, within, false);
  }

  /** A page's top in the scroller's coordinates. */
  topOf(n) {
    return (this.containerOffset ?? 0) + (this.tops[n - 1] ?? 0);
  }

  offsetWithin(n) {
    const page = this.pages[n - 1];
    if (!page) return 0;
    return (this.scroller.scrollTop - this.topOf(n)) / Math.max(1, page.h);
  }

  scrollToPage(n, within = 0, track = true) {
    const clamped = Math.max(1, Math.min(n, this.pages.length));
    const page = this.pages[clamped - 1];
    if (!page) return;
    this.scroller.scrollTop = this.topOf(clamped) - 48 + within * page.h;
    if (track) {
      this.trackPage();
      this.schedule();
    }
  }

  /** The page under the reading line, by binary search over the computed tops. */
  trackPage(force = false) {
    if (!this.pages.length) return;
    const line = this.scroller.scrollTop + this.scroller.clientHeight * 0.35 - (this.containerOffset ?? 0);
    let lo = 0;
    let hi = this.tops.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.tops[mid] <= line) lo = mid;
      else hi = mid - 1;
    }
    const found = lo + 1;
    if (force || found !== this.currentPage) {
      this.currentPage = found;
      this.onPage?.(found);
    }
  }

  /** Pages currently on screen. */
  visibleRange() {
    const top = this.scroller.scrollTop - (this.containerOffset ?? 0);
    const bottom = top + this.scroller.clientHeight;
    let first = this.currentPage;
    while (first > 1 && this.tops[first - 2] + this.pages[first - 2].h > top) first -= 1;
    while (first < this.pages.length && this.tops[first - 1] + this.pages[first - 1].h < top) first += 1;
    let last = first;
    while (last < this.pages.length && this.tops[last] < bottom) last += 1;
    return [first, last];
  }

  /** Queue what should be rendered, nearest first; free what is far away. */
  schedule() {
    if (this.disposed || !this.pages.length) return;
    const [first, last] = this.visibleRange();
    const want = [];
    for (let n = first; n <= last; n += 1) want.push(n);
    for (let d = 1; d <= PRELOAD; d += 1) {
      if (last + d <= this.pages.length) want.push(last + d);
      if (first - d >= 1) want.push(first - d);
    }
    // During a fling nothing new starts (pages keep their grey placeholder);
    // once it slows, visible pages draw fast at 1x, then sharp when settled.
    if (this.lastScroll.speed > FAST_PX_PER_MS) {
      this.queue = [];
    } else {
      const settled = this.lastScroll.speed === 0;
      this.queue = want
        .filter((n) => !this.isCurrent(this.pages[n - 1], settled))
        .sort((a, b) => Number(this.pages[a - 1].rendered === this.scale) - Number(this.pages[b - 1].rendered === this.scale));
    }
    for (const page of this.pages) {
      if ((page.n < first - KEEP || page.n > last + KEEP) && page.rendered) this.release(page);
    }
    this.pump();
  }

  pump() {
    if (this.active || this.disposed) return;
    const n = this.queue.shift();
    if (n === undefined) return;
    const page = this.pages[n - 1];
    if (this.isCurrent(page, this.lastScroll.speed === 0)) {
      this.pump();
      return;
    }
    this.active = page;
    this.renderPage(page).finally(() => {
      if (this.active === page) this.active = null;
      this.pump();
    });
  }

  /** Drawn at this scale already, and sharp when it needs to be. */
  isCurrent(page, settled) {
    if (page.rendered !== this.scale) return false;
    return !settled || page.sharp || (window.devicePixelRatio || 1) <= 1;
  }

  async renderPage(entry) {
    const scale = this.scale;
    // First draw at 1x so pages appear quickly; once scrolling settles the
    // same page is redrawn at the screen's full density.
    const sharp = entry.rendered === scale || this.lastScroll.speed === 0;
    try {
      const page = await this.doc.getPage(entry.n);
      if (this.disposed || scale !== this.scale) return;
      const viewport = page.getViewport({ scale });
      let ratio = sharp ? Math.min(window.devicePixelRatio || 1, 2) : 1;
      const pixels = viewport.width * viewport.height * ratio * ratio;
      if (pixels > MAX_CANVAS_PIXELS) ratio *= Math.sqrt(MAX_CANVAS_PIXELS / pixels);

      const canvas = document.createElement('canvas');
      canvas.className = 'dpa-canvas';
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      entry.task = page.render({
        canvas,
        canvasContext: canvas.getContext('2d', { alpha: false }),
        viewport,
        transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
      });
      await entry.task.promise;
      entry.task = null;
      if (this.disposed || scale !== this.scale) return;

      // Swap the new image in over the old (stretched) one: no blank frame.
      const old = entry.canvas;
      entry.el.prepend(canvas);
      requestAnimationFrame(() => canvas.classList.add('dpa-shown'));
      if (old) setTimeout(() => this.dropCanvas(old), 150);
      entry.canvas = canvas;
      const first = entry.rendered !== scale;
      entry.rendered = scale;
      entry.sharp = ratio > 1 || (window.devicePixelRatio || 1) <= 1;
      entry.el.classList.remove('dpa-pending');

      // The text layer comes after, in idle time, so scrolling never waits on it.
      if (first || !entry.text) idle(() => this.renderText(entry, page, viewport, scale));
    } catch (error) {
      if (error?.name !== 'RenderingCancelledException') entry.el.dataset.error = String(error?.message ?? error);
    }
  }

  async renderText(entry, page, viewport, scale) {
    if (this.disposed || scale !== this.scale || entry.rendered !== scale) return;
    entry.textTask?.cancel?.();
    const div = document.createElement('div');
    div.className = 'textLayer';
    const layer = new pdfjs.TextLayer({
      textContentSource: page.streamTextContent({ includeMarkedContent: true, disableNormalization: true }),
      container: div,
      viewport,
    });
    entry.textTask = layer;
    try {
      await layer.render();
    } catch {
      return;
    }
    if (this.disposed || scale !== this.scale || entry.rendered !== scale) return;
    const end = document.createElement('div');
    end.className = 'endOfContent';
    div.append(end);
    entry.text?.remove();
    entry.el.appendChild(div);
    entry.text = div;
    entry.textTask = null;
  }

  dropCanvas(canvas) {
    canvas.width = 0; // frees the backing store immediately
    canvas.height = 0;
    canvas.remove();
  }

  /** Free a far-away page; it re-renders when it comes back into range. */
  release(page) {
    page.task?.cancel?.();
    page.textTask?.cancel?.();
    page.task = null;
    page.textTask = null;
    if (page.canvas) this.dropCanvas(page.canvas);
    page.text?.remove();
    page.canvas = null;
    page.text = null;
    page.rendered = 0;
    page.sharp = false;
    page.el.classList.add('dpa-pending');
  }

  /** New scale: stretch what is drawn now, keep the reading position, re-render sharp. */
  relayout() {
    if (!this.doc) return;
    const next = this.computeScale();
    if (Math.abs(next - this.scale) < 0.001) return;
    this.scale = next;
    for (const page of this.pages) {
      // The text layer is positioned for the old scale; hide it until rebuilt.
      page.text?.remove();
      page.text = null;
      page.textTask?.cancel?.();
    }
    this.applySizes(true);
    this.schedule();
  }

  setZoom(zoom) {
    this.zoom = zoom;
    this.relayout();
  }

  zoomBy(direction) {
    const current = this.scale;
    const steps = direction > 0 ? ZOOM_STEPS.filter((z) => z > current + 0.001) : ZOOM_STEPS.filter((z) => z < current - 0.001).reverse();
    if (steps.length) this.setZoom(steps[0]);
  }

  /**
   * Find quoted words: the hinted page first, then its neighbours, then the
   * rest. Searches pdf.js text content, so undrawn pages count too.
   * @returns {{ page: number, boxes: object[] } | null}
   */
  async locate(quote, hint) {
    if (!this.doc || !quote) return null;
    this.textCache ??= new Map();
    for (const n of searchOrder(this.doc.numPages, hint)) {
      if (this.disposed) return null;
      let entry = this.textCache.get(n);
      if (!entry) {
        const page = await this.doc.getPage(n);
        const { items } = await page.getTextContent();
        entry = { items, viewport: page.getViewport({ scale: 1 }) };
        this.textCache.set(n, entry);
      }
      const spans = findInItems(entry.items, quote);
      if (spans) return { page: n, boxes: boxesFor(spans, entry.items, entry.viewport) };
    }
    return null;
  }

  /** Scroll a passage into view (about a third down the screen) and highlight it. */
  reveal(n, boxes = []) {
    const page = this.pages[n - 1];
    if (!page) return;
    if (boxes.length) {
      const top = Math.min(...boxes.map((b) => b.y));
      const target = this.topOf(n) + top * page.h - this.scroller.clientHeight * 0.3;
      this.scroller.scrollTop = Math.max(0, target);
      this.trackPage();
      this.schedule();
    } else {
      this.scrollToPage(n);
    }
    this.flash(n, boxes);
  }

  /** Briefly mark a page, and the passage on it when given (in page-relative fractions). */
  flash(n, boxes = []) {
    const page = this.pages[n - 1];
    if (!page) return;
    page.el.classList.remove('dpa-flash');
    void page.el.offsetWidth;
    page.el.classList.add('dpa-flash');
    for (const box of boxes) {
      const mark = document.createElement('div');
      mark.className = 'dpa-mark';
      mark.style.left = `${box.x * 100}%`;
      mark.style.top = `${box.y * 100}%`;
      mark.style.width = `${box.w * 100}%`;
      mark.style.height = `${box.h * 100}%`;
      page.el.appendChild(mark);
      setTimeout(() => mark.remove(), 3400);
    }
    setTimeout(() => page.el.classList.remove('dpa-flash'), 1600);
  }

  dispose() {
    this.disposed = true;
    if (this.frame) cancelAnimationFrame(this.frame);
    clearTimeout(this.settleTimer);
    this.resizeObserver.disconnect();
    this.scroller.removeEventListener('scroll', this.onScroll);
    this.detachSelection?.();
    for (const page of this.pages) this.release(page);
    this.task?.destroy?.();
    this.container.replaceChildren();
  }
}

/**
 * Where a DOM selection sits in a PDF: its page and, for a later flash, its
 * boxes as fractions of that page. Null when the selection is not on a page.
 */
export function selectionInPdf(selection, root) {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const node = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
  const pageEl = node?.closest?.('.dpa-page');
  if (!pageEl || !root.contains(pageEl)) return null;
  const text = selection.toString();
  if (text.trim() === '') return null;
  const pageRect = pageEl.getBoundingClientRect();
  const boxes = [...range.getClientRects()]
    .filter((r) => r.width > 1 && r.height > 1)
    .map((r) => ({
      x: (r.left - pageRect.left) / pageRect.width,
      y: (r.top - pageRect.top) / pageRect.height,
      w: r.width / pageRect.width,
      h: r.height / pageRect.height,
    }))
    .filter((b) => b.x > -0.05 && b.x < 1.05 && b.y > -0.05 && b.y < 1.05 && b.w < 1.1);
  const rect = range.getBoundingClientRect();
  return { page: Number(pageEl.dataset.page), text, boxes, rect };
}
