// dsh-cite-lens — find quoted words in a PDF page and where they sit.
//
// Works on pdf.js text content (page.getTextContent()), not the rendered text
// layer, so a page can be searched before it is drawn. Matching forgives what
// a model cannot know from the LaTeX source: line breaks, words hyphenated
// across lines, ligatures (pdf.js already expands ﬁ to fi), curly vs straight
// quotes, dash styles, spacing and case. A second, looser pass ignores
// punctuation altogether.

/** One character of normalized page text, and where it came from. */
function pushChar(out, ch, item, offset) {
  out.chars.push(ch);
  out.src.push(item, offset);
}

const DASHES = /[‐-―−]/g;
const QUOTES_S = /[‘’‚‛′]/g;
const QUOTES_D = /[“”„‟″]/g;

/** Fold one piece of text the same way page text is folded. */
function fold(text) {
  return text
    .normalize('NFKC')
    .replace(/­/g, '')
    .replace(DASHES, '-')
    .replace(QUOTES_S, "'")
    .replace(QUOTES_D, '"')
    .toLowerCase();
}

/**
 * Page text as one normalized string, with each character mapped back to
 * (item index, offset in that item's str).
 * @param items pdf.js text items ({ str, hasEOL, transform, width, height })
 * @param loose drop everything but letters and digits
 */
export function indexPage(items, loose = false) {
  const out = { chars: [], src: [] };
  let lastSpace = true;
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const str = typeof item?.str === 'string' ? item.str : '';
    for (let j = 0; j < str.length; j += 1) {
      // Fold per source character so each output char keeps a source position.
      for (const ch of fold(str[j])) {
        if (/\s/.test(ch)) {
          if (!loose && !lastSpace) pushChar(out, ' ', i, j);
          lastSpace = true;
        } else if (loose && !/[\p{L}\p{N}]/u.test(ch)) {
          // punctuation dropped in the loose pass
        } else {
          pushChar(out, ch, i, j);
          lastSpace = false;
        }
      }
    }
    if (item?.hasEOL || i === items.length - 1) {
      // A word hyphenated across the line break joins up: "evalu-" + "ation".
      const n = out.chars.length;
      if (!loose && n >= 2 && out.chars[n - 1] === '-' && /[\p{L}]/u.test(out.chars[n - 2])) {
        out.chars.pop();
        out.src.length -= 2;
        lastSpace = true; // no space: the next line continues the word
        continue;
      }
      if (!loose && !lastSpace) {
        pushChar(out, ' ', i, str.length);
        lastSpace = true;
      }
    } else if (!loose && str !== '' && !lastSpace && items[i + 1] && /^\s/.test(items[i + 1].str ?? '') === false
      && Math.abs((items[i + 1].transform?.[5] ?? 0) - (item.transform?.[5] ?? 0)) > 0.5 * (item.height || 10)) {
      // Next item on another line without hasEOL: treat as a break.
      pushChar(out, ' ', i, str.length);
      lastSpace = true;
    }
  }
  return { text: out.chars.join(''), src: out.src };
}

/** The query folded the same way. */
export function foldQuery(query, loose = false) {
  const folded = fold(String(query ?? ''))
    .replace(/(\p{L})-\s+(\p{L})/gu, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
  return loose ? folded.replace(/[^\p{L}\p{N}]/gu, '') : folded;
}

/**
 * Find a quote in one page's text items.
 * @returns per-item character spans [{ item, from, to }], or null
 */
export function findInItems(items, query) {
  for (const loose of [false, true]) {
    const q = foldQuery(query, loose);
    if (q.length < (loose ? 4 : 3)) continue;
    const page = indexPage(items, loose);
    const at = page.text.indexOf(q);
    if (at < 0) continue;
    const spans = new Map();
    for (let k = at; k < at + q.length; k += 1) {
      const item = page.src[k * 2];
      const offset = page.src[k * 2 + 1];
      const span = spans.get(item);
      if (span) {
        span.from = Math.min(span.from, offset);
        span.to = Math.max(span.to, offset + 1);
      } else {
        spans.set(item, { item, from: offset, to: offset + 1 });
      }
    }
    return [...spans.values()]
      .map((s) => ({ ...s, to: Math.min(s.to, (items[s.item].str ?? '').length) }))
      .filter((s) => s.to > s.from)
      .sort((a, b) => a.item - b.item);
  }
  return null;
}

/**
 * Boxes for matched spans, as fractions of the page.
 * @param viewport a pdf.js viewport at scale 1 (width, height, convertToViewportPoint)
 */
export function boxesFor(spans, items, viewport) {
  const boxes = [];
  for (const { item: index, from, to } of spans) {
    const item = items[index];
    const t = item.transform;
    const len = Math.max(1, (item.str ?? '').length);
    const fontHeight = item.height || Math.hypot(t[2], t[3]) || 10;
    const x = t[4] + (item.width * from) / len;
    const w = (item.width * (to - from)) / len;
    // Baseline to cap height, plus room for descenders.
    const y0 = t[5] - fontHeight * 0.22;
    const y1 = t[5] + fontHeight * 0.92;
    // (pdf.js 6 has no convertToViewportRectangle: convert the two corners.)
    const [ax, ay] = viewport.convertToViewportPoint(x, y0);
    const [bx, by] = viewport.convertToViewportPoint(x + w, y1);
    const left = Math.min(ax, bx);
    const top = Math.min(ay, by);
    boxes.push({
      x: left / viewport.width,
      y: top / viewport.height,
      w: Math.abs(bx - ax) / viewport.width,
      h: Math.abs(by - ay) / viewport.height,
    });
  }
  return boxes.filter((b) => b.w > 0 && b.h > 0);
}

/** Pages to search: the hinted one, its neighbours, then the rest in order. */
export function searchOrder(numPages, hint) {
  const order = [];
  const seen = new Set();
  const add = (n) => {
    if (n >= 1 && n <= numPages && !seen.has(n)) {
      seen.add(n);
      order.push(n);
    }
  };
  if (hint) for (const d of [0, 1, -1, 2, -2]) add(hint + d);
  for (let n = 1; n <= numPages; n += 1) add(n);
  return order;
}
