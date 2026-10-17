#!/bin/sh
# End-to-end check that the window's size and position survive a real quit and relaunch.
# Launches a temp copy of the app (own app id, own store) three times:
#   1. moves/resizes the window and waits for the backend to save it, then quits
#   2. relaunches: the window must come back exactly where it was left
#   3. relaunches after the saved position is edited to somewhere off every screen:
#      the size must come back, the position must land on a real screen
set -e
cd "$(dirname "$0")/.."
ID=$(python3 -c "import json;print(json.load(open('tinyjs.json'))['id'] + '.persist')")
DIR="$HOME/Library/Application Support/$ID"   # macOS
STORE="$DIR/store.json"
TMP=$(mktemp -d)
cp -R tinyjs.json icon.png src "$TMP/"
python3 - "$TMP" "$ID" <<'PY'
import sys, json
t = sys.argv[1]
cfg = json.load(open(t + '/tinyjs.json')); cfg['id'] = sys.argv[2]; json.dump(cfg, open(t + '/tinyjs.json', 'w'))
p = t + '/src/frontend/index.html'
h = open(p).read()
driver = """
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  while (typeof tiny === 'undefined') await sleep(100);
  tiny.win.setAlwaysOnTop(true);   // a covered window is throttled by the OS, and this driver runs on timers
  await sleep(2000);                                  // let the backend restore the saved frame
  const mode = (await tiny.store.get('mode')) || 'set';
  const pick = (s) => ({ x: s.x, y: s.y, width: s.width, height: s.height });
  if (mode === 'set') {
    tiny.win.setSize(900, 600); tiny.win.setPosition(140, 160);
    await sleep(2600);                                // the backend polls once a second
  }
  await tiny.store.set('seen_' + mode, pick(await tiny.win.getState()));
  await sleep(300);
  tiny.quit();
})();
"""
open(p, 'w').write(h.replace('</body>', '<script>' + driver + '</script></body>'))
PY
rm -rf "$DIR"
launch() { (cd "$TMP" && timeout 45 tinyjs dev >/dev/null 2>&1) || true; sleep 1; }
edit() { python3 - "$STORE" "$1" <<'PY'
import sys, json
p, patch = sys.argv[1], json.loads(sys.argv[2])
d = json.load(open(p)); d.update(patch); json.dump(d, open(p, 'w'))
PY
}
launch                                                # 1
edit '{"mode": "check"}'
launch                                                # 2
python3 - "$STORE" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
want = {'x': 140, 'y': 160, 'width': 900, 'height': 600}
ok = True
def report(name, cond, info):
    global ok
    ok = ok and cond
    print('PASS' if cond else 'FAIL', name, '' if cond else info)
report('backend saved the moved window', d.get('window') == want, d.get('window'))
report('relaunch restores size and position exactly', d.get('seen_check') == want, d.get('seen_check'))
json.dump({**d, 'window': {'x': 99999, 'y': 99999, 'width': 1000, 'height': 700}, 'mode': 'offscreen'}, open(sys.argv[1], 'w'))
sys.exit(0 if ok else 1)
PY
launch                                                # 3
python3 - "$STORE" <<'PY'
import json, sys
d = json.load(open(sys.argv[1])).get('seen_offscreen') or {}
ok = d.get('width') == 1000 and d.get('height') == 700 and d.get('x', 99999) < 20000 and d.get('y', 99999) < 20000
print('PASS' if ok else 'FAIL', 'off-screen position is ignored, size is kept', d)
sys.exit(0 if ok else 1)
PY
rc=$?
rm -rf "$TMP" "$DIR"
exit $rc
