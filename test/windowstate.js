// Run: ~/.tinyjs/bin/tjs run test/windowstate.js  (no display or database needed)
import { restoreWindow, saveWindowIfChanged } from '../src/windowstate.js';

const SCREENS = [{ x: 0, y: 0, width: 1680, height: 1050, scale: 2 }, { x: 1680, y: 0, width: 3440, height: 1440, scale: 1 }];
const ok = (c, m) => { if (!c) throw new Error('FAIL ' + m); console.log('ok', m); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);

function fakeApp({ saved, state = {}, screens = SCREENS } = {}) {
  const mem = new Map(saved === undefined ? [] : [['window', saved]]);
  const app = {
    calls: [], mem, state,
    store: { get: async (k) => mem.get(k) ?? null, set: async (k, v) => (mem.set(k, v), true) },
    screens: async () => screens,
    window: () => ({
      setSize: (w, h) => app.calls.push(['size', w, h]),
      setPosition: (x, y) => app.calls.push(['pos', x, y]),
      getState: async () => app.state,
    }),
  };
  return app;
}
const restore = async (saved, screens) => { const a = fakeApp({ saved, screens }); await restoreWindow(a); return a.calls; };

// ---- restore ----
eq(await restore(undefined), [], 'first launch: nothing saved, nothing touched');
eq(await restore({ x: 140, y: 160, width: 900, height: 600 }), [['size', 900, 600], ['pos', 140, 160]], 'restores size and position');
eq(await restore({ x: 2920, y: 212, width: 960, height: 640 }), [['size', 960, 640], ['pos', 2920, 212]], 'restores a window on the second monitor');
eq(await restore({ x: 100, y: 100, width: 500, height: 300 }), [['size', 760, 480], ['pos', 100, 100]], 'never restores below the minimum size');
eq(await restore({ x: 2920, y: 212, width: 960, height: 640 }, [SCREENS[0]]), [['size', 960, 640]], 'monitor unplugged: size kept, position left to tinyjs');
eq(await restore({ x: 9000, y: 9000, width: 900, height: 600 }), [['size', 900, 600]], 'fully off every screen: position ignored');
eq(await restore({ x: 1600, y: 100, width: 900, height: 600 }), [['size', 900, 600], ['pos', 1600, 100]], 'straddling two screens counts as visible');
eq(await restore({ x: 1630, y: 100, width: 900, height: 600 }, [SCREENS[0]]), [['size', 900, 600]], 'only a 50px sliver visible: position ignored');
eq(await restore({ x: 1480, y: 100, width: 900, height: 600 }, [SCREENS[0]]), [['size', 900, 600], ['pos', 1480, 100]], '200px visible is enough');
eq(await restore({ x: 'a', y: null, width: 900, height: 600 }), [], 'corrupt saved value is ignored');
eq(await restore({ x: 10, y: 10, width: NaN, height: 600 }), [], 'NaN in saved value is ignored');

// ---- save ----
const fine = { x: 140, y: 160, width: 900, height: 600, outer: { width: 900, height: 628 }, fullscreen: false, minimized: false, focused: true };
let a = fakeApp({ state: fine });
eq(await saveWindowIfChanged(a), { x: 140, y: 160, width: 900, height: 600 }, 'saves only the four geometry fields');
eq(a.mem.get('window'), { x: 140, y: 160, width: 900, height: 600 }, 'written to the store');
eq(await saveWindowIfChanged(a), null, 'unchanged geometry is not rewritten');
a.state = { ...fine, x: 150 };
eq((await saveWindowIfChanged(a)).x, 150, 'a move is saved');
a.state = { ...fine, x: 150, fullscreen: true, width: 1680, height: 1050 };
eq(await saveWindowIfChanged(a), null, 'fullscreen geometry is not saved');
eq(a.mem.get('window').width, 900, 'the pre-fullscreen size survives');
a.state = { ...fine, minimized: true, x: -32000, y: -32000 };
eq(await saveWindowIfChanged(a), null, 'minimized geometry is not saved');
a.state = { ...fine, x: undefined };
eq(await saveWindowIfChanged(a), null, 'incomplete state is not saved');

// restoring then polling the same frame must not rewrite it
a = fakeApp({ saved: { x: 140, y: 160, width: 900, height: 600 }, state: fine });
await restoreWindow(a);
eq(await saveWindowIfChanged(a), null, 'restored frame is not mistaken for a user change');
a.state = { ...fine, height: 700 };
eq((await saveWindowIfChanged(a)).height, 700, 'a resize after restore is saved');
console.log('ALL PASS');
