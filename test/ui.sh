#!/bin/sh
# Self-driving UI check in the real webview. Runs a TEMP COPY of the project whose index.html also
# carries test/ui-driver.js (TINYJS_HTML pages are copied elsewhere, so relative assets like vs/ would
# not resolve). The driver writes its checks to the app store; this prints them.
# The MySQL end-to-end part of the driver runs against 127.0.0.1:33061 when something answers there (test/mysql-server.sh start);
# otherwise it records one passing "SKIPPED" check and the rest of the suite runs as usual.
set -e
cd "$(dirname "$0")/.."
# The copy gets its own app id, so its store (and keychain entries) never touch your real dev data.
ID=$(python3 -c "import json;print(json.load(open('tinyjs.json'))['id'] + '.uitest')")
STORE="$HOME/Library/Application Support/$ID/store.json"   # macOS
TMP=$(mktemp -d)
cp -R tinyjs.json icon.png src "$TMP/"
python3 - "$TMP" "$ID" <<'PY'
import sys, json
t = sys.argv[1]
cfg = json.load(open(t + '/tinyjs.json')); cfg['id'] = sys.argv[2]; json.dump(cfg, open(t + '/tinyjs.json', 'w'))
p = t + '/src/frontend/index.html'
h = open(p).read()
h = h.replace('</body>', '<script>' + open('test/ui-driver.js').read() + '</script></body>')
open(p, 'w').write(h)
PY
rm -f "$STORE"
(cd "$TMP" && timeout 150 tinyjs dev >/dev/null 2>&1 &)
for i in $(seq 1 140); do sleep 1; grep -q '"done": *true' "$STORE" 2>/dev/null && break; done
pkill -f "tinyjs" 2>/dev/null || true
rm -rf "$TMP"
rm -f "${TMPDIR:-/tmp}"/tinyarql-ui-*   # files the file-open/export checks wrote to the app temp dir
python3 - "$STORE" <<'PY'
import json, sys
try: store = json.load(open(sys.argv[1]))
except Exception: sys.exit('no store written (did the window open?)')
if 'jserr' in store: print('PAGE ERROR', store['jserr'])
if 'results' not in store: sys.exit('driver never ran a check (see PAGE ERROR above, if any)')
r = store['results']
if not r['done']:
    import time
    beat = store.get('beat')
    age = (time.time() * 1000 - beat) / 1000 if beat else None
    print('RUN DID NOT FINISH after the last check below (hung or timed out);',
          'the page is %s;' % ('FROZEN (heartbeat stopped %.0fs ago)' % age if age is not None and age > 5 else 'alive (the driver is waiting on something)'), 'last window state:', store.get('beatState'), '(a window that is "hidden" is being throttled by the OS: keep it uncovered)')
for c in r['checks']: print('PASS' if c['ok'] else 'FAIL', c['name'], c['info'] or '')
sys.exit(0 if r['done'] and all(c['ok'] for c in r['checks']) else 1)
PY
