'use strict';

// Pane layout for the Twitch Stream panel. The pure parts live at the top so
// node:test can require this file; everything below them touches the DOM and only
// runs when called from the browser.
//
// A tab is { name, panes: [ {kind, channel, grow} ] }.
//   kind 'chat'   — one Twitch channel, `channel` is its login
//   kind 'events' — the alert/event feed
//   kind 'obs'    — the compact OBS controls
//
// ponytail: horizontal panes only. Chatterino's nested split tree is a lot of
// machinery for a layout nobody has asked for yet; add it if someone does.

const PANE_KINDS = ['chat', 'events', 'obs'];
const PANE_MIN_PX = 180;

// Redistributes flex-grow between two adjacent panes after a drag of `deltaPx`.
// Works in grow units rather than pixels so the layout survives a window resize
// on its own, with no recalculation.
function resizePanes(growA, growB, pxA, pxB, deltaPx, minPx = PANE_MIN_PX) {
  const totalGrow = growA + growB;
  const totalPx = pxA + pxB;
  // Nothing sensible to redistribute, or the pair is already too small to split.
  if (totalGrow <= 0 || totalPx <= 0 || totalPx < minPx * 2) return [growA, growB];
  const newPxA = Math.max(minPx, Math.min(totalPx - minPx, pxA + deltaPx));
  return [
    totalGrow * (newPxA / totalPx),
    totalGrow * ((totalPx - newPxA) / totalPx),
  ];
}

// The layout shown before anyone customises it: today's Chat + Events columns.
function defaultTabs(homeLogin) {
  return [{
    name: 'Stream',
    panes: [
      { kind: 'chat', channel: String(homeLogin || '').toLowerCase(), grow: 1 },
      { kind: 'events', grow: 1 },
    ],
  }];
}

// Stored layout is user-editable JSON that also survives app upgrades, so treat it
// as untrusted: drop unknown kinds, chat panes with no channel, and empty tabs
// rather than rendering a broken layout.
function normalizeTabs(raw, homeLogin) {
  let list;
  try {
    list = typeof raw === 'string' ? JSON.parse(raw || '[]') : raw;
  } catch {
    return defaultTabs(homeLogin);
  }
  if (!Array.isArray(list)) return defaultTabs(homeLogin);

  const tabs = [];
  for (const tab of list) {
    if (!tab || typeof tab !== 'object') continue;
    const panes = [];
    for (const pane of (Array.isArray(tab.panes) ? tab.panes : [])) {
      if (!pane || !PANE_KINDS.includes(pane.kind)) continue;
      const channel = String(pane.channel || '').toLowerCase();
      if (pane.kind === 'chat' && !channel) continue;
      const grow = Number(pane.grow);
      panes.push({
        kind: pane.kind,
        ...(pane.kind === 'chat' ? { channel } : {}),
        grow: Number.isFinite(grow) && grow > 0 ? grow : 1,
      });
    }
    if (panes.length) tabs.push({ name: String(tab.name || 'Stream').slice(0, 40), panes });
  }
  return tabs.length ? tabs : defaultTabs(homeLogin);
}

// Which panes a chat message belongs in. A channel can legitimately be open in
// more than one pane, so this returns every match rather than the first.
function panesForMessage(panes, channel) {
  const want = String(channel || '').toLowerCase();
  const out = [];
  for (let i = 0; i < panes.length; i++) {
    if (panes[i].kind === 'chat' && panes[i].channel === want) out.push(i);
  }
  return out;
}

// Every distinct channel the layout needs emotes and badges for.
function channelsInTabs(tabs) {
  const seen = [];
  for (const tab of tabs) {
    for (const pane of tab.panes) {
      if (pane.kind === 'chat' && pane.channel && !seen.includes(pane.channel)) seen.push(pane.channel);
    }
  }
  return seen;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    PANE_KINDS, PANE_MIN_PX,
    resizePanes, defaultTabs, normalizeTabs, panesForMessage, channelsInTabs,
  };
}

// ── Browser half ──────────────────────────────────────────────────────────────
// Nothing below runs on require(); it all needs a document.

const AUTOSCROLL_SLOP_PX = 40;  // treat "within 40px of the bottom" as pinned
const PANE_CHAT_MAX = 200;      // messages kept per pane before the top is trimmed

// Per-channel emote and badge maps, keyed by login. A single shared map would
// render one channel's emote in another channel's pane.
const paneEmotes = {};
const paneBadges = {};

let paneTabs = [];
let paneActiveTab = 0;
let paneHome = '';
let paneSaveTimer = null;

function paneCurrent() {
  return paneTabs[paneActiveTab] || { name: 'Stream', panes: [] };
}

// Debounced so a drag writes once when it settles, not on every pointermove.
function savePaneLayout() {
  clearTimeout(paneSaveTimer);
  paneSaveTimer = setTimeout(() => {
    fetch('/api/chat/tabs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tabs: paneTabs }),
    }).catch(() => {});
  }, 600);
}

async function loadChannelAssets(login) {
  if (!login || paneEmotes[login]) return;
  paneEmotes[login] = {};   // claim the slot so concurrent panes don't double-fetch
  paneBadges[login] = paneBadges[login] || {};
  const q = encodeURIComponent(login);
  try {
    const [e, b] = await Promise.all([
      fetch(`/api/chat/emotes?channel=${q}`).then(r => r.ok ? r.json() : {}),
      fetch(`/api/chat/badges?channel=${q}`).then(r => r.ok ? r.json() : {}),
    ]);
    paneEmotes[login] = e;
    paneBadges[login] = b;
  } catch { /* keep the empty maps; text still renders */ }
}

function paneHeaderHtml(pane) {
  const label = pane.kind === 'chat' ? pane.channel
              : pane.kind === 'events' ? 'Events' : 'OBS';
  const detach = window.electronAPI?.detachPane
    ? `<button class="pane-btn pane-detach" title="Open in its own window">⧉</button>` : '';
  return `<span class="pane-title">${esc(label)}</span>` +
         `<span class="pane-actions">${detach}<button class="pane-btn pane-close" title="Close pane">×</button></span>`;
}

function buildPane(pane, index) {
  const el = document.createElement('div');
  el.className = 'stream-col';
  el.dataset.index = String(index);
  el.dataset.kind = pane.kind;
  if (pane.channel) el.dataset.channel = pane.channel;
  el.style.flexGrow = String(pane.grow || 1);

  const empty = pane.kind === 'events' ? 'No events yet' : 'Waiting for chat…';
  const body = pane.kind === 'obs'
    ? `<div class="pane-obs" data-role="obs"></div>`
    : `<div class="stream-messages" data-role="messages">` +
      `<div class="empty-state" style="padding:20px 0">${empty}</div></div>`;

  const input = pane.kind === 'chat' ? `
    <div class="stream-chat-input-wrap">
      <button class="stream-chat-sender-btn" data-role="sender" data-tip="Click to switch sender account">
        <span data-role="sender-icon">🤖</span><span data-role="sender-label">Bot</span>
      </button>
      <input class="stream-chat-input" data-role="input" type="text" placeholder="Send a message…" maxlength="500" autocomplete="off" />
      <button class="stream-chat-send" data-role="send">Send</button>
    </div>` : '';

  el.innerHTML =
    `<div class="stream-col-header">${paneHeaderHtml(pane)}</div>` +
    body +
    `<div class="pane-new-pill" data-role="new-pill" hidden>▼ new messages</div>` +
    input;
  return el;
}

function renderPanes() {
  const wrap = document.getElementById('stream-wrap');
  if (!wrap) return;
  wrap.innerHTML = '';

  // Every tab keeps its DOM. Hiding instead of rebuilding means switching tabs
  // preserves each pane's scrollback, and costs less code than buffering
  // messages for tabs that are not on screen.
  paneTabs.forEach((tab, ti) => {
    const group = document.createElement('div');
    group.className = 'cpane-group' + (ti === paneActiveTab ? ' active' : '');
    group.dataset.tab = String(ti);

    tab.panes.forEach((pane, i) => {
      if (i > 0) {
        const handle = document.createElement('div');
        handle.className = 'pane-resize';
        handle.dataset.left = String(i - 1);
        group.appendChild(handle);
      }
      group.appendChild(buildPane(pane, i));
      if (pane.kind === 'chat') loadChannelAssets(pane.channel);
    });
    wrap.appendChild(group);
  });

  renderTabStrip();
  // OBS panes reuse the existing dashboard renderer.
  if (paneTabs.some(t => t.panes.some(p => p.kind === 'obs')) && typeof syncObsSplitCol === 'function') syncObsSplitCol();
  refreshSenderButtons();
}

function renderTabStrip() {
  const strip = document.getElementById('chat-tabs');
  if (!strip) return;   // absent in a detached dock
  // Own classes, never .dtab/.sub-panel: those selectors are unscoped, so the two
  // tab systems would clear each other's active state.
  strip.innerHTML = paneTabs.map((t, i) =>
    `<button class="ctab${i === paneActiveTab ? ' active' : ''}" data-tab="${i}">` +
    `${esc(t.name)}${paneTabs.length > 1 ? '<span class="ctab-close" title="Close tab">\u00d7</span>' : ''}</button>`
  ).join('') + `<button class="ctab-add" id="ctab-add" title="New tab">+</button>`;
}

function switchTab(index) {
  if (index < 0 || index >= paneTabs.length || index === paneActiveTab) return;
  paneActiveTab = index;
  document.querySelectorAll('#stream-wrap .cpane-group').forEach(g => {
    g.classList.toggle('active', Number(g.dataset.tab) === index);
  });
  renderTabStrip();
  // Panes that were hidden could not track scroll position, so pin them.
  document.querySelectorAll('#stream-wrap .cpane-group.active [data-role="messages"]').forEach(box => {
    box.scrollTop = box.scrollHeight;
  });
}

function addTab() {
  const name = prompt('Name for the new tab:', `Tab ${paneTabs.length + 1}`);
  if (!name) return;
  paneTabs.push({ name: String(name).slice(0, 40), panes: [{ kind: 'events', grow: 1 }] });
  paneActiveTab = paneTabs.length - 1;
  renderPanes();
  savePaneLayout();
}

function closeTab(index) {
  if (paneTabs.length <= 1) return;   // never leave the panel with no tabs
  paneTabs.splice(index, 1);
  if (paneActiveTab >= paneTabs.length) paneActiveTab = paneTabs.length - 1;
  renderPanes();
  savePaneLayout();
}

function renameTab(index) {
  const tab = paneTabs[index];
  if (!tab) return;
  const name = prompt('Rename tab:', tab.name);
  if (!name) return;
  tab.name = String(name).slice(0, 40);
  renderTabStrip();
  savePaneLayout();
}

// True when the user is reading the bottom of the log. Anything else means they
// have scrolled back and must not be yanked away from what they are reading.
function paneIsPinned(box) {
  return box.scrollHeight - box.scrollTop - box.clientHeight < AUTOSCROLL_SLOP_PX;
}

function paneAppend(box, el) {
  const pinned = paneIsPinned(box);
  box.appendChild(el);
  while (box.children.length > PANE_CHAT_MAX) box.firstChild.remove();
  if (pinned) {
    box.scrollTop = box.scrollHeight;
  } else {
    const pill = box.parentElement?.querySelector('[data-role="new-pill"]');
    if (pill) pill.hidden = false;
  }
}

function routeChatToPanes(data) {
  const wrap = document.getElementById('stream-wrap');
  if (!wrap) return;
  // Background tabs receive messages too, so switching to one shows history
  // rather than an empty pane that fills from scratch.
  paneTabs.forEach((tab, ti) => {
    const group = wrap.querySelector(`.cpane-group[data-tab="${ti}"]`);
    if (!group) return;
    for (const idx of panesForMessage(tab.panes, data.channel)) {
      const col = group.querySelector(`.stream-col[data-index="${idx}"]`);
      const box = col?.querySelector('[data-role="messages"]');
      if (!box) continue;
      const verdict = applyRules(paneCompiled, data);
      if (verdict.hide) continue;   // never built, so it costs nothing to skip
      box.querySelector('.empty-state')?.remove();
      const login = col.dataset.channel;
      const row = buildChatRow(data, paneEmotes[login] || {}, paneBadges[login] || {});
      if (verdict.highlight) row.classList.add('chat-hl');
      paneAppend(box, row);
    }
  });
}

function routeEventToPanes(html) {
  const wrap = document.getElementById('stream-wrap');
  if (!wrap) return;
  wrap.querySelectorAll('.stream-col[data-kind="events"] [data-role="messages"]').forEach(box => {
    box.querySelector('.empty-state')?.remove();
    const el = document.createElement('div');
    el.className = 'stream-event';
    el.innerHTML = html;
    paneAppend(box, el);
  });
}

function buildChatRow(data, emotes, badges) {
  const colour = (data.color && data.color.length === 7) ? data.color : nameToColour(data.user || '');
  const source = data.sourceChannel ? `<span class="chat-source-tag">${esc(data.sourceChannel)}</span>` : '';
  const el = document.createElement('div');
  el.className = 'chat-msg';
  // Stamped for filtering in a later phase, and useful for moderation tooling.
  el.dataset.user = (data.login || data.user || '').toLowerCase();
  el.dataset.channel = data.channel || '';
  if (data.id) el.dataset.msgId = data.id;
  el.innerHTML =
    `${renderBadges(data.badges, badges)}${source}` +
    `<span class="chat-user" style="color:${colour}">${esc(data.user)}</span>` +
    `<span style="opacity:0.5;margin-right:4px">:</span>${renderBody(data, emotes)}`;
  return el;
}

// Pointer capture rather than document-level mousemove/mouseup: the browser
// releases it for us, so there is no listener left behind if the drag ends off
// the window or the element is re-rendered mid-drag.
function startPaneDrag(handle, ev) {
  const group = handle.parentElement;
  const li = Number(handle.dataset.left);
  const a = group.querySelector(`.stream-col[data-index="${li}"]`);
  const b = group.querySelector(`.stream-col[data-index="${li + 1}"]`);
  if (!a || !b) return;

  const startX = ev.clientX;
  const pxA = a.getBoundingClientRect().width;
  const pxB = b.getBoundingClientRect().width;
  const growA = parseFloat(a.style.flexGrow) || 1;
  const growB = parseFloat(b.style.flexGrow) || 1;

  handle.setPointerCapture(ev.pointerId);
  handle.classList.add('dragging');

  const move = e => {
    const [ga, gb] = resizePanes(growA, growB, pxA, pxB, e.clientX - startX);
    a.style.flexGrow = String(ga);
    b.style.flexGrow = String(gb);
  };
  const done = () => {
    handle.removeEventListener('pointermove', move);
    handle.classList.remove('dragging');
    const panes = paneTabs[Number(group.dataset.tab)]?.panes || [];
    if (panes[li]) panes[li].grow = parseFloat(a.style.flexGrow) || 1;
    if (panes[li + 1]) panes[li + 1].grow = parseFloat(b.style.flexGrow) || 1;
    savePaneLayout();
  };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', done, { once: true });
  handle.addEventListener('pointercancel', done, { once: true });
  ev.preventDefault();
}

function closePane(tabIndex, paneIndex) {
  const panes = paneTabs[tabIndex]?.panes;
  if (!panes || panes.length <= 1) return;  // never leave a tab with nothing in it
  panes.splice(paneIndex, 1);
  renderPanes();
  savePaneLayout();
}

async function addPane(pane) {
  if (pane.kind === 'chat') {
    // Joining is what makes messages arrive; the pane is useless without it.
    const r = await fetch('/api/chat/channels', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: pane.channel }),
    });
    if (!r.ok && pane.channel !== paneHome) {
      const { error } = await r.json().catch(() => ({}));
      return { ok: false, error: error || 'Could not join that channel' };
    }
  }
  paneCurrent().panes.push({ grow: 1, ...pane });
  renderPanes();
  savePaneLayout();
  return { ok: true };
}

// ── Per-pane send ─────────────────────────────────────────────────────────────
// One sender choice shared across panes (it is an account, not a per-room thing),
// but each pane has its own input because each targets its own channel.
let paneChatSender = 'bot';
let paneKnownBot = '';

function setPaneBotName(name) {
  paneKnownBot = name || '';
  if (!paneKnownBot) paneChatSender = 'broadcaster';
  refreshSenderButtons();
}

function refreshSenderButtons() {
  document.querySelectorAll('#stream-wrap [data-role="sender"]').forEach(btn => {
    const icon = btn.querySelector('[data-role="sender-icon"]');
    const label = btn.querySelector('[data-role="sender-label"]');
    // No bot configured: nothing to toggle between, so hide the affordance.
    btn.classList.toggle('active', !!paneKnownBot);
    btn.hidden = !paneKnownBot;
    if (!paneKnownBot) return;
    const asBot = paneChatSender === 'bot';
    btn.dataset.sender = asBot ? 'bot' : 'broadcaster';
    if (icon) icon.textContent = asBot ? '\u{1F916}' : '\u{1F64B}';
    if (label) label.textContent = asBot ? paneKnownBot : 'Me';
  });
}

async function sendFromPane(col) {
  const input = col.querySelector('[data-role="input"]');
  const btn = col.querySelector('[data-role="send"]');
  const channel = col.dataset.channel;
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;

  input.disabled = true;
  if (btn) btn.disabled = true;
  try {
    const res = await fetch('/api/chat/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, sender: paneChatSender, channel }),
    });
    if (res.ok) {
      input.value = '';
    } else {
      // Sub-only, follower-only, slow mode and bans all land here, and the reason
      // is the only thing that tells you which. Show it on the pane, not console.
      const { error } = await res.json().catch(() => ({}));
      showPaneError(col, error || `Send failed (${res.status})`);
    }
  } catch (e) {
    showPaneError(col, e.message);
  } finally {
    input.disabled = false;
    if (btn) btn.disabled = false;
    input.focus();
  }
}

function showPaneError(col, message) {
  const box = col.querySelector('[data-role="messages"]');
  if (!box) return;
  const el = document.createElement('div');
  el.className = 'pane-error';
  el.textContent = message;
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
  setTimeout(() => el.remove(), 8000);
}

// One delegated listener for the whole wrap, so panes added later just work.
function wirePaneEvents() {
  const wrap = document.getElementById('stream-wrap');
  if (!wrap || wrap.dataset.wired) return;
  wrap.dataset.wired = '1';

  wrap.addEventListener('pointerdown', e => {
    const handle = e.target.closest('.pane-resize');
    if (handle) startPaneDrag(handle, e);
  });

  wrap.addEventListener('click', e => {
    const col = e.target.closest('.stream-col');
    if (!col) return;
    const ti = Number(col.closest('.cpane-group')?.dataset.tab ?? paneActiveTab);
    if (e.target.closest('.pane-close')) return closePane(ti, Number(col.dataset.index));
    if (e.target.closest('.pane-detach')) {
      const pane = paneTabs[ti]?.panes[Number(col.dataset.index)];
      window.electronAPI?.detachPane?.(pane);
      return;
    }
    if (e.target.closest('[data-role="send"]')) return void sendFromPane(col);
    if (e.target.closest('[data-role="sender"]')) {
      paneChatSender = paneChatSender === 'bot' ? 'broadcaster' : 'bot';
      refreshSenderButtons();
      return;
    }
    if (e.target.closest('[data-role="new-pill"]')) {
      const box = col.querySelector('[data-role="messages"]');
      if (box) box.scrollTop = box.scrollHeight;
      col.querySelector('[data-role="new-pill"]').hidden = true;
    }
  });

  wrap.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || !e.target.matches('[data-role="input"]')) return;
    const col = e.target.closest('.stream-col');
    if (col) sendFromPane(col);
  });

  // Hide the "new messages" pill as soon as the user scrolls back to the bottom.
  wrap.addEventListener('scroll', e => {
    const box = e.target;
    if (!box.matches?.('[data-role="messages"]')) return;
    if (paneIsPinned(box)) {
      const pill = box.parentElement?.querySelector('[data-role="new-pill"]');
      if (pill) pill.hidden = true;
    }
  }, true);
}

function wireTabStrip() {
  const strip = document.getElementById('chat-tabs');
  if (!strip || strip.dataset.wired) return;
  strip.dataset.wired = '1';
  strip.addEventListener('click', e => {
    if (e.target.closest('#ctab-add')) return addTab();
    const tab = e.target.closest('.ctab');
    if (!tab) return;
    const i = Number(tab.dataset.tab);
    if (e.target.closest('.ctab-close')) return closeTab(i);
    switchTab(i);
  });
  strip.addEventListener('dblclick', e => {
    const tab = e.target.closest('.ctab');
    if (tab) renameTab(Number(tab.dataset.tab));
  });
}

async function initPanes() {
  wirePaneEvents();
  wireTabStrip();
  wireFilterPanel();
  await loadFilters();
  try {
    const r = await fetch('/api/chat/tabs');
    const { tabs, home } = await r.json();
    paneHome = home || '';
    paneTabs = normalizeTabs(tabs, paneHome);
  } catch {
    paneTabs = defaultTabs(paneHome);
  }
  renderPanes();
}

// Drops every cached channel map and refetches for the panes currently open.
// Called when the emote providers change or the server signals new emote data.
async function reloadPaneAssets() {
  const logins = channelsInTabs(paneTabs);
  for (const k of Object.keys(paneEmotes)) delete paneEmotes[k];
  await Promise.all(logins.map(loadChannelAssets));
}

function paneHint(msg) {
  const el = document.getElementById('pane-hint');
  if (!el) return;
  el.textContent = msg || '';
  if (msg) setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 6000);
}

function wirePaneToolbar() {
  const add = (id, make) => document.getElementById(id)?.addEventListener('click', async () => {
    const pane = await make();
    if (!pane) return;
    const r = await addPane(pane);
    paneHint(r.ok ? '' : r.error);
  });

  add('pane-add-chat', () => {
    const name = prompt('Channel to open (Twitch login):', '');
    return name ? { kind: 'chat', channel: String(name).trim().toLowerCase() } : null;
  });
  add('pane-add-events', () => ({ kind: 'events' }));
  add('pane-add-obs', () => ({ kind: 'obs' }));
}

// A detached dock is the same code with one pane and no chrome. pane.html loads
// this file too, so the query string decides which bootstrap runs.
async function initSinglePane() {
  const q = new URLSearchParams(location.search);
  const kind = q.get('kind') || 'chat';
  const channel = (q.get('channel') || '').toLowerCase();
  wirePaneEvents();
  await loadFilters();
  try {
    paneHome = (await fetch('/api/chat/tabs').then(r => r.json())).home || '';
  } catch { /* home is only used by the highlight-me preset */ }
  paneTabs = [{ name: 'dock', panes: [{ kind, ...(kind === 'chat' ? { channel } : {}), grow: 1 }] }];
  paneActiveTab = 0;
  document.title = kind === 'chat' ? channel : kind;
  renderPanes();
}

// Guarded so node:test can require this file for the pure helpers above.
if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    if (new URLSearchParams(location.search).has('kind')) return void initSinglePane();
    wirePaneToolbar();
    initPanes();
  });
}

// ── Filters ───────────────────────────────────────────────────────────────────
// ponytail: one filter set applied to every pane. Chatterino scopes filters per
// split; that needs a rule editor per pane and a merge rule when a channel is
// open twice. Move `paneFilters` into the tab config if that becomes worth it.

let paneFilters = { presets: {}, rules: [] };
let paneCompiled = [];

function recompileFilters() {
  paneCompiled = compileRules([
    ...presetRules(paneFilters.presets || {}, paneHome),
    ...(paneFilters.rules || []),
  ]);
}

async function loadFilters() {
  try {
    const { filters } = await fetch('/api/chat/filters').then(r => r.json());
    if (filters) paneFilters = JSON.parse(filters);
  } catch { /* defaults are fine */ }
  if (!paneFilters.presets) paneFilters.presets = {};
  if (!Array.isArray(paneFilters.rules)) paneFilters.rules = [];
  recompileFilters();
}

function saveFilters() {
  recompileFilters();
  fetch('/api/chat/filters', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(paneFilters),
  }).catch(() => {});
  renderFilterPanel();
}

function renderFilterPanel() {
  const panel = document.getElementById('filter-panel');
  if (!panel || panel.hidden) return;
  const p = paneFilters.presets || {};
  const cb = (key, label) =>
    `<label class="filter-check"><input type="checkbox" data-preset="${key}"${p[key] ? ' checked' : ''}> ${label}</label>`;

  const rows = (paneFilters.rules || []).map((r, i) => {
    const compiled = compileRule(r);
    return `<div class="filter-row" data-rule="${i}">
      <select data-f="type">${['hide', 'highlight'].map(t => `<option${r.type === t ? ' selected' : ''}>${t}</option>`).join('')}</select>
      <select data-f="field">${['message', 'user', 'channel'].map(f => `<option${r.field === f ? ' selected' : ''}>${f}</option>`).join('')}</select>
      <input data-f="pattern" value="${esc(r.pattern || '')}" placeholder="text or /regex/i" />
      <button class="pane-btn" data-f="del" title="Delete rule">×</button>
      ${compiled.error ? `<span class="filter-err">${esc(compiled.error)}</span>` : ''}
    </div>`;
  }).join('');

  panel.innerHTML =
    `<div class="filter-presets">${cb('hideBots', 'Hide bots')}${cb('hideCommands', 'Hide ! commands')}${cb('highlightMe', 'Highlight mentions of me')}</div>` +
    `<div class="filter-rules">${rows || '<div class="filter-empty">No custom rules.</div>'}</div>` +
    `<button class="pane-add" id="filter-add">＋ Rule</button>` +
    `<span class="filter-note">Plain text matches anywhere, case-insensitive. Wrap in slashes for a regex.</span>`;
}

function wireFilterPanel() {
  const panel = document.getElementById('filter-panel');
  const toggle = document.getElementById('filter-toggle');
  if (!panel || !toggle || panel.dataset.wired) return;
  panel.dataset.wired = '1';

  toggle.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    toggle.classList.toggle('active', !panel.hidden);
    renderFilterPanel();
  });

  panel.addEventListener('change', e => {
    const preset = e.target.dataset.preset;
    if (preset) {
      paneFilters.presets[preset] = e.target.checked;
      return saveFilters();
    }
    const row = e.target.closest('.filter-row');
    if (!row) return;
    const rule = paneFilters.rules[Number(row.dataset.rule)];
    if (rule && e.target.dataset.f) {
      rule[e.target.dataset.f] = e.target.value;
      saveFilters();
    }
  });

  panel.addEventListener('click', e => {
    if (e.target.id === 'filter-add') {
      paneFilters.rules.push({ type: 'hide', field: 'message', pattern: '', enabled: true });
      return saveFilters();
    }
    if (e.target.dataset.f === 'del') {
      paneFilters.rules.splice(Number(e.target.closest('.filter-row').dataset.rule), 1);
      saveFilters();
    }
  });
}
