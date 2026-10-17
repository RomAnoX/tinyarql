// Remembers the main window's size and position between launches (tinyjs doesn't do this itself).
// Saved under the store key 'window' as { x, y, width, height } in the units getState/setSize/setPosition use.
const MIN_W = 760, MIN_H = 480;  // never restore a window smaller than the layout can use
const VISIBLE_W = 200, VISIBLE_H = 120;  // how much of the window must sit on a connected screen

const onScreen = (r, screens) => screens.some((s) =>
  Math.min(r.x + r.width, s.x + s.width) - Math.max(r.x, s.x) >= Math.min(VISIBLE_W, r.width) &&
  Math.min(r.y + r.height, s.y + s.height) - Math.max(r.y, s.y) >= Math.min(VISIBLE_H, r.height));

const geometry = (st) => ({ x: st.x, y: st.y, width: st.width, height: st.height });
const same = (a, b) => a && b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

const lastSaved = new WeakMap();  // app -> geometry last written or restored

export async function restoreWindow(app) {
  const saved = await app.store.get('window');
  if (!saved || ![saved.x, saved.y, saved.width, saved.height].every(Number.isFinite)) return;
  const r = { ...saved, width: Math.max(MIN_W, saved.width), height: Math.max(MIN_H, saved.height) };
  const win = app.window('main');
  win.setSize(r.width, r.height);
  // A monitor that was unplugged since last time would strand the window; then keep tinyjs' default spot.
  if (onScreen(r, await app.screens())) win.setPosition(r.x, r.y);
  lastSaved.set(app, geometry(saved));
}

// One poll: save the geometry if it changed. Fullscreen and minimized windows report geometry that isn't the
// user's chosen one, so they are skipped. Returns the saved geometry, or null when nothing was written.
export async function saveWindowIfChanged(app) {
  const st = await app.window('main').getState();
  if (!st || st.fullscreen || st.minimized) return null;
  const g = geometry(st);
  if (!Object.values(g).every(Number.isFinite) || same(g, lastSaved.get(app))) return null;
  lastSaved.set(app, g);
  await app.store.set('window', g);
  return g;
}

// ponytail: polling, because the launcher reports no move/resize event; a quit within `ms` of the last drag loses it.
export function trackWindow(app, ms = 1000) {
  setInterval(() => { saveWindowIfChanged(app).catch(() => {}); }, ms);
}
