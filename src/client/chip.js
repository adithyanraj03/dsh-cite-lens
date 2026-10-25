// dsh-cite-lens — the /cite-links indicator: a link icon (with a dot when on).
//
// Shown in the chat's top bar (slot conversation.session.header.utilities),
// just left of the context gauge and the ⋮ menu. CiteLinksChip (the same
// indicator sized for the chat bar) is kept for reuse but not registered.
// Off: a faint link icon that turns it on. On: the icon in blue with a softly
// pulsing dot; turning it on plays a short pop so the change is noticed.
// Clicking either toggles. The state is the host's (typing /cite-links also
// changes it), so it is re-read every couple of seconds while visible and on
// window focus — once per chat, however many indicators are showing.

import React from 'react';

const h = React.createElement;
const { useEffect, useRef, useState } = React;
const BASE = '/plugin-data/dsh-cite-lens';
const POLL_MS = 2500;

export const CHIP_CSS = [
  '.dpa-chip{display:inline-flex;align-items:center;justify-content:center;gap:4px;border:1px solid transparent;background:transparent;'
    + 'color:var(--dsw-alias-label-secondary,inherit);font:inherit;cursor:pointer;position:relative;flex:none;transition:background .15s,border-color .15s,opacity .15s,color .15s}',
  '.dpa-chip svg{flex:none;display:block}',
  // chat bar: a small round pill
  '.dpa-chip.dpa-bar{height:26px;min-width:26px;padding:0 6px;border-radius:999px}',
  // top bar: same size and corners as the other header buttons
  '.dpa-chip.dpa-head{height:28px;min-width:28px;padding:0 7px;border-radius:8px}',
  '.dpa-chip.dpa-off{opacity:.55}',
  '.dpa-chip.dpa-off:hover{opacity:1;background:var(--dsw-alias-bg-module-platform,rgba(128,128,128,.15));color:var(--dsw-alias-label-primary,inherit)}',
  '.dpa-chip.dpa-on{color:#60a5fa;background:rgba(59,130,246,.13);border-color:rgba(59,130,246,.42)}',
  '.dpa-chip.dpa-on:hover{background:rgba(59,130,246,.22)}',
  '.dpa-chip .dpa-chip-dot{width:6px;height:6px;border-radius:50%;background:#60a5fa;animation:dpa-chip-breathe 2.4s ease-in-out infinite}',
  '@keyframes dpa-chip-breathe{0%,100%{opacity:.5}50%{opacity:1}}',
  // turning on: a quick pop and a glow ring
  '.dpa-chip.dpa-arrive{animation:dpa-chip-pop .42s cubic-bezier(.2,1.4,.4,1),dpa-chip-glow 1.4s ease-out}',
  '@keyframes dpa-chip-pop{0%{transform:scale(.7)}60%{transform:scale(1.15)}100%{transform:scale(1)}}',
  '@keyframes dpa-chip-glow{0%{box-shadow:0 0 0 0 rgba(59,130,246,.65)}100%{box-shadow:0 0 0 9px rgba(59,130,246,0)}}',
].join('\n');

function LinkIcon(size) {
  return h(
    'svg',
    { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
    h('path', { d: 'M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5' }),
    h('path', { d: 'M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5' }),
  );
}

/* ---- one shared state per chat ------------------------------------------- */

const chats = new Map(); // sessionId -> { on, listeners:Set, timer, arrivedAt }

/**
 * The last chat this indicator was rendered for. The header hands every chat's
 * top bar its session id, so this is known even when the sessions list has no
 * selection (dsh 0.2.x) — which is one of the ways a citation can find the
 * workspace a relative PDF path belongs to.
 */
let lastSeenSessionId = null;

/** The most recent chat whose top bar rendered, or undefined before any chat. */
export function lastSessionId() {
  return lastSeenSessionId || undefined;
}

function emit(entry) {
  for (const listener of [...entry.listeners]) listener(entry);
}

async function read(sessionId, entry) {
  try {
    const res = await fetch(`${BASE}/cite-links?session=${encodeURIComponent(sessionId)}`, { headers: { accept: 'application/json' } });
    if (!res.ok) return;
    set(entry, Boolean((await res.json()).on));
  } catch { /* keep the last known state */ }
}

function set(entry, on) {
  if (entry.on === on) return;
  // Animate only a real off → on change, not the first read of a chat already on.
  if (on && entry.on === false) entry.arrivedAt = Date.now();
  entry.on = on;
  emit(entry);
}

function subscribe(sessionId, listener) {
  hookFocus();
  let entry = chats.get(sessionId);
  if (!entry) {
    entry = { on: null, listeners: new Set(), timer: null, arrivedAt: 0 };
    chats.set(sessionId, entry);
  }
  entry.listeners.add(listener);
  if (entry.timer === null) {
    read(sessionId, entry);
    entry.timer = setInterval(() => {
      if (document.visibilityState === 'visible') read(sessionId, entry);
    }, POLL_MS);
  }
  listener(entry);
  return () => {
    entry.listeners.delete(listener);
    if (entry.listeners.size === 0) {
      clearInterval(entry.timer);
      entry.timer = null;
    }
  };
}

async function toggle(sessionId) {
  const entry = chats.get(sessionId);
  if (!entry || entry.on === null) return;
  const next = !entry.on;
  set(entry, next); // answer the click at once; the host confirms
  try {
    const res = await fetch(`${BASE}/cite-links`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ session: sessionId, on: next }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    set(entry, Boolean((await res.json()).on));
  } catch {
    set(entry, !next);
  }
}

let focusHooked = false;
/** Re-read every shown chat when the window regains focus; hooked on first use. */
function hookFocus() {
  if (focusHooked || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  focusHooked = true;
  window.addEventListener('focus', () => {
    for (const [sessionId, entry] of chats) if (entry.listeners.size) read(sessionId, entry);
  });
}

/* ---- the indicator -------------------------------------------------------- */

function CiteLinks({ sessionId, variant }) {
  const [state, setState] = useState({ on: null, arriving: false });
  const arriveTimer = useRef(null);

  useEffect(() => {
    if (!sessionId) return undefined;
    lastSeenSessionId = String(sessionId);
    const off = subscribe(sessionId, (entry) => {
      const arriving = entry.on === true && Date.now() - entry.arrivedAt < 1400;
      setState({ on: entry.on, arriving });
      clearTimeout(arriveTimer.current);
      if (arriving) arriveTimer.current = setTimeout(() => setState((s) => ({ ...s, arriving: false })), 1450);
    });
    return () => {
      off();
      clearTimeout(arriveTimer.current);
    };
  }, [sessionId]);

  if (!sessionId || state.on === null) return null;
  const size = variant === 'head' ? 15 : 14;
  const kind = variant === 'head' ? 'dpa-head' : 'dpa-bar';
  if (!state.on) {
    return h('button', {
      type: 'button',
      className: `dpa-chip ${kind} dpa-off`,
      title: 'Citation links: off — click to make answers link each claim to the PDF (or type /cite-links)',
      'aria-label': 'Turn citation links on',
      'aria-pressed': 'false',
      onClick: () => toggle(sessionId),
    }, LinkIcon(size));
  }
  return h('button', {
    type: 'button',
    className: `dpa-chip ${kind} dpa-on${state.arriving ? ' dpa-arrive' : ''}`,
    title: 'Citation links: ON for this chat — answers link each claim to the PDF. Click to turn off.',
    'aria-label': 'Citation links on — turn off',
    'aria-pressed': 'true',
    onClick: () => toggle(sessionId),
  }, h('span', { className: 'dpa-chip-dot', 'aria-hidden': 'true' }), LinkIcon(size));
}

/** For the chat bar. */
export function CiteLinksChip(props) {
  return h(CiteLinks, { sessionId: props?.sessionId ? String(props.sessionId) : null, variant: 'bar' });
}

/** For the chat's top bar. */
export function CiteLinksHeaderButton(props) {
  return h(CiteLinks, { sessionId: props?.sessionId ? String(props.sessionId) : null, variant: 'head' });
}
