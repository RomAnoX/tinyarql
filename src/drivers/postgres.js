// Minimal Postgres wire-protocol client (simple query protocol, text results).
// txiki.js has no node:net/pg and no MD5, so: cleartext + SCRAM-SHA-256 auth, TLS through ../tls.js.
// ponytail: no md5 auth, no bind params, no COPY; TLS always verifies the certificate (no sslmode=require without a CA).
import { startTls } from '../tls.js';
const enc = new TextEncoder();
const dec = new TextDecoder();
const subtle = crypto.subtle;
const MAX_ROWS = 1000;
// Type OIDs the UI cares about; anything else comes back as null (the page treats it as text).
const TYPE_NAMES = { 16: 'bool', 20: 'int8', 21: 'int2', 23: 'int4', 25: 'text', 114: 'json', 700: 'float4', 701: 'float8',
  1043: 'varchar', 1082: 'date', 1114: 'timestamp', 1184: 'timestamptz', 1700: 'numeric', 2950: 'uuid', 3802: 'jsonb' };

const cat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const i32 = (n) => new Uint8Array([n >>> 24, n >>> 16, n >>> 8, n]);
const cstr = (s) => cat(enc.encode(s), new Uint8Array(1));
const msg = (type, body) => cat(type ? enc.encode(type) : new Uint8Array(0), i32(body.length + 4), body);
const q = (id) => '"' + id.replace(/"/g, '""') + '"';

const hmac = async (key, data) =>
  new Uint8Array(await subtle.sign('HMAC', await subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), data));
const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function scram(password, send, readAuth) {
  const nonce = b64(crypto.getRandomValues(new Uint8Array(18)));
  const first = `n=,r=${nonce}`;
  const mech = enc.encode('SCRAM-SHA-256');
  const init = enc.encode('n,,' + first);
  send(msg('p', cat(mech, new Uint8Array(1), i32(init.length), init)));
  const serverFirst = dec.decode(await readAuth(11));
  const f = Object.fromEntries(serverFirst.split(',').map((p) => [p[0], p.slice(2)]));
  if (!f.r.startsWith(nonce)) throw new Error('SCRAM: bad server nonce');
  const key = await subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const salted = new Uint8Array(await subtle.deriveBits(
    { name: 'PBKDF2', salt: unb64(f.s), iterations: +f.i, hash: 'SHA-256' }, key, 256));
  const clientKey = await hmac(salted, enc.encode('Client Key'));
  const stored = new Uint8Array(await subtle.digest('SHA-256', clientKey));
  const withoutProof = `c=biws,r=${f.r}`;
  const authMsg = enc.encode(`${first},${serverFirst},${withoutProof}`);
  const sig = await hmac(stored, authMsg);
  const proof = clientKey.map((b, i) => b ^ sig[i]);
  send(msg('p', enc.encode(`${withoutProof},p=${b64(proof)}`)));
  const serverFinal = dec.decode(await readAuth(12));
  const expect = b64(await hmac(await hmac(salted, enc.encode('Server Key')), authMsg));
  if (serverFinal !== `v=${expect}`) throw new Error('SCRAM: server signature mismatch');
}

const SSL_REQUEST = cat(i32(8), i32(80877103));

// A connection to the server, encrypted when `tls` ({ sni, ca }) is given. Postgres starts in plaintext: send an
// SSLRequest, and the server answers one byte, 'S' (go ahead) or 'N' (no TLS here).
async function dial(host, port, tls) {
  const conn = await tjs.connect('tcp', host, port);
  const { readable, writable } = await conn.opened;
  let reader = readable.getReader(), writer = writable.getWriter();
  if (!tls) return { reader, writer, close: () => conn.close() };
  try {
    await writer.write(SSL_REQUEST);
    const { value } = await reader.read();
    if (!value || value.length !== 1) throw new Error('unexpected reply to the TLS request');  // more than one byte = injected plaintext
    if (value[0] === 69) throw new Error('This server is too old to speak TLS');  // 'E'
    if (value[0] !== 83) throw new Error('This server does not accept TLS connections');  // not 'S'
    const s = await startTls({ reader, writer, close: () => conn.close() }, tls);
    return { reader: s.readable.getReader(), writer: s.writable.getWriter(), close: s.close };
  } catch (e) { conn.close(); throw e; }
}

export async function connect({ host = '127.0.0.1', port = 5432, user, password = '', database, tls = null }) {
  const { reader, writer, close: closeSocket } = await dial(host, port, tls);
  let buf = new Uint8Array(0);
  const need = async (n) => {
    while (buf.length < n) {
      const { value, done } = await reader.read();
      if (done) throw new Error('connection closed by server');
      buf = cat(buf, value);
    }
  };
  const readMsg = async () => {
    await need(5);
    const len = new DataView(buf.buffer, buf.byteOffset).getInt32(1);
    await need(1 + len);
    const m = { type: String.fromCharCode(buf[0]), body: buf.slice(5, 1 + len) };
    buf = buf.slice(1 + len);
    return m;
  };
  const send = (u8) => { writer.write(u8).catch(() => {}); };  // ordered; a dead socket surfaces on the next read
  const errFields = (body) => {
    const f = {};
    for (let i = 0; i < body.length && body[i];) {
      const end = body.indexOf(0, i + 1);
      f[String.fromCharCode(body[i])] = dec.decode(body.subarray(i + 1, end));
      i = end + 1;
    }
    return f;
  };
  const errText = (body) => { const f = errFields(body); return f.M + (f.D ? ` (${f.D})` : ''); };
  // Reads until the next 'R' of the wanted auth code; returns its payload.
  const readAuth = async (code) => {
    for (;;) {
      const m = await readMsg();
      if (m.type === 'E') throw new Error(errText(m.body));
      if (m.type === 'R' && new DataView(m.body.buffer, m.body.byteOffset).getInt32(0) === code) return m.body.subarray(4);
    }
  };

  let pid = 0, secret = 0, running = false;
  try {
    send(msg(null, cat(i32(196608), cstr('user'), cstr(user), cstr('database'), cstr(database || user), new Uint8Array(1))));
    for (;;) {
      const m = await readMsg();
      if (m.type === 'E') throw new Error(errText(m.body));
      if (m.type === 'Z') break;
      if (m.type === 'K') {  // BackendKeyData: what a cancel request must quote to name this session
        const kv = new DataView(m.body.buffer, m.body.byteOffset);
        pid = kv.getInt32(0); secret = kv.getInt32(4);
      }
      if (m.type !== 'R') continue;
      const code = new DataView(m.body.buffer, m.body.byteOffset).getInt32(0);
      if (code === 3) send(msg('p', cstr(password)));
      else if (code === 10) await scram(password, send, readAuth);
      else if (code === 5) throw new Error('md5 password auth is not supported; use scram-sha-256');
      else if (code !== 0 && code !== 12) throw new Error('unsupported auth method ' + code);
    }
  } catch (e) {
    closeSocket();
    throw e;
  }

  let busy = Promise.resolve();
  // With a `sink`, rows are handed over in batches instead of being collected (and the 1000-row cap does not apply):
  // sink.columns(names, types) at the start of each result set (a script's later statement starts it afresh) and
  // sink.rows(batch) as they arrive. If the sink fails, the query is cancelled and the rest of the result is read and
  // thrown away, so the connection is left in step with the server; the sink's error is what gets thrown.
  const run = (sql, sink = null) => {
    const p = busy.then(async () => {
      running = true;
      try {
        send(msg('Q', cstr(sql)));
        let columns = [], types = [], rows = [], truncated = false, error = null, tag = '';
        let batch = [], sinkError = null, cancelling = null;
        const toSink = async (fn) => {
          if (sinkError) return;
          try { await fn(); } catch (e) { sinkError = e; cancelling = cancel().catch(() => {}); }
        };
        const flushBatch = async () => { const b = batch; batch = []; if (b.length) await toSink(() => sink.rows(b)); };
        for (;;) {
          const m = await readMsg();
          const dv = new DataView(m.body.buffer, m.body.byteOffset);
          if (m.type === 'T') {
            columns = [];
            types = [];
            rows = [];
            let o = 2;
            for (let i = 0; i < dv.getInt16(0); i++) {
              const end = m.body.indexOf(0, o);
              columns.push(dec.decode(m.body.subarray(o, end)));
              types.push(TYPE_NAMES[dv.getInt32(end + 1 + 6)] ?? null);  // after the name: table oid (4) + attr no (2), then type oid
              o = end + 1 + 18;
            }
            if (sink) { batch = []; await toSink(() => sink.columns(columns, types)); }
          } else if (m.type === 'D') {
            if (!sink && rows.length >= MAX_ROWS) { truncated = true; continue; }
            if (sinkError) continue;  // draining
            const row = [];
            let o = 2;
            for (let i = 0; i < dv.getInt16(0); i++) {
              const len = dv.getInt32(o);
              o += 4;
              if (len < 0) row.push(null);
              else { row.push(dec.decode(m.body.subarray(o, o + len))); o += len; }
            }
            if (sink) { batch.push(row); if (batch.length >= 256) await flushBatch(); } else rows.push(row);
          } else if (m.type === 'C') tag = dec.decode(m.body.subarray(0, m.body.length - 1));
          else if (m.type === 'E') { const f = errFields(m.body); error = Object.assign(new Error(f.M + (f.D ? ` (${f.D})` : '')), { code: f.C, cancelled: f.C === '57014' && /user request/.test(f.M) }); }
          else if (m.type === 'Z') break;
        }
        if (cancelling) await cancelling;  // the cancel must land before the next statement can start, or it would hit that one
        if (sink && !error) await flushBatch();
        if (sinkError) throw sinkError;
        if (error) throw error;
        return { columns, types, rows, truncated, tag };
      } finally { running = false; }
    });
    busy = p.catch(() => {});
    return p;
  };

  // Cancel the statement now running, by asking the server over a second connection (the protocol's CancelRequest).
  // The running query then fails with SQLSTATE 57014 on its own connection, which stays usable.
  // Returns false when nothing is running. ponytail: a cancel that lands just as a query ends can hit the next
  // statement; the window is a few milliseconds.
  async function cancel() {
    if (!running || !pid) return false;
    const c = await dial(host, port, tls);
    await c.writer.write(cat(i32(16), i32(80877102), i32(pid), i32(secret)));
    // the server closes the socket once it has read the request; wait for that so the bytes are not cut off
    await Promise.race([c.reader.read().catch(() => {}), new Promise((r) => setTimeout(r, 2000))]);
    c.close();
    return true;
  }

  return {
    cancel,
    query: (sql) => run(sql),
    stream: (sql, sink) => run(sql, sink),
    // One row per column so the editor can complete table.column; grouped back into tables here.
    tables: async () => {
      const { rows } = await run(`select c.table_schema, c.table_name, t.table_type, c.column_name
        from information_schema.columns c join information_schema.tables t using (table_schema, table_name)
        where c.table_schema not in ('pg_catalog','information_schema')
        order by c.table_schema, c.table_name, c.ordinal_position`);
      const byRef = new Map();
      for (const [s, t, type, col] of rows) {
        const ref = `${q(s)}.${q(t)}`;
        if (!byRef.has(ref)) byRef.set(ref, { name: s === 'public' ? t : `${s}.${t}`, ref, type: type === 'VIEW' ? 'view' : 'table', columns: [] });
        byRef.get(ref).columns.push(col);
      }
      return [...byRef.values()];
    },
    select: (ref, limit, offset) => run(`select * from ${ref} limit ${+limit} offset ${+offset}`),
    close: async () => {
      try { send(msg('X', new Uint8Array(0))); } catch {}
      closeSocket();
    },
  };
}
