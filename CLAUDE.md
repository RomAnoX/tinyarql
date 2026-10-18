# TinyArQL

A tiny desktop SQL client for PostgreSQL, MySQL and SQLite. About 8 MB, built on **tinyjs**: a txiki.js backend plus the operating system's own web view. It began as a clean-room rebuild of Arctype (unmaintained) and shares no code with it. Public repo: https://github.com/RomAnoX/tinyarql (MIT). Current version: see `tinyjs.json`.

Read this before changing anything. The "Decisions" section records why things are the way they are; several of them look odd until you know the constraint behind them.

## Working agreements

- **Verify, don't assume.** Almost everything here was checked against a real server or a real window: Postgres 15, MySQL 8.0.40, an sshd, the tinyjs webview. Say plainly what you did and did not verify. Never claim something works from reading code alone.
- **Every change gets tests**, in the style of the existing ones (see Testing). The suites are fast; run the relevant ones before finishing.
- **Don't touch outward-facing or hard-to-reverse things without being asked**: pushing, releases, repo settings, installing software, deleting data. Never force-push. Commits carry the assistant's `Co-Authored-By` trailer.
- **Never use the real app id in a test or experiment.** The real data lives in `~/Library/Application Support/com.example.tinyarql/`. Tests use their own ids (`...uitest`, `...persist`, `...restart`) so they cannot touch it.
- Comments say *why*, not what. A deliberate shortcut with a known ceiling is marked `// ponytail: <ceiling and upgrade path>`; grep for it before assuming a gap is an oversight.
- Keep it small. Plain JavaScript, no framework, no runtime dependencies. Reuse what exists before adding anything.

## Layout

```
tinyjs.json            name/title/id/version. title = window, menu and .app name. id owns the data folder: never change it.
icon.png               1024px, rounded square inset 100px on a transparent canvas (python3 tools/make-icon.py <img>)
src/main.js            backend: the `api` object the page calls, sessions, SSH tunnel wiring, CSV and file endpoints
src/csv.js             CSV format (RFC 4180) and the safe file writer (.part then rename)
src/tunnel.js          `ssh -L` wrapper
src/windowstate.js     saves and restores the main window's size and position
src/drivers/{postgres,mysql,sqlite}.js
src/frontend/          index.html, style.css, app.js (everything), jsonpretty.js, icons.js (generated),
                       editor.js (generated bundle), fonts/ (Geist Mono), ICONS-LICENSE.txt
tools/editor/          esbuild project: entry.js -> editor.js (CodeMirror 6 + Vim); icons.mjs -> icons.js (Lucide)
test/                  see Testing
types/                 tinyjs typings (from tinyjs, MIT)
docs/screenshots/      README images
```

`.claude/`, `.agents/` and `.remember/` are local tooling and are git-ignored. `dist/` and `.build/` are build output; delete them after building.

## Runtime constraints (tinyjs / txiki.js)

The backend is **not Node**. This shapes the whole design.

- No `require`, no Node builtins, no native npm modules. Pure-JS only, which is why the database drivers speak the wire protocols themselves.
- Streams need `getReader()` (no `for await`). `tjs.cwd` is a property. Every `tjs.*` filesystem call is async; `tjs:sqlite` is fully **synchronous** (no `get()`, `run()` returns void) and has no cursor or interrupt.
- **No `Intl` in the backend**: `toLocaleString()` adds no separators. Use an explicit formatter (`thousands()` in the MySQL driver). The webview *does* have `Intl`.
- **No TLS** for raw sockets, **no MD5** in WebCrypto. SHA-1, SHA-256, HMAC, PBKDF2 and RSA-OAEP(SHA-1) do exist.
- The page has an RPC channel to a backend with full system access, so **everything interpolated into `innerHTML` must go through `esc()`**. Never add a path that skips it.
- A window that is covered or hidden is **throttled by the OS** (timers stop, `document.visibilityState` is `hidden`). Anything driven by timers, including every UI test, needs a visible window.
- `tiny.dialog.confirm(message, { detail, ok, cancel })` takes an options object. (An early call passed the detail as a string and it was silently ignored.)
- Screen capture is blocked here (no screen-recording permission, results come back black). Screenshots are made with `tiny.win.printToPDF` plus `sips`.

## Architecture

**Backend (`src/main.js`)** exports `api` (called from the page as `tiny.api.call(name, params)`) and `init(app)`, which restores the window and starts the position poll.

`listConnections saveConnection deleteConnection testConnection connect disconnect tables query cancelQuery browse readTextFile writeTextFile exportRowsCsv exportQueryCsv`

Sessions are kept in a `Map` by connection id. `open()` creates a driver session, going through an SSH tunnel first when `sshHost` is set (Postgres and MySQL only).

**Driver contract** (every driver implements it; the backend and UI rely on it):

- `query(sql)` resolves `{ columns, types, rows, truncated, tag }`. Rows are arrays of strings, `null` for NULL. Results are capped at **1000 rows**; `truncated` says so and the rest is read and discarded so the connection stays in step.
- `tables()` resolves `[{ name, ref, type: 'table'|'view', columns }]`. `ref` is the safely quoted identifier the UI sends back to `select()`.
- `select(ref, limit, offset)`, `close()`.
- `stream(sql, sink)` (Postgres, MySQL, SQLite): `sink.columns(names, types)` opens each result set (a script's later statement starts it afresh) and `sink.rows(batch)` delivers rows, with no cap. Used by CSV export.
- `cancel()` (Postgres, MySQL only), resolves `true` if something was running. A stopped statement fails with an error carrying **`cancelled: true`**; `main.js` turns that into `{ cancelled: true }` instead of an error. Never match database error codes in `main.js`.
- `via` (MySQL) names the login path used; tests rely on it.

**Frontend** is classic scripts sharing one global scope, loaded in this order: `icons.js`, `editor.js`, `jsonpretty.js`, `app.js`. **The test driver reaches into those globals** (`tabs`, `editor`, `renderGrid`, `settings`, `queries`, ...). Do not convert these to ES modules or wrap `app.js` in a closure without porting the driver.

Main state in `app.js`: `conns`, `active` (the current tab's connection), `tables` (present = connected), `tabs`/`currentId`, `queries`, `running`, `result`/`detail`/`view` (what the grid shows). Rendering is string-based and rebuilds lists wholesale, so focus is captured and restored in `renderConns`, `renderTabs` and `renderSaved`.

**Persistence (`tiny.store`) keys:** `connections` (no secrets), `settings` `{vim, theme}`, `layout` `{editorHeight, sidebarWidth, detailWidth}`, `tabs` `{current, list:[{id,title,sql,connId,savedId,origin}]}`, `queries` `[{id,name,sql,connId,updatedAt}]`, `window` `{x,y,width,height}` (written by the backend). Passwords go in the keychain via `app.secrets` under `conn:<id>`; never in the store. Results are never persisted.

## Decisions (and why)

### Databases and drivers
- **Wire protocols in pure JS**, because the runtime has no libraries and no native modules. Postgres: simple-query protocol, text results, cleartext and SCRAM-SHA-256 (no MD5: unavailable). MySQL: text protocol `COM_QUERY`, `mysql_native_password` and `caching_sha2_password`, including the full RSA login over plaintext (the first login of any new MySQL 8 account needs it), multi-statements enabled, `LOCAL INFILE` never enabled.
- **No TLS** (yet). A server that needs it is refused. This is the app's biggest limitation. The Postgres error is `no pg_hba.conf entry ... no encryption`. See Backlog.
- **Cancellation uses a second connection**: Postgres `CancelRequest`, MySQL `KILL QUERY <thread id>`. It goes through an SSH tunnel too. SQLite cannot be cancelled (synchronous driver would block the very cancel call), so the UI shows a disabled "Running…" there.
- **A cancel must land before the connection is released.** When a sink fails, the driver cancels, drains the rest of the result, and *awaits that cancel* before finishing. Without the await, the late cancel killed the user's next statement. Same in both drivers.
- **SQLite**: `prepare()` runs only the first statement and silently drops the rest, so `splitStatements()` (aware of strings and comments) runs them in order. Column names come from the first row only (a zero-row result has none; `select()` falls back to `table_info`).
- MySQL binary columns show as `0x…` hex, previewed to 2048 bytes in the grid and written in full to CSV. A killed statement that is only `SLEEP()` returns normally in MySQL; tests use a heavy cross join instead.
- Greeting timeout (10 s) on MySQL so a non-MySQL port (e.g. Postgres) fails with a clear message instead of hanging.

### SSH tunnels
- Use the **system `ssh -L`** (no ssh library exists here). `BatchMode`, `ExitOnForwardFailure`, `StrictHostKeyChecking=accept-new`, key or agent auth only (no password or passphrase prompts). A random local port is chosen and skipped if something already listens. Host/user values starting with `-` or containing spaces are rejected before spawning (option injection). A tunnel adds no TLS to the database leg; it only helps when the server accepts plain connections from the tunnel's far end (for example `127.0.0.1` on the DB host).

### Tabs, saved queries, files
- **Each tab owns SQL, results, undo history and a connection.** Switching tabs switches `active`, so a query can never silently run on the wrong database. The editor state is cached per tab (`editor.getState/setState`) so undo cannot leak between tabs. A result that finishes in a background tab is stored there, not painted over the visible one. One query runs at a time globally.
- Default names are **"Query N" with the lowest free N** (closing frees the number; no counter is stored). **The last tab cannot be closed** (no × button; every other route is a no-op).
- Tabs persist and restore. A restored tab starts offline: **Run connects first**, then runs.
- **Reordering** uses pointer events, not HTML5 drag and drop (testable, no clash with the window's file-drop handler). Live reorder, auto-scroll at the edges, Esc cancels, the picked-up tab becomes selected, the drop slot is decided from the pointer (not the clamped position), redraws are held while dragging. Keyboard: Alt+←/→.
- **Saved queries** are a named library in the store. Names are unique (case-insensitive; replacing asks first). A search box matches every word against name or SQL. Open/export `.sql`: opened files are normalized to `\n`; a tab that came from or went to a file stores `origin {path, hash}` and counts as "unsaved" only while its text differs (a hash, not a copy). Files are text only, up to 5 MB.
- Closing a tab with unsaved text asks first. Deleting a connection or saved query asks first, names the item, and says what happens.

### Results
- **The grid holds at most 1000 rows** (browse pages are 100). Because of that, **CSV export asks** when there may be more: export what is shown, or re-run the query and stream every row to disk. The re-run uses the SQL and connection that produced the snapshot (not the editor's current text). Exports write `<name>.part` and rename on success, so a failure or stop never destroys an existing file. NULL is an empty field and `""` is an empty string. No spreadsheet-formula escaping and no BOM: values stay exact (documented in `src/csv.js`).
- Typed columns: type shown under the name, numbers right-aligned (Postgres and MySQL names; SQLite sniffs numbers from values), NULL is a hatched empty cell.
- **Cell detail panel** with Tree, Json and Raw. The Json view uses its own formatter (`jsonpretty.js`) over the original text: `JSON.stringify` would round integers past 2^53 and reorder integer-like keys. Raw is exact. Copy copies the indented text in Json view, the exact value otherwise. The last chosen view is remembered per session. Past 200k characters the Json view drops colouring.

### Design system
- **Colour carries meaning only**: amber `#ffb454` = actions, selection and focus (darkens to `#b36200` for lines and text on light); the three environment colours (local, staging, production) = where you are, shown as a 3px window edge, a tag and a tab border; red = failure and destructive actions; green `--ok` = a live connection. Syntax colours stay cool and muted so amber keeps its meaning.
- Dark by default, light, or follow the system. **Every colour is a CSS variable** (`style.css`), and the CodeMirror theme reads the same variables, so a theme switch needs no rebuild. Tests measure contrast for 24 colour pairs in both themes (4.5:1 text, 3:1 lines).
- Geist Mono (bundled, shared by editor, grid and panels); UI uses the system font. Lucide icons inline via `icon(name, size)`. State is never colour alone (connected and offline plugs differ in shape; the hollow/filled and spinner states have labels or `aria-busy`).
- Avoid generic tells: no all-caps labels, no middle-dot separators, no "label above everything". Visible focus rings, targets at least 24px, motion respects reduced-motion, every icon-only button has an `aria-label` (tested).
- Panels (editor height, sidebar, detail) are resizable by pointer and keyboard (arrows, Home/End, double-click resets), clamp to leave room, and re-check each other's limits whenever any moves.
- **Shortcuts**: ⌘↵ run (selection or all), ⌘. stop, ⌘T new tab, ⌘S save, ⌘⇧S save a copy, ⌘O open files, ⌘E export SQL, ⌘⇧E export CSV, ⌘, settings, Ctrl+Tab / Ctrl+⇧+Tab cycle, Alt+←/→ move a tab. With Vim on, only ⌘ (not Ctrl) triggers ⌘O/⌘E/⌘⇧E, because Ctrl+O and Ctrl+E are Vim keys. `:w` in Vim runs the query.

### Window
- tinyjs does **not** restore the window itself. `windowstate.js` polls the geometry once a second (no move/resize event exists), skips fullscreen and minimized, and restores at start. A saved position is used only if at least 200×120 px would be on a connected screen; sizes below 760×480 are raised.

### Release
- Ad-hoc signed, **not notarized** (needs an Apple Developer ID), so the first launch needs *Open Anyway*. macOS 15 or later (a tinyjs floor). The build is universal (Intel and Apple Silicon) but was built on an Intel Mac, so **the arm64 half has never run on real hardware**.

## Testing

All under `test/`. Each file's header lists what it needs. Nothing is installed system-wide; servers are throwaway and live in a scratch folder.

| Command | Covers | Needs |
| --- | --- | --- |
| `~/.tinyjs/bin/tjs run test/csv.js` | CSV format, writer, a round-trip property test | nothing |
| `~/.tinyjs/bin/tjs run test/windowstate.js` | restore and save rules | nothing |
| `~/.tinyjs/bin/tjs run test/drivers.js` | the three drivers, against real servers | Postgres 54329, MySQL 33061 (`test/postgres-server.sh`, `test/mysql-server.sh`) |
| `~/.tinyjs/bin/tjs run test/main.js` | the backend API end to end, CSV, files, cancel | same |
| `SSH_TEST_KEY=... ~/.tinyjs/bin/tjs run test/tunnel.js` | tunnels, cancel through a tunnel | same + sshd 22222 |
| `test/ui.sh` | the whole UI in a real window (several hundred checks) | a visible display; MySQL optional |
| `test/persist.sh` | window geometry across real quits | display |
| `test/restart.sh` | tabs, saved queries, order across real quits, Run auto-connect | display |

Throwaway servers:
- **MySQL**: `test/mysql-server.sh start|stop|status` downloads MySQL 8.0.40 once into `$TMPDIR/tinyarql-mysql` and creates users (`tester`/`secret` caching_sha2, `native`/`secret`, `nopass`) and the `testdb`/`otherdb` data the tests expect.
- **Postgres**: `test/postgres-server.sh start|stop|status` rebuilds a throwaway cluster on 127.0.0.1:54329 (user `tester`, password `secret`, SCRAM auth) with `people(id serial, name, note)` (rows `ada`/`x` and `bob`/NULL) and a view `v`. It downloads nothing: it uses a PostgreSQL you already have (Homebrew `postgresql@NN`, Postgres.app, or `PG_BIN=...`). Data lives in `$TMPDIR/tinyarql-postgres`. It listens on TCP only (`unix_socket_directories=''`), because socket paths under `$TMPDIR` are too long.
- **sshd**: a user-level `sshd -f` on 127.0.0.1:22222 with a generated key, `UsePAM no`, `PasswordAuthentication no`, `StrictModes no`, plus an `ssh` wrapper first on `PATH` that adds `-o UserKnownHostsFile=<scratch>` so `~/.ssh/known_hosts` is never written.

UI test rules:
- `ui.sh` runs a **temp copy of the project** with the driver appended and its own app id. The driver saves after every check and records a heartbeat, so a hang reports where it stopped and whether the page was frozen. It sets the window always-on-top because a covered window is throttled.
- Dialogs (`tiny.dialog.*`) and, where needed, `tiny.api.call` are stubbed in tests; real native dialogs would block the page.
- Tests assert the *reason* a check passes: add a negative control when a check could pass for the wrong reason (the PostgreSQL-dialect control for the MySQL dialect check is an example).
- Test-local variable names collide in the shared driver scope; prefix them.

## Build and release

```sh
tinyjs dev                          # run with hot reload
tinyjs build --universal --dmg      # dist/TinyArQL.app and dist/tinyarql-<version>.dmg
cd tools/editor && npm install && npm run build   # regenerate src/frontend/editor.js
cd tools/editor && npm run icons                  # regenerate src/frontend/icons.js
```

Release checklist (what v0.1.0 followed): bump `version` in `tinyjs.json`; run the suites; build the universal DMG; `hdiutil verify`, mount it, and check architectures and `codesign --verify`; copy to `TinyArQL-<version>-macOS-universal.dmg` and write `SHA256SUMS.txt`; make sure the DMG was built from exactly the committed files; push `main`; `gh release create v<version>` with the notes (install steps, checksum, honest limitations); then download the published asset anonymously and verify the checksum. Delete `dist/` and `.build/` afterwards.

## Known limitations and backlog

- **TLS** to databases (Postgres `hostssl`, RDS/Azure, MySQL `require_secure_transport`). Needs a JS implementation of the protocol over WebCrypto; a first version could match `sslmode=require` (encrypt, no certificate check), with CA verification later. Meanwhile the connection form's hint about SSH tunnels is misleading when a server demands encryption: fix the wording and turn the `no encryption` / secure-transport errors into a plain explanation.
- Notarization; real Apple Silicon testing; Windows and Linux are untried.
- MySQL tested on 8.0 only (MariaDB, 5.7 untested); only the two logins above.
- SQLite: cannot be stopped; a zero-row result has no header.
- Ideas not built: exporting the whole saved-query library to a folder of `.sql` files, opening `.sql` files from Finder (`fileExtensions` in `tinyjs.json` plus `onOpenFiles`), a Cancel button on a connecting row (an SSH tunnel can hold a row busy for ~15 s), and query history.

## Lessons (things that went wrong once)

- A cancel that fires and is not awaited can kill the next statement. Await it before releasing the connection.
- Tests that used the real app id wiped real data. Always give tests their own id.
- Bulk regex renames corrupt string literals and SQL aliases; check strings after any mechanical rename.
- In zsh, an unmatched glob aborts the whole command (`rm -rf a b *.x` did nothing). Use explicit paths.
- A hidden window stalls timer-driven tests; keep it on top.
- `JSON.stringify(JSON.parse(x))` is not a safe pretty-printer for database values.
- `toLocaleString()` and `Intl` do not exist in the backend runtime.
- The tinyjs `title` (not `name`) names the app; the `id` must never change or users lose their saved data.
