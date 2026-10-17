// Self-driving UI check: TINYJS_HTML=$PWD/test/ui.html tinyjs dev
// Results land in tiny.store 'results' (~/Library/Application Support/<id>/store.json).
// Anything thrown outside the checks (page script errors, unhandled rejections) is kept in the store as 'jserr'.
const logErr = (m) => { try { tiny.store.set('jserr', String(m)); } catch {} };
window.addEventListener('error', (e) => logErr(`${e.message} @${String(e.filename).split('/').pop()}:${e.lineno}`));
window.addEventListener('unhandledrejection', (e) => logErr('unhandled: ' + (e.reason && e.reason.message || e.reason)));
// A heartbeat in the store tells ui.sh, after a hang, whether the page froze (the beat stops) or the driver is waiting (it goes on).
setInterval(() => { try { tiny.store.set('beat', Date.now()); tiny.store.set('beatState', { visibility: document.visibilityState, focused: document.hasFocus() }); } catch {} }, 1000);
(async () => {
  const results = { done: false, checks: [] };
  // Saved after every check, so a hang still shows how far the run got.
  const check = (name, ok, info) => { results.checks.push({ name, ok: !!ok, info: info ?? null }); tiny.store.set('results', results); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, what) => { for (let i = 0; i < 100; i++) { const v = fn(); if (v) return v; await sleep(100); } throw new Error('timeout: ' + what); };
  const run = async (sql) => { editor.setValue(sql); document.getElementById('run').click(); await sleep(400); };
  const save = () => tiny.store.set('results', results);
  try {
    while (typeof tiny === 'undefined') await sleep(100);
    // A covered window is throttled by the OS (timers stop, the page reports visibility "hidden"), and this driver runs on
    // timers. Floating keeps the test window on top without taking keyboard focus from whatever you are doing.
    tiny.win.setAlwaysOnTop(true);
    await tiny.api.call('ping');
    await until(() => tabs.length && currentTab(), 'tabs loaded');  // the app restores its tabs asynchronously at startup
    check('codemirror mounted', !!document.querySelector('#sql .cm-editor'));
    check('the app is called TinyArQL (page title)', document.title === 'TinyArQL', document.title);

    // ---- design system ----
    await document.fonts.load('13px "Geist Mono"');
    check('bundled mono font loads', document.fonts.check('13px "Geist Mono"'));
    check('editor uses the shared mono', getComputedStyle(document.querySelector('#sql .cm-content')).fontFamily.includes('Geist Mono'), getComputedStyle(document.querySelector('#sql .cm-content')).fontFamily);
    check('sidebar has no all-caps label; add-connection button instead', !document.querySelector('.side-head') && !document.querySelector('aside').textContent.includes('Connections') && document.getElementById('addConn').textContent.trim() === 'Add connection');
    // ---- editor splitter ----
    const sp = document.getElementById('splitter'), sqlBox = document.getElementById('sql');
    const H = () => sqlBox.offsetHeight, maxH = () => +sp.getAttribute('aria-valuemax');
    const drag = async (dy) => {
      const y0 = 300, ev = (type, y) => new PointerEvent(type, { clientY: y, bubbles: true, cancelable: true, pointerId: 1 });
      sp.dispatchEvent(ev('pointerdown', y0)); window.dispatchEvent(ev('pointermove', y0 + dy)); window.dispatchEvent(ev('pointerup', y0 + dy)); await sleep(80);
    };
    const key = (k, extra = {}) => sp.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }));
    check('splitter is an accessible separator', sp.getAttribute('role') === 'separator' && sp.tabIndex === 0 && sp.getAttribute('aria-orientation') === 'horizontal');
    check('native resize handle is gone', getComputedStyle(sqlBox).resize === 'none');
    check('editor starts at the default height', H() === 168 && +sp.getAttribute('aria-valuenow') === 168, String(H()));
    await drag(60);
    check('dragging down grows the editor', H() === 228, String(H()));
    check('CodeMirror fills the resized panel', Math.abs(document.querySelector('#sql .cm-editor').offsetHeight - H()) <= 1, document.querySelector('#sql .cm-editor').offsetHeight + ' vs ' + H());
    check('drag end saves the height', (await tiny.store.get('layout')).editorHeight === 228);
    await drag(-40);
    check('dragging up shrinks it', H() === 188, String(H()));
    await drag(5000);
    check('cannot grow past the window (results keep 140px)', H() === maxH() && document.querySelector('.body').offsetHeight >= 139, `${H()} max ${maxH()} body ${document.querySelector('.body').offsetHeight}`);
    await drag(-5000);
    check('cannot shrink below 64px', H() === 64, String(H()));
    sp.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    check('double-click resets to the default', H() === 168 && (await tiny.store.get('layout')).editorHeight === 168);
    key('ArrowDown'); check('ArrowDown grows by 16', H() === 184, String(H()));
    key('ArrowUp'); key('ArrowUp'); check('ArrowUp shrinks by 16', H() === 152, String(H()));
    key('ArrowDown', { shiftKey: true }); check('Shift+Arrow moves by 64', H() === 216, String(H()));
    key('Home'); check('Home goes to the minimum', H() === 64);
    key('End'); check('End goes to the maximum', H() === maxH(), `${H()} max ${maxH()}`);
    editorPane.set(210, true); editorPane.set(0);
    check('(sanity) height was forced away', H() === 64);
    await loadLayout();
    check('saved height is restored on load', H() === 210, String(H()));
    // a shrinking window pulls the editor back in, and the wish is remembered when it grows again
    editorPane.set(2000);
    tiny.win.setSize(900, 560); await sleep(500);
    check('shrinking the window keeps the editor inside it', H() <= maxH() && document.querySelector('.body').offsetHeight >= 139, `${H()} max ${maxH()}`);
    const small = H();
    tiny.win.setSize(960, 640); await sleep(500);
    check('growing the window gives the room back', H() > small && H() === maxH(), `${small} -> ${H()} max ${maxH()}`);
    editorPane.set(168, true);

    // ---- sidebar splitter ----
    const ss = document.getElementById('sideSplitter'), side = document.querySelector('aside'), mainEl = document.querySelector('main');
    const W = () => side.offsetWidth, maxW = () => +ss.getAttribute('aria-valuemax');
    const dragX = async (dx) => {
      const x0 = 400, ev = (type, x) => new PointerEvent(type, { clientX: x, bubbles: true, cancelable: true, pointerId: 1 });
      ss.dispatchEvent(ev('pointerdown', x0)); window.dispatchEvent(ev('pointermove', x0 + dx)); window.dispatchEvent(ev('pointerup', x0 + dx)); await sleep(80);
    };
    const keyX = (k, extra = {}) => ss.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }));
    check('sidebar splitter is an accessible vertical separator', ss.getAttribute('role') === 'separator' && ss.tabIndex === 0 && ss.getAttribute('aria-orientation') === 'vertical');
    check('sidebar starts at the default width', W() === 248 && +ss.getAttribute('aria-valuenow') === 248, String(W()));
    check('sidebar sits between the splitter and the window edge (no gap, no overlap)', side.getBoundingClientRect().left === 0 && Math.abs(mainEl.getBoundingClientRect().left - W()) <= 1, `${mainEl.getBoundingClientRect().left} vs ${W()}`);
    await dragX(60);
    check('dragging right widens the sidebar', W() === 308, String(W()));
    check('drag end saves the width without losing the editor height', (await tiny.store.get('layout')).sidebarWidth === 308 && (await tiny.store.get('layout')).editorHeight === 168, JSON.stringify(await tiny.store.get('layout')));
    await dragX(-40);
    check('dragging left narrows it', W() === 268, String(W()));
    await dragX(5000);
    check('cannot grow past the limit (main keeps 480px)', W() === maxW() && W() <= 520 && mainEl.offsetWidth >= 479, `${W()} max ${maxW()} main ${mainEl.offsetWidth}`);
    await dragX(-5000);
    check('cannot shrink below 180px', W() === 180, String(W()));
    ss.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    check('double-click resets to the default', W() === 248 && (await tiny.store.get('layout')).sidebarWidth === 248);
    keyX('ArrowRight'); check('ArrowRight widens by 16', W() === 264, String(W()));
    keyX('ArrowLeft'); keyX('ArrowLeft'); check('ArrowLeft narrows by 16', W() === 232, String(W()));
    keyX('ArrowRight', { shiftKey: true }); check('Shift+Arrow moves by 64', W() === 296, String(W()));
    keyX('Home'); check('Home goes to the minimum', W() === 180);
    keyX('End'); check('End goes to the maximum', W() === maxW(), `${W()} max ${maxW()}`);
    check('Up/Down do nothing on the vertical splitter', (() => { const w = W(); keyX('ArrowUp'); keyX('ArrowDown'); return W() === w; })());
    // both sizes live in one saved layout; each is restored
    editorPane.set(200, true); sidePane.set(300, true);
    check('all sizes are saved together', JSON.stringify(await tiny.store.get('layout')) === JSON.stringify({ editorHeight: 200, sidebarWidth: 300, detailWidth: 380 }), JSON.stringify(await tiny.store.get('layout')));
    editorPane.set(0); sidePane.set(0);
    check('(sanity) sizes were forced away', H() === 64 && W() === 180);
    await loadLayout();
    check('saved sizes are restored on load', H() === 200 && W() === 300, `${H()} / ${W()}`);
    // a narrow window pulls the sidebar in; the wish survives and is honoured again when the window grows
    sidePane.set(520);
    tiny.win.setSize(900, 640); await sleep(500);
    check('narrow window: sidebar yields so main keeps 480px', W() <= maxW() && mainEl.offsetWidth >= 479, `${W()} max ${maxW()} main ${mainEl.offsetWidth}`);
    const narrow = W();
    tiny.win.setSize(1300, 640); await sleep(500);
    check('wide window: the sidebar gets its width back', W() > narrow && W() === 520, `${narrow} -> ${W()}`);
    tiny.win.setSize(960, 640); await sleep(300);
    sidePane.set(248, true); editorPane.set(168, true);

    // ---- cell details splitter (the panel sits on the right, so dragging LEFT widens it) ----
    const ds = document.getElementById('detailSplitter'), dpanel = document.getElementById('detail'), gridEl = document.getElementById('grid');
    const DW = () => dpanel.offsetWidth, dmax = () => +ds.getAttribute('aria-valuemax');
    const dragD = async (dx) => {
      const x0 = 900, ev = (type, x) => new PointerEvent(type, { clientX: x, bubbles: true, cancelable: true, pointerId: 1 });
      ds.dispatchEvent(ev('pointerdown', x0)); window.dispatchEvent(ev('pointermove', x0 + dx)); window.dispatchEvent(ev('pointerup', x0 + dx)); await sleep(80);
    };
    const keyD = (k, extra = {}) => ds.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }));
    check('details splitter is hidden with the panel', dpanel.hidden && ds.offsetWidth === 0);
    renderGrid({ columns: ['d'], types: ['text'], rows: [['hello']], truncated: false, ms: 0 });
    gridEl.querySelector('td').click();
    check('details splitter is an accessible vertical separator inside the open panel', !dpanel.hidden && ds.offsetWidth > 0 && ds.getAttribute('role') === 'separator' && ds.getAttribute('aria-orientation') === 'vertical' && ds.tabIndex === 0);
    check('details panel starts at the default width', DW() === 380 && +ds.getAttribute('aria-valuenow') === 380, String(DW()));
    check('the splitter draws the divider (panel has no border of its own)', getComputedStyle(dpanel).borderLeftWidth === '0px');
    await dragD(-60);
    check('dragging left widens the panel', DW() === 440, String(DW()));
    check('drag end saves the width and keeps the other sizes', (await tiny.store.get('layout')).detailWidth === 440 && Number.isFinite((await tiny.store.get('layout')).editorHeight) && Number.isFinite((await tiny.store.get('layout')).sidebarWidth), JSON.stringify(await tiny.store.get('layout')));
    await dragD(40);
    check('dragging right narrows it', DW() === 400, String(DW()));
    await dragD(-5000);
    check('cannot grow past the limit (results keep 240px)', DW() === dmax() && gridEl.offsetWidth >= 239, `${DW()} max ${dmax()} grid ${gridEl.offsetWidth}`);
    await dragD(5000);
    check('cannot shrink below 260px', DW() === 260, String(DW()));
    ds.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    check('double-click resets to the default', DW() === 380 && (await tiny.store.get('layout')).detailWidth === 380);
    keyD('ArrowLeft'); check('ArrowLeft widens by 16', DW() === 396, String(DW()));
    keyD('ArrowRight'); keyD('ArrowRight'); check('ArrowRight narrows by 16', DW() === 364, String(DW()));
    keyD('ArrowLeft', { shiftKey: true }); check('Shift+Arrow moves by 64', DW() === 428, String(DW()));
    keyD('Home'); check('Home goes to the minimum', DW() === 260);
    keyD('End'); check('End goes to the maximum', DW() === dmax(), `${DW()} max ${dmax()}`);
    check('Up/Down do nothing on this vertical splitter', (() => { const w = DW(); keyD('ArrowUp'); keyD('ArrowDown'); return DW() === w; })());
    detailPane.set(420, true); detailPane.set(0);
    check('(sanity) width was forced away', DW() === 260);
    await loadLayout();
    check('saved width is restored on load', DW() === 420, String(DW()));
    detailPane.set(900);
    tiny.win.setSize(900, 640); await sleep(500);
    check('narrow window: the panel yields so the grid keeps 240px', DW() <= dmax() && gridEl.offsetWidth >= 239, `${DW()} max ${dmax()} grid ${gridEl.offsetWidth}`);
    const squeezed = DW();
    tiny.win.setSize(1500, 640); await sleep(500);
    check('wide window: the panel gets its width back', DW() > squeezed && DW() === 900, `${squeezed} -> ${DW()}`);
    tiny.win.setSize(960, 640); await sleep(300);
    closeDetail();
    check('closing the panel hides the splitter again', dpanel.hidden && ds.offsetWidth === 0);
    // moving the sidebar changes how much room the details panel has: it must re-check without a window resize
    gridEl.querySelector('td').click();
    detailPane.set(600); sidePane.set(520);
    const squeezed2 = DW();
    check('(sanity) a wide sidebar squeezes the details panel', squeezed2 < 600, String(squeezed2));
    sidePane.set(180);
    check('narrowing the sidebar gives the room back to the details panel', DW() > squeezed2 && DW() === Math.min(600, dmax()), `${squeezed2} -> ${DW()} (max ${dmax()})`);
    closeDetail();
    detailPane.set(380, true); sidePane.set(248, true);
    renderEmpty();  // leave the grid as the first-run checks below expect it

    // ---- first run: no connections yet ----
    const welcome = document.querySelector('#grid .welcome');
    check('first-run welcome is shown with a card per database', !!welcome && welcome.querySelector('h2').textContent === 'Connect to a database' && [...welcome.querySelectorAll('.choice')].map((c) => c.dataset.new).join() === 'postgres,mysql,sqlite');
    welcome.querySelector('[data-new=sqlite]').click();
    check('SQLite choice opens the form on SQLite', document.getElementById('dlg').open && document.getElementById('form').elements.type.value === 'sqlite' && !document.querySelector('[data-for=sqlite]').hidden);
    document.getElementById('cancel').click();
    welcome.querySelector('[data-new=postgres]').click();
    check('PostgreSQL choice opens the form on PostgreSQL', document.getElementById('dlg').open && document.getElementById('form').elements.type.value === 'postgres' && !document.querySelector('[data-for="postgres mysql"]').hidden);
    document.getElementById('cancel').click();

    // ---- icons ----
    check('icon placeholders were all replaced', !document.querySelector('i[data-icon]') && document.querySelectorAll('svg.i').length >= 8, String(document.querySelectorAll('svg.i').length));
    let threw = false; try { icon('nope'); } catch { threw = true; }
    check('unknown icon name fails loudly', threw);
    check('no glyph characters used as icons', ![...document.querySelectorAll('button')].some((b) => /[⚙✎×‹›]/.test(b.textContent)));
    let focusRule = null;
    try { focusRule = [...document.styleSheets].some((sh) => [...sh.cssRules].some((r) => (r.selectorText || '').includes(':focus-visible'))); } catch (e) { focusRule = 'unreadable: ' + e.name; }
    check('keyboard focus ring rule exists', focusRule === true, String(focusRule));

    // settings: vim is off by default; toggling applies immediately and persists
    const vimOn = () => !!document.querySelector('#sql .cm-vim-panel');
    check('vim off by default', !vimOn() && settings.vim === false);
    document.getElementById('settingsBtn').click();
    check('settings dialog opens', document.getElementById('settings').open);
    // ---- theme ----
    const root = document.documentElement, seg = document.getElementById('themeSeg');
    const bgOf = (e) => getComputedStyle(e).backgroundColor;
    const osDark = matchMedia('(prefers-color-scheme: dark)').matches;
    check('theme defaults to System and follows the OS', settings.theme === 'system' && root.dataset.theme === (osDark ? 'dark' : 'light') && seg.querySelector('[data-theme=system]').getAttribute('aria-checked') === 'true');
    const probe = document.createElement('span'); document.body.appendChild(probe);
    const rgb = (v) => { probe.style.color = `var(${v})`; return getComputedStyle(probe).color.match(/[\d.]+/g).slice(0, 3).map(Number); };
    const lum = (c) => { const [r, g, b] = c.map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const ratio = (fg, bg) => { const [a, b] = [lum(rgb(fg)), lum(rgb(bg))].sort((x, y) => y - x); return (a + 0.05) / (b + 0.05); };
    const PAIRS = [  // [foreground, background, minimum ratio]: 4.5 for text, 3 for lines/UI
      ['--text', '--ground', 4.5], ['--text', '--panel', 4.5], ['--dim', '--ground', 4.5], ['--dim', '--panel', 4.5],
      ['--accent-ink', '--accent', 4.5], ['--bad', '--panel', 4.5], ['--bad', '--ground', 4.5],
      ['--accent-line', '--ground', 3], ['--accent-line', '--panel', 3], ['--gutter', '--ground', 3],
      ['--ok', '--panel', 4.5], ['--ok', '--raise', 3], ['--env-local', '--panel', 4.5], ['--env-staging', '--panel', 4.5], ['--env-production', '--panel', 4.5],
      ['--j-key', '--panel', 4.5], ['--j-str', '--panel', 4.5], ['--j-num', '--panel', 4.5], ['--j-bool', '--panel', 4.5],
      ['--syn-keyword', '--ground', 4.5], ['--syn-string', '--ground', 4.5], ['--syn-number', '--ground', 4.5], ['--syn-type', '--ground', 4.5], ['--syn-comment', '--ground', 4.5],
    ];
    const contrast = (name) => { const bad = PAIRS.map(([f, b, min]) => [f, b, min, ratio(f, b)]).filter(([, , min, r]) => r < min); check(`${name} theme meets contrast (${PAIRS.length} pairs)`, !bad.length, bad.map(([f, b, min, r]) => `${f} on ${b} ${r.toFixed(2)} < ${min}`).join('; ')); };
    seg.querySelector('[data-theme=light]').click(); await sleep(150);
    check('Light: page and editor switch', root.dataset.theme === 'light' && bgOf(document.body) === 'rgb(255, 255, 255)' && bgOf(document.querySelector('#sql .cm-editor')) === 'rgb(255, 255, 255)' && getComputedStyle(document.querySelector('#sql .cm-content')).color === 'rgb(23, 33, 43)', bgOf(document.querySelector('#sql .cm-editor')) + ' / ' + getComputedStyle(document.querySelector('#sql .cm-content')).color);
    check('Light: segmented control reflects the choice', seg.querySelector('[data-theme=light]').getAttribute('aria-checked') === 'true' && seg.querySelector('[data-theme=system]').getAttribute('aria-checked') === 'false');
    check('Light: choice persisted', (await tiny.store.get('settings')).theme === 'light');
    contrast('Light');
    seg.querySelector('[data-theme=dark]').click(); await sleep(150);
    check('Dark: page and editor switch', root.dataset.theme === 'dark' && bgOf(document.body) === 'rgb(19, 27, 34)' && bgOf(document.querySelector('#sql .cm-editor')) === 'rgb(19, 27, 34)', bgOf(document.querySelector('#sql .cm-editor')));
    contrast('Dark');
    seg.querySelector('[data-theme=system]').click(); await sleep(100);
    check('System resolves from the OS again', root.dataset.theme === (osDark ? 'dark' : 'light'));
    seg.querySelector('[data-theme=dark]').click(); await sleep(100);  // the colour assertions below assume dark
    settings.theme = 'system'; await loadSettings();
    check('theme survives a settings reload', settings.theme === 'dark' && root.dataset.theme === 'dark');
    document.getElementById('optVim').click();
    await sleep(200);
    check('vim status panel shown when enabled', vimOn());
    check('setting persisted to store', (await tiny.store.get('settings')).vim === true);
    editor.setValue('abc'); editor.select(0, 0); editor.vimKeys('x');
    check('vim normal mode: x deletes a char', editor.getValue() === 'bc', editor.getValue());
    settings.vim = false; await loadSettings();
    check('loadSettings restores persisted vim', settings.vim === true && vimOn());
    document.getElementById('settingsClose').click();
    check('settings dialog closes', !document.getElementById('settings').open);
    for (const c of await tiny.api.call('listConnections')) await tiny.api.call('deleteConnection', { id: c.id });

    document.getElementById('addConn').click();
    const f = document.getElementById('form');
    const ssh = document.getElementById('ssh');
    check('ssh fields hidden by default', ssh.hidden);
    f.elements.sshOn.checked = true; f.elements.sshOn.dispatchEvent(new Event('change'));
    check('ticking tunnel box reveals ssh fields', !ssh.hidden);
    f.elements.sshOn.checked = false; f.elements.sshOn.dispatchEvent(new Event('change'));
    check('unticking hides them again', ssh.hidden);
    f.elements.env.value = 'production'; f.elements.name.value = 'ui-test'; f.elements.type.value = 'sqlite'; f.elements.type.dispatchEvent(new Event('change')); f.elements.path.value = ':memory:';
    check('sqlite fields shown, postgres hidden', !document.querySelector('[data-for=sqlite]').hidden && document.querySelector('[data-for="postgres mysql"]').hidden);
    f.requestSubmit();
    const row = await until(() => document.querySelector('.conn .row'), 'saved connection listed');
    check('connection saved + listed', row.textContent.includes('ui-test'));
    check('with connections but none picked, the empty state points at the sidebar', document.querySelector('#grid .empty')?.textContent === 'Pick a connection, then run a query or open a table.', document.querySelector('#grid .empty')?.textContent);
    check('sidebar shows the environment tag', row.querySelector('.env')?.textContent === 'production');
    check('icon-only buttons all have labels', [...document.querySelectorAll('button')].filter((b) => !b.textContent.trim()).every((b) => b.getAttribute('aria-label')), [...document.querySelectorAll('button')].filter((b) => !b.textContent.trim() && !b.getAttribute('aria-label')).map((b) => b.id).join());
    const offlineIcon = row.querySelector('.state').innerHTML;
    check('row buttons are at least 24px', parseFloat(getComputedStyle(row.querySelector('.tools button')).minWidth) >= 24 && parseFloat(getComputedStyle(row.querySelector('.tools button')).minHeight) >= 24);

    row.click();
    await until(() => document.querySelector('.conn.on'), 'connected');
    check('connected, Run enabled', !document.getElementById('run').disabled);
    check('connection icon changes shape when connected', document.querySelector('.conn .state').innerHTML !== offlineIcon && !!document.querySelector('.conn .state svg'));
    const stateRgb = () => getComputedStyle(document.querySelector('.conn.on .state')).color.match(/\d+/g).slice(0, 3).map(Number);
    check('connected: the plug is green (dark theme)', JSON.stringify(stateRgb()) === JSON.stringify(rgb('--ok')) && JSON.stringify(stateRgb()) === JSON.stringify([95, 200, 143]), String(stateRgb()));
    const offRgb = getComputedStyle([...document.querySelectorAll('.conn:not(.on) .state')][0] || document.body).color;
    check('offline connections stay dim, not green', !document.querySelector('.conn:not(.on)') || offRgb !== getComputedStyle(document.querySelector('.conn.on .state')).color, offRgb);
    seg.querySelector('[data-theme=light]').click(); await sleep(150);
    check('connected: the plug is the darker green in the light theme', JSON.stringify(stateRgb()) === JSON.stringify(rgb('--ok')) && JSON.stringify(stateRgb()) === JSON.stringify([17, 121, 74]), String(stateRgb()));
    seg.querySelector('[data-theme=dark]').click(); await sleep(150);
    check('tables and views carry icons', document.querySelectorAll('.tbls li svg').length >= 1 || document.querySelectorAll('.tbls li').length === 0);
    const bar = document.getElementById('envBar');
    check('window edge turns production red', !bar.hidden && getComputedStyle(bar).backgroundColor === 'rgb(255, 92, 108)', getComputedStyle(bar).backgroundColor);
    const where = document.getElementById('where');
    check('status bar names connection, dialect and environment', where.textContent.includes('ui-test') && where.textContent.includes('SQLite') && where.querySelector('.env')?.textContent === 'production', where.textContent);

    // vim is still on: :w runs the query, then switch vim off for the remaining (plain-editor) checks
    await run("create table pets(id integer primary key, name text, owner text); insert into pets(name,owner) values ('<b>rex</b>','amy'),('tom',null);");
    editor.setValue('select 9 as nine'); editor.vimEx('w'); await sleep(500);
    check(':w runs the query', document.querySelector('#grid th')?.textContent === 'nine', document.querySelector('#grid th')?.textContent);
    editor.setValue('select 5 as five');
    const vc = document.querySelector('#sql .cm-content'); vc.focus();
    for (const mod of [{ metaKey: true }, { ctrlKey: true }]) {
      vc.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true, ...mod }));
      await sleep(400);
      if (document.querySelector('#grid th')?.textContent === 'five') break;
    }
    check('Mod-Enter still runs with vim on', document.querySelector('#grid th')?.textContent === 'five', document.querySelector('#grid th')?.textContent);
    document.getElementById('settingsBtn').click(); document.getElementById('optVim').click(); document.getElementById('settingsClose').click();
    await sleep(200);
    check('vim panel removed when disabled', !vimOn() && (await tiny.store.get('settings')).vim === false);

    await run('select * from pets order by id');
    const g = document.getElementById('grid');
    await until(() => g.querySelector('td'), 'grid rendered');
    check('2 rows rendered', g.querySelectorAll('tbody tr').length === 2);
    check('cell HTML escaped, not injected', g.querySelector('td:nth-child(2)').textContent === '<b>rex</b>' && !g.querySelector('b'));
    check('NULL styled', g.querySelectorAll('td.null').length === 1);
    const nullTd = g.querySelector('td.null');
    check('NULL is a hatched empty cell', nullTd.textContent === '' && nullTd.title === 'NULL' && getComputedStyle(nullTd).backgroundImage.includes('linear-gradient'), getComputedStyle(nullTd).backgroundImage.slice(0, 40));
    check('numbers right-align (SQLite has no types: sniffed from values)', g.querySelector('th.num') && g.querySelector('td.num') && getComputedStyle(g.querySelector('td.num')).textAlign === 'right' && !g.querySelectorAll('th')[1].classList.contains('num'));
    check('status bar reports rows and timing', /^2 rows in \d+ ms$/.test(document.getElementById('status').textContent), document.getElementById('status').textContent);

    // run-selection: only the highlighted statement executes
    editor.setValue('select 1 as first_col;\nselect 2 as second_col;');
    editor.select(23, 46);  // line 2 only
    document.getElementById('run').click(); await sleep(400);
    check('runs only the selection', g.querySelector('th')?.textContent === 'second_col', g.querySelector('th')?.textContent);
    editor.select(0, 0);
    document.getElementById('run').click(); await sleep(400);
    check('runs whole editor without a selection (last statement wins)', g.querySelector('th')?.textContent === 'second_col');
    // highlighting: the SQL grammar parses keywords
    editor.setValue('select 1 from pets');
    check('sql keywords parsed', editor.nodeNames().includes('Keyword'), editor.nodeNames().join(','));
    // completion from the connection's schema: tables, then columns after `table.`
    editor.setValue('select * from pe'); editor.cursorToEnd();
    const tl = await editor.completionLabels();
    check('completes table names', tl.includes('pets'), tl.slice(0, 8).join(','));
    editor.setValue('select pets.'); editor.cursorToEnd();
    const cl = await editor.completionLabels();
    check('completes columns after table.', ['id', 'name', 'owner'].every((c) => cl.includes(c)), cl.slice(0, 8).join(','));
    // keyboard: Mod-Enter inside the editor runs the query (default keymap would insert a newline)
    editor.setValue('select 7 as seven');
    const content = document.querySelector('#sql .cm-content'); content.focus();
    for (const mod of [{ metaKey: true }, { ctrlKey: true }]) {
      content.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true, ...mod }));
      await sleep(400);
      if (g.querySelector('th')?.textContent === 'seven') break;
    }
    check('Mod-Enter runs the query', g.querySelector('th')?.textContent === 'seven' && editor.getValue() === 'select 7 as seven', editor.getValue());
    // ---- detail panel ----
    const doc = '{"a":{"b":[1,2,{"c":null}]},"s":"<img src=x onerror=alert(1)>","t":true}';
    await run(`create table docs(id integer primary key, body text); insert into docs(body) values ('${doc}'), ('hello'), (null);`);
    await run('select body from docs order by id');
    const cells = () => [...g.querySelectorAll('td')];
    const panel = document.getElementById('detail'), dbody = document.getElementById('detailBody');
    const el = (id) => document.getElementById(id);
    check('JSON-looking cell marked, plain text not', cells()[0].classList.contains('json') && !cells()[1].classList.contains('json'));
    check('panel closed until a cell is clicked', panel.hidden);
    cells()[0].click();
    check('click opens panel on that cell', !panel.hidden && cells()[0].classList.contains('sel') && el('detailTitle').textContent.startsWith('body'));
    check('tree view: collapsible nodes + keys', dbody.querySelectorAll('details').length >= 4 && dbody.textContent.includes('"a"') && dbody.querySelector('.j-bool'));
    check('tree escapes markup from values', !dbody.querySelector('img') && dbody.textContent.includes('<img src=x onerror=alert(1)>'));
    el('detailRaw').click();
    check('raw view shows the exact text', dbody.querySelector('pre')?.textContent === doc && !dbody.querySelector('details'));
    el('detailTree').click();
    check('tree view comes back', !!dbody.querySelector('details'));
    cells()[1].click();
    check('plain text cell: raw text, no view toggles', dbody.querySelector('pre')?.textContent === 'hello' && el('detailTree').hidden && el('detailJson').hidden && el('detailRaw').hidden);
    let copied = null; tiny.clipboard.write = (x) => { copied = x; };  // never touch the real clipboard
    check('copy button is labelled just "Copy"', el('detailCopy').textContent.trim() === 'Copy', el('detailCopy').textContent.trim());
    el('detailCopy').click();
    check('copy sends the cell value', copied && copied.text === 'hello', JSON.stringify(copied));
    check('copy button confirms with a check icon', el('detailCopy').textContent.trim() === 'Copied' && !!el('detailCopy').querySelector('svg'), el('detailCopy').textContent);
    cells()[2].click();
    check('NULL cell shows NULL', dbody.textContent === 'NULL');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    check('Esc closes the panel', panel.hidden && !g.querySelector('td.sel'));
    cells()[0].click(); el('detailClose').click();
    check('close button closes the panel', panel.hidden);
    cells()[0].click(); await run('select 1 as n');
    check('new result closes the panel', panel.hidden);
    // column type wins over text sniffing (what Postgres json/jsonb columns report)
    renderGrid({ columns: ['j'], types: ['jsonb'], rows: [['"just a string"'], ['42'], ['not json']], truncated: false, ms: 0 });
    check('jsonb-typed scalars count as JSON', cells()[0].classList.contains('json') && cells()[1].classList.contains('json') && !cells()[2].classList.contains('json'));
    cells()[1].click();
    check('jsonb scalar renders as a number', !!dbody.querySelector('.j-num') && el('detailTitle').textContent.endsWith('jsonb'), el('detailTitle').textContent);
    // ---- Json view: beautified, coloured, exact ----
    const pretty = '{\n  "a": {\n    "b": [\n      1,\n      2,\n      {\n        "c": null\n      }\n    ]\n  },\n  "s": "<img src=x onerror=alert(1)>",\n  "t": true\n}';
    renderGrid({ columns: ['d', 't'], types: ['jsonb', 'text'], rows: [[doc, 'hello'], ['{"x":[1,2]}', null]], truncated: false, ms: 0 });
    cells()[0].click();
    check('view buttons are ordered Tree, Json, Raw', [...document.querySelectorAll('#detail .segs button')].map((b) => b.textContent.trim()).join() === 'Tree,Json,Raw');
    check('Json button has the braces icon', !!el('detailJson').querySelector('svg'));
    const jv = () => dbody.querySelector('pre.jsonview');
    el('detailJson').click();
    check('Json view shows the value indented', jv()?.textContent === pretty, JSON.stringify(jv()?.textContent));
    check('Json view colours keys, strings, numbers, booleans and null', jv().querySelectorAll('.j-key').length === 5 && jv().querySelectorAll('.j-str').length === 1 && jv().querySelectorAll('.j-num').length === 2 && jv().querySelectorAll('.j-bool').length === 1 && jv().querySelectorAll('.j-null').length === 1);
    check('Json view escapes markup from values', !dbody.querySelector('img') && jv().textContent.includes('<img src=x onerror=alert(1)>'));
    check('only the Json button is active; no tree nodes', el('detailJson').classList.contains('on') && !el('detailTree').classList.contains('on') && !el('detailRaw').classList.contains('on') && !dbody.querySelector('details'));
    check('Json view keeps indentation (scrolls instead of wrapping)', getComputedStyle(jv()).whiteSpace === 'pre');
    let sent = null; tiny.clipboard.write = (x) => { sent = x; };
    el('detailCopy').click();
    check('Copy in the Json view copies the indented text', sent?.text === pretty, JSON.stringify(sent));
    el('detailRaw').click(); el('detailCopy').click();
    check('Copy in the Raw view copies the value exactly as returned', sent?.text === doc);
    el('detailTree').click(); el('detailCopy').click();
    check('Copy in the Tree view copies the value exactly as returned', sent?.text === doc);
    el('detailJson').click();
    cells()[2].click();
    check('the next JSON cell opens in the view you last chose', !!jv() && jv().textContent === '{\n  "x": [\n    1,\n    2\n  ]\n}' && el('detailJson').classList.contains('on'), jv()?.textContent);
    cells()[1].click();
    check('a plain text cell hides all three view buttons', el('detailTree').hidden && el('detailJson').hidden && el('detailRaw').hidden && dbody.querySelector('pre')?.textContent === 'hello');
    cells()[3].click();
    check('NULL in a JSON column shows NULL, whatever the view', dbody.textContent === 'NULL');
    // fidelity: numbers, key order and escapes are never rewritten
    check('keeps key order, huge integers and escape sequences exactly', prettyJson('{"b":1,"2":2,"1":12345678901234567890,"e":{},"a":[],"s":"\\u00e9\\n"}') === '{\n  "b": 1,\n  "2": 2,\n  "1": 12345678901234567890,\n  "e": {},\n  "a": [],\n  "s": "\\u00e9\\n"\n}');
    check('scalars and empty containers', prettyJson('42') === '42' && prettyJson('"a"') === '"a"' && prettyJson('[]') === '[]' && prettyJson('  [ 1 ,2 ]  ') === '[\n  1,\n  2\n]' && prettyJson('[[],{}]') === '[\n  [],\n  {}\n]');
    const rnd = (d = 0) => { const r = Math.random(); if (d > 3 || r < 0.3) return [1, -2.5e10, 'a"b\\cé\n', true, null, '', 0][Math.floor(Math.random() * 7)];
      if (r < 0.65) return Array.from({ length: Math.floor(Math.random() * 4) }, () => rnd(d + 1));
      return Object.fromEntries(Array.from({ length: Math.floor(Math.random() * 4) }, (_, i) => ['k', 'x y', '', 'q"', 'é'][i % 5] + Math.floor(Math.random() * 3)).map((k) => [k, rnd(d + 1)])); };
    let bad = 0;
    for (let i = 0; i < 500; i++) { const v = rnd(), p = prettyJson(JSON.stringify(v)); if (JSON.stringify(JSON.parse(p)) !== JSON.stringify(v) || prettyJson(p) !== p) bad++; }
    check('500 random documents round-trip and re-format to the same text', bad === 0, String(bad));
    // very large documents stay responsive: indented, but without a span per token
    const big = '{"k":"' + 'x'.repeat(250000) + '","n":[1,2,3]}';
    renderGrid({ columns: ['d'], types: ['jsonb'], rows: [[big]], truncated: false, ms: 0 });
    const t0 = Date.now(); cells()[0].click();
    check('a 250k-character document renders indented without per-token colouring', !!jv() && jv().querySelectorAll('span').length === 0 && jv().textContent.startsWith('{\n  "k": "xxx') && Date.now() - t0 < 3000, `${Date.now() - t0} ms`);
    jsonMode = 'tree';  // the checks below expect the default view
    // Postgres reports real types: shown under the column name, numbers right-align, JSON gets a badge
    renderGrid({ columns: ['id', 'label', 'doc', 'at'], types: ['int4', 'text', 'jsonb', 'timestamptz'], rows: [['1', 'a', '{"x":1}', '2026-01-01 00:00:00+00']], truncated: false, ms: 1 });
    check('column types shown in headers', [...g.querySelectorAll('th .ctype')].map((e) => e.textContent).join() === 'int4,text,jsonb,timestamptz');
    check('typed numeric strings right-align', cells()[0].classList.contains('num') && getComputedStyle(cells()[0]).textAlign === 'right' && !cells()[1].classList.contains('num'));
    check('json cells carry a braces badge', !!cells()[2].querySelector('.jb svg') && !cells()[1].querySelector('.jb'));
    // environment follows the connection: clearing it removes the edge colour
    const me = conns.find((c) => c.id === active); const was = me.env; me.env = ''; renderWhere();
    check('no environment, no coloured edge', bar.hidden && !where.querySelector('.env')); me.env = was; renderWhere();
    // failures replace the results with an explanation
    await run('select * from nope');
    check('error panel has an alert icon', !!g.querySelector('.error strong svg'));
    check('error panel replaces the results', !!g.querySelector('.error[role=alert]') && g.querySelector('.error strong').textContent === 'Query failed' && g.querySelector('.error pre').textContent.length > 0, g.querySelector('.error')?.textContent);
    check('status bar says Failed in red', document.getElementById('status').textContent === 'Failed' && document.getElementById('status').classList.contains('bad'));

    const t = await until(() => [...document.querySelectorAll('.tbls li')].find((li) => li.textContent === 'pets'), 'pets table listed');
    // Keyboard path: table names are focusable and Enter opens them
    check('table names are keyboard-focusable', t.tabIndex === 0);
    t.focus(); t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await until(() => !document.getElementById('pager').hidden, 'browse opened');
    check('pager lives in the status bar', document.getElementById('statusbar').contains(document.getElementById('pager')));
    check('browse shows pager + rows', g.querySelectorAll('tbody tr').length === 2 && document.getElementById('prev').disabled && document.getElementById('next').disabled);

    // ---- collapsible connections ----
    const conn1 = () => document.querySelector('.conn'), head1 = () => conn1().querySelector('.head');
    const arrow = (el, k) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    const tcount = () => conn1().querySelectorAll('.tbls li').length;
    check('connected connection is expanded and says so to assistive tech', head1().getAttribute('aria-expanded') === 'true' && conn1().classList.contains('open') && tcount() >= 2, String(tcount()));
    check('table count badge matches the list', conn1().querySelector('.count').textContent === String(tcount()), conn1().querySelector('.count').textContent);
    check('chevron points down while open', getComputedStyle(conn1().querySelector('.chev svg')).transform !== 'none');
    check('the open table is highlighted', !!conn1().querySelector('.tbls li.sel'));
    head1().click();
    check('click collapses: tables hidden, aria-expanded false', !conn1().querySelector('.tbls') && head1().getAttribute('aria-expanded') === 'false' && !conn1().classList.contains('open'));
    check('collapsed: still connected, badge kept, results and Run untouched', conn1().classList.contains('on') && !!conn1().querySelector('.count') && !document.getElementById('run').disabled && g.querySelectorAll('tbody tr').length === 2);
    check('chevron points right while closed', getComputedStyle(conn1().querySelector('.chev svg')).transform === 'none');
    head1().click();
    check('click again expands; the open table is still highlighted', !!conn1().querySelector('.tbls') && !!conn1().querySelector('.tbls li.sel'));
    head1().click(); await run('select 1 as n');
    check('collapsed state survives running a query', !conn1().querySelector('.tbls') && head1().getAttribute('aria-expanded') === 'false');
    head1().focus(); arrow(head1(), 'ArrowRight');
    check('→ expands and keeps keyboard focus on the connection', !!conn1().querySelector('.tbls') && document.activeElement === head1(), String(document.activeElement && document.activeElement.className));
    arrow(head1(), 'ArrowLeft');
    check('← collapses and keeps focus', !conn1().querySelector('.tbls') && document.activeElement === head1());
    arrow(head1(), 'ArrowLeft');
    check('← on a collapsed connection does nothing', !conn1().querySelector('.tbls') && document.activeElement === head1());
    arrow(head1(), 'ArrowRight');
    const li0 = conn1().querySelector('.tbls li'); li0.focus();
    li0.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); await sleep(400);
    check('opening a table keeps focus on it after the list re-renders', document.activeElement?.dataset?.ref === li0.dataset.ref && document.activeElement.matches('.tbls li'), String(document.activeElement && document.activeElement.outerHTML.slice(0, 60)));
    await tiny.api.call('saveConnection', { conn: { name: 'second', type: 'sqlite', path: ':memory:' }, password: null }); await load();
    const second = () => [...document.querySelectorAll('.conn')].find((c) => c.querySelector('.name').textContent === 'second');
    check('offline connection: no expanded state and the chevron is hidden', !second().querySelector('.head').hasAttribute('aria-expanded') && getComputedStyle(second().querySelector('.chev')).visibility === 'hidden');
    second().querySelector('.head').click(); await until(() => second().classList.contains('on'), 'second connected');
    check('clicking an offline connection connects it and opens its (empty) table list', second().classList.contains('open') && second().querySelector('.count').textContent === '0' && !!second().querySelector('.tbls'));
    check('it becomes the active connection; the first is untouched', document.getElementById('where').textContent.includes('second') && conn1().classList.contains('open'));
    // ---- connecting indicator ----
    // The test sqlite connect is instant, so delay connect/testConnection to catch the in-flight state.
    const realCall = tiny.api.call.bind(tiny.api); let connectCalls = 0, testDelay = 0;
    tiny.api.call = async (m, p) => { if (m === 'connect') { connectCalls++; await sleep(700); } if (m === 'testConnection') await sleep(testDelay); return realCall(m, p); };
    const named = (n) => [...document.querySelectorAll('.conn')].find((c) => c.querySelector('.name').textContent === n);
    await realCall('saveConnection', { conn: { name: 'third', type: 'sqlite', path: ':memory:' }, password: null });
    await realCall('saveConnection', { conn: { name: 'broken', type: 'sqlite', path: '/nonexistent-dir/none.sqlite' }, password: null });
    await load();
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    named('third').querySelector('.head').click();
    named('third').querySelector('.head').click();  // arrives mid-connect and must be ignored
    await sleep(250);
    const spin = () => named('third').querySelector('.state svg');
    check('connecting: row is marked busy for assistive tech', named('third').classList.contains('connecting') && named('third').querySelector('.head').getAttribute('aria-busy') === 'true');
    check('connecting: a spinner replaces the plug and turns', !!spin() && named('third').querySelector('.state').innerHTML !== offlineIcon && (reduce || getComputedStyle(spin()).animationName === 'spin'), spin() && getComputedStyle(spin()).animationName);
    check('connecting: "Connecting…" in the row and "Connecting to third…" in the status bar', named('third').querySelector('.progress')?.textContent === 'Connecting…' && document.getElementById('status').textContent === 'Connecting to third…', document.getElementById('status').textContent);
    check('connecting: edit and delete are out of reach', getComputedStyle(named('third').querySelector('.tools')).display === 'none');
    named('third').querySelector('.head').click();
    named('third').querySelector('[data-act=del]').click();
    await until(() => named('third').classList.contains('on'), 'third connected');
    check('repeated clicks and a delete during the connect were ignored', connectCalls === 1 && !!named('third'), String(connectCalls));
    check('connected: spinner and label are gone, plug icon is back, tables open', !named('third').classList.contains('connecting') && !named('third').querySelector('.progress') && !named('third').querySelector('.head').hasAttribute('aria-busy') && named('third').querySelector('.state').innerHTML === conn1().querySelector('.state').innerHTML && named('third').classList.contains('open'));
    named('broken').querySelector('.head').click();
    await until(() => !named('broken').classList.contains('connecting') && g.querySelector('.error'), 'broken connect finished');
    check('failed connect: indicator clears, row stays offline, error panel explains', !named('broken').classList.contains('on') && !named('broken').querySelector('.progress') && g.querySelector('.error strong').textContent === 'Couldn’t connect' && g.querySelector('.error pre').textContent.length > 0, g.querySelector('.error')?.textContent);
    named('broken').querySelector('.head').click(); await sleep(150);
    check('after a failure the connection can be retried', named('broken').classList.contains('connecting') && connectCalls === 3, `${connectCalls} calls`);
    await until(() => !named('broken').classList.contains('connecting'), 'retry finished');
    // the form's Test connection button
    testDelay = 700;
    document.getElementById('addConn').click();
    const tf = document.getElementById('form'), note = document.getElementById('formErr'), testBtn = document.getElementById('test');
    tf.elements.type.value = 'sqlite'; tf.elements.type.dispatchEvent(new Event('change')); tf.elements.name.value = 'tmp'; tf.elements.path.value = ':memory:';
    const noteRgb = () => getComputedStyle(note).color.match(/\d+/g).slice(0, 3).map(Number);
    testBtn.click(); await sleep(250);
    check('testing: button is disabled and a dim spinner note shows', testBtn.disabled && note.classList.contains('busy') && !!note.querySelector('svg') && note.textContent.includes('Testing connection…') && JSON.stringify(noteRgb()) !== JSON.stringify(rgb('--bad')));
    check('testing: the spinner turns', reduce || getComputedStyle(note.querySelector('svg')).animationName === 'spin');
    await until(() => !testBtn.disabled, 'test finished');
    check('test success: a check note in the normal text colour, not the error red', note.classList.contains('ok') && note.textContent.trim() === 'Connected successfully.' && !!note.querySelector('svg') && JSON.stringify(noteRgb()) !== JSON.stringify(rgb('--bad')), JSON.stringify(noteRgb()));
    tf.elements.path.value = '/nonexistent-dir/none.sqlite'; testBtn.click();
    await until(() => !testBtn.disabled, 'failing test finished');
    check('test failure: an alert note in the error red', note.classList.contains('error') && !!note.querySelector('svg') && note.textContent.trim().length > 0 && JSON.stringify(noteRgb()) === JSON.stringify(rgb('--bad')), note.textContent);
    document.getElementById('cancel').click();
    tiny.api.call = realCall;

    // ---- deleting a connection: red trash icon, and always ask first ----
    const trash = () => named('broken').querySelector('[data-act=del]'), pencil = () => named('broken').querySelector('[data-act=edit]');
    const colorOf = (el) => getComputedStyle(el).color.match(/\d+/g).slice(0, 3).map(Number);
    check('trash icon is red, edit icon is not', JSON.stringify(colorOf(trash())) === JSON.stringify(rgb('--bad')) && JSON.stringify(colorOf(pencil())) !== JSON.stringify(rgb('--bad')), `${colorOf(trash())} vs ${rgb('--bad')}`);
    const realConfirm = tiny.dialog.confirm; let asked = null, answer = false;
    tiny.dialog.confirm = async (message, opts) => { asked = { message, opts }; return answer; };
    const stored = async (n) => (await realCall('listConnections')).some((c) => c.name === n);
    trash().click(); await sleep(250);
    check('delete asks first, naming the connection', asked && asked.message === 'Delete “broken”?', JSON.stringify(asked));
    check('the dialog explains what is removed and offers Delete / Cancel', asked.opts && /keychain/.test(asked.opts.detail) && /database itself is not touched/.test(asked.opts.detail) && asked.opts.ok === 'Delete' && asked.opts.cancel === 'Cancel' && !/disconnected/.test(asked.opts.detail), JSON.stringify(asked.opts));
    check('Cancel keeps the connection, in the list and in storage', !!named('broken') && await stored('broken'));
    asked = null; named('third').querySelector('[data-act=del]').click(); await sleep(250);
    check('deleting a connected connection warns that it will be disconnected', /disconnected/.test(asked?.opts?.detail || ''), JSON.stringify(asked));
    check('Cancel again: the connected one is untouched', !!named('third') && named('third').classList.contains('on') && await stored('third'));
    answer = true; asked = null;
    check('(sanity) the broken connection is the active one before deleting', document.getElementById('where').textContent.includes('broken'));
    trash().click(); await sleep(400);
    check('Delete removes it from the list and from storage', !named('broken') && !(await stored('broken')));
    check('deleting the active connection resets the editor and status bar', document.getElementById('run').disabled && document.getElementById('where').textContent.trim() === 'No connection' && document.getElementById('envBar').hidden, document.getElementById('where').textContent);
    check('the other connections are untouched', !!named('third') && !!named('second') && !!conn1());
    tiny.dialog.confirm = realConfirm;

    // ---- stopping a running query ----
    // The backend is stubbed so a query can be held open; real cancellation is covered by test/drivers.js, main.js, tunnel.js.
    const stubCalls = []; let finish, lastCancel;
    tiny.api.call = async (m, p) => {
      stubCalls.push(m);
      if (m === 'query') return new Promise((resolve, reject) => { finish = { resolve, reject }; });
      if (m === 'cancelQuery') { lastCancel = p; await sleep(300); finish.resolve({ cancelled: true, ms: 1234 }); return { cancelled: true }; }
      if (m === 'tables') return [];
      return realCall(m, p);
    };
    const count = (m) => stubCalls.filter((x) => x === m).length;
    conns.push({ id: 'pg-fake', name: 'pgfake', type: 'postgres' }); tables['pg-fake'] = []; active = 'pg-fake'; renderConns();
    const runBtn = document.getElementById('run'), hintEl = document.getElementById('hint'), statusEl = document.getElementById('status');
    const label = () => runBtn.textContent.trim();
    check('idle: Run is enabled, primary, with the normal hint', !runBtn.disabled && label() === 'Run' && runBtn.classList.contains('primary') && hintEl.textContent.startsWith('⌘/Ctrl+Enter'));
    editor.setValue('select pg_sleep(30)'); runBtn.click(); await sleep(150);
    check('running a Postgres query: the button becomes Stop (red, with an icon)', label() === 'Stop' && runBtn.classList.contains('stop') && !runBtn.disabled && !!runBtn.querySelector('svg') && JSON.stringify(colorOf(runBtn)) === JSON.stringify(rgb('--bad')));
    check('running: the hint explains the shortcut', hintEl.textContent === '⌘/Ctrl+. stops the query');
    await sleep(1200);
    check('running: the status bar counts elapsed seconds', /^Running… [1-9]\d*s$/.test(statusEl.textContent), statusEl.textContent);
    runSql(); await sleep(100);
    check('a second run is ignored while one is in flight', count('query') === 1);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '.', metaKey: true, bubbles: true, cancelable: true })); await sleep(100);
    check('⌘. starts stopping: Stopping… on a disabled button and in the status bar', label() === 'Stopping…' && runBtn.disabled && statusEl.textContent === 'Stopping…');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '.', ctrlKey: true, bubbles: true, cancelable: true })); await sleep(500);
    check('exactly one cancel was sent, for the running connection', count('cancelQuery') === 1 && lastCancel.id === 'pg-fake', JSON.stringify(lastCancel));
    check('stopped: a neutral notice (not an error) says how long it ran', !!g.querySelector('.notice') && g.querySelector('.notice strong').textContent === 'Query stopped' && g.querySelector('.notice p').textContent.includes('1.2 s') && !g.querySelector('.error'), g.querySelector('.notice')?.textContent);
    check('stopped: status says Stopped (not red) and Run is back', statusEl.textContent === 'Stopped' && !statusEl.classList.contains('bad') && label() === 'Run' && runBtn.classList.contains('primary') && !runBtn.disabled && hintEl.textContent.startsWith('⌘/Ctrl+Enter'));
    // the Stop button itself, clicked twice
    editor.setValue('select pg_sleep(30)'); runBtn.click(); await sleep(150);
    runBtn.click(); await sleep(100); runBtn.click();
    check('while stopping the button is disabled, so a second click does nothing', runBtn.disabled && label() === 'Stopping…');
    await sleep(500);
    check('clicking Stop cancels once and shows the notice', count('cancelQuery') === 2 && !!g.querySelector('.notice') && label() === 'Run');
    // switching connection mid-query must not retarget the Stop
    editor.setValue('select pg_sleep(30)'); runBtn.click(); await sleep(150);
    active = named('third').dataset.id; renderConns();
    check('switching connection mid-query keeps Stop for the one that is running', label() === 'Stop' && !runBtn.disabled);
    runBtn.click(); await sleep(500);
    check('Stop still cancels the connection that is running, not the active one', lastCancel.id === 'pg-fake' && count('cancelQuery') === 3, JSON.stringify(lastCancel));
    // SQLite: nothing to stop (a synchronous driver cannot be interrupted)
    active = named('third').dataset.id; renderConns();
    editor.setValue('select 1'); runBtn.click(); await sleep(150);
    check('SQLite: no Stop is offered; the button is a disabled Running…', label() === 'Running…' && runBtn.disabled && !runBtn.classList.contains('stop') && !!runBtn.querySelector('svg') && hintEl.textContent.startsWith('⌘/Ctrl+Enter'));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '.', metaKey: true, bubbles: true, cancelable: true })); await sleep(150);
    check('SQLite: ⌘. sends no cancel', count('cancelQuery') === 3);
    finish.resolve({ columns: ['x'], types: [null], rows: [[1]], truncated: false, ms: 1 }); await sleep(250);
    check('SQLite: the result shows and Run comes back', g.querySelectorAll('tbody tr').length === 1 && label() === 'Run' && !runBtn.disabled);
    // a failing query must not leave the button stuck on Stop
    active = 'pg-fake'; renderConns();
    editor.setValue('select nope'); runBtn.click(); await sleep(100);
    finish.reject(new Error('boom: syntax error')); await sleep(250);
    check('a failing query shows the error and Run is back (not stuck on Stop)', g.querySelector('.error pre')?.textContent.includes('boom') && label() === 'Run' && !runBtn.disabled && statusEl.classList.contains('bad'));
    tiny.api.call = realCall;
    conns.splice(conns.findIndex((c) => c.id === 'pg-fake'), 1); delete tables['pg-fake']; active = null; renderConns();
    check('idle with nothing selected: Run is disabled', runBtn.disabled && label() === 'Run');

    // ================= tabs and saved queries =================
    clearTimeout(persistTimer);  // a pending debounced write would put the old tabs straight back
    await tiny.store.delete('tabs'); await tiny.store.delete('queries'); await loadTabs();   // a known starting point
    const realPrompt = tiny.dialog.prompt, realConfirm2 = tiny.dialog.confirm;
    const dialogLog = []; let promptAnswer = null, confirmAnswer = true;
    tiny.dialog.prompt = async (m, o) => { dialogLog.push(['prompt', m, o]); return promptAnswer; };
    tiny.dialog.confirm = async (m, o) => { dialogLog.push(['confirm', m, o]); return confirmAnswer; };
    const dialogs = (kind) => dialogLog.filter((d) => d[0] === kind), lastDialog = () => dialogLog[dialogLog.length - 1];
    const press = (key, mods = {}) => document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...mods }));
    const tabEls = () => [...document.querySelectorAll('#tablist .tab')];
    const tabNames = () => tabEls().map((t) => t.querySelector('.t').textContent);
    const selIdx = () => tabEls().findIndex((t) => t.getAttribute('aria-selected') === 'true');
    const dirtyAt = (i) => !!tabEls()[i].querySelector('.dirty');
    const conn1Id = conn1().dataset.id;
    const gridRows = () => g.querySelectorAll('tbody tr').length;

    // ---- tabs ----
    check('starts with one tab, selected, in a tablist', tabNames().join() === 'Query 1' && selIdx() === 0 && document.getElementById('tablist').getAttribute('role') === 'tablist' && tabEls()[0].getAttribute('role') === 'tab' && editor.getValue() === '' && !dirtyAt(0));
    editor.setValue('select 1 as one');
    check('typing in a tab marks it unsaved', dirtyAt(0) && !!tabEls()[0].querySelector('.dirty[aria-label="Unsaved changes"]'));
    document.getElementById('newTab').click();
    check('+ opens a second tab and selects it, with an empty editor', tabNames().join() === 'Query 1,Query 2' && selIdx() === 1 && editor.getValue() === '' && !dirtyAt(1) && dirtyAt(0));
    named('ui-test').querySelector('.head').click(); await sleep(200);
    check('picking a connection binds the tab you are on', tabs[1].connId === conn1Id && tabs[0].connId === null && document.getElementById('where').textContent.includes('ui-test'));
    check('the tab shows its connection\'s environment', tabEls()[1].dataset.env === 'production' && getComputedStyle(tabEls()[1]).borderTopColor === 'rgb(255, 92, 108)' && tabEls()[1].title.includes('ui-test'), getComputedStyle(tabEls()[1]).borderTopColor);
    editor.setValue('select * from pets order by id'); document.getElementById('run').click(); await sleep(500);
    check('results appear in the tab that ran', gridRows() === 2);
    tabEls()[0].click(); await sleep(150);
    check('switching tabs restores that tab\'s SQL', selIdx() === 0 && editor.getValue() === 'select 1 as one');
    check('...its own (empty) results, and its own connection', gridRows() === 0 && !!g.querySelector('.empty') && document.getElementById('where').textContent.includes('No connection') && document.getElementById('run').disabled && active === null);
    tabEls()[1].click(); await sleep(150);
    check('switching back restores the SQL, the results and the connection', editor.getValue() === 'select * from pets order by id' && gridRows() === 2 && active === conn1Id && !document.getElementById('run').disabled);
    // undo history belongs to the tab: undoing in tab 1 must never bring back tab 2's text
    editor.setValue('select 2 as two');
    tabEls()[0].click(); await sleep(150);
    editor.undo();
    check('undo is per tab (tab 1 undoes only its own edit)', editor.getValue() === '' && !/pets|two/.test(editor.getValue()), JSON.stringify(editor.getValue()));
    editor.setValue('select 1 as one');
    press('Tab', { ctrlKey: true }); await sleep(100);
    check('Ctrl+Tab moves to the next tab', selIdx() === 1);
    press('Tab', { ctrlKey: true, shiftKey: true }); await sleep(100);
    check('Ctrl+Shift+Tab moves back', selIdx() === 0);
    press('t', { metaKey: true }); await sleep(100);
    check('⌘T opens a new tab', tabNames().join() === 'Query 1,Query 2,Query 3' && selIdx() === 2);
    tabEls()[0].focus(); tabEls()[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })); await sleep(100);
    check('→ moves to the next tab and keeps keyboard focus on it', selIdx() === 1 && document.activeElement === tabEls()[1], String(document.activeElement && document.activeElement.className));
    check('only the selected tab is in the tab order', tabEls().filter((t) => t.tabIndex === 0).length === 1 && tabEls()[1].tabIndex === 0);

    // ---- closing ----
    const asked0 = dialogs('confirm').length;
    tabEls()[2].querySelector('.x').click(); await sleep(150);
    check('closing an empty tab needs no confirmation', tabNames().join() === 'Query 1,Query 2' && dialogs('confirm').length === asked0);
    confirmAnswer = false;
    tabEls()[0].querySelector('.x').click(); await sleep(150);
    check('closing a tab with unsaved SQL asks first, naming it', tabNames().length === 2 && lastDialog()[0] === 'confirm' && lastDialog()[1] === 'Close “Query 1”?' && lastDialog()[2].ok === 'Close' && /not been saved/.test(lastDialog()[2].detail), JSON.stringify(lastDialog()));
    confirmAnswer = true;
    tabEls()[0].querySelector('.x').click(); await sleep(150);
    check('confirming closes it and selects the neighbour', tabNames().join() === 'Query 2' && selIdx() === 0 && editor.getValue() === 'select 2 as two' && gridRows() === 2, `${tabNames().join()} / ${editor.getValue()} / ${gridRows()}`);
    // ---- the last tab cannot be closed ----
    check('with one tab left it has no close button', tabNames().join() === 'Query 2' && !tabEls()[0].querySelector('.x') && tabEls()[0].classList.contains('solo'), tabNames().join());
    const askedLast = dialogs('confirm').length;
    tabEls()[0].dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true })); await sleep(150);
    check('middle-click on the only tab does nothing, and does not even ask', tabNames().join() === 'Query 2' && dialogs('confirm').length === askedLast);
    closeTab(currentId); await sleep(150);
    check('closeTab is a no-op for the only tab, even when called directly (and the tab keeps its text)', tabs.length === 1 && editor.getValue() === 'select 2 as two' && dialogs('confirm').length === askedLast);
    document.getElementById('newTab').click(); await sleep(100);
    check('a second tab brings the close buttons back, on both tabs', tabEls().length === 2 && tabEls().every((t) => !!t.querySelector('.x') && !t.classList.contains('solo')));

    // ---- numbering: the lowest free "Query N" ----
    check('a new tab takes the lowest free number (Query 2 is taken, so Query 1)', tabNames().join() === 'Query 2,Query 1', tabNames().join());
    document.getElementById('newTab').click(); await sleep(100);
    check('...and the next one the next free number', tabNames().join() === 'Query 2,Query 1,Query 3', tabNames().join());
    confirmAnswer = true;
    tabEls()[0].querySelector('.x').click(); await sleep(200);   // closes Query 2 (it has SQL, so it asks, and the answer is yes)
    document.getElementById('newTab').click(); await sleep(100);
    check('closing a tab frees its number: the next new tab reuses it', tabNames().join() === 'Query 1,Query 3,Query 2', tabNames().join());
    for (const title of ['Query 1', 'Query 2']) { tabEls().find((t) => t.querySelector('.t').textContent === title).querySelector('.x').click(); await sleep(150); }
    check('(sanity) only "Query 3" is left', tabNames().join() === 'Query 3' && !tabEls()[0].querySelector('.x'), tabNames().join());
    document.getElementById('newTab').click(); await sleep(100);
    check('with only "Query 3" open, the next tab is "Query 1" (the counter does not keep climbing)', tabNames().join() === 'Query 3,Query 1', tabNames().join());
    tabs[1].title = 'Revenue report';  // as if saved under a name: it no longer holds a number
    document.getElementById('newTab').click(); await sleep(100);
    check('a tab with a custom name does not hold a number', tabNames().join() === 'Query 3,Revenue report,Query 1', tabNames().join());
    tabs.find((t) => t.title === 'Query 3').title = 'Query 1';  // a saved query called "Query 1" does hold it, being open
    document.getElementById('newTab').click(); await sleep(100);
    check('a tab titled "Query 1" (for example a saved query with that name) holds the number while it is open', tabNames().filter((n) => n === 'Query 1').length === 2 && tabNames().includes('Query 2'), tabNames().join());
    while (tabs.length > 1) { await closeTab(tabs[tabs.length - 1].id); await sleep(60); }
    check('closing down to one tab ends with one tab, and no close button', tabs.length === 1 && !tabEls()[0].querySelector('.x'));
    switchTab(tabs[0].id); editor.setValue('select 2 as two'); tabs[0].title = 'Query 2';
    await persistTabsNow();
    check('the counter is no longer stored', !('seq' in (await tiny.store.get('tabs'))));
    await tiny.store.set('tabs', { ...(await tiny.store.get('tabs')), seq: 99 });   // data saved by an earlier version
    await loadTabs();
    document.getElementById('newTab').click(); await sleep(100);
    check('old stored data that still has a counter is read fine and the counter is ignored', tabNames().join() === 'Query 2,Query 1', tabNames().join());
    await closeTab(tabs[1].id); await sleep(100); renderTabs();

    // ---- persistence ----
    editor.setValue('select 42');
    document.getElementById('newTab').click(); editor.setValue('select * from pets'); setActive(conn1Id);
    await persistTabsNow();
    const savedTabs = await tiny.store.get('tabs');
    check('tabs are stored as SQL, title, connection, saved link and file origin only', savedTabs.list.length === 2 && savedTabs.list.every((t) => JSON.stringify(Object.keys(t).sort()) === JSON.stringify(['connId', 'id', 'origin', 'savedId', 'sql', 'title'])) && savedTabs.current === currentId, JSON.stringify(savedTabs).slice(0, 200));
    const titlesBefore = tabNames().join(), curTabId = currentId;
    await loadTabs();
    check('a restart restores the tabs, the SQL, the connection and the selected tab', tabNames().join() === titlesBefore && currentId === curTabId && editor.getValue() === 'select * from pets' && active === conn1Id && tabs[0].sql === 'select 42', `${tabNames().join()} / ${editor.getValue()}`);
    check('results are not restored (a restart starts with the empty state)', gridRows() === 0 && !!g.querySelector('.empty'));
    // a restored tab is offline: Run connects first
    const thirdId = named('third').dataset.id;
    setActive(thirdId); delete tables[thirdId]; expanded.delete(thirdId); renderConns();
    check('(sanity) the tab\'s connection is offline and Run is still available', !named('third').classList.contains('on') && !document.getElementById('run').disabled);
    editor.setValue('select 1 as n'); document.getElementById('run').click();
    await until(() => gridRows() === 1, 'auto-connect then run');
    check('Run on an offline connection connects first, then runs', gridRows() === 1 && !!tables[thirdId] && named('third').classList.contains('on'));
    // a query that finishes in a background tab lands in that tab
    const stub = { resolve: null };
    const realCall3 = tiny.api.call.bind(tiny.api);
    tiny.api.call = async (m, p) => (m === 'query' ? new Promise((res) => { stub.resolve = res; }) : realCall3(m, p));
    setActive(conn1Id); editor.setValue('select slow'); document.getElementById('run').click(); await sleep(150);
    const runningTab = currentId;
    const spinnerOn = (t) => !!t.querySelector(':scope > svg.i');  // a direct child: the close button's x icon is an svg too
    check('the running tab shows a spinner, and no other tab does', spinnerOn(tabEls().find((t) => t.dataset.id === runningTab)) && tabEls().filter(spinnerOn).length === 1);
    document.getElementById('newTab').click(); await sleep(100);
    check('another tab cannot start a query meanwhile: Run is disabled and says why', document.getElementById('run').disabled && document.getElementById('run').title === 'A query is running in another tab');
    stub.resolve({ columns: ['slow'], types: [null], rows: [['done']], truncated: false, ms: 5 }); await sleep(250);
    check('the result did not appear on the tab you are looking at', !g.querySelector('table') && selIdx() !== tabNames().indexOf(tabs.find((t) => t.id === runningTab).title));
    check('...it was stored on the tab that ran it, and the spinner is gone', tabs.find((t) => t.id === runningTab).snap?.kind === 'grid' && !tabEls().some(spinnerOn) && !document.getElementById('run').disabled);
    switchTab(runningTab); await sleep(100);
    check('switching to it shows the result', gridRows() === 1 && g.textContent.includes('done'));
    tiny.api.call = realCall3;

    // ---- saved queries ----
    const savedItems = () => [...document.querySelectorAll('#saved .sq')];
    const savedNames = () => savedItems().map((li) => li.querySelector('.name').textContent);
    check('with nothing saved, the group says how to save one', document.getElementById('savedCount').textContent === '0' && document.querySelector('#saved .sq-empty')?.textContent.includes('⌘S'));
    const newTabAndSwitch = () => { document.getElementById('newTab').click(); return sleep(100); };
    await newTabAndSwitch();
    const promptsBefore = dialogs('prompt').length;
    press('s', { metaKey: true }); await sleep(150);
    check('⌘S on an empty query saves nothing and does not ask for a name', dialogs('prompt').length === promptsBefore && document.getElementById('status').textContent.startsWith('Nothing to save') && queries.length === 0);
    editor.setValue('-- who is who\nselect * from pets\nwhere id = 1;');
    promptAnswer = 'Pets by id';
    press('s', { metaKey: true }); await sleep(250);
    check('⌘S on a new query asks for a name, suggesting the first line of SQL that is not a comment', lastDialog()[0] === 'prompt' && lastDialog()[1] === 'Name this query' && lastDialog()[2].default === 'select * from pets' && lastDialog()[2].ok === 'Save', JSON.stringify(lastDialog()));
    const sq1 = () => queries.find((q) => q.name === 'Pets by id');
    check('it is saved with its SQL and connection', queries.length === 1 && sq1().sql === editor.getValue() && sq1().connId === active && Number.isFinite(sq1().updatedAt), JSON.stringify(queries));
    check('the tab takes the name and is no longer unsaved', tabEls()[selIdx()].querySelector('.t').textContent === 'Pets by id' && !dirtyAt(selIdx()) && currentTab().savedId === sq1().id);
    check('the status line confirms, and it is persisted to the store', document.getElementById('status').textContent === 'Saved “Pets by id”' && (await tiny.store.get('queries')).length === 1);
    check('it appears in the sidebar, highlighted, with a count and its SQL as the tooltip', savedNames().join() === 'Pets by id' && savedItems()[0].classList.contains('sel') && document.getElementById('savedCount').textContent === '1' && savedItems()[0].title.includes('where id = 1'));
    editor.setValue('select * from pets where id = 2');
    check('editing a saved query marks the tab unsaved again', dirtyAt(selIdx()));
    const promptsMid = dialogs('prompt').length;
    press('s', { metaKey: true }); await sleep(250);
    check('⌘S on a saved query updates it without asking', dialogs('prompt').length === promptsMid && sq1().sql === 'select * from pets where id = 2' && !dirtyAt(selIdx()) && queries.length === 1);
    promptAnswer = 'Pets copy';
    press('s', { metaKey: true, shiftKey: true }); await sleep(250);
    check('⌘⇧S saves a copy under a new name (default: "… copy")', lastDialog()[2].default === 'Pets by id copy' && queries.length === 2 && savedNames().join() === 'Pets by id,Pets copy' && currentTab().title === 'Pets copy' && queries.find((q) => q.name === 'Pets by id').sql === 'select * from pets where id = 2');
    // clashes
    await newTabAndSwitch(); editor.setValue('select 2'); promptAnswer = 'pets COPY'; confirmAnswer = false;
    press('s', { metaKey: true }); await sleep(250);
    check('a name that already exists (any case) asks before replacing', lastDialog()[0] === 'confirm' && lastDialog()[1] === 'Replace “Pets copy”?' && lastDialog()[2].ok === 'Replace');
    check('Cancel leaves the saved query and the tab alone', queries.find((q) => q.name === 'Pets copy').sql === 'select * from pets where id = 2' && currentTab().savedId === null && dirtyAt(selIdx()));
    confirmAnswer = true;
    press('s', { metaKey: true }); await sleep(250);
    check('Replace overwrites it and links the tab', queries.length === 2 && queries.find((q) => q.name === 'Pets copy').sql === 'select 2' && currentTab().savedId === queries.find((q) => q.name === 'Pets copy').id && currentTab().title === 'Pets copy');
    await newTabAndSwitch(); editor.setValue('select 3');
    promptAnswer = null; press('s', { metaKey: true }); await sleep(200);
    promptAnswer = '   '; press('s', { metaKey: true }); await sleep(200);
    check('cancelling the name prompt, or an empty name, saves nothing', queries.length === 2 && currentTab().savedId === null);
    // opening
    const tabCount = tabs.length;
    savedItems().find((li) => li.querySelector('.name').textContent === 'Pets by id').click(); await sleep(150);
    check('opening a saved query that is not open creates a tab with its SQL and name', tabs.length === tabCount + 1 && currentTab().title === 'Pets by id' && editor.getValue() === 'select * from pets where id = 2' && currentTab().savedId === sq1().id && !dirtyAt(selIdx()));
    check('...bound to the connection it was saved on', currentTab().connId === sq1().connId && active === sq1().connId);
    tabEls()[0].click(); await sleep(100);
    savedItems().find((li) => li.querySelector('.name').textContent === 'Pets by id').click(); await sleep(150);
    check('opening one that is already open focuses its tab instead', tabs.length === tabCount + 1 && currentTab().title === 'Pets by id');
    // an untouched blank tab is reused
    await newTabAndSwitch(); const withBlank = tabs.length;
    savedItems().find((li) => li.querySelector('.name').textContent === 'Pets copy').click(); await sleep(150);
    check('Pets copy was already open, so it is focused (no blank reuse needed)', tabs.length === withBlank && currentTab().title === 'Pets copy');
    queries.push({ id: 'q-extra', name: 'Alpha', sql: 'select 99', connId: 'gone-connection', updatedAt: 1 }); renderSaved();
    check('the list is sorted by name, ignoring case', savedNames().join() === 'Alpha,Pets by id,Pets copy' && document.getElementById('savedCount').textContent === '3');
    document.getElementById('newTab').click(); await sleep(100);
    const nBlank = tabs.length;
    savedItems()[0].click(); await sleep(150);
    check('a blank tab is reused for the opened query instead of adding another', tabs.length === nBlank && currentTab().title === 'Alpha' && editor.getValue() === 'select 99');
    check('a saved connection that no longer exists falls back to the tab\'s own', currentTab().connId !== 'gone-connection');
    savedItems()[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); await sleep(100);
    check('Enter opens a focused saved query', currentTab().title === 'Alpha');
    // rename / delete
    promptAnswer = 'Beta'; savedItems()[0].querySelector('[data-act=rename]').click(); await sleep(250);
    check('rename updates the list, the store and the open tab\'s title', savedNames().join() === 'Beta,Pets by id,Pets copy' && tabs.some((t) => t.title === 'Beta') && lastDialog()[1] === 'Rename query' && lastDialog()[2].default === 'Alpha' && (await tiny.store.get('queries')).some((q) => q.name === 'Beta'));
    promptAnswer = 'pets by ID'; savedItems()[0].querySelector('[data-act=rename]').click(); await sleep(250);
    check('renaming onto an existing name is refused', savedNames().join() === 'Beta,Pets by id,Pets copy' && /already exists/.test(document.getElementById('status').textContent) && document.getElementById('status').classList.contains('bad'));
    confirmAnswer = false; savedItems()[0].querySelector('[data-act=del]').click(); await sleep(200);
    check('delete asks first, naming the query, and Cancel keeps it', lastDialog()[1] === 'Delete “Beta”?' && lastDialog()[2].ok === 'Delete' && /keep their text/.test(lastDialog()[2].detail) && savedNames().length === 3);
    check('the delete icon is red', JSON.stringify(getComputedStyle(savedItems()[0].querySelector('[data-act=del]')).color.match(/\d+/g).slice(0, 3).map(Number)) === JSON.stringify(rgb('--bad')));
    confirmAnswer = true; savedItems()[0].querySelector('[data-act=del]').click(); await sleep(250);
    check('confirming deletes it from the list and the store', savedNames().join() === 'Pets by id,Pets copy' && !(await tiny.store.get('queries')).some((q) => q.name === 'Beta'));
    check('a tab that had it open keeps its text, as unsaved scratch', tabs.some((t) => t.title === 'Beta' && t.savedId === null && t.sql === 'select 99') && dirtyAt(tabs.findIndex((t) => t.title === 'Beta')));
    // group
    const groupHead = document.getElementById('savedHead');
    groupHead.click();
    check('the group collapses (list hidden, aria-expanded false)', groupHead.getAttribute('aria-expanded') === 'false' && getComputedStyle(document.getElementById('saved')).display === 'none');
    groupHead.click();
    check('and expands again', groupHead.getAttribute('aria-expanded') === 'true' && getComputedStyle(document.getElementById('saved')).display !== 'none');
    const libBefore = JSON.stringify(queries); await loadQueries();
    check('the library reloads from the store unchanged', JSON.stringify(queries) === libBefore && queries.length === 2, `${queries.length}`);
    tiny.dialog.prompt = realPrompt; tiny.dialog.confirm = realConfirm2;
    await tiny.store.delete('queries'); queries = []; renderSaved();

    // ================= library search =================
    const box = () => document.getElementById('savedSearchBox'), filterInput = () => document.getElementById('savedSearch');
    const shownNames = () => [...document.querySelectorAll('#saved .sq .name')].map((n) => n.textContent);
    const typeFilter = (v) => { filterInput().value = v; filterInput().dispatchEvent(new Event('input', { bubbles: true })); };
    const fkey = (k, extra = {}) => filterInput().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }));
    clearTimeout(persistTimer); await tiny.store.delete('tabs'); await loadTabs();
    queries = [];
    renderSaved();
    check('the search box is hidden while the library is empty', box().hidden);
    queries = [
      { id: 's1', name: 'Orders by customer', sql: 'select * from orders where customer_id = 1', connId: null, updatedAt: 1 },
      { id: 's2', name: 'Pets by id', sql: 'select * from pets where id = 1', connId: null, updatedAt: 2 },
      { id: 's3', name: 'Pets copy', sql: 'select 2', connId: null, updatedAt: 3 },
      { id: 's4', name: 'Refund audit', sql: 'select 1 from refunds where pets > 0', connId: null, updatedAt: 4 },
    ];
    renderSaved();
    check('with saved queries the box appears, labelled, and the count is the total', !box().hidden && filterInput().getAttribute('aria-label') === 'Filter saved queries' && document.getElementById('savedCount').textContent === '4' && document.getElementById('savedSearchClear').hidden);
    typeFilter('pets');
    check('a word matches names and SQL text, case-insensitively', shownNames().join() === 'Pets by id,Pets copy,Refund audit', shownNames().join());
    check('the count says how many match', document.getElementById('savedCount').textContent === '3 of 4');
    check('matches are highlighted in the name, keeping its original case', [...document.querySelectorAll('#saved .name mark')].map((m) => m.textContent).join() === 'Pets,Pets', [...document.querySelectorAll('#saved .name mark')].map((m) => m.textContent).join());
    typeFilter('pets copy');
    check('several words must all match (any order, name or SQL)', shownNames().join() === 'Pets copy');
    typeFilter('customer orders');
    check('...across the name and the SQL', shownNames().join() === 'Orders by customer');
    typeFilter('REFUNDS');
    check('SQL-only matches are found, with nothing to highlight in the name', shownNames().join() === 'Refund audit' && !document.querySelector('#saved .name mark') && document.getElementById('savedCount').textContent === '1 of 4');
    typeFilter('zzz');
    check('no match: says so, plainly, and counts 0 of 4', shownNames().length === 0 && document.querySelector('#saved .sq-empty')?.textContent === 'No saved query matches “zzz”.' && document.getElementById('savedCount').textContent === '0 of 4');
    check('the clear button appears only while there is a filter', !document.getElementById('savedSearchClear').hidden);
    document.getElementById('savedSearchClear').click();
    check('clear empties the filter, shows everything, and returns focus to the box', filterInput().value === '' && shownNames().length === 4 && document.activeElement === filterInput() && document.getElementById('savedSearchClear').hidden);
    typeFilter('pets'); fkey('Escape');
    check('Esc clears the filter', filterInput().value === '' && shownNames().length === 4);
    filterInput().focus(); fkey('Escape');
    check('a second Esc leaves the box', document.activeElement !== filterInput());
    typeFilter('pets'); filterInput().focus(); fkey('ArrowDown');
    check('↓ moves from the box to the first match', document.activeElement === document.querySelector('#saved .sq') && document.activeElement.querySelector('.name').textContent === 'Pets by id');
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    check('↓ moves down the list', document.activeElement.querySelector('.name').textContent === 'Pets copy');
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
    check('↑ from the first item goes back to the box', document.activeElement === filterInput());
    fkey('Enter'); await sleep(150);
    check('Enter opens the first match', currentTab().title === 'Pets by id' && currentTab().savedId === 's2');
    check('the filter stays while you work', filterInput().value === 'pets');
    typeFilter('');
    queries.push({ id: 's5', name: '<img src=x onerror=alert(1)>', sql: 'x', connId: null, updatedAt: 5 }); renderSaved();
    typeFilter('img');
    check('names are escaped, and the match is highlighted inside the text', !document.querySelector('#saved img') && shownNames().join() === '<img src=x onerror=alert(1)>' && document.querySelector('#saved .name mark')?.textContent === 'img');
    typeFilter('');
    document.getElementById('savedHead').click();
    check('collapsing the group hides the search box too', box().hidden);
    document.getElementById('savedHead').click();
    check('...and expanding brings it back', !box().hidden);
    queries = []; renderSaved();

    // ================= .sql files =================
    const temp = (await tiny.app.paths()).temp.replace(/\/$/, '');
    const fileA = `${temp}/tinyarql-ui-report.sql`, fileB = `${temp}/tinyarql-ui-notes.txt`, fileC = `${temp}/tinyarql-ui-crlf.sql`, exportPath = `${temp}/tinyarql-ui-export`;
    await tiny.api.call('writeTextFile', { path: fileA, text: 'select 1;\nselect 2;\n' });
    await tiny.api.call('writeTextFile', { path: fileB, text: '-- notes\nselect 3' });
    await tiny.api.call('writeTextFile', { path: fileC, text: "select 'a'\r\nfrom t\r\n" });
    clearTimeout(persistTimer); await tiny.store.delete('tabs'); await loadTabs();
    const fdialogs = []; let openAnswer = [fileA, fileB], saveAnswer = null, confirmAnswerF = true;
    const realOpenFiles = tiny.dialog.openFiles, realSaveFile = tiny.dialog.saveFile, realAlert = tiny.dialog.alert, realConfirm3 = tiny.dialog.confirm;
    tiny.dialog.openFiles = async (o) => { fdialogs.push(['openFiles', o]); return openAnswer; };
    tiny.dialog.saveFile = async (o) => { fdialogs.push(['saveFile', o]); return saveAnswer; };
    tiny.dialog.alert = async (m, d) => { fdialogs.push(['alert', m, d]); };
    tiny.dialog.confirm = async (m, o) => { fdialogs.push(['confirm', m, o]); return confirmAnswerF; };
    const fcount = (k) => fdialogs.filter((d) => d[0] === k).length, flast = (k) => [...fdialogs].reverse().find((d) => d[0] === k);
    check('Open and Export SQL buttons are present and labelled', document.getElementById('openFile').getAttribute('aria-label') === 'Open SQL files' && !!document.getElementById('openFile').querySelector('svg') && document.getElementById('exportBtn').textContent.trim() === 'Export SQL' && !!document.getElementById('exportBtn').querySelector('svg'));
    document.getElementById('openFile').click(); await sleep(400);
    check('the file dialog is limited to .sql and .txt', fcount('openFiles') === 1 && JSON.stringify(flast('openFiles')[1]) === JSON.stringify({ types: ['sql', 'txt'] }));
    check('each chosen file opens in its own tab, named after the file (the blank tab is reused)', tabNames().join() === 'tinyarql-ui-report,tinyarql-ui-notes' && tabs.length === 2, tabNames().join());
    switchTab(tabs[0].id);
    check('...with the file\'s text, and not marked unsaved', editor.getValue() === 'select 1;\nselect 2;\n' && !dirtyAt(0) && !dirtyAt(1));
    check('the tab remembers the file (a path and a fingerprint, not a copy of the text)', tabs[0].origin.path === fileA && JSON.stringify(Object.keys(tabs[0].origin).sort()) === JSON.stringify(['hash', 'path']));
    editor.setValue('select 1;\nselect 2;\nselect 99;');
    check('editing makes it unsaved', dirtyAt(0));
    editor.setValue('select 1;\nselect 2;\n');
    check('putting the text back makes it clean again', !dirtyAt(0));
    openAnswer = [fileB]; document.getElementById('openFile').click(); await sleep(300);
    check('opening a file that is already open goes to its tab instead of duplicating it', tabs.length === 2 && currentTab().origin.path === fileB, `${tabs.length} tabs, on ${currentTab().origin && currentTab().origin.path}`);
    openAnswer = [fileC]; document.getElementById('openFile').click(); await sleep(300);
    check('CRLF files open with normal line breaks and are not instantly "unsaved"', currentTab().title === 'tinyarql-ui-crlf' && editor.getValue() === "select 'a'\nfrom t\n" && !dirtyAt(selIdx()), JSON.stringify(editor.getValue()));
    openAnswer = null; const tabsBefore = tabs.length; document.getElementById('openFile').click(); await sleep(200);
    check('cancelling the dialog opens nothing', tabs.length === tabsBefore);
    openAnswer = ['/nonexistent-dir/none.sql']; document.getElementById('openFile').click(); await sleep(300);
    check('a file that cannot be opened says why, in an alert, and adds no tab', tabs.length === tabsBefore && flast('alert')[1] === 'Couldn’t open none.sql' && flast('alert')[2] === 'File not found', JSON.stringify(flast('alert')));
    openAnswer = [temp]; document.getElementById('openFile').click(); await sleep(300);
    check('a folder is refused in plain words', flast('alert')[2] === 'That is a folder, not a file' && tabs.length === tabsBefore, JSON.stringify(flast('alert')));
    // drag and drop
    handleDrop([`${temp}/photo.png`, fileA]); await sleep(300);
    check('dropping files opens the .sql/.txt ones and ignores the rest', tabs.length === tabsBefore && currentTab().origin.path === fileA);
    handleDrop([`${temp}/photo.png`]); await sleep(100);
    check('dropping only other kinds of file says what can be opened', document.getElementById('status').textContent === 'Only .sql and .txt files can be opened' && document.getElementById('status').classList.contains('bad'));
    // closing: pristine file tabs need no confirmation, edited ones do
    const askedF = fcount('confirm');
    closeTab(tabs.find((t) => t.origin.path === fileC).id); await sleep(200);
    check('closing an unedited file tab asks nothing', fcount('confirm') === askedF && !tabs.some((t) => t.origin?.path === fileC));
    switchTab(tabs.find((t) => t.origin?.path === fileB).id); editor.setValue('-- notes\nselect 3 -- edited');
    closeTab(currentId); await sleep(200);
    check('closing an edited one asks first', fcount('confirm') === askedF + 1 && flast('confirm')[1] === 'Close “tinyarql-ui-notes”?');
    // export
    switchTab(tabs[0].id);
    editor.setValue('select * from pets\nwhere id = 7;'); editor.select(0, 5);
    saveAnswer = exportPath; document.getElementById('exportBtn').click(); await sleep(400);
    check('Export asks where, limited to .sql', fcount('saveFile') === 1 && JSON.stringify(flast('saveFile')[1]) === JSON.stringify({ types: ['sql'] }));
    const written = await tiny.api.call('readTextFile', { path: `${exportPath}.sql` });
    check('a bare name gets .sql, and the whole editor is written (not just the selection)', written.text === 'select * from pets\nwhere id = 7;', JSON.stringify(written.text));
    check('the status line says where it went', document.getElementById('status').textContent === 'Exported to tinyarql-ui-export.sql');
    check('the tab now counts as saved to that file', !dirtyAt(selIdx()) && currentTab().origin.path === `${exportPath}.sql`);
    editor.setValue('select 8');
    check('...and edits make it unsaved again', dirtyAt(selIdx()));
    saveAnswer = `${temp}/tinyarql-ui-export.txt`; document.getElementById('exportBtn').click(); await sleep(300);
    check('a name that already has an extension is kept as typed', currentTab().origin.path.endsWith('tinyarql-ui-export.txt') && (await tiny.api.call('readTextFile', { path: `${temp}/tinyarql-ui-export.txt` })).text === 'select 8');
    const originBefore = JSON.stringify(currentTab().origin);
    saveAnswer = null; document.getElementById('exportBtn').click(); await sleep(200);
    check('cancelling the save dialog writes nothing and changes nothing', JSON.stringify(currentTab().origin) === originBefore);
    saveAnswer = '/nonexistent-dir/x.sql'; document.getElementById('exportBtn').click(); await sleep(300);
    check('a failed export says why, and the tab keeps its previous file', flast('alert')[1] === 'Couldn’t save x.sql' && flast('alert')[2] === 'That folder does not exist' && JSON.stringify(currentTab().origin) === originBefore);
    editor.setValue('   \n');
    const savesBefore = fcount('saveFile'); document.getElementById('exportBtn').click(); await sleep(200);
    check('exporting an empty query does nothing but say so', fcount('saveFile') === savesBefore && document.getElementById('status').textContent === 'Nothing to export: the query is empty');
    editor.setValue('select 8');
    const exportedTab = currentId;
    document.getElementById('newTab').click(); await sleep(100);
    const nTabs = tabs.length; openAnswer = [`${temp}/tinyarql-ui-export.txt`]; document.getElementById('openFile').click(); await sleep(300);
    check('opening the file you just exported goes back to that tab (round trip), not a copy', tabs.length === nTabs && currentId === exportedTab && editor.getValue() === 'select 8', `${tabs.length}/${nTabs}`);
    // persistence
    editor.setValue('select 8 -- changed');
    await persistTabsNow();
    const keep = tabs.map((t) => [t.title, t.origin && t.origin.path, isUnsaved(t)].join()).join('|');
    await loadTabs();
    check('file origins and their clean/unsaved state survive a restart', tabs.map((t) => [t.title, t.origin && t.origin.path, isUnsaved(t)].join()).join('|') === keep && tabs.some((t) => t.origin) && tabs.some((t) => isUnsaved(t) && t.origin), keep);
    // keyboard
    const o0 = fcount('openFiles'), s0 = fcount('saveFile');
    openAnswer = null; saveAnswer = null;
    press('o', { metaKey: true }); await sleep(100); press('e', { metaKey: true }); await sleep(100);
    check('⌘O opens the file dialog and ⌘E starts an export', fcount('openFiles') === o0 + 1 && fcount('saveFile') === s0 + 1);
    settings.vim = true;
    press('o', { ctrlKey: true }); press('e', { ctrlKey: true }); await sleep(100);
    check('with Vim on, Ctrl+O and Ctrl+E stay Vim\'s (they are not taken for open/export)', fcount('openFiles') === o0 + 1 && fcount('saveFile') === s0 + 1);
    press('o', { metaKey: true }); await sleep(100);
    check('...but ⌘O still works', fcount('openFiles') === o0 + 2);
    settings.vim = false;
    press('o', { ctrlKey: true }); await sleep(100);
    check('without Vim, Ctrl+O works too (Windows and Linux)', fcount('openFiles') === o0 + 3);
    tiny.dialog.openFiles = realOpenFiles; tiny.dialog.saveFile = realSaveFile; tiny.dialog.alert = realAlert; tiny.dialog.confirm = realConfirm3;

    // ================= CSV export =================
    clearTimeout(persistTimer); await tiny.store.delete('tabs'); await loadTabs(); setActive(conn1Id);
    const csvBtn = document.getElementById('exportCsv');
    const csvLog = []; let csvSave = null, csvAll = true;
    const realSave4 = tiny.dialog.saveFile, realConfirm4 = tiny.dialog.confirm, realAlert4 = tiny.dialog.alert;
    tiny.dialog.saveFile = async (o) => { csvLog.push(['save', o]); return csvSave; };
    tiny.dialog.confirm = async (m, o) => { csvLog.push(['confirm', m, o]); return csvAll; };
    tiny.dialog.alert = async (m, d) => { csvLog.push(['alert', m, d]); };
    const csvLast = (k) => [...csvLog].reverse().find((d) => d[0] === k), csvCount = (k) => csvLog.filter((d) => d[0] === k).length;
    const readCsv = async (path) => (await tiny.api.call('readTextFile', { path })).text;
    const csvLines = (t) => t.split('\r\n');
    const runAndWait = async (sql) => { editor.setValue(sql); document.getElementById('run').click(); await sleep(500); };
    const csvStatus = () => document.getElementById('status').textContent;
    check('Export CSV is hidden with no results', csvBtn.hidden);
    await runAndWait('select * from nope');
    check('...and while an error is shown', csvBtn.hidden && !!g.querySelector('.error'));
    showNotice('Query stopped', 'x');
    check('...and while a notice is shown', csvBtn.hidden);

    // a small, complete result: exported exactly as shown, no questions csvAskedPage
    await runAndWait("select 'a,b' as txt, null as n, '' as e, 3 as num union all select 'say \"hi\"', 1, 'x', 4");
    check('with a grid, the button appears (labelled, with an icon)', !csvBtn.hidden && !csvBtn.disabled && csvBtn.textContent.trim() === 'Export CSV' && !!csvBtn.querySelector('svg'));
    csvSave = `${temp}/tinyarql-ui-results`; csvBtn.click(); await sleep(500);
    check('Export CSV asks where, limited to .csv, and does not ask about row counts', csvCount('save') === 1 && JSON.stringify(csvLast('save')[1]) === JSON.stringify({ types: ['csv'] }) && csvCount('confirm') === 0);
    check('a bare name gets .csv, and the file holds the header and rows exactly (quotes, NULL, empty string)', (await readCsv(`${temp}/tinyarql-ui-results.csv`)) === 'txt,n,e,num\r\n"a,b",,"",3\r\n"say ""hi""",1,x,4\r\n', JSON.stringify(await readCsv(`${temp}/tinyarql-ui-results.csv`)));
    check('the status line says how many rows went where', csvStatus() === 'Exported 2 rows to tinyarql-ui-results.csv', csvStatus());
    const csvStatusBefore = csvStatus(); csvSave = null; csvBtn.click(); await sleep(200);
    check('cancelling the save dialog changes nothing', csvStatus() === csvStatusBefore && csvCount('alert') === 0);
    csvSave = '/nonexistent-dir/x.csv'; csvBtn.click(); await sleep(400);
    check('an export that cannot be written says why, and the results stay', csvLast('alert')[1] === 'Couldn’t save x.csv' && csvLast('alert')[2] === 'That folder does not exist' && gridRows() === 2);

    // a result bigger than the grid: a choice between what is shown and every row
    await runAndWait("create table csvbig(id integer primary key, label text); with recursive c(x) as (select 1 union all select x + 1 from c where x < 1500) insert into csvbig(id, label) select x, 'row ' || x from c;");
    await runAndWait('select * from csvbig order by id');
    check('(sanity) the grid shows 1000 of 1500 rows and says it is truncated', gridRows() === 1000 && /truncated at 1000/.test(csvStatus()), `${gridRows()} / ${csvStatus()}`);
    csvSave = `${temp}/tinyarql-ui-all`; csvAll = true; csvBtn.click(); await sleep(900);
    check('it asks whether to export every row, spelling out the choice', csvLast('confirm')[1] === 'Export all rows?' && /first 1,000 rows/.test(csvLast('confirm')[2].detail) && /runs the query again/.test(csvLast('confirm')[2].detail) && csvLast('confirm')[2].ok === 'Export all rows' && csvLast('confirm')[2].cancel === 'Export the 1,000 shown', JSON.stringify(csvLast('confirm')));
    const csvAllText = await readCsv(`${temp}/tinyarql-ui-all.csv`);
    check('"Export all rows" writes all 1500 (not just the 1000 on screen)', csvLines(csvAllText)[0] === 'id,label' && csvLines(csvAllText).length === 1502 && csvLines(csvAllText)[1500] === '1500,row 1500', `${csvLines(csvAllText).length} lines`);
    check('...reports it with a thousands separator, and leaves the grid as it was', csvStatus() === 'Exported 1,500 rows to tinyarql-ui-all.csv' && gridRows() === 1000 && !running && !document.getElementById('run').disabled, csvStatus());
    csvAll = false; csvSave = `${temp}/tinyarql-ui-shown`; csvBtn.click(); await sleep(600);
    check('"Export the 1,000 shown" writes exactly what is on screen', csvLines(await readCsv(`${temp}/tinyarql-ui-shown.csv`)).length === 1002 && csvStatus() === 'Exported 1,000 rows to tinyarql-ui-shown.csv', csvStatus());
    editor.setValue('select 1 as changed_after');   // the export re-runs what produced the grid, not what the editor says now
    csvAll = true; csvSave = `${temp}/tinyarql-ui-again`; csvBtn.click(); await sleep(900);
    check('"all rows" re-runs the query that produced the grid, even if the editor has changed since', csvLines(await readCsv(`${temp}/tinyarql-ui-again.csv`)).length === 1502 && csvLines(await readCsv(`${temp}/tinyarql-ui-again.csv`))[0] === 'id,label');

    // browsing a table: one page on screen, the whole table on request
    const csvTableLi = (n) => [...document.querySelectorAll('.tbls li')].find((li) => li.textContent === n);
    expanded.add(conn1Id); renderConns();   // earlier checks may have left this connection collapsed
    csvTableLi('csvbig').click(); await sleep(500);
    check('(sanity) browsing shows one page of 100 rows', gridRows() === 100 && !document.getElementById('pager').hidden);
    csvAll = true; csvSave = `${temp}/tinyarql-ui-table`; csvBtn.click(); await sleep(900);
    check('a browsed table asks about the whole table, not "the query"', csvLast('confirm')[1] === 'Export the whole table?' && /one page of csvbig/.test(csvLast('confirm')[2].detail) && csvLast('confirm')[2].ok === 'Export whole table' && csvLast('confirm')[2].cancel === 'Export this page', JSON.stringify(csvLast('confirm')));
    check('...and exports all 1500 rows', csvLines(await readCsv(`${temp}/tinyarql-ui-table.csv`)).length === 1502 && csvStatus() === 'Exported 1,500 rows to tinyarql-ui-table.csv', csvStatus());
    csvAll = false; csvSave = `${temp}/tinyarql-ui-page`; csvBtn.click(); await sleep(500);
    check('"Export this page" writes the 100 on screen', csvLines(await readCsv(`${temp}/tinyarql-ui-page.csv`)).length === 102);
    document.getElementById('next').click(); await sleep(500);
    const csvAskedPage = csvCount('confirm'); csvAll = false; csvSave = `${temp}/tinyarql-ui-page2`; csvBtn.click(); await sleep(500);
    check('on page 2 it asks again, and "this page" is rows 101-200', csvCount('confirm') === csvAskedPage + 1 && csvLines(await readCsv(`${temp}/tinyarql-ui-page2.csv`))[1] === '101,row 101');
    csvTableLi('pets').click(); await sleep(500);
    const csvAskedSmall = csvCount('confirm'); csvSave = `${temp}/tinyarql-ui-pets`; csvBtn.click(); await sleep(500);
    check('a small table fits on one page, so no question is csvAskedPage', csvCount('confirm') === csvAskedSmall && csvLines(await readCsv(`${temp}/tinyarql-ui-pets.csv`)).length === 4, String(csvLines(await readCsv(`${temp}/tinyarql-ui-pets.csv`)).length));

    // while a query or export is running (calls stubbed: a slow Postgres cannot be conjured from here)
    const csvRows1000 = Array.from({ length: 1000 }, (_, i) => [String(i + 1)]);
    const csvHold = {};
    const csvRealCall = tiny.api.call.bind(tiny.api);
    tiny.api.call = async (m, p) => {
      if (m === 'query') return csvHold.query === 'hang' ? new Promise((res) => { csvHold.resolveQuery = res; }) : { columns: ['n'], types: ['int4'], rows: csvRows1000, truncated: true, ms: 1 };
      if (m === 'exportQueryCsv') { csvHold.exportArgs = p; if (csvHold.export === 'fail') throw new Error('disk full'); if (csvHold.export === 'ok') return { rows: 5000 }; return new Promise((res) => { csvHold.resolveExport = res; }); }
      if (m === 'cancelQuery') { csvHold.cancelArgs = p; await sleep(80); csvHold.resolveExport({ cancelled: true, rows: 12 }); return { cancelled: true }; }
      if (m === 'tables') return [];
      return csvRealCall(m, p);
    };
    conns.push({ id: 'pg-csv', name: 'pgcsv', type: 'postgres' }); tables['pg-csv'] = []; setActive('pg-csv');
    await runAndWait('select n from t'); csvAll = true; csvSave = `${temp}/tinyarql-ui-stub`;
    csvHold.export = 'hang'; csvBtn.click(); await sleep(250);
    const csvRunLabel = () => document.getElementById('run').textContent.trim();
    check('exporting on Postgres: Run becomes Stop, the CSV button is disabled, the status says Exporting…', csvRunLabel() === 'Stop' && document.getElementById('run').classList.contains('stop') && csvBtn.disabled && csvStatus() === 'Exporting…', `${csvRunLabel()} / ${csvStatus()}`);
    check('the export was csvAskedPage for the snapshot\'s SQL and connection', csvHold.exportArgs.id === 'pg-csv' && csvHold.exportArgs.sql === 'select n from t' && csvHold.exportArgs.path === `${temp}/tinyarql-ui-stub.csv`, JSON.stringify(csvHold.exportArgs));
    onExportProgress({ id: 'pg-csv', rows: 4321 }); await sleep(400);
    check('progress shows as a row count in the status line', csvStatus() === 'Exporting… 4,321 rows', csvStatus());
    press('.', { metaKey: true }); await sleep(400);
    check('⌘. stops the export: cancel went to that connection, status says no file was written, no alert', csvHold.cancelArgs.id === 'pg-csv' && csvStatus() === 'Export stopped. No file was written' && csvLast('alert')[1] !== 'Couldn’t export to tinyarql-ui-stub.csv', csvStatus());
    check('...the grid is untouched and the buttons are back', gridRows() === 1000 && csvRunLabel() === 'Run' && !csvBtn.disabled && !document.getElementById('run').disabled);
    csvHold.export = 'fail'; csvBtn.click(); await sleep(400);
    check('a failed export: red status, an alert with the reason, buttons back', csvStatus() === 'Export failed' && document.getElementById('status').classList.contains('bad') && csvLast('alert')[1] === 'Couldn’t export to tinyarql-ui-stub.csv' && csvLast('alert')[2] === 'disk full' && !csvBtn.disabled && csvRunLabel() === 'Run');
    csvHold.export = 'ok'; csvBtn.click(); await sleep(400);
    check('a finished export says how many rows went where', csvStatus() === 'Exported 5,000 rows to tinyarql-ui-stub.csv' && !document.getElementById('status').classList.contains('bad'));
    // SQLite cannot be stopped: the button says so rather than offering Stop
    setActive(conn1Id); await runAndWait('select n from t'); csvHold.export = 'hang'; csvBtn.click(); await sleep(250);
    const csvCancelsBefore = csvHold.cancelArgs;
    check('exporting on SQLite: no Stop is offered, Run is a disabled "Exporting…"', csvRunLabel() === 'Exporting…' && document.getElementById('run').disabled && !document.getElementById('run').classList.contains('stop'));
    press('.', { metaKey: true }); await sleep(150);
    check('⌘. does nothing there', csvHold.cancelArgs === csvCancelsBefore);
    csvHold.resolveExport({ rows: 7 }); await sleep(250);
    check('when it finishes, the buttons are back', csvRunLabel() === 'Run' && !csvBtn.disabled && csvStatus() === 'Exported 7 rows to tinyarql-ui-stub.csv');
    // Export CSV is off while a query is running
    csvHold.query = 'hang'; editor.setValue('select slow'); document.getElementById('run').click(); await sleep(200);
    check('the CSV button is disabled while a query runs', csvBtn.disabled);
    const csvSavesRunning = csvCount('save'); press('e', { metaKey: true, shiftKey: true }); await sleep(150);
    check('...and ⌘⇧E does nothing then', csvCount('save') === csvSavesRunning);
    csvHold.resolveQuery({ columns: ['n'], types: ['int4'], rows: [['1']], truncated: false, ms: 1 }); await sleep(250);
    check('...and comes back when it ends', !csvBtn.disabled);
    tiny.api.call = csvRealCall;
    conns.splice(conns.findIndex((c) => c.id === 'pg-csv'), 1); delete tables['pg-csv']; setActive(conn1Id); renderConns();
    // keyboard
    await runAndWait("select 1 as a");
    csvSave = null; const csvSaves0 = csvLog.filter((d) => d[0] === 'save').length;
    press('e', { metaKey: true, shiftKey: true }); await sleep(150);
    check('⌘⇧E starts a CSV export', csvLog.filter((d) => d[0] === 'save').length === csvSaves0 + 1 && JSON.stringify(csvLast('save')[1]) === JSON.stringify({ types: ['csv'] }));
    press('e', { metaKey: true }); await sleep(150);
    check('⌘E is still the .sql export (a different dialog)', JSON.stringify(csvLast('save')[1]) === JSON.stringify({ types: ['sql'] }));
    settings.vim = true; press('e', { ctrlKey: true, shiftKey: true }); await sleep(150);
    check('with Vim on, Ctrl+Shift+E is left alone', csvLog.filter((d) => d[0] === 'save').length === csvSaves0 + 2);
    press('e', { metaKey: true, shiftKey: true }); await sleep(150);
    check('...but ⌘⇧E still works', csvLog.filter((d) => d[0] === 'save').length === csvSaves0 + 3);
    settings.vim = false;
    tiny.dialog.saveFile = realSave4; tiny.dialog.confirm = realConfirm4; tiny.dialog.alert = realAlert4;

    // ================= MySQL =================
    // ---- the connection form and the welcome screen ----
    document.getElementById('addConn').click();
    const myForm = document.getElementById('form');
    check('the type list offers PostgreSQL, MySQL and SQLite', [...myForm.elements.type.options].map((o) => `${o.value}:${o.textContent}`).join() === 'postgres:PostgreSQL,mysql:MySQL,sqlite:SQLite');
    myForm.elements.type.value = 'mysql'; myForm.elements.type.dispatchEvent(new Event('change'));
    check('MySQL shows the same connection fields as PostgreSQL, and hides the SQLite file', !document.querySelector('[data-for="postgres mysql"]').hidden && document.querySelector('[data-for=sqlite]').hidden);
    check('the TLS note appears for MySQL', !document.querySelector('p[data-for=mysql]').hidden && /require TLS/.test(document.querySelector('p[data-for=mysql]').textContent));
    check('the port switches to MySQL\'s default', myForm.elements.port.value === '3306');
    myForm.elements.type.value = 'postgres'; myForm.elements.type.dispatchEvent(new Event('change'));
    check('...and back to PostgreSQL\'s, with the MySQL-only note hidden again', myForm.elements.port.value === '5432' && document.querySelector('p[data-for=mysql]').hidden && !document.querySelector('[data-for="postgres mysql"]').hidden);
    myForm.elements.port.value = '6543';
    myForm.elements.type.value = 'mysql'; myForm.elements.type.dispatchEvent(new Event('change'));
    check('a port you typed yourself is never overwritten', myForm.elements.port.value === '6543');
    myForm.elements.type.value = 'sqlite'; myForm.elements.type.dispatchEvent(new Event('change'));
    check('SQLite hides the network fields and the MySQL note', document.querySelector('[data-for="postgres mysql"]').hidden && document.querySelector('p[data-for=mysql]').hidden && !document.querySelector('[data-for=sqlite]').hidden);
    document.getElementById('cancel').click();
    const hadConns = conns.splice(0); renderEmpty();
    const card = document.querySelector('#grid .choice[data-new=mysql]');
    check('the welcome screen has a MySQL card', !!card && /MySQL/.test(card.textContent) && !!card.querySelector('svg'));
    card.click();
    check('the MySQL card opens the form on MySQL with its default port', document.getElementById('dlg').open && myForm.elements.type.value === 'mysql' && myForm.elements.port.value === '3306' && !document.querySelector('[data-for="postgres mysql"]').hidden);
    document.getElementById('cancel').click();
    conns.push(...hadConns); renderEmpty();

    // ---- labels, alignment and the editor dialect (no server needed) ----
    renderGrid({ columns: ['id', 'name', 'price', 'qty', 'ratio'], types: ['int', 'varchar', 'decimal', 'bigint', 'double'], rows: [['1', 'a', '9.50', '3', '0.5']], truncated: false, ms: 1 });
    check('MySQL numeric types right-align and show under the column name', [...g.querySelectorAll('td')].map((t) => t.classList.contains('num')).join() === 'true,false,true,true,true' && [...g.querySelectorAll('th .ctype')].map((t) => t.textContent).join() === 'int,varchar,decimal,bigint,double');
    conns.push({ id: 'my-fake', name: 'myfake', type: 'mysql', env: 'staging' }); tables['my-fake'] = [{ name: 'orders', ref: '`orders`', type: 'table', columns: ['id', 'total'] }]; setActive('my-fake'); renderConns();
    check('the status bar names the dialect as MySQL, with the environment', document.getElementById('where').textContent.includes('MySQL') && document.getElementById('where').textContent.includes('staging'), document.getElementById('where').textContent);
    editor.setValue('select `id`, `total` from `orders`');
    check('the editor switches to the MySQL dialect: backtick identifiers parse as quoted identifiers', editor.nodeNames().includes('QuotedIdentifier'), editor.nodeNames().join(','));
    conns.push({ id: 'pg-ctl', name: 'pgctl', type: 'postgres' }); tables['pg-ctl'] = []; setActive('pg-ctl'); renderConns();
    check('(control) under the PostgreSQL dialect the same text does not parse as quoted identifiers', !editor.nodeNames().includes('QuotedIdentifier'), editor.nodeNames().join(','));
    conns.splice(conns.findIndex((c) => c.id === 'pg-ctl'), 1); delete tables['pg-ctl']; setActive('my-fake'); renderConns();
    editor.setValue('select orders.'); editor.cursorToEnd();
    const myLabels = await editor.completionLabels();
    check('...and completes the MySQL table\'s columns', ['id', 'total'].every((c) => myLabels.includes(c)), myLabels.slice(0, 6).join());
    conns.splice(conns.findIndex((c) => c.id === 'my-fake'), 1); delete tables['my-fake']; setActive(conn1Id); renderConns();

    // ---- end to end against a real server, when there is one ----
    const myAnswer = { conn: { type: 'mysql', host: '127.0.0.1', port: 33061, user: 'tester', database: 'testdb' }, password: 'secret' };
    const myProbe = await tiny.api.call('testConnection', myAnswer).then(() => true, (e) => String(e.message || e));
    if (myProbe !== true) check('MySQL end-to-end: SKIPPED, no MySQL answered on 127.0.0.1:33061 (see test/drivers.js to start one)', true, myProbe);
    else {
      const myDlg = []; let mySave = null, myAll = true;
      const rS = tiny.dialog.saveFile, rC = tiny.dialog.confirm, rA = tiny.dialog.alert;
      tiny.dialog.saveFile = async () => mySave; tiny.dialog.confirm = async (m, o) => { myDlg.push([m, o]); return myAll; }; tiny.dialog.alert = async () => {};
      clearTimeout(persistTimer); await tiny.store.delete('tabs'); await loadTabs();
      await tiny.api.call('saveConnection', { conn: { ...myAnswer.conn, name: 'my-e2e', env: 'staging' }, password: 'secret' });
      await load();
      named('my-e2e').querySelector('.head').click();
      await until(() => named('my-e2e').classList.contains('on'), 'MySQL connected');
      const myId = named('my-e2e').dataset.id;
      check('connecting to MySQL (a full caching_sha2 login) works from the sidebar', named('my-e2e').classList.contains('open') && !named('my-e2e').classList.contains('connecting'));
      check('its tables and views are listed, a view with the eye icon', [...named('my-e2e').querySelectorAll('.tbls li')].map((li) => li.textContent).join() === 'people,v' && !!named('my-e2e').querySelector('.tbls li.view svg'));
      check('the status bar says MySQL and staging', document.getElementById('where').textContent.includes('MySQL') && document.getElementById('where').textContent.includes('staging') && !document.getElementById('envBar').hidden);
      named('my-e2e').querySelector('[data-act=edit]').click();
      check('editing it opens the form as MySQL with the saved port and fields', myForm.elements.type.value === 'mysql' && myForm.elements.port.value === '33061' && myForm.elements.name.value === 'my-e2e' && myForm.elements.database.value === 'testdb' && myForm.elements.env.value === 'staging');
      document.getElementById('cancel').click();
      await runAndWait('select * from people order by id');
      check('a MySQL result shows its column types', [...g.querySelectorAll('th .ctype')].map((t) => t.textContent).join() === 'int,varchar,text,date,decimal,tinyint,json,blob', [...g.querySelectorAll('th .ctype')].map((t) => t.textContent).join());
      const myRow = () => [...g.querySelectorAll('tbody tr')[0].children], myRow2 = () => [...g.querySelectorAll('tbody tr')[1].children];
      check('id, score and flag are right-aligned numbers; name is not', myRow().map((t) => t.classList.contains('num')).join() === 'true,false,false,false,true,true,false,false');
      check('decimals are exact, dates plain, and binary shows as hex', myRow()[4].textContent === '12.50' && myRow()[3].textContent === '1815-12-10' && myRow()[7].textContent === '0x00ff10');
      check('NULLs are hatched empty cells', myRow2().filter((t) => t.classList.contains('null')).length === 5, String(myRow2().filter((t) => t.classList.contains('null')).length));
      check('a MySQL json column is recognised as JSON (badge)', myRow()[6].classList.contains('json') && !!myRow()[6].querySelector('.jb svg'));
      myRow()[6].click();
      check('clicking it opens the JSON tree with the right values', !document.getElementById('detail').hidden && el('detailTitle').textContent.endsWith('json') && document.getElementById('detailBody').textContent.includes('"a"') && document.querySelectorAll('#detailBody .j-num').length === 2);
      el('detailRaw').click();
      check('Raw shows the JSON exactly as MySQL formats it', document.querySelector('#detailBody pre').textContent === '{"a": [1, 2]}');
      el('detailTree').click(); closeDetail();
      editor.setValue('select people.'); editor.cursorToEnd();
      const myCols = await editor.completionLabels();
      check('completion knows the live MySQL columns', ['name', 'meta', 'raw'].every((c) => myCols.includes(c)), myCols.slice(0, 6).join());
      await runAndWait('select 1 as a; select 2 as b, 3 as c');
      check('a script shows its last result set', [...g.querySelectorAll('th')].map((t) => t.textContent.replace(/\W+$/, '')).join().startsWith('b') && g.querySelectorAll('tbody tr').length === 1);
      await runAndWait('select * from nope');
      check('a MySQL error shows in the error panel, in the server\'s words', /doesn't exist/.test(g.querySelector('.error pre')?.textContent || '') && g.querySelector('.error strong').textContent === 'Query failed', g.querySelector('.error')?.textContent);
      await runAndWait('update people set note = note where id = 1');
      check('a statement with no rows says what it did', /1 row affected/.test(g.querySelector('.empty')?.textContent || '') || /affected/.test(g.textContent), g.textContent.slice(0, 80));
      // stopping a real statement
      editor.setValue('select count(*) from information_schema.columns a, information_schema.columns b, information_schema.columns c');
      document.getElementById('run').click(); await sleep(500);
      check('while a MySQL statement runs, Run is Stop', document.getElementById('run').textContent.trim() === 'Stop' && document.getElementById('run').classList.contains('stop'));
      press('.', { metaKey: true }); await sleep(2500);
      check('⌘. stops it for real: a "Query stopped" notice, and Run is back', g.querySelector('.notice strong')?.textContent === 'Query stopped' && document.getElementById('run').textContent.trim() === 'Run' && !document.getElementById('run').disabled, g.querySelector('.notice, .error')?.textContent);
      await runAndWait('select 42 as answer');
      check('the connection works after a stop', g.querySelector('tbody td')?.textContent === '42');
      // export all rows from MySQL
      await runAndWait('set session cte_max_recursion_depth = 5000; with recursive c(n) as (select 1 union all select n + 1 from c where n < 1500) select n, concat("row ", n) as label from c');
      check('(sanity) the MySQL grid shows 1000 of 1500 rows, truncated', g.querySelectorAll('tbody tr').length === 1000 && /truncated at 1000/.test(document.getElementById('status').textContent));
      mySave = `${temp}/tinyarql-ui-mysql`; myAll = true; document.getElementById('exportCsv').click(); await sleep(1500);
      const myCsvOut = await readCsv(`${temp}/tinyarql-ui-mysql.csv`);
      check('Export CSV "all rows" re-runs the MySQL script and writes all 1500 rows', myDlg.some(([m]) => m === 'Export all rows?') && csvLines(myCsvOut).length === 1502 && csvLines(myCsvOut)[0] === 'n,label' && csvLines(myCsvOut)[1500] === '1500,row 1500', `${csvLines(myCsvOut).length} lines`);
      // browsing
      csvTableLi('people').click(); await sleep(600);
      check('browsing a MySQL table pages through it', g.querySelectorAll('tbody tr').length === 2 && !document.getElementById('pager').hidden);
      csvTableLi('v').click(); await sleep(600);
      check('browsing a view works too', [...g.querySelectorAll('th')].map((t) => t.textContent.replace(/\W+$/, '').replace(/int$/, '')).join().startsWith('id') && g.querySelectorAll('tbody tr').length === 2);
      tiny.dialog.saveFile = rS; tiny.dialog.confirm = rC; tiny.dialog.alert = rA;
      await tiny.api.call('deleteConnection', { id: myId }); await load();
    }

    // ================= reordering tabs =================
    const realConfirm6 = tiny.dialog.confirm; tiny.dialog.confirm = async () => true;  // never let a native dialog block the page
    clearTimeout(persistTimer); await tiny.store.delete('tabs'); await loadTabs();
    for (let i = 0; i < 3; i++) document.getElementById('newTab').click();
    await sleep(150);
    const dragList = document.getElementById('tablist');
    const tabOrder = () => tabs.map((t) => t.title).join(), domTabOrder = () => tabNames().join();
    const ptr = (type, x, y = 0, extra = {}) => new PointerEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true, pointerId: 1, button: 0, ...extra });
    const center = (i) => { const r = tabEls()[i].getBoundingClientRect(); return r.left + r.width / 2; };
    const grabTab = (i, extra = {}, target) => { const el = target || tabEls()[i]; const r = tabEls()[i].getBoundingClientRect(); const x = r.left + r.width / 2; el.dispatchEvent(ptr('pointerdown', x, r.top + 10, extra)); return x; };
    const dragTo = async (x0, x1) => { for (let k = 1; k <= 6; k++) { window.dispatchEvent(ptr('pointermove', x0 + ((x1 - x0) * k) / 6)); await sleep(20); } };
    const release = (x) => window.dispatchEvent(ptr('pointerup', x));
    const stripRight = () => dragList.getBoundingClientRect().right, stripLeft = () => dragList.getBoundingClientRect().left;
    const noDragLeft = () => !document.querySelector('.tab.dragging') && !document.body.classList.contains('dragging-tab') && tabEls().every((t) => !t.style.transform);
    check('(setup) four tabs in creation order', tabOrder() === 'Query 1,Query 2,Query 3,Query 4' && domTabOrder() === tabOrder() && currentTab().title === 'Query 4', tabOrder());

    // a press that barely moves is a click, not a drag
    let x0 = grabTab(1); window.dispatchEvent(ptr('pointermove', x0 + 3)); release(x0 + 3);
    check('moving less than 5px is not a drag', noDragLeft() && tabOrder() === 'Query 1,Query 2,Query 3,Query 4');

    // dragging the first tab past the middle of the third
    const beforeDragSel = currentTab().title;
    x0 = grabTab(0);
    await dragTo(x0, center(2) + 10);
    const lifted = document.querySelector('.tab.dragging');
    check('while dragging, the tab is lifted and the page shows a grabbing cursor', !!lifted && lifted.querySelector('.t').textContent === 'Query 1' && document.body.classList.contains('dragging-tab') && getComputedStyle(lifted).boxShadow !== 'none' && getComputedStyle(lifted).zIndex === '4');
    check('...the tab you pick up becomes the selected one', beforeDragSel === 'Query 4' && currentTab().title === 'Query 1');
    check('...and the others have already moved aside (live), but the order is only committed on release', domTabOrder() === 'Query 2,Query 3,Query 1,Query 4' && tabOrder() === 'Query 1,Query 2,Query 3,Query 4', `${domTabOrder()} | ${tabOrder()}`);
    release(center(2) + 10); await sleep(50);
    check('releasing commits the new order', tabOrder() === 'Query 2,Query 3,Query 1,Query 4' && domTabOrder() === tabOrder(), tabOrder());
    check('...and clears every drag style (no lifted tab, transforms or cursor left behind)', noDragLeft());
    check('...with the dragged tab still selected', currentTab().title === 'Query 1' && selIdx() === 2);
    await persistTabsNow();
    check('the new order is what gets stored', (await tiny.store.get('tabs')).list.map((t) => t.title).join() === 'Query 2,Query 3,Query 1,Query 4');

    // the click the browser sends after a drag must not also select a tab; the next real click must work
    x0 = grabTab(0); await dragTo(x0, center(1) + 5); release(center(1) + 5);
    const selAfterDrag = currentTab().title;
    tabEls()[3].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    check('the click right after a drag is swallowed', currentTab().title === selAfterDrag, `${selAfterDrag} -> ${currentTab().title}`);
    await sleep(50);
    tabEls()[3].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    check('...and ordinary clicks work again afterwards', currentTab().title === tabEls()[3].querySelector('.t').textContent);

    // the ends
    const lastTitle = () => tabEls()[tabEls().length - 1].querySelector('.t').textContent;
    const firstGrab = tabEls()[0].querySelector('.t').textContent;
    x0 = grabTab(0); await dragTo(x0, stripRight() + 400); release(stripRight() + 400); await sleep(50);
    check('dragging far past the right end puts the tab last', lastTitle() === firstGrab && tabs.length === 4 && tabs[3].title === firstGrab, `grabbed ${firstGrab}; dom ${domTabOrder()}; tabs ${tabOrder()}; strip ${Math.round(stripLeft())}-${Math.round(stripRight())}`);
    const lastGrab = lastTitle();
    x0 = grabTab(3); await dragTo(x0, stripLeft() - 400); release(stripLeft() - 400); await sleep(50);
    check('dragging far past the left end puts it first', tabEls()[0].querySelector('.t').textContent === lastGrab && tabs[0].title === lastGrab, `grabbed ${lastGrab}; dom ${domTabOrder()}; tabs ${tabOrder()}`);
    const keepOrder = tabOrder();

    // Esc cancels, leaving everything as it was
    x0 = grabTab(1); await dragTo(x0, stripRight() + 400);
    check('(sanity) mid-drag the order has changed on screen', domTabOrder() !== keepOrder);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    check('Esc cancels the drag: the original order is back and nothing is left lifted', domTabOrder() === keepOrder && tabOrder() === keepOrder && noDragLeft());
    release(stripRight() + 400); await sleep(50);
    check('...and the mouse release afterwards changes nothing', tabOrder() === keepOrder && domTabOrder() === keepOrder);

    // presses that must not start a drag
    x0 = grabTab(1, {}, tabEls()[1].querySelector('.x')); await dragTo(x0, stripRight() + 200); release(stripRight() + 200);
    check('pressing the close button never starts a drag', tabOrder() === keepOrder && noDragLeft());
    x0 = grabTab(1, { button: 2 }); await dragTo(x0, stripRight() + 200); release(stripRight() + 200);
    check('a right-button press never starts a drag', tabOrder() === keepOrder && noDragLeft());

    // a re-render in the middle of a drag (a query finishing in the background) must not pull the tab out from under the pointer
    x0 = grabTab(0); await dragTo(x0, center(1) + 5);
    const heldNode = document.querySelector('.tab.dragging');
    renderTabs(); onEdit();
    check('redraws are held back during a drag: the lifted tab is the same element, still attached', document.querySelector('.tab.dragging') === heldNode && heldNode.isConnected);
    release(center(1) + 5); await sleep(50);
    check('...and the strip is rebuilt cleanly after the drop', noDragLeft() && domTabOrder() === tabOrder());

    // keyboard: Alt+← / Alt+→ moves the focused tab one place, and focus stays on it
    const orderBeforeKeys = tabOrder();
    const altKey = (el, k) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, altKey: true, bubbles: true, cancelable: true }));
    const nameAt = (i) => tabEls()[i].querySelector('.t').textContent;
    const mover = nameAt(1), curBeforeKeys = currentTab().title;
    tabEls()[1].focus(); altKey(tabEls()[1], 'ArrowRight'); await sleep(50);
    check('Alt+→ moves the focused tab one place right, and keeps focus on it', nameAt(2) === mover && document.activeElement === tabEls()[2] && tabOrder() === domTabOrder(), `${domTabOrder()}`);
    check('...without changing which tab is selected', currentTab().title === curBeforeKeys);
    altKey(tabEls()[2], 'ArrowLeft'); await sleep(50);
    check('Alt+← moves it back', nameAt(1) === mover && tabOrder() === orderBeforeKeys, tabOrder());
    tabEls()[0].focus(); altKey(tabEls()[0], 'ArrowLeft'); await sleep(50);
    check('Alt+← on the first tab does nothing', tabOrder() === orderBeforeKeys);
    tabEls()[3].focus(); altKey(tabEls()[3], 'ArrowRight'); await sleep(50);
    check('Alt+→ on the last tab does nothing', tabOrder() === orderBeforeKeys);
    tabEls()[1].focus(); tabEls()[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })); await sleep(50);
    check('plain → still just moves between tabs (it does not reorder)', tabOrder() === orderBeforeKeys && selIdx() === 2, tabOrder());

    // other features follow the new order
    switchTab(tabs[0].id); await sleep(50);
    const firstName = tabs[0].title, secondName = tabs[1].title;
    press('Tab', { ctrlKey: true }); await sleep(100);
    check('Ctrl+Tab goes by the new order', currentTab().title === secondName && firstName !== secondName);
    await persistTabsNow();
    const savedOrder = tabOrder();
    await loadTabs();
    check('a restart restores the order', tabOrder() === savedOrder && domTabOrder() === savedOrder, `${tabOrder()} vs ${savedOrder}`);

    // a strip wider than the window: holding near the edge scrolls it
    while (dragList.scrollWidth <= dragList.clientWidth + 120 && tabs.length < 24) { document.getElementById('newTab').click(); await sleep(30); }
    await sleep(100);
    check('(sanity) enough tabs that the strip overflows', dragList.scrollWidth > dragList.clientWidth + 100, `${dragList.scrollWidth} vs ${dragList.clientWidth}`);
    switchTab(tabs[0].id); dragList.scrollLeft = 0; await sleep(50);
    const carried = tabs[0].title;
    x0 = grabTab(0);
    await dragTo(x0, stripRight() - 10);
    await sleep(700);
    check('holding a tab near the right edge scrolls the strip', dragList.scrollLeft > 50, String(dragList.scrollLeft));
    const midDragIndex = [...dragList.children].findIndex((c) => c.querySelector('.t').textContent === carried);
    check('...and the tab carried along has moved on past its old neighbours', midDragIndex > 0, String(midDragIndex));
    release(stripRight() - 10); await sleep(100);
    check('dropping after a scroll lands it where it was carried', tabs.findIndex((t) => t.title === carried) === midDragIndex && domTabOrder() === tabOrder() && noDragLeft(), `${tabs.findIndex((t) => t.title === carried)} vs ${midDragIndex}`);
    while (tabs.length > 1) { confirmAnswer = true; await closeTab(tabs[tabs.length - 1].id); await sleep(30); }
    // a single tab has nothing to reorder
    x0 = grabTab(0); await dragTo(x0, x0 + 200); release(x0 + 200);
    check('with one tab, dragging does nothing', tabs.length === 1 && noDragLeft());
    tiny.dialog.confirm = realConfirm6;

    for (const c of await tiny.api.call('listConnections')) await tiny.api.call('deleteConnection', { id: c.id });
    check('cleanup', (await tiny.api.call('listConnections')).length === 0);
  } catch (e) {
    check('no exception', false, String(e && e.message || e));
  }
  results.done = true;
  await save();
})();
