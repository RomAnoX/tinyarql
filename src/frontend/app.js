const $ = (id) => document.getElementById(id);
const call = (m, p) => tiny.api.call(m, p);
// Escape anything that goes into innerHTML — table/column/connection names and cell
// values are attacker-controlled text in a page that holds an RPC channel to the backend.
const esc = (s) => String(s).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

hydrateIcons();  // icons.js: <i data-icon> placeholders in the static HTML become inline SVG

const PAGE_SIZE = 100;
let conns = [];
let active = null;              // connection id queries run against
const tables = {};              // connection id -> [{ name, ref, type }] (present = connected)
const connecting = new Set();   // ids with a connect in flight (an SSH tunnel can take up to ~15s)
const expanded = new Set();     // connected ids whose table list is open (a session choice: reconnecting opens it again)
let view = null;                // { ref, page } while browsing a table
const tabs = [];                // [{ id, title, sql, connId, savedId, snap, cm }]: snap = what the results area shows, cm = editor snapshot
let currentId = null;
let queries = [];               // saved queries: [{ id, name, sql, connId, updatedAt }]
const currentTab = () => tabs.find((t) => t.id === currentId);

const status = (text, bad) => { $('status').textContent = text; $('status').classList.toggle('bad', !!bad); };
const DIALECTS = { postgres: 'PostgreSQL', mysql: 'MySQL', sqlite: 'SQLite' };

// Status bar (left) + the 3px window edge say which connection, and which environment, you're talking to.
function renderWhere() {
  const c = conns.find((x) => x.id === active);
  $('where').innerHTML = c
    ? `<b>${esc(c.name)}</b> <span>${esc(DIALECTS[c.type] || c.type)}</span>${envTag(c)}`
    : '<span>No connection</span>';
  $('envBar').hidden = !envOf(c?.env);
  $('envBar').dataset.env = envOf(c?.env)?.id || '';
}

// ---- CodeMirror 6 (bundled by tools/editor into editor.js) ----
const editor = CM.create({ parent: $('sql'), onRun: () => runSql(), onChange: () => onEdit() });
let synced = {};
// Dialect + { table: [columns] } drive highlighting and completion; only reconfigure on change.
function syncEditor() {
  if (synced.id === active && synced.tables === tables[active]) return;
  synced = { id: active, tables: tables[active] };
  editor.setDialect(conns.find((c) => c.id === active)?.type || 'postgres');
  editor.setSchema(Object.fromEntries((tables[active] || []).map((t) => [t.name, t.columns])));
}

// ---- resizable panels: sizes are remembered together in tiny.store 'layout' ----
const layout = { editorHeight: 168, sidebarWidth: 248, detailWidth: 380 };
const saveLayout = () => tiny.store.set('layout', layout);
const panes = [];  // every splitter; moving one changes how much room the others have, so they re-check their limits together

// Wires a separator `el` to the size of `target`. axis 'y' = target height (grows as the pointer moves down),
// 'x' = target width (grows as it moves right, or as it moves left with `invert`, for a panel on the right). `wanted` is what the user asked for; the shown size is that,
// kept between min and max(), so a shrinking window pulls the panel in and a growing one gives the room back.
function makeSplitter({ el, target, axis, def, min, max, key, invert = false }) {
  const y = axis === 'y', dir = invert ? -1 : 1;
  const [prop, client, bigger, smaller] = y ? ['height', 'clientY', 'ArrowDown', 'ArrowUp'] : ['width', 'clientX', ...(invert ? ['ArrowLeft', 'ArrowRight'] : ['ArrowRight', 'ArrowLeft'])];
  const current = () => (y ? target.offsetHeight : target.offsetWidth);
  let wanted = def;
  function apply() {
    const shown = Math.round(Math.min(max(), Math.max(min, wanted)));
    target.style[prop] = shown + 'px';
    el.setAttribute('aria-valuenow', shown);
    el.setAttribute('aria-valuemax', max());
    return shown;
  }
  function set(size, save) {
    wanted = size;
    const shown = apply();
    for (const other of panes) if (other !== pane) other.apply();
    if (save) { layout[key] = shown; saveLayout(); }
  }
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const start = e[client], startSize = current(), cls = 'dragging-' + axis;
    el.classList.add('drag');
    document.body.classList.add(cls);
    const move = (ev) => set(startSize + dir * (ev[client] - start));
    const up = () => {
      for (const t of ['pointermove', 'pointerup', 'pointercancel']) window.removeEventListener(t, t === 'pointermove' ? move : up);
      el.classList.remove('drag');
      document.body.classList.remove(cls);
      set(wanted, true);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });
  el.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 64 : 16, now = current();
    const to = { [smaller]: now - step, [bigger]: now + step, Home: min, End: Infinity }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    set(to, true);
  });
  el.addEventListener('dblclick', () => set(def, true));
  const pane = { set, apply };
  panes.push(pane);
  apply();
  return pane;
}

const EDITOR_MIN = 64, RESULTS_MIN = 140, SIDEBAR_MIN = 180, MAIN_MIN = 480, DETAIL_MIN = 260, GRID_MIN = 240;
const editorPane = makeSplitter({
  el: $('splitter'), target: $('sql'), axis: 'y', def: 168, min: EDITOR_MIN, key: 'editorHeight',
  // the editor may grow until the results area would drop below RESULTS_MIN
  max: () => Math.max(EDITOR_MIN, $('splitter').parentElement.clientHeight - $('tabs').offsetHeight - document.querySelector('.bar').offsetHeight - $('statusbar').offsetHeight - RESULTS_MIN),
});
const sidePane = makeSplitter({
  el: $('sideSplitter'), target: document.querySelector('aside'), axis: 'x', def: 248, min: SIDEBAR_MIN, key: 'sidebarWidth',
  // the sidebar may grow until the main area would drop below MAIN_MIN (and never past 520px)
  max: () => Math.max(SIDEBAR_MIN, Math.min(520, document.body.clientWidth - MAIN_MIN)),
});
const detailPane = makeSplitter({
  el: $('detailSplitter'), target: $('detail'), axis: 'x', invert: true, def: 380, min: DETAIL_MIN, key: 'detailWidth',
  // the panel may grow until the results grid would drop below GRID_MIN
  max: () => Math.max(DETAIL_MIN, $('detail').parentElement.clientWidth - GRID_MIN),
});
window.addEventListener('resize', () => panes.forEach((p) => p.apply()));  // the saved sizes are untouched
async function loadLayout() {
  const saved = await tiny.store.get('layout');
  for (const [key, pane] of [['editorHeight', editorPane], ['sidebarWidth', sidePane], ['detailWidth', detailPane]]) {
    if (saved && Number.isFinite(saved[key])) { layout[key] = saved[key]; pane.set(saved[key]); }
  }
}
Promise.resolve(tiny.win.setMinSize(760, 480)).catch(() => {});  // matches windowstate.js: the layout needs this much room

// ---- environments: a named colour a connection can carry (window edge, tag, tab border) ----
// A connection stores the environment's id. The three built-ins keep their theme-aware colour tokens (--env-<id>) until you
// pick a colour; a picked colour is one hex, nudged toward white (dark theme) or black (light) until it reads on the panel.
const BUILT_IN_ENVS = ['local', 'staging', 'production'];
const defaultEnvs = () => BUILT_IN_ENVS.map((id) => ({ id, name: id }));
let envs = defaultEnvs();                                   // [{ id, name, color? }], saved in tiny.store 'environments'
const envOf = (id) => envs.find((e) => e.id === id);        // undefined for none, or for one that was deleted
const envTag = (c) => { const e = envOf(c.env); return e ? `<span class="env" data-env="${esc(e.id)}">${esc(e.name)}</span>` : ''; };
const HEX = /^#[0-9a-f]{6}$/i;
const rgbOf = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const hexOf = (c) => '#' + c.map((x) => Math.round(x).toString(16).padStart(2, '0')).join('');
const lumOf = (c) => { const [r, g, b] = c.map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrastOf = (a, b) => { const [hi, lo] = [lumOf(a), lumOf(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
function readable(hex) {
  const panel = rgbOf(cssVar('--panel')), toward = document.documentElement.dataset.theme === 'light' ? 0 : 255, c = rgbOf(hex);
  for (let t = 0; t <= 1.001; t += 0.05) {
    const m = c.map((x) => x + (toward - x) * t);
    if (contrastOf(m, panel) >= 4.5) return hexOf(m);
  }
  return hexOf([toward, toward, toward]);
}
// The colour an environment shows right now (the picker starts from it).
const envShown = (e) => (e.color ? readable(e.color) : cssVar('--env-' + e.id) || '#8497a6');
// One rule per environment, written into a <style>: ids and hex values are validated on load and on edit, so nothing else can get in.
function applyEnvStyles() {
  let st = $('envStyles');
  if (!st) { st = document.createElement('style'); st.id = 'envStyles'; document.head.appendChild(st); }
  st.textContent = envs.map((e) => `[data-env="${e.id}"] { --env: ${e.color ? readable(e.color) : BUILT_IN_ENVS.includes(e.id) ? `var(--env-${e.id})` : '#8497a6'}; }`).join('\n');
}
const saveEnvs = () => tiny.store.set('environments', envs);
const cleanEnvs = (list) => list.filter((e) => e && typeof e.id === 'string' && /^[a-z0-9-]{1,40}$/i.test(e.id) && typeof e.name === 'string' && e.name.trim())
  .map((e) => ({ id: e.id, name: e.name.trim().slice(0, 40), ...(typeof e.color === 'string' && HEX.test(e.color) ? { color: e.color.toLowerCase() } : {}) }));
const capitalize = (t) => t.charAt(0).toUpperCase() + t.slice(1);
function fillEnvSelect() {
  const sel = document.querySelector('#form select[name=env]');
  sel.innerHTML = '<option value="">None</option>' + envs.map((e) => `<option value="${esc(e.id)}">${esc(capitalize(e.name))}</option>`).join('');
}
// Amber means "action"; an environment colour close to it would blur the two.
const nearAmber = (hex) => {
  const [r, g, b] = rgbOf(hex).map((x) => x / 255), mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (d < 0.25 || mx < 0.3) return false;  // grey or very dark
  const h = ((mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60 + 360) % 360;
  return Math.abs(h - 36) < 22;
};
const AMBER_HINT = 'is close to the amber used for actions; pick a colour that is easier to tell apart.';
function renderEnvList() {
  $('envList').innerHTML = envs.map((e) => `<div class="envrow" data-id="${esc(e.id)}">
      <input class="envname" value="${esc(e.name)}" maxlength="40" aria-label="Name of environment ${esc(e.name)}" autocomplete="off" spellcheck="false">
      <input class="envcolor" type="color" value="${envShown(e)}" aria-label="Colour of ${esc(e.name)}">
      <button type="button" class="icon" data-act="del" title="Delete environment" aria-label="Delete environment ${esc(e.name)}">${icon('trash-2', 14)}</button>
    </div>`).join('') || '<p class="hint">No environments. Connections then carry no colour.</p>';
  const near = envs.filter((e) => nearAmber(envShown(e))).map((e) => e.name);
  $('envNote').textContent = near.length ? `${near.join(', ')} ${AMBER_HINT}` : '';
}
const refreshEnvViews = () => { applyEnvStyles(); fillEnvSelect(); renderWhere(); renderConns(); renderTabs(); };
async function loadEnvs() {
  const saved = await tiny.store.get('environments');
  envs = Array.isArray(saved) ? cleanEnvs(saved) : defaultEnvs();
  refreshEnvViews(); renderEnvList();
}
$('envList').addEventListener('input', (e) => {  // a colour drag repaints live; nothing else needs to re-render
  const row = e.target.closest('.envrow'), env = row && envOf(row.dataset.id);
  if (!env || !e.target.matches('.envcolor')) return;
  env.color = e.target.value.toLowerCase();
  applyEnvStyles(); saveEnvs();
  const near = envs.filter((x) => nearAmber(envShown(x))).map((x) => x.name);
  $('envNote').textContent = near.length ? `${near.join(', ')} ${AMBER_HINT}` : '';
});
$('envList').addEventListener('change', (e) => {
  const row = e.target.closest('.envrow'), env = row && envOf(row.dataset.id);
  if (!env || !e.target.matches('.envname')) return;
  const name = e.target.value.trim();
  if (!name || envs.some((x) => x !== env && x.name.toLowerCase() === name.toLowerCase())) { e.target.value = env.name; return; }  // empty or taken: keep the old name
  env.name = name;
  saveEnvs(); refreshEnvViews(); renderEnvList();
});
$('envList').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act=del]'), env = b && envOf(b.closest('.envrow').dataset.id);
  if (!env) return;
  const using = conns.filter((c) => c.env === env.id);
  const sure = await tiny.dialog.confirm(`Delete the “${env.name}” environment?`, {
    detail: using.length ? `${using.length} connection${using.length === 1 ? '' : 's'} (${using.map((c) => c.name).join(', ')}) will have no environment. The connections themselves are kept.` : 'No connection uses it.',
    ok: 'Delete', cancel: 'Cancel',
  });
  if (!sure) return;
  for (const c of using) await call('saveConnection', { conn: { ...c, env: '' }, password: null });
  envs = envs.filter((x) => x !== env);
  await saveEnvs(); await load(); refreshEnvViews(); renderEnvList();
});
$('envAdd').onclick = () => {
  const taken = new Set(envs.map((e) => e.name.toLowerCase()));
  let n = 1, name = 'new environment';
  while (taken.has(name)) name = `new environment ${++n}`;
  const used = new Set(envs.map((e) => envShown(e).toLowerCase()));
  const color = ['#38bdf8', '#f472b6', '#2dd4bf', '#a3e635', '#818cf8', '#e879f9'].find((c) => !used.has(c)) || '#38bdf8';
  envs.push({ id: 'e' + crypto.randomUUID().slice(0, 8), name, color });
  saveEnvs(); refreshEnvViews(); renderEnvList();
  const rows = $('envList').querySelectorAll('.envname'); rows[rows.length - 1].focus(); rows[rows.length - 1].select();
};
$('envReset').onclick = async () => {
  const lost = conns.filter((c) => c.env && !BUILT_IN_ENVS.includes(c.env) && envOf(c.env));
  const sure = await tiny.dialog.confirm('Restore the default environments?', {
    detail: `This brings back local, staging and production with their original names and colours and removes the others.${lost.length ? ` ${lost.length} connection${lost.length === 1 ? '' : 's'} using a removed environment will have none.` : ''}`,
    ok: 'Restore', cancel: 'Cancel',
  });
  if (!sure) return;
  for (const c of lost) await call('saveConnection', { conn: { ...c, env: '' }, password: null });
  envs = defaultEnvs();
  await saveEnvs(); await load(); refreshEnvViews(); renderEnvList();
};

// ---- settings (persisted in tiny.store) ----
const settings = { vim: false, theme: 'system' };
const media = matchMedia('(prefers-color-scheme: dark)');
// 'system' follows the OS live; the page and the editor both switch through the same CSS variables.
function applyTheme() {
  const t = settings.theme === 'system' ? (media.matches ? 'dark' : 'light') : settings.theme;
  document.documentElement.dataset.theme = t;
  editor.setTheme(t);
  applyEnvStyles();
  $('themeSeg').querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.theme === settings.theme)));
}
media.addEventListener('change', () => { if (settings.theme === 'system') applyTheme(); });
function applySettings() {
  applyTheme();
  editor.setVim(settings.vim);
  $('optVim').checked = settings.vim;
}
applyTheme();  // match the OS before the saved settings arrive
async function loadSettings() {
  Object.assign(settings, (await tiny.store.get('settings')) || {});
  applySettings();
}
$('themeSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  settings.theme = b.dataset.theme;
  applySettings();
  tiny.store.set('settings', settings);
});
$('optVim').onchange = () => {
  settings.vim = $('optVim').checked;
  applySettings();
  tiny.store.set('settings', settings);
};
const openSettings = () => { renderEnvList(); $('settings').showModal(); };
$('settingsBtn').onclick = openSettings;
$('settingsClose').onclick = () => { $('settings').close(); editor.focus(); };
document.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === ',') { e.preventDefault(); openSettings(); } });

// The active connection is the current tab's connection: picking one in the sidebar rebinds the tab you are looking at.
function setActive(id) {
  active = id;
  const t = currentTab();
  if (t && t.connId !== id) { t.connId = id; persistTabs(); renderTabs(); }
}

function renderConns() {
  syncEditor();
  renderWhere();
  renderRun();
  // The list is rebuilt wholesale, so remember what had keyboard focus and give it back afterwards.
  const f = document.activeElement;
  const focus = f && $('conns').contains(f) ? { id: f.closest('.conn').dataset.id, ref: f.closest('.tbls li')?.dataset.ref } : null;
  $('conns').innerHTML = conns.map((c) => {
    const on = !!tables[c.id], open = on && expanded.has(c.id), busy = connecting.has(c.id);
    return `
    <li class="conn ${on ? 'on' : ''} ${open ? 'open' : ''} ${busy ? 'connecting' : ''}" data-id="${esc(c.id)}">
      <div class="row">
        <button class="head"${on ? ` aria-expanded="${open}"` : ''}${busy ? ' aria-busy="true"' : ''}><span class="chev">${icon('chevron-right', 14)}</span><span class="state">${icon(busy ? 'loader-circle' : on ? 'plug-zap' : 'unplug', 15)}</span><span class="name">${esc(c.name)}</span></button>
        ${envTag(c)}
        ${busy ? '<span class="progress" role="status">Connecting…</span>' : ''}
        ${on ? `<span class="count" title="${tables[c.id].length} tables and views">${tables[c.id].length}</span>` : ''}
        <span class="tools"><button data-act="edit" title="Edit connection" aria-label="Edit ${esc(c.name)}">${icon('pencil', 14)}</button><button data-act="del" title="Delete connection" aria-label="Delete ${esc(c.name)}">${icon('trash-2', 14)}</button></span>
      </div>
      ${open ? `<ul class="tbls">${tables[c.id].map((t) =>
        `<li tabindex="0" class="${t.type} ${active === c.id && view?.ref === t.ref ? 'sel' : ''}" data-ref="${esc(t.ref)}">${icon(t.type === 'view' ? 'eye' : 'table-2', 14)}<span>${esc(t.name)}</span></li>`).join('')}</ul>` : ''}
    </li>`;
  }).join('');
  if (focus) {
    const li = [...$('conns').children].find((el) => el.dataset.id === focus.id);
    (focus.ref ? [...li?.querySelectorAll('.tbls li') || []].find((x) => x.dataset.ref === focus.ref) : li?.querySelector('.head'))?.focus();
  }
}
// Table names are focusable list items (Enter/Space opens them). On a connection, → opens its tables and ← closes them.
$('conns').addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.tbls li')) { e.preventDefault(); e.target.click(); }
  if (!e.target.matches('.head')) return;
  const id = e.target.closest('.conn').dataset.id;
  if (e.key === 'ArrowRight' && tables[id] && !expanded.has(id)) { e.preventDefault(); expanded.add(id); renderConns(); }
  if (e.key === 'ArrowLeft' && tables[id] && expanded.has(id)) { e.preventDefault(); expanded.delete(id); renderConns(); }
});

// ---- cell detail panel: JSON tree / raw text for the clicked cell ----
let result = { columns: [], types: [], rows: [] };  // what the grid currently shows
let detail = null;                                   // { r, c, mode: 'tree' | 'json' | 'raw' } while the panel is open
let jsonMode = 'tree';                               // the view last chosen for JSON cells; the next JSON cell opens in it
const isJsonType = (t) => t === 'json' || t === 'jsonb';
// json/jsonb columns always parse; any other string that looks like an object/array and parses is shown as JSON too
// (SQLite and text columns have no JSON type).
function parseJson(v, type) {
  if (typeof v !== 'string' || !(isJsonType(type) || /^\s*[\[{]/.test(v))) return { ok: false };
  try { return { ok: true, value: JSON.parse(v) }; } catch { return { ok: false }; }
}
const MAX_ITEMS = 500;  // per object/array, to keep the DOM sane
// ponytail: JSON.parse rounds integers beyond 2^53; Raw shows the exact text.
function tree(v, depth = 0) {
  if (v === null) return '<span class="j-null">null</span>';
  if (typeof v === 'string') return `<span class="j-str">${esc(JSON.stringify(v))}</span>`;
  if (typeof v === 'number') return `<span class="j-num">${esc(v)}</span>`;
  if (typeof v === 'boolean') return `<span class="j-bool">${v}</span>`;
  const arr = Array.isArray(v);
  const entries = arr ? v.map((x, i) => [i, x]) : Object.entries(v);
  if (!entries.length) return arr ? '[]' : '{}';
  const rows = entries.slice(0, MAX_ITEMS).map(([k, x]) =>
    `<div class="j-row"><span class="j-key">${arr ? k : esc(JSON.stringify(k))}</span>: ${tree(x, depth + 1)}</div>`).join('');
  const more = entries.length > MAX_ITEMS ? `<div class="j-more">… ${entries.length - MAX_ITEMS} more</div>` : '';
  return `<details${depth < 2 ? ' open' : ''}><summary>${arr ? `[ ${entries.length} ]` : `{ ${entries.length} }`}</summary>${rows}${more}</details>`;
}

function renderDetail() {
  $('grid').querySelectorAll('td.sel').forEach((td) => td.classList.remove('sel'));
  $('detail').hidden = !detail;
  if (!detail) return;
  const { r, c } = detail;
  $('grid').querySelector(`td[data-r="${r}"][data-c="${c}"]`)?.classList.add('sel');
  const v = result.rows[r][c], type = result.types[c];
  const json = parseJson(v, type);
  $('detailTitle').innerHTML = `${esc(result.columns[c])}<small>${esc(type || (json.ok ? 'json' : 'text'))}</small>`;
  $('detailTree').hidden = $('detailJson').hidden = $('detailRaw').hidden = !json.ok;
  for (const mode of ['tree', 'json', 'raw']) $('detail' + mode[0].toUpperCase() + mode.slice(1)).classList.toggle('on', detail.mode === mode);
  $('detailBody').innerHTML = v === null ? '<span class="j-null">NULL</span>'
    : json.ok && detail.mode === 'tree' ? tree(json.value)
    : json.ok && detail.mode === 'json' ? `<pre class="jsonview">${jsonHtml(v)}</pre>`
    : `<pre>${esc(v)}</pre>`;
  $('detailFindBar').hidden = v === null || !CSS.highlights;
  runFind();
}

// ---- find inside the detail panel: Tree, Json and Raw alike ----
// Matches are Ranges over the text already on screen, painted with the CSS Custom Highlight API, so the markup is not
// rewritten. Case-insensitive, one text node at a time (a match cannot span a key and its value). Tree summaries
// ("{ 3 }") are not searched. Matches inside a collapsed node count; going to one opens it.
const FIND_MAX = 5000;
let findHits = [], findAt = 0;
function paintFind() {
  CSS.highlights.delete('find'); CSS.highlights.delete('find-current');
  if (findHits.length) {
    CSS.highlights.set('find', new Highlight(...findHits));
    CSS.highlights.set('find-current', new Highlight(findHits[findAt]));
  }
  const q = $('detailFind').value;
  $('detailFindCount').textContent = !q ? '' : findHits.length ? `${findAt + 1} of ${findHits.length}${findHits.length >= FIND_MAX ? '+' : ''}` : 'No matches';
}
function runFind() {
  findHits = []; findAt = 0;
  const q = $('detailFind').value.toLowerCase();
  if (q && !$('detailFindBar').hidden) {
    const walker = document.createTreeWalker($('detailBody'), NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement.closest('summary') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
    for (let n; (n = walker.nextNode()) && findHits.length < FIND_MAX;) {
      const t = n.data.toLowerCase();
      for (let i = t.indexOf(q); i >= 0 && findHits.length < FIND_MAX; i = t.indexOf(q, i + q.length)) {
        const r = new Range(); r.setStart(n, i); r.setEnd(n, i + q.length); findHits.push(r);
      }
    }
  }
  paintFind();
}
function findGo(delta) {
  if (!findHits.length) return;
  findAt = (findAt + delta + findHits.length) % findHits.length;
  const at = findHits[findAt].startContainer.parentElement;
  for (let d = at.closest('details'); d; d = d.parentElement?.closest('details')) d.open = true;
  paintFind();
  at.scrollIntoView({ block: 'center', inline: 'nearest' });
}
$('detailFind').addEventListener('input', runFind);
$('detailFind').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); findGo(e.shiftKey ? -1 : 1); }
  else if (e.key === 'Escape' && $('detailFind').value) { e.stopPropagation(); $('detailFind').value = ''; runFind(); }  // the first Esc only clears; the next closes the panel
});
$('detailFindNext').onclick = () => findGo(1);
$('detailFindPrev').onclick = () => findGo(-1);
// ⌘F with the panel open finds in the value (the editor keeps its own ⌘F).
document.addEventListener('keydown', (e) => {
  if (e.key === 'f' && e.metaKey && !e.ctrlKey && !e.altKey && detail && !$('detailFindBar').hidden && !document.querySelector('dialog[open]') && !e.target.closest?.('#sql')) {
    e.preventDefault(); $('detailFind').focus(); $('detailFind').select();
  }
});
const closeDetail = () => { detail = null; renderDetail(); };

let showingResult = false;  // false = the grid area shows the empty/welcome state

function renderEmpty() {
  showingResult = false;
  $('exportCsv').hidden = true;
  result = { columns: [], types: [], rows: [] };
  detail = null;
  $('detail').hidden = true;
  $('grid').innerHTML = conns.length
    ? '<div class="empty">Pick a connection, then run a query or open a table.</div>'
    : `<div class="welcome">
         <div class="mark">${icon('database', 28)}</div>
         <h2>Connect to a database</h2>
         <p>Run SQL and browse tables in PostgreSQL or SQLite. Saved passwords stay in your system keychain.</p>
         <div class="choices">
           <button class="choice" data-new="postgres"><strong>${icon('database')}PostgreSQL</strong><small>Host and port, with an optional SSH tunnel</small></button>
           <button class="choice" data-new="mysql"><strong>${icon('database')}MySQL</strong><small>Host and port, with an optional SSH tunnel</small></button>
           <button class="choice" data-new="sqlite"><strong>${icon('hard-drive')}SQLite file</strong><small>A database file on this computer</small></button>
         </div>
       </div>`;
}

const NUMERIC = new Set(['int2', 'int4', 'int8', 'float4', 'float8', 'numeric', 'tinyint', 'smallint', 'mediumint', 'int', 'bigint', 'float', 'double', 'decimal']);  // Postgres and MySQL names

function renderGrid({ columns, types = [], rows, truncated, ms, tag }) {
  result = { columns, types, rows, truncated: !!truncated };
  $('exportCsv').hidden = !columns.length;
  showingResult = true;
  detail = null;
  $('detail').hidden = true;
  // Numbers right-align. Postgres reports a numeric type; SQLite has none, so a column of JS numbers counts.
  const num = columns.map((_, j) => NUMERIC.has(types[j]) ||
    (!types[j] && rows.some((r) => typeof r[j] === 'number') && rows.every((r) => r[j] === null || typeof r[j] === 'number')));
  $('grid').innerHTML = columns.length
    ? `<table><thead><tr>${columns.map((c, j) =>
        `<th${num[j] ? ' class="num"' : ''}>${esc(c)}${types[j] ? `<span class="ctype">${esc(types[j])}</span>` : ''}</th>`).join('')}</tr></thead><tbody>${rows.map((r, i) =>
        `<tr>${r.map((v, j) => {
          const at = `data-r="${i}" data-c="${j}"`;
          if (v === null) return `<td class="null${num[j] ? ' num' : ''}" title="NULL" ${at}></td>`;
          const json = parseJson(v, types[j]).ok;
          return `<td class="${[json && 'json', num[j] && 'num'].filter(Boolean).join(' ')}" ${at}>${json ? `<i class="jb" aria-hidden="true">${icon('braces', 12)}</i>` : ''}${esc(v)}</td>`;
        }).join('')}</tr>`).join('')}</tbody></table>`
    : `<div class="empty">${esc(tag || 'Done')}. The statement returned no rows.</div>`;
  status(`${rows.length} row${rows.length === 1 ? '' : 's'}${truncated ? ' (truncated at 1000)' : ''} in ${ms} ms`);
}

// Failures replace the results with what went wrong, instead of a dim line in a corner.
function showError(title, message) {
  showingResult = true;
  $('exportCsv').hidden = true;
  result = { columns: [], types: [], rows: [] };
  detail = null;
  $('detail').hidden = true;
  $('grid').innerHTML = `<div class="error" role="alert"><strong>${icon('circle-alert')}${esc(title)}</strong><pre>${esc(message)}</pre></div>`;
  status('Failed', true);
}

function showNotice(title, message) {
  showingResult = true;
  $('exportCsv').hidden = true;
  result = { columns: [], types: [], rows: [] };
  detail = null;
  $('detail').hidden = true;
  $('grid').innerHTML = `<div class="notice" role="status"><strong>${icon('square', 14)}${esc(title)}</strong><p>${esc(message)}</p></div>`;
  status('Stopped');
}

// What a tab's results area shows is kept as a snapshot: { kind: 'grid', r, view } | { kind: 'error' | 'notice', title, message, view } | null.
// paint() draws one; deliver() stores it on its tab and draws it only if that tab is the one on screen, so a query that
// finishes in a background tab lands there instead of on top of whatever you are looking at.
function paint(snap) {
  if (!snap) { view = null; $('pager').hidden = true; renderEmpty(); status(''); return; }
  view = snap.view || null;
  if (snap.kind === 'grid') renderGrid(snap.r);
  else if (snap.kind === 'error') showError(snap.title, snap.message);
  else showNotice(snap.title, snap.message);
  $('pager').hidden = !view;
  if (view) {
    $('pageNo').textContent = `Page ${view.page + 1}`;
    $('prev').disabled = view.page === 0;
    $('next').disabled = snap.kind === 'grid' && snap.r.rows.length < PAGE_SIZE;
  }
}
function deliver(tab, snap) {
  if (!tab) return paint(snap);
  tab.snap = snap;
  if (tab.id === currentId) paint(snap);
  renderTabs();
}
async function guarded(title, fn, tab = currentTab(), extra = {}) {
  try { return await fn(); } catch (e) { deliver(tab, { kind: 'error', title, message: String(e.message || e), ...extra }); }
}

async function connect(id) {
  if (connecting.has(id)) return;
  const name = conns.find((c) => c.id === id)?.name || 'connection';
  connecting.add(id);
  status(`Connecting to ${name}…`);
  renderConns();
  await guarded('Couldn’t connect', async () => {
    tables[id] = await call('connect', { id });
    expanded.add(id);
    status('Connected');
  });
  connecting.delete(id);
  renderConns();
}

// ---- Run / Stop ----
const HINT = '⌘/Ctrl+Enter runs the selection, or the whole editor';
let running = null;  // { id, type, start, stopping, tab } while a query is in flight (one at a time, whichever tab started it)
let runTimer = null;
const fmtMs = (ms) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
const stoppable = () => running && ['postgres', 'mysql'].includes(running.type);  // SQLite's driver is synchronous: it cannot be interrupted

// One place decides what the button says: Run (idle), Stop (a Postgres query is running), or a disabled Running… (SQLite).
function renderRun() {
  const b = $('run');
  b.title = '';
  $('exportCsv').disabled = !!running;
  if (running && running.tab !== currentId) {
    b.className = 'primary'; b.disabled = true;
    b.innerHTML = `${icon('play', 14)}Run`;
    b.title = 'A query is running in another tab';
    $('hint').textContent = HINT;
  } else if (running && stoppable()) {
    b.className = 'stop'; b.disabled = running.stopping;
    b.innerHTML = `${icon('square', 14)}${running.stopping ? 'Stopping…' : 'Stop'}`;
    $('hint').textContent = '⌘/Ctrl+. stops the query';
  } else if (running) {
    b.className = 'primary'; b.disabled = true;
    b.innerHTML = `${icon('loader-circle', 14)}${running.exporting ? 'Exporting…' : 'Running…'}`;
    $('hint').textContent = HINT;
  } else {
    b.className = 'primary'; b.disabled = !conns.some((c) => c.id === active);  // an offline connection is fine: Run connects first
    b.innerHTML = `${icon('play', 14)}Run`;
    $('hint').textContent = HINT;
  }
}

async function stopQuery() {
  if (!running || running.stopping || !stoppable()) return;
  running.stopping = true;
  renderRun();
  status('Stopping…');
  // The query's own call resolves with { cancelled: true }; that is what updates the screen.
  await call('cancelQuery', { id: running.id }).catch(() => {});
}

async function runSql() {
  if (running) return;
  const tab = currentTab();
  const sql = (editor.selectedText().trim() || editor.getValue()).trim();
  const connId = active;
  if (!tab || !connId || !sql) return;
  // A restored tab starts offline: connect first, then run.
  if (!tables[connId]) { await connect(connId); if (!tables[connId]) return; }
  const conn = conns.find((c) => c.id === connId);
  running = { id: connId, type: conn?.type, start: Date.now(), stopping: false, tab: tab.id };
  if (tab.id === currentId) { view = null; $('pager').hidden = true; }
  const tick = () => {
    if (running.tab !== currentId || running.stopping) return;
    const s = Math.floor((Date.now() - running.start) / 1000);
    status(s ? `Running… ${s}s` : 'Running…');
  };
  tick();
  runTimer = setInterval(tick, 250);
  renderRun();
  renderTabs();
  await guarded('Query failed', async () => {
    const r = await call('query', { id: connId, sql });
    if (r.cancelled) return deliver(tab, { kind: 'notice', title: 'Query stopped', message: `Stopped after ${fmtMs(r.ms)}. The server cancelled it, so nothing was returned.` });
    deliver(tab, { kind: 'grid', r, view: null, sql, connId });  // sql + connId let Export CSV run it again for every row
    tables[connId] = await call('tables', { id: connId });  // the SQL may have created/dropped tables
  }, tab);
  clearInterval(runTimer);
  running = null;
  renderRun();
  renderConns();
  renderTabs();
}

async function browse(ref, page = 0) {
  const tab = currentTab(), id = active;
  view = { ref, page };
  status('Loading…');
  await guarded('Couldn’t load table', async () => {
    const r = await call('browse', { id, ref, page, pageSize: PAGE_SIZE });
    deliver(tab, { kind: 'grid', r, view: { ref, page }, connId: id });
  }, tab, { view: { ref, page } });
  renderConns();
}

$('grid').addEventListener('click', (e) => {
  const choice = e.target.closest('[data-new]');
  if (choice) return openForm(null, choice.dataset.new);
  const td = e.target.closest('td[data-r]');
  if (!td) return;
  const r = +td.dataset.r, c = +td.dataset.c;
  detail = { r, c, mode: jsonMode };
  renderDetail();
});
for (const mode of ['tree', 'json', 'raw']) {
  $('detail' + mode[0].toUpperCase() + mode.slice(1)).onclick = () => { detail.mode = jsonMode = mode; renderDetail(); };
}
$('detailClose').onclick = closeDetail;
const setCopyLabel = (done) => { $('detailCopy').innerHTML = `${icon(done ? 'check' : 'copy', 14)}<span>${done ? 'Copied' : 'Copy'}</span>`; };
$('detailCopy').onclick = () => {
  const v = result.rows[detail.r][detail.c];
  // Json copies the indented text you are looking at; Tree and Raw copy the value exactly as returned.
  const text = v === null ? '' : detail.mode === 'json' && parseJson(v, result.types[detail.c]).ok ? prettyJson(v) : String(v);
  tiny.clipboard.write({ text });
  setCopyLabel(true);
  setTimeout(() => setCopyLabel(false), 1000);
};
// Esc closes the panel (but not while a dialog or the editor has focus).
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && detail && !document.querySelector('dialog[open]') && !e.target.closest?.('#sql')) closeDetail();
});

$('conns').addEventListener('click', async (e) => {
  const li = e.target.closest('.conn');
  if (!li) return;
  const id = li.dataset.id;
  if (connecting.has(id)) return;  // wait for the connect to finish; this also stops double-connects
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'edit') return openForm(conns.find((c) => c.id === id));
  if (act === 'del') {
    const c = conns.find((x) => x.id === id);
    const sure = await tiny.dialog.confirm(`Delete “${c.name}”?`, {
      detail: `This removes the saved connection and its password from your keychain.${tables[id] ? ' It will be disconnected.' : ''} The database itself is not touched.`,
      ok: 'Delete', cancel: 'Cancel',
    });
    if (sure) {
      await call('deleteConnection', { id });
      delete tables[id];
      expanded.delete(id);
      for (const tb of tabs) if (tb.connId === id) tb.connId = null;  // its tabs stay, but unbound
      if (active === id) active = null;
      persistTabs();
      return load().then(renderTabs);
    }
    return;
  }
  const t = e.target.closest('.tbls li');
  setActive(id);
  if (t) return browse(t.dataset.ref);
  // Offline: connect (which opens its tables). Online: the row toggles its table list, like a folder.
  if (!tables[id]) await connect(id);
  else { if (!expanded.delete(id)) expanded.add(id); renderConns(); }
});

// ---- connection form ----
const form = $('form');
const showType = () => {
  document.querySelectorAll('[data-for]').forEach((d) => { d.hidden = !d.dataset.for.split(' ').includes(form.type.value); });
  $('ssh').hidden = !form.sshOn.checked;
  $('tls').hidden = !form.tlsOn.checked;
  $('tlsInsecureHint').hidden = !form.tlsInsecure.checked;
  form.tlsCa.disabled = form.tlsInsecure.checked;
};
const formConn = () => {
  const { password, sshOn, tlsOn, tlsInsecure, ...conn } = Object.fromEntries(new FormData(form));
  // Tunnel fields only count while the box is ticked; an unticked box clears a saved tunnel.
  if (!sshOn) for (const k of ['sshHost', 'sshPort', 'sshUser', 'sshKey']) conn[k] = '';
  conn.tls = !!tlsOn;
  conn.tlsInsecure = !!tlsOn && !!tlsInsecure;
  if (!tlsOn) conn.tlsCa = '';
  conn.id = form.dataset.id || undefined;
  return { conn, password };
};

function openForm(c, type) {
  form.reset();
  form.dataset.id = c?.id || '';
  $('dlgTitle').textContent = c ? 'Edit connection' : 'New connection';
  formNote();
  showPassword(false);
  fillEnvSelect();
  for (const [k, v] of Object.entries(c || {})) if (form.elements[k] && !['password', 'tls', 'tlsInsecure'].includes(k)) form.elements[k].value = v;
  form.sshOn.checked = !!c?.sshHost;
  form.tlsOn.checked = !!c?.tls;
  form.tlsInsecure.checked = !!c?.tlsInsecure;
  if (!c && type) { form.type.value = type; applyPortDefault(); }
  showType();
  $('dlg').showModal();
}

// Switching between PostgreSQL and MySQL swaps the port to the new default, unless you typed a custom one.
const DEFAULT_PORT = { postgres: '5432', mysql: '3306' };
function applyPortDefault() {
  if (DEFAULT_PORT[form.type.value] && (!form.port.value || Object.values(DEFAULT_PORT).includes(form.port.value))) form.port.value = DEFAULT_PORT[form.type.value];
}
form.type.addEventListener('change', () => { applyPortDefault(); showType(); });
form.sshOn.addEventListener('change', showType);
form.tlsOn.addEventListener('change', showType);
form.tlsInsecure.addEventListener('change', showType);
$('addConn').onclick = () => openForm();
$('cancel').onclick = () => $('dlg').close();
// The eye shows the password while you check what you typed. It always starts hidden and goes back when the dialog closes.
function showPassword(on) {
  form.password.type = on ? 'text' : 'password';
  const b = $('pwToggle');
  b.innerHTML = icon(on ? 'eye-off' : 'eye', 14);
  b.setAttribute('aria-pressed', String(on));
  b.setAttribute('aria-label', on ? 'Hide password' : 'Show password');
  b.title = on ? 'Hide password' : 'Show password';
}
$('pwToggle').onclick = () => { showPassword(form.password.type === 'password'); form.password.focus(); };
$('dlg').addEventListener('close', () => showPassword(false));
$('pick').onclick = async () => { const p = await tiny.dialog.openFile(); if (p) form.path.value = p; };
$('pickKey').onclick = async () => { const p = await tiny.dialog.openFile(); if (p) form.sshKey.value = p; };
$('pickCa').onclick = async () => { const p = await tiny.dialog.openFile(); if (p) form.tlsCa.value = p; };
// The line under the form fields: busy (spinner), ok (check) or error (alert). formNote() clears it.
function formNote(kind, text) {
  const icons = { busy: 'loader-circle', ok: 'check', error: 'circle-alert' };
  $('formErr').className = 'note' + (kind ? ' ' + kind : '');
  $('formErr').innerHTML = kind ? `${icon(icons[kind], 14)}<span>${esc(text)}</span>` : '';
}
$('test').onclick = async () => {
  $('test').disabled = true;
  formNote('busy', 'Testing connection…');
  try { await call('testConnection', formConn()); formNote('ok', 'Connected successfully.'); }
  catch (e) { formNote('error', String(e.message || e)); }
  $('test').disabled = false;
};
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const { conn, password } = formConn();
  // A blank password keeps the stored one (ponytail: no way to clear a saved password).
  await call('saveConnection', { conn, password: password || null });
  $('dlg').close();
  await load();
});

// ---- tabs: each keeps its own SQL, results, undo history and connection ----
// A cheap fingerprint (FNV-1a) of a file's text: a tab that came from or went to a .sql file is "unsaved" only while its
// text differs from what the file holds, and persisting a hash avoids storing every file twice.
function hashText(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return `${(h >>> 0).toString(16)}:${text.length}`;
}
const isUnsaved = (t) => {
  const q = t.savedId && queries.find((x) => x.id === t.savedId);
  if (q) return q.sql !== t.sql;  // a saved query that was edited
  if (t.origin) {  // opened from, or exported to, a file: unsaved only if it no longer matches the file
    if (t.memoSql !== t.sql) { t.memoSql = t.sql; t.memoHash = hashText(t.sql); }  // hashed once per edit, not once per redraw
    return t.memoHash !== t.origin.hash;
  }
  return t.sql.trim() !== '';  // scratch text that was never saved anywhere
};

let tabDragging = false;      // a tab is being dragged: renderTabs() waits, because it would replace the element under the pointer
let tabRenderWaiting = false;
function renderTabs() {
  if (tabDragging) { tabRenderWaiting = true; return; }
  const f = document.activeElement;
  const focused = f && $('tablist').contains(f) ? { id: f.closest('.tab')?.dataset.id, close: f.matches('.x') } : null;
  $('tablist').innerHTML = tabs.map((t) => {
    const conn = conns.find((c) => c.id === t.connId), busy = running && running.tab === t.id, on = t.id === currentId;
    return `<div class="tab ${on ? 'on' : ''}${tabs.length === 1 ? ' solo' : ''}" role="tab" aria-selected="${on}" tabindex="${on ? 0 : -1}" data-id="${esc(t.id)}"${envOf(conn?.env) ? ` data-env="${esc(envOf(conn.env).id)}"` : ''} title="${esc(t.title)}${conn ? ` on ${esc(conn.name)}` : ''}">
      ${busy ? icon('loader-circle', 13) : ''}<span class="t">${esc(t.title)}</span>${isUnsaved(t) ? '<i class="dirty" role="img" aria-label="Unsaved changes" title="Unsaved changes"></i>' : ''}${tabs.length > 1 ? `<button class="x" aria-label="Close ${esc(t.title)}" title="Close tab">${icon('x', 12)}</button>` : ''}
    </div>`;  // the last tab has no close button: there is always one
  }).join('');
  if (focused) {
    const el = [...$('tablist').children].find((x) => x.dataset.id === focused.id);
    (focused.close ? el?.querySelector('.x') || el : el)?.focus();  // a lone tab has no ×, so focus lands on the tab itself
  }
  $('tablist').querySelector('.tab.on')?.scrollIntoView?.({ inline: 'nearest', block: 'nearest' });
}

function onEdit() {  // after every keystroke in the editor
  const t = currentTab();
  if (!t) return;
  t.sql = editor.getValue();
  renderTabs();
  persistTabs();
}

// A new tab is "Query N" with the lowest N no open tab is using, so numbers are reused as tabs close (and start again at 1
// when only a differently named tab is left) instead of climbing for ever.
function defaultTitle() {
  const taken = new Set(tabs.map((t) => t.title));
  let n = 1;
  while (taken.has(`Query ${n}`)) n++;
  return `Query ${n}`;
}

function newTab({ title, sql = '', connId = active, savedId = null, origin = null, show = true } = {}) {
  const tab = { id: crypto.randomUUID(), title: title || defaultTitle(), sql, connId, savedId, origin, snap: null, cm: null };
  tabs.push(tab);
  if (show) switchTab(tab.id); else { renderTabs(); persistTabs(); }
  return tab;
}

// `discard`: the tab we are leaving is gone (closed), so there is nothing to save from the editor.
function switchTab(id, { discard = false } = {}) {
  const next = tabs.find((t) => t.id === id);
  if (!next || (id === currentId && !discard)) return;
  const cur = currentTab();
  if (cur && !discard) { cur.sql = editor.getValue(); cur.connId = active; cur.cm = editor.getState(); }
  currentId = id;
  active = next.connId && conns.some((c) => c.id === next.connId) ? next.connId : null;
  editor.setState(next.cm, next.sql);
  paint(next.snap);
  renderConns();  // also redraws the Run button, status line and editor schema for the new connection
  renderTabs();
  renderSaved();
  persistTabs();
}

async function closeTab(id) {
  const tab = tabs.find((t) => t.id === id);
  if (!tab || tabs.length === 1) return;  // there is always one tab, so the last one cannot be closed
  if (isUnsaved(tab)) {
    const ok = await tiny.dialog.confirm(`Close “${tab.title}”?`, { detail: 'Its SQL has not been saved.', ok: 'Close', cancel: 'Cancel' });
    if (!ok) return;
  }
  if (running && running.tab === id) stopQuery();
  const i = tabs.indexOf(tab);
  const wasCurrent = id === currentId;
  tabs.splice(i, 1);
  if (wasCurrent) switchTab(tabs[Math.min(i, tabs.length - 1)].id, { discard: true });
  else { renderTabs(); renderSaved(); persistTabs(); }
}

const cycleTab = (step) => switchTab(tabs[(tabs.findIndex((t) => t.id === currentId) + step + tabs.length) % tabs.length].id);

$('tablist').addEventListener('click', (e) => {
  const el = e.target.closest('.tab');
  if (!el) return;
  if (e.target.closest('.x')) closeTab(el.dataset.id); else switchTab(el.dataset.id);
});
$('tablist').addEventListener('auxclick', (e) => {  // middle-click closes
  const el = e.target.closest('.tab');
  if (e.button === 1 && el) { e.preventDefault(); closeTab(el.dataset.id); }
});
$('tablist').addEventListener('keydown', (e) => {
  const el = e.target.closest('.tab');
  if (!el || e.target.matches('.x')) return;
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); return switchTab(el.dataset.id); }
  const i = tabs.findIndex((t) => t.id === el.dataset.id);
  if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {  // move the tab itself, one place
    e.preventDefault();
    return moveTab(el.dataset.id, i + (e.key === 'ArrowRight' ? 1 : -1));
  }
  const to = { ArrowRight: tabs[(i + 1) % tabs.length], ArrowLeft: tabs[(i - 1 + tabs.length) % tabs.length], Home: tabs[0], End: tabs[tabs.length - 1] }[e.key];
  if (!to) return;
  e.preventDefault();
  switchTab(to.id);
  [...$('tablist').children].find((x) => x.dataset.id === to.id)?.focus();
});
// ---- reordering: drag a tab along the strip, or Alt+←/→ on a focused tab ----
function moveTab(id, toIndex) {
  const from = tabs.findIndex((t) => t.id === id), to = Math.max(0, Math.min(tabs.length - 1, toIndex));
  if (from < 0 || from === to) return;
  tabs.splice(to, 0, ...tabs.splice(from, 1));
  renderTabs();  // keeps keyboard focus on the moved tab
  persistTabs();
}

const DRAG_THRESHOLD = 5;  // px of movement before a press becomes a drag; less is still a click
$('tablist').addEventListener('pointerdown', (e) => {
  const list = $('tablist'), pressed = e.target.closest('.tab');
  if (!pressed || e.button !== 0 || e.target.closest('.x') || tabs.length < 2) return;
  const id = pressed.dataset.id, startX = e.clientX, originalOrder = tabs.map((t) => t.id);
  let el = null, grab = 0, lastX = startX, timer = null;

  const begin = () => {
    if (id !== currentId) switchTab(id);  // the tab you pick up becomes the selected one (this redraws the strip)
    tabDragging = true;
    el = [...list.children].find((c) => c.dataset.id === id);
    grab = startX - el.getBoundingClientRect().left;  // where on the tab it was picked up
    el.classList.add('dragging');
    document.body.classList.add('dragging-tab');
    timer = setInterval(autoScroll, 30);
  };
  // Near either end of the strip, keep scrolling it so a tab can be carried past what is visible.
  const autoScroll = () => {
    const r = list.getBoundingClientRect(), edge = 36;
    const step = lastX < r.left + edge ? -12 : lastX > r.right - edge ? 12 : 0;
    if (step) { list.scrollLeft += step; follow(lastX); }
  };
  // The dragged tab follows the pointer; the others slide into the gap it leaves as it passes their middles.
  const follow = (x) => {
    const r = list.getBoundingClientRect(), w = el.offsetWidth;
    const want = Math.max(r.left, Math.min(r.right - w, x - grab));  // where it is drawn: never leaves the strip
    const others = [...list.children].filter((c) => c !== el);
    const center = x - grab + w / 2;  // where it belongs is decided from the pointer itself, so dragging past either end reaches that end
    // Decide from where tabs sit in the layout (offsetLeft), not where they are drawn, so a tab mid-slide cannot skew the choice.
    const before = others.find((c) => center < r.left - list.scrollLeft + c.offsetLeft + c.offsetWidth / 2) || null;
    if (before !== el.nextElementSibling) {
      const lefts = new Map(others.map((c) => [c, c.getBoundingClientRect().left]));
      list.insertBefore(el, before);
      if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
        for (const c of others) {  // slide each shifted tab from where it was to where it is now
          const dx = lefts.get(c) - c.getBoundingClientRect().left;
          if (!dx) continue;
          c.style.transition = 'none'; c.style.transform = `translateX(${dx}px)`;
          requestAnimationFrame(() => { c.style.transition = 'transform .14s'; c.style.transform = ''; });
        }
      }
    }
    el.style.transform = `translateX(${want - (list.getBoundingClientRect().left + el.offsetLeft - list.scrollLeft)}px)`;
  };

  const move = (ev) => {
    lastX = ev.clientX;
    if (!tabDragging) { if (Math.abs(lastX - startX) < DRAG_THRESHOLD) return; begin(); }
    follow(lastX);
  };
  const end = (commit) => {
    for (const t of ['pointermove', 'pointerup', 'pointercancel']) window.removeEventListener(t, t === 'pointermove' ? move : up);
    document.removeEventListener('keydown', onKey, true);
    clearInterval(timer);
    document.body.classList.remove('dragging-tab');
    if (!tabDragging) return;  // it was only a click
    const order = [...list.children].map((c) => c.dataset.id);
    tabDragging = false;
    if (commit && order.join() !== originalOrder.join()) { tabs.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)); persistTabs(); }
    tabRenderWaiting = false;
    renderTabs();  // rebuilds the strip from `tabs`: clears the transforms, and undoes the move if it was cancelled
    // the click the browser sends after the mouse is released must not also select a tab
    const swallow = (ev) => { ev.stopImmediatePropagation(); ev.preventDefault(); };
    list.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => list.removeEventListener('click', swallow, true), 0);
  };
  const up = () => end(true);
  const onKey = (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); end(false); } };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
  document.addEventListener('keydown', onKey, true);
});

$('newTab').onclick = () => { newTab(); editor.focus(); };

// Tabs survive a restart (SQL, title, connection, saved link). Results do not.
let persistTimer = null;
function persistTabs() { clearTimeout(persistTimer); persistTimer = setTimeout(persistTabsNow, 400); }
function persistTabsNow() {
  clearTimeout(persistTimer);
  const cur = currentTab();
  if (cur) { cur.sql = editor.getValue(); cur.connId = active; }
  return tiny.store.set('tabs', {
    current: currentId,
    list: tabs.map(({ id, title, sql, connId, savedId, origin }) => ({ id, title, sql, connId, savedId, origin })),
  });
}
window.addEventListener('pagehide', persistTabsNow);

async function loadTabs() {
  await loadQueries();
  const saved = await tiny.store.get('tabs');
  tabs.length = 0;
  currentId = null;
  for (const t of saved?.list || []) {
    tabs.push({ id: t.id, title: t.title, sql: t.sql || '', connId: t.connId || null, origin: t.origin || null, snap: null, cm: null,
      savedId: queries.some((q) => q.id === t.savedId) ? t.savedId : null });
  }
  if (!tabs.length) newTab({ show: false });
  switchTab((tabs.find((t) => t.id === saved?.current) || tabs[0]).id, { discard: true });
}

// ---- saved queries: a named library in tiny.store 'queries' ----
let savedOpen = true;  // the sidebar group
let savedFilter = '';  // the search box: every word must appear in a query's name or SQL
const saveQueries = () => tiny.store.set('queries', queries);
async function loadQueries() {
  queries = (await tiny.store.get('queries')) || [];
  renderSaved();
}

// The matching parts of `text` wrapped in <mark>, everything escaped.
function highlight(text, words) {
  const lower = text.toLowerCase();
  if (!words.length || lower.length !== text.length) return esc(text);
  const spans = [];
  for (const w of words) for (let i = lower.indexOf(w); i !== -1; i = lower.indexOf(w, i + w.length)) spans.push([i, i + w.length]);
  spans.sort((a, b) => a[0] - b[0]);
  let out = '', at = 0;
  for (const [from, to] of spans) {
    if (to <= at) continue;
    const start = Math.max(from, at);
    out += esc(text.slice(at, start)) + `<mark>${esc(text.slice(start, to))}</mark>`;
    at = to;
  }
  return out + esc(text.slice(at));
}

function renderSaved() {
  const words = savedFilter.toLowerCase().split(/\s+/).filter(Boolean);
  const hit = (q) => words.every((w) => q.name.toLowerCase().includes(w) || q.sql.toLowerCase().includes(w));
  const list = [...queries].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })).filter(hit);
  const f = document.activeElement;
  const focusId = f && $('saved').contains(f) ? f.closest('.sq')?.dataset.id : null;
  $('savedGroup').classList.toggle('open', savedOpen);
  $('savedHead').setAttribute('aria-expanded', savedOpen);
  $('savedCount').textContent = words.length ? `${list.length} of ${queries.length}` : queries.length;
  $('savedSearchBox').hidden = !savedOpen || !queries.length;
  $('savedSearchClear').hidden = !savedFilter;
  const sel = currentTab()?.savedId;
  $('saved').innerHTML = list.length
    ? list.map((q) => `<li class="sq ${q.id === sel ? 'sel' : ''}" tabindex="0" data-id="${esc(q.id)}" title="${esc(q.sql.slice(0, 240))}">
        ${icon('file-code', 14)}<span class="name">${highlight(q.name, words)}</span>
        <span class="tools"><button data-act="rename" title="Rename" aria-label="Rename ${esc(q.name)}">${icon('pencil', 14)}</button><button data-act="del" title="Delete saved query" aria-label="Delete ${esc(q.name)}">${icon('trash-2', 14)}</button></span>
      </li>`).join('')
    : queries.length ? `<li class="sq-empty">No saved query matches “${esc(savedFilter.trim())}”.</li>`
    : '<li class="sq-empty">No saved queries yet. Press ⌘S to save the query in this tab.</li>';
  if (focusId) [...$('saved').children].find((x) => x.dataset.id === focusId)?.focus();
}

// A short, readable default name: the first line of SQL that is not a comment.
function suggestName(sql) {
  const line = sql.split('\n').map((l) => l.replace(/--.*$/, '').trim()).find(Boolean) || '';
  const one = line.replace(/\s+/g, ' ').replace(/;$/, '');
  return one.length > 40 ? one.slice(0, 39) + '…' : one;
}

// Save updates the query this tab came from; with none (or `as`), it asks for a name and creates one.
async function saveTab({ as = false } = {}) {
  const tab = currentTab();
  if (!tab) return;
  const sql = editor.getValue();
  if (!sql.trim()) return status('Nothing to save: the query is empty');
  tab.sql = sql;
  tab.connId = active;
  const linked = tab.savedId ? queries.find((q) => q.id === tab.savedId) : null;
  let target = linked && !as ? linked : null;
  if (!target) {
    const asked = await tiny.dialog.prompt('Name this query', { default: linked ? `${linked.name} copy` : suggestName(sql) || tab.title, ok: 'Save', cancel: 'Cancel' });
    const name = asked == null ? '' : String(asked).trim();
    if (!name) return;
    const clash = queries.find((q) => q.name.toLowerCase() === name.toLowerCase());
    if (clash) {
      const replace = await tiny.dialog.confirm(`Replace “${clash.name}”?`, { detail: 'A saved query with this name already exists.', ok: 'Replace', cancel: 'Cancel' });
      if (!replace) return;
      target = clash;
    } else {
      target = { id: crypto.randomUUID(), name, sql: '', connId: null, updatedAt: 0 };
      queries.push(target);
    }
  }
  Object.assign(target, { sql, connId: active, updatedAt: Date.now() });
  tab.savedId = target.id;
  tab.title = target.name;
  await saveQueries();
  persistTabs();
  renderTabs();
  renderSaved();
  status(`Saved “${target.name}”`);
}

function openSaved(id) {
  const q = queries.find((x) => x.id === id);
  if (!q) return;
  const open = tabs.find((t) => t.savedId === id);
  if (open) { switchTab(open.id); return editor.focus(); }
  openInTab({ title: q.name, sql: q.sql, connId: conns.some((c) => c.id === q.connId) ? q.connId : active, savedId: id });
  editor.focus();
}

// An untouched blank tab is reused rather than left behind; otherwise a new tab opens.
function openInTab(spec) {
  const cur = currentTab();
  if (cur && !cur.savedId && !cur.origin && !cur.sql.trim() && !cur.snap) {
    Object.assign(cur, { title: spec.title, sql: spec.sql, connId: spec.connId ?? active, savedId: spec.savedId ?? null, origin: spec.origin ?? null, cm: null });
    switchTab(cur.id, { discard: true });
  } else newTab(spec);
}

// ---- .sql files: open (dialog, several at once, or drop on the window) and export ----
const baseName = (path) => path.split(/[/\\]/).pop();
async function openFiles(paths) {
  for (const path of paths) {
    const known = tabs.find((t) => t.origin?.path === path);
    if (known) { switchTab(known.id); continue; }  // already open: go to it rather than open a second copy
    let file;
    try { file = await call('readTextFile', { path }); }
    catch (e) { await tiny.dialog.alert(`Couldn’t open ${baseName(path)}`, String(e.message || e)); continue; }
    const text = file.text.replace(/\r\n?/g, '\n');  // the editor stores \n, so hash what it will actually hold
    openInTab({ title: baseName(path).replace(/\.[^.]*$/, '') || baseName(path), sql: text, connId: active, origin: { path, hash: hashText(text) } });
  }
  editor.focus();
}
async function openFileDialog() {
  const paths = await tiny.dialog.openFiles({ types: ['sql', 'txt'] });
  if (paths && paths.length) await openFiles(paths);
}
function handleDrop(paths) {
  const sql = paths.filter((p) => /\.(sql|txt)$/i.test(p));
  if (sql.length) openFiles(sql); else status('Only .sql and .txt files can be opened', true);
}
tiny.win.onDrop(handleDrop);

// Writes the tab's whole SQL (not just a selection) to a file the user picks. The tab then counts as saved to that file.
async function exportTab() {
  const tab = currentTab();
  if (!tab) return;
  const sql = editor.getValue();
  if (!sql.trim()) return status('Nothing to export: the query is empty');
  const picked = await tiny.dialog.saveFile({ types: ['sql'] });
  if (!picked) return;
  const path = /\.[^/\\.]+$/.test(picked) ? picked : `${picked}.sql`;
  try { await call('writeTextFile', { path, text: sql }); }
  catch (e) { return tiny.dialog.alert(`Couldn’t save ${baseName(path)}`, String(e.message || e)); }
  tab.sql = sql;
  tab.origin = { path, hash: hashText(sql) };
  persistTabs();
  renderTabs();
  status(`Exported to ${baseName(path)}`);
}
// ---- export results as CSV ----
// The grid holds at most 1000 rows (or one 100-row page of a table). When there may be more, ask whether to export just what
// is shown or every row; every row means running the query again and streaming it to disk (see exportQueryCsv).
let exportRows = 0;
const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
const onExportProgress = ({ id, rows }) => { if (running && running.exporting && running.id === id) exportRows = rows; };
tiny.api.on('exportProgress', onExportProgress);

async function exportCsv() {
  if (running || !result.columns.length) return;
  const tab = currentTab(), snap = tab && tab.snap;
  const ctx = snap && snap.kind === 'grid' && snap.r.rows === result.rows ? snap : null;  // the snapshot that is on screen
  const browsing = ctx && ctx.view;
  const more = browsing ? !(browsing.page === 0 && result.rows.length < PAGE_SIZE) : result.truncated;
  let allSql = null;
  if (more && ctx && ctx.connId && (browsing || ctx.sql)) {
    const shown = result.rows.length.toLocaleString();
    const name = browsing ? (tables[ctx.connId] || []).find((t) => t.ref === browsing.ref)?.name || 'this table' : '';
    const all = await tiny.dialog.confirm(browsing ? 'Export the whole table?' : 'Export all rows?', {
      detail: browsing ? `The grid shows one page of ${name}. Exporting the whole table reads it again.` : `The grid shows the first ${shown} rows. Exporting every row runs the query again.`,
      ok: browsing ? 'Export whole table' : 'Export all rows',
      cancel: browsing ? 'Export this page' : `Export the ${shown} shown`,
    });
    if (all) allSql = browsing ? `select * from ${browsing.ref}` : ctx.sql;
  }
  const picked = await tiny.dialog.saveFile({ types: ['csv'] });
  if (!picked) return;
  const path = /\.[^/\\.]+$/.test(picked) ? picked : `${picked}.csv`;
  if (allSql) return exportAllCsv(tab, ctx.connId, allSql, path);
  try {
    const r = await call('exportRowsCsv', { path, columns: result.columns, rows: result.rows });
    status(`Exported ${plural(r.rows, 'row')} to ${baseName(path)}`);
  } catch (e) { await tiny.dialog.alert(`Couldn’t save ${baseName(path)}`, String(e.message || e)); }
}

// Runs as the one operation in flight: the status line counts rows, Stop cancels it (Postgres), and the results on
// screen are left alone either way.
async function exportAllCsv(tab, connId, sql, path) {
  const conn = conns.find((c) => c.id === connId);
  running = { id: connId, type: conn?.type, start: Date.now(), stopping: false, tab: tab.id, exporting: true };
  exportRows = 0;
  const tick = () => {
    if (running.tab !== currentId || running.stopping) return;
    status(exportRows ? `Exporting… ${plural(exportRows, 'row')}` : 'Exporting…');
  };
  tick();
  runTimer = setInterval(tick, 250);
  renderRun();
  renderTabs();
  let failure = null, r = null;
  try { r = await call('exportQueryCsv', { id: connId, sql, path }); } catch (e) { failure = e; }
  clearInterval(runTimer);
  running = null;
  renderRun();
  renderTabs();
  if (failure) {
    status('Export failed', true);
    return tiny.dialog.alert(`Couldn’t export to ${baseName(path)}`, String(failure.message || failure));
  }
  status(r.cancelled ? 'Export stopped. No file was written' : `Exported ${plural(r.rows, 'row')} to ${baseName(path)}`);
}
$('exportCsv').onclick = exportCsv;
$('openFile').onclick = openFileDialog;
$('exportBtn').onclick = exportTab;

async function renameSaved(id) {
  const q = queries.find((x) => x.id === id);
  if (!q) return;
  const asked = await tiny.dialog.prompt('Rename query', { default: q.name, ok: 'Rename', cancel: 'Cancel' });
  const name = asked == null ? '' : String(asked).trim();
  if (!name || name === q.name) return;
  const clash = queries.find((x) => x.id !== id && x.name.toLowerCase() === name.toLowerCase());
  if (clash) return status(`A saved query named “${clash.name}” already exists`, true);
  q.name = name;
  for (const t of tabs) if (t.savedId === id) t.title = name;
  await saveQueries();
  persistTabs();
  renderTabs();
  renderSaved();
}

async function deleteSaved(id) {
  const q = queries.find((x) => x.id === id);
  if (!q) return;
  const sure = await tiny.dialog.confirm(`Delete “${q.name}”?`, { detail: 'Tabs that have it open keep their text.', ok: 'Delete', cancel: 'Cancel' });
  if (!sure) return;
  queries = queries.filter((x) => x.id !== id);
  for (const t of tabs) if (t.savedId === id) t.savedId = null;
  await saveQueries();
  persistTabs();
  renderTabs();
  renderSaved();
}

$('saved').addEventListener('click', (e) => {
  const li = e.target.closest('.sq');
  if (!li) return;
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'rename') return renameSaved(li.dataset.id);
  if (act === 'del') return deleteSaved(li.dataset.id);
  openSaved(li.dataset.id);
});
$('saved').addEventListener('keydown', (e) => {
  if (!e.target.matches('.sq')) return;
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); return e.target.click(); }
  const items = [...$('saved').querySelectorAll('.sq')], i = items.indexOf(e.target);
  if (e.key === 'ArrowDown' && items[i + 1]) { e.preventDefault(); items[i + 1].focus(); }
  if (e.key === 'ArrowUp') { e.preventDefault(); (items[i - 1] || $('savedSearch')).focus(); }
});
$('savedSearch').addEventListener('input', () => { savedFilter = $('savedSearch').value; renderSaved(); });
$('savedSearch').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); if (savedFilter) { $('savedSearch').value = savedFilter = ''; renderSaved(); } else $('savedSearch').blur(); }
  if (e.key === 'Enter') { e.preventDefault(); $('saved').querySelector('.sq')?.click(); }  // open the first match
  if (e.key === 'ArrowDown') { e.preventDefault(); $('saved').querySelector('.sq')?.focus(); }
});
$('savedSearchClear').onclick = () => { $('savedSearch').value = savedFilter = ''; renderSaved(); $('savedSearch').focus(); };
$('savedHead').onclick = () => { savedOpen = !savedOpen; renderSaved(); };
$('saveBtn').onclick = (e) => saveTab({ as: e.shiftKey });
// ⌘T new tab, ⌘S save, ⌘⇧S save as, ⌘O open files, ⌘E export SQL, ⌘⇧E export CSV, Ctrl+Tab / Ctrl+Shift+Tab to move between tabs.
document.addEventListener('keydown', (e) => {
  if (document.querySelector('dialog[open]')) return;
  const mod = e.metaKey || e.ctrlKey, key = e.key.toLowerCase();
  if (mod && !e.shiftKey && !e.altKey && key === 't') { e.preventDefault(); newTab(); editor.focus(); }
  else if (mod && !e.altKey && key === 's') { e.preventDefault(); saveTab({ as: e.shiftKey }); }
  else if (e.ctrlKey && e.key === 'Tab') { e.preventDefault(); cycleTab(e.shiftKey ? -1 : 1); }
  else if (e.shiftKey && !e.altKey && (e.metaKey || (e.ctrlKey && !settings.vim)) && key === 'e') { e.preventDefault(); exportCsv(); }
  else if (!e.shiftKey && !e.altKey && (e.metaKey || (e.ctrlKey && !settings.vim)) && (key === 'o' || key === 'e')) {
    e.preventDefault();
    if (key === 'o') openFileDialog(); else exportTab();
  }
});

// ---- wiring ----
$('run').onclick = () => (running ? stopQuery() : runSql());
// ⌘. (macOS) / Ctrl+. stops the running query, wherever focus is.
document.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === '.') { e.preventDefault(); stopQuery(); } });
$('prev').onclick = () => browse(view.ref, view.page - 1);
$('next').onclick = () => browse(view.ref, view.page + 1);

async function load() {
  conns = await call('listConnections');
  renderConns();
  if (!showingResult) renderEmpty();
}
load().then(loadTabs);
loadSettings();
loadLayout();
loadEnvs();
