# Third-party notices

TinyArQL is released under the [MIT license](LICENSE). It includes, or is built on, the open-source components below. Each keeps its own license and copyright; follow the links for the full texts.

## Inside the app

| Component | What it is used for | License |
| --- | --- | --- |
| [tinyjs](https://tinyjs.app) | The app shell: native window and web view, native dialogs, keychain access. Its launcher is part of every built app, and `types/tiny.d.ts` comes from it. | MIT |
| [txiki.js](https://github.com/saghul/txiki.js) | The JavaScript runtime that runs the backend (bundled inside tinyjs). | MIT |
| [CodeMirror 6](https://codemirror.net) (`codemirror`, `@codemirror/*`, `@lezer/*`, `@marijn/find-cluster-break`, `crelt`, `style-mod`, `w3c-keyname`) | The SQL editor. Bundled into `src/frontend/editor.js`. | MIT |
| [@replit/codemirror-vim](https://github.com/replit/codemirror-vim) | The optional Vim keybindings. Bundled into `src/frontend/editor.js`. | MIT |
| [Lucide](https://lucide.dev) | The icons, generated into `src/frontend/icons.js`. The license text is in `src/frontend/ICONS-LICENSE.txt`. | ISC |
| [Geist Mono](https://vercel.com/font) | The monospaced typeface. The license text is in `src/frontend/fonts/GEIST-OFL.txt`. | SIL Open Font License 1.1 |

## Only used to build

| Component | What it is used for | License |
| --- | --- | --- |
| [esbuild](https://esbuild.github.io) | Bundles the editor (`tools/editor`). | MIT |
| [Pillow](https://python-pillow.org) | Used by `tools/make-icon.py` to shape the app icon. | MIT-CMU (HPND) |

The exact versions of the editor's dependencies are pinned in `tools/editor/package-lock.json`.

## Not included

TinyArQL's database drivers (PostgreSQL, MySQL, SQLite access) are original code written against each database's published wire protocol. TinyArQL was inspired by Arctype, which is no longer maintained, but contains none of its code, assets or branding.
