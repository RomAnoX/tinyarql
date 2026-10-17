#!/bin/sh
# End-to-end check that tabs and saved queries survive a real quit and relaunch, and that a restored tab
# (which starts offline) connects itself and runs. Two launches of a temp copy of the app (own app id and store):
#   1. creates a connection to a real SQLite file, three tabs (one saved as a query, two unsaved, one dragged to the front), then quits
#   2. relaunches, records what was restored, then clicks Run on the restored tab
set -e
cd "$(dirname "$0")/.."
ID=$(python3 -c "import json;print(json.load(open('tinyjs.json'))['id'] + '.restart')")
DIR="$HOME/Library/Application Support/$ID"   # macOS
STORE="$DIR/store.json"
TMP=$(mktemp -d)
DB="$TMP/data.sqlite"
sqlite3 "$DB" "create table t(id integer primary key, name text); insert into t(name) values ('ada'),('bob'),('cy');"
cp -R tinyjs.json icon.png src "$TMP/"
python3 - "$TMP" "$ID" "$DB" <<'PY'
import sys, json
t, id_, db = sys.argv[1], sys.argv[2], sys.argv[3]
cfg = json.load(open(t + '/tinyjs.json')); cfg['id'] = id_; json.dump(cfg, open(t + '/tinyjs.json', 'w'))
p = t + '/src/frontend/index.html'
h = open(p).read()
driver = """
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn) => { for (let i = 0; i < 100; i++) { if (fn()) return; await sleep(100); } };
  while (typeof tiny === 'undefined') await sleep(100);
  tiny.win.setAlwaysOnTop(true);   // a covered window is throttled by the OS, and this driver runs on timers
  await until(() => typeof tabs !== 'undefined' && tabs.length && currentTab());
  const mode = (await tiny.store.get('mode')) || 'write';
  if (mode === 'write') {
    const c = await tiny.api.call('saveConnection', { conn: { name: 'restart-db', type: 'sqlite', path: %s, env: 'staging' }, password: null });
    await load();
    setActive(c.id);
    editor.setValue('select 1 as one');                       // tab 1: scratch, unsaved
    newTab(); editor.setValue('select * from t order by id'); // tab 2: saved below
    tiny.dialog.prompt = async () => 'Rows in t';
    await saveTab();
    newTab(); editor.setValue('select 3');                    // tab 3: scratch, unsaved
    moveTab(tabs[2].id, 0);                                   // drag the last tab to the front
    switchTab(tabs.find((t) => t.savedId).id);                // and leave the saved one selected
    await sleep(1500);                                        // the debounced write (nothing here flushes it by hand)
  } else {
    await sleep(1200);
    const seen = {
      titles: tabs.map((t) => t.title), sqls: tabs.map((t) => t.sql),
      current: tabs.findIndex((t) => t.id === currentId), editor: editor.getValue(),
      dirty: [...document.querySelectorAll('#tablist .tab')].map((t) => !!t.querySelector('.dirty')),
      saved: queries.map((q) => q.name), selSaved: document.querySelector('#saved .sq.sel .name')?.textContent || null,
      where: document.getElementById('where').textContent, bar: !document.getElementById('envBar').hidden,
      empty: !document.querySelector('#grid table'), offline: !tables[active],
    };
    document.getElementById('run').click();                    // the restored tab starts offline: Run must connect first
    await until(() => document.querySelector('#grid table') || document.querySelector('#grid .error'));
    seen.rows = [...document.querySelectorAll('#grid tbody tr')].map((r) => r.textContent);
    seen.error = document.querySelector('#grid .error')?.textContent || null;
    await tiny.store.set('seen_restart', seen);
  }
  await sleep(300);
  tiny.quit();
})();
""" % json.dumps(db)
open(p, 'w').write(h.replace('</body>', '<script>' + driver + '</script></body>'))
PY
rm -rf "$DIR"
launch() { (cd "$TMP" && timeout 60 tinyjs dev >/dev/null 2>&1) || true; sleep 1; }
launch
python3 - "$STORE" <<'PY'
import json, sys
d = json.load(open(sys.argv[1])); d['mode'] = 'check'; json.dump(d, open(sys.argv[1], 'w'))
PY
launch
python3 - "$STORE" <<'PY'
import json, sys
d = json.load(open(sys.argv[1])).get('seen_restart')
if not d: sys.exit('FAIL the second launch recorded nothing')
ok = True
def report(name, cond, info=''):
    global ok
    ok = ok and cond
    print('PASS' if cond else 'FAIL', name, '' if cond else info)
report('all three tabs come back with their titles', len(d['titles']) == 3 and d['titles'][2] == 'Rows in t', d['titles'])
report('in the order they were dragged into, with their SQL', d['sqls'] == ['select 3', 'select 1 as one', 'select * from t order by id'], d['sqls'])
report('the selected tab is the one that was selected', d['current'] == 2 and d['editor'] == 'select * from t order by id', (d['current'], d['editor']))
report('unsaved tabs are still marked unsaved; the saved one is not', d['dirty'] == [True, True, False], d['dirty'])
report('the saved query is in the library and linked to its tab', d['saved'] == ['Rows in t'] and d['selSaved'] == 'Rows in t', (d['saved'], d['selSaved']))
report('the tab is still bound to its connection and environment', 'restart-db' in d['where'] and 'staging' in d['where'] and d['bar'], d['where'])
report('results are not restored, and the connection starts offline', d['empty'] and d['offline'], (d['empty'], d['offline']))
report('Run connects first, then runs the restored query against the real file', d['rows'] == ['1ada', '2bob', '3cy'], (d['rows'], d['error']))
sys.exit(0 if ok else 1)
PY
rc=$?
rm -rf "$TMP" "$DIR"
exit $rc
