// TinyArQL backend: saved connections + database sessions. The page only ever talks to `api`.
import { connect as connectPostgres } from './drivers/postgres.js';
import { connect as connectMysql } from './drivers/mysql.js';
import { connect as connectSqlite } from './drivers/sqlite.js';
import { openTunnel } from './tunnel.js';
import { restoreWindow, trackWindow } from './windowstate.js';
import { createCsvWriter } from './csv.js';
import { readCa } from './tls.js';

const drivers = {
  postgres: (c, password, tls) => connectPostgres({ host: c.host, port: +c.port || 5432, user: c.user, password, database: c.database, tls }),
  mysql: (c, password, tls) => connectMysql({ host: c.host, port: +c.port || 3306, user: c.user, password, database: c.database, tls }),
  sqlite: (c) => connectSqlite({ path: c.path }),
};

const NETWORK_TYPES = ['postgres', 'mysql'];  // the ones that can go through an SSH tunnel
const DEFAULT_PORTS = { postgres: 5432, mysql: 3306 };
const sessions = new Map(); // connection id -> driver handle
let app;

// Servers that insist on encryption refuse us in their own words; say what to turn on.
const TLS_REFUSED = /no encryption|insecure transport|require_secure_transport/i;
const explainTls = (e) => (TLS_REFUSED.test(String(e.message)) ? new Error(e.message + '. This server requires an encrypted connection: turn on "Use TLS" in the connection settings.') : e);

const open = async (c, password) => {
  const driver = drivers[c.type];
  if (!driver) throw new Error('unsupported database type: ' + c.type);
  // The certificate must name the host the user typed, even when the socket goes through an SSH tunnel to 127.0.0.1.
  const tls = NETWORK_TYPES.includes(c.type) && c.tls ? { sni: c.host || '127.0.0.1', ca: await readCa(c.tlsCa) } : null;
  try { return await dial(c, password, tls, driver); } catch (e) { throw tls ? e : explainTls(e); }
};
const dial = async (c, password, tls, driver) => {
  if (!NETWORK_TYPES.includes(c.type) || !c.sshHost) return driver(c, password, tls);
  // Dial the database through an `ssh -L` forward; the tunnel lives and dies with the session.
  const tunnel = await openTunnel({
    sshHost: c.sshHost, sshPort: c.sshPort || 22, sshUser: c.sshUser, keyPath: c.sshKey,
    host: c.host || '127.0.0.1', port: +c.port || DEFAULT_PORTS[c.type],
  });
  try {
    const s = await driver({ ...c, host: '127.0.0.1', port: tunnel.port }, password, tls);
    return { ...s, close: async () => { await s.close(); tunnel.close(); } };
  } catch (e) {
    tunnel.close();
    throw e;
  }
};
const session = (id) => {
  const s = sessions.get(id);
  if (!s) throw new Error('not connected');
  return s;
};
const saved = async () => (await app.store.get('connections')) || [];

// ---- .sql files ----
const MAX_FILE = 5 * 1024 * 1024;
const FS_MESSAGES = { ENOENT: 'File not found', EISDIR: 'That is a folder, not a file', EACCES: 'Permission denied', EPERM: 'Permission denied', ENOSPC: 'The disk is full', ENOTDIR: 'Part of that path is not a folder' };
// tjs errors read "ENOENT: no such file or directory"; say what happened in plain words.
const fsError = (e, fallback, overrides = {}) => {
  const code = e.code || String(e.message).split(':')[0];
  return new Error(overrides[code] || FS_MESSAGES[code] || `${fallback}: ${e.message}`);
};

const isFullPath = (p) => typeof p === 'string' && /^([/\\]|[A-Za-z]:[/\\])/.test(p);
const csvWriteError = (e) => (/^(ENOENT|EACCES|EPERM|ENOSPC|EISDIR|ENOTDIR)/.test(String(e.message)) ? fsError(e, 'Could not save the file', { ENOENT: 'That folder does not exist' }) : e);

export const api = {
  async listConnections() {
    return saved();
  },

  // Passwords live in the OS keychain, never in the store.
  async saveConnection({ conn, password }) {
    const c = { ...conn, id: conn.id || crypto.randomUUID() };
    const list = (await saved()).filter((x) => x.id !== c.id);
    await app.store.set('connections', [...list, c]);
    if (password) await app.secrets.set('conn:' + c.id, password);
    return c;
  },

  async deleteConnection({ id }) {
    await api.disconnect({ id });
    await app.store.set('connections', (await saved()).filter((x) => x.id !== id));
    await app.secrets.delete('conn:' + id);
  },

  async testConnection({ conn, password }) {
    const s = await open(conn, password);
    await s.close();
    return true;
  },

  async connect({ id }) {
    const c = (await saved()).find((x) => x.id === id);
    if (!c) throw new Error('unknown connection');
    await api.disconnect({ id });
    sessions.set(id, await open(c, (await app.secrets.get('conn:' + id)) || ''));
    return session(id).tables();
  },

  async disconnect({ id }) {
    const s = sessions.get(id);
    sessions.delete(id);
    if (s) await s.close();
  },

  async tables({ id }) {
    return session(id).tables();
  },

  async query({ id, sql }) {
    const t = Date.now();
    try {
      const r = await session(id).query(sql);
      return { ...r, ms: Date.now() - t };
    } catch (e) {
      // Returned, not thrown: a stopped query is not a failure, and errors lose their code crossing the bridge.
      if (e.cancelled) return { cancelled: true, ms: Date.now() - t };  // drivers flag a statement the user stopped
      throw e;
    }
  },

  // Stops the statement running on this connection. SQLite can't be stopped (its driver is synchronous and
  // would block this very call), so only Postgres and MySQL sessions offer cancel().
  async cancelQuery({ id }) {
    const s = session(id);
    return { cancelled: s.cancel ? await s.cancel() : false };
  },

  // Opening a .sql file: text only, up to 5 MB. Line endings come back as stored; the editor normalizes them to \n.
  async readTextFile({ path }) {
    if (typeof path !== 'string' || !path) throw new Error('No file given');
    let st;
    try { st = await tjs.stat(path); } catch (e) { throw fsError(e, 'Could not read the file'); }
    if (st.isDirectory) throw new Error(FS_MESSAGES.EISDIR);
    if (st.size > MAX_FILE) throw new Error('File is larger than 5 MB');
    let bytes;
    try { bytes = await tjs.readFile(path); } catch (e) { throw fsError(e, 'Could not read the file'); }
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Error('Not a text file: it is not valid UTF-8'); }
    if (text.includes('\0')) throw new Error('Not a text file: it contains binary data');
    return { text: text.replace(/^\uFEFF/, ''), bytes: bytes.length };  // a byte-order mark is not part of the SQL
  },

  // Exporting: the page only ever passes a path the user chose in the native save dialog.
  async writeTextFile({ path, text }) {
    if (typeof path !== 'string' || !/^([/\\]|[A-Za-z]:[/\\])/.test(path)) throw new Error('Choose a full file path');
    if (typeof text !== 'string') throw new Error('Nothing to write');
    try { await tjs.writeFile(path, text); } catch (e) { throw fsError(e, 'Could not save the file', { ENOENT: 'That folder does not exist' }); }
    return { bytes: new TextEncoder().encode(text).length };
  },

  // CSV of rows the page already holds (what the grid shows). Written to <path>.part and renamed into place when complete.
  async exportRowsCsv({ path, columns, rows }) {
    if (!isFullPath(path)) throw new Error('Choose a full file path');
    if (!Array.isArray(columns) || !columns.length || !Array.isArray(rows)) throw new Error('Nothing to export');
    const writer = createCsvWriter(path);
    try { await writer.start(columns); await writer.write(rows); await writer.finish(); }
    catch (e) { await writer.abort(); throw csvWriteError(e); }
    return { rows: rows.length };
  },

  // CSV of a query's whole result: runs it again and streams every row to disk, with no row cap and without holding the
  // result in memory. Stopping it (cancelQuery) removes the partial file and resolves { cancelled: true }.
  async exportQueryCsv({ id, sql, path }) {
    if (!isFullPath(path)) throw new Error('Choose a full file path');
    const s = session(id);
    if (!s.stream) throw new Error('This connection cannot stream results');
    const writer = createCsvWriter(path);
    let count = 0, lastPush = 0;
    const sink = {
      async columns(names) { count = 0; await writer.start(names); },  // a script's later statement starts the file afresh
      async rows(batch) {
        await writer.write(batch);
        count += batch.length;
        if (Date.now() - lastPush > 250) { lastPush = Date.now(); app.push?.('exportProgress', { id, rows: count }); }
      },
    };
    try {
      await s.stream(sql, sink);
      if (!writer.started) throw new Error('That statement did not return any rows to export');
      await writer.finish();
      return { rows: count };
    } catch (e) {
      await writer.abort();
      if (e.cancelled) return { cancelled: true, rows: count };
      throw csvWriteError(e);
    }
  },

  async browse({ id, ref, page = 0, pageSize = 100 }) {
    const t = Date.now();
    const r = await session(id).select(ref, pageSize, page * pageSize);
    return { ...r, ms: Date.now() - t };
  },
};

export async function init(a) {
  app = a;
  await restoreWindow(a).catch(() => {});  // before tracking starts, so the restored frame isn't mistaken for a user change
  trackWindow(a);
}
