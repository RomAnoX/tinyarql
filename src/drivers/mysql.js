// Minimal MySQL wire-protocol client (text protocol, COM_QUERY). txiki.js has no MySQL library, so: mysql_native_password
// and caching_sha2_password logins (the latter's "full" step uses the server's RSA public key over plaintext, or the
// password itself inside TLS). TLS goes through ../tls.js. Works with MySQL 5.7/8.x; MariaDB's default native_password
// login should too (untested).
// ponytail: TLS always verifies the certificate (no "encrypt but don't check" mode), no prepared statements or bind
// params, no LOAD DATA LOCAL.
import { startTls } from '../tls.js';
const enc = new TextEncoder();
const dec = new TextDecoder();
const subtle = crypto.subtle;
const MAX_ROWS = 1000;
const BLOB_PREVIEW = 2048;  // bytes of a binary value shown in the grid (an export gets all of it)

const CLIENT = {
  LONG_PASSWORD: 0x1, LONG_FLAG: 0x4, CONNECT_WITH_DB: 0x8, PROTOCOL_41: 0x200, TRANSACTIONS: 0x2000,
  SSL: 0x800, SECURE_CONNECTION: 0x8000, MULTI_STATEMENTS: 0x10000, MULTI_RESULTS: 0x20000, PLUGIN_AUTH: 0x80000,
};
const MORE_RESULTS = 0x0008;  // server status flag: another result set follows
const ER_QUERY_INTERRUPTED = 1317;  // what a killed statement fails with

const cat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const u32le = (n) => new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);
const cstr = (s) => cat(enc.encode(s), new Uint8Array(1));
const q = (id) => '`' + id.replace(/`/g, '``') + '`';
const thousands = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');  // this runtime has no Intl, so toLocaleString() adds nothing
const hex = (u8) => '0x' + [...u8].map((b) => b.toString(16).padStart(2, '0')).join('');

const digest = async (alg, ...parts) => new Uint8Array(await subtle.digest(alg, cat(...parts)));
const xor = (a, b) => a.map((x, i) => x ^ b[i % b.length]);
// mysql_native_password: SHA1(pw) XOR SHA1(salt + SHA1(SHA1(pw)))
async function nativeToken(password, salt) {
  if (!password) return new Uint8Array(0);
  const p1 = await digest('SHA-1', enc.encode(password));
  return xor(p1, await digest('SHA-1', salt, await digest('SHA-1', p1)));
}
// caching_sha2_password fast path: SHA256(pw) XOR SHA256(SHA256(SHA256(pw)) + salt)
async function sha2Token(password, salt) {
  if (!password) return new Uint8Array(0);
  const p1 = await digest('SHA-256', enc.encode(password));
  return xor(p1, await digest('SHA-256', await digest('SHA-256', p1), salt));
}
// caching_sha2_password full path over plaintext: RSA-OAEP(SHA-1) of (password + NUL) XOR salt, with the server's key.
async function sha2Encrypted(password, salt, pem) {
  const der = Uint8Array.from(atob(pem.replace(/-----[A-Z ]+-----|\s/g, '')), (c) => c.charCodeAt(0));
  const key = await subtle.importKey('spki', der, { name: 'RSA-OAEP', hash: 'SHA-1' }, false, ['encrypt']);
  return new Uint8Array(await subtle.encrypt({ name: 'RSA-OAEP' }, key, xor(cstr(password), salt)));
}

// Length-encoded integer at o: returns [value, nextOffset].
function lenenc(b, o) {
  const f = b[o];
  if (f < 0xFB) return [f, o + 1];
  if (f === 0xFC) return [b[o + 1] | (b[o + 2] << 8), o + 3];
  if (f === 0xFD) return [b[o + 1] | (b[o + 2] << 8) | (b[o + 3] << 16), o + 4];
  const dv = new DataView(b.buffer, b.byteOffset + o + 1, 8);
  return [Number(dv.getBigUint64(0, true)), o + 9];
}
const lenencStr = (b, o) => { const [n, at] = lenenc(b, o); return [dec.decode(b.subarray(at, at + n)), at + n]; };

function parseError(p) {  // 0xFF, code(2), ['#' sqlstate(5)], message
  const code = p[1] | (p[2] << 8);
  const hasState = p[3] === 0x23;
  const message = dec.decode(p.subarray(hasState ? 9 : 3));
  return Object.assign(new Error(message), { code, sqlState: hasState ? dec.decode(p.subarray(4, 9)) : null, cancelled: code === ER_QUERY_INTERRUPTED });
}

// Column type codes -> the names the UI knows (it right-aligns the numeric ones and treats 'json' as JSON).
const TYPE_NAMES = {
  0x00: 'decimal', 0x01: 'tinyint', 0x02: 'smallint', 0x03: 'int', 0x04: 'float', 0x05: 'double', 0x07: 'timestamp', 0x08: 'bigint',
  0x09: 'mediumint', 0x0A: 'date', 0x0B: 'time', 0x0C: 'datetime', 0x0D: 'year', 0x0F: 'varchar', 0x10: 'bit', 0xF5: 'json',
  0xF6: 'decimal', 0xF7: 'enum', 0xF8: 'set', 0xFF: 'geometry',
};
const BINARY_CHARSET = 63;
function typeName(type, charset) {
  if (type >= 0xF9 && type <= 0xFC) return charset === BINARY_CHARSET ? 'blob' : 'text';
  if (type === 0xFD) return charset === BINARY_CHARSET ? 'varbinary' : 'varchar';
  if (type === 0xFE) return charset === BINARY_CHARSET ? 'binary' : 'char';
  return TYPE_NAMES[type] ?? null;
}
const isBinary = (m) => m.charset === BINARY_CHARSET && (m.type === 0x10 || m.type === 0xFF || (m.type >= 0xF9 && m.type <= 0xFE));

function decodeValue(bytes, m, full) {
  if (!isBinary(m)) return dec.decode(bytes);
  return full || bytes.length <= BLOB_PREVIEW ? hex(bytes) : `${hex(bytes.subarray(0, BLOB_PREVIEW))}… (${thousands(bytes.length)} bytes)`;
}

// One authenticated socket: packets in, packets out.
// greetingTimeoutMs: how long to wait for the server's first packet (a port that accepts but never speaks MySQL, like
// Postgres's, would otherwise hang forever).
// tls ({ sni, ca }): after the (plaintext) greeting, ask to switch to TLS and log in inside it.
async function open({ host, port, user, password = '', database, greetingTimeoutMs = 10000, tls = null }) {
  const conn = await tjs.connect('tcp', host, port);
  const { readable, writable } = await conn.opened;
  let reader = readable.getReader();
  let writer = writable.getWriter();
  let closeSocket = () => conn.close();
  let buf = new Uint8Array(0), pos = 0;

  const need = async (n) => {
    while (buf.length - pos < n) {
      const { value, done } = await reader.read();
      if (done) throw new Error('connection closed by server');
      if (pos === buf.length) { buf = value; pos = 0; } else { buf = cat(buf.subarray(pos), value); pos = 0; }
    }
  };
  // A payload of exactly 0xFFFFFF bytes continues in the next packet.
  const readPacket = async () => {
    const parts = [];
    let seq;
    for (;;) {
      await need(4);
      const len = buf[pos] | (buf[pos + 1] << 8) | (buf[pos + 2] << 16);
      seq = buf[pos + 3];
      await need(4 + len);
      parts.push(buf.slice(pos + 4, pos + 4 + len));
      pos += 4 + len;
      if (len < 0xFFFFFF) break;
    }
    return { seq, payload: parts.length === 1 ? parts[0] : cat(...parts) };
  };
  const write = (seq, payload) => {
    let o = 0;
    for (;;) {
      const n = Math.min(0xFFFFFF, payload.length - o);
      writer.write(cat(new Uint8Array([n & 255, (n >> 8) & 255, (n >> 16) & 255, seq++ & 255]), payload.subarray(o, o + n))).catch(() => {});  // a dead socket surfaces on the next read
      o += n;
      if (n < 0xFFFFFF) break;
    }
    return seq;
  };
  const close = async () => {
    try { write(0, new Uint8Array([0x01])); } catch {}  // COM_QUIT
    try { closeSocket(); } catch {}
  };

  try {
    // ---- greeting ----
    let timer;
    const timedOut = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('The server did not greet us: is that port a MySQL server?')), greetingTimeoutMs); });
    const { payload: g } = await Promise.race([readPacket(), timedOut]).finally(() => clearTimeout(timer));
    if (g[0] === 0xFF) throw parseError(g);
    if (g[0] !== 10) throw new Error('That does not look like a MySQL server (unexpected greeting)');
    let o = 1;
    const verEnd = g.indexOf(0, o);
    o = verEnd + 1;
    const threadId = new DataView(g.buffer, g.byteOffset + o, 4).getUint32(0, true);
    o += 4;
    const salt1 = g.subarray(o, o + 8);
    o += 8 + 1;  // + filler
    const capLow = g[o] | (g[o + 1] << 8);
    o += 2 + 1 + 2;  // capabilities (low), charset, status
    const capHigh = g[o] | (g[o + 1] << 8);
    o += 2;
    const authLen = g[o];
    o += 1 + 10;  // auth data length, reserved
    const salt2 = g.subarray(o, o + Math.max(13, authLen - 8) - 1);  // drop the trailing NUL
    o += Math.max(13, authLen - 8);
    let plugin = 'mysql_native_password';
    if (((capLow | (capHigh << 16)) & CLIENT.PLUGIN_AUTH) && o < g.length) plugin = dec.decode(g.subarray(o, g.indexOf(0, o) < 0 ? g.length : g.indexOf(0, o)));
    let salt = cat(salt1, salt2);

    // ---- login ----
    const tokenFor = (name, s) => (name === 'caching_sha2_password' ? sha2Token(password, s) : name === 'mysql_native_password' ? nativeToken(password, s) : null);
    const first = await tokenFor(plugin, salt);
    if (!first) throw new Error(`The server wants the "${plugin}" login, which is not supported`);
    let flags = CLIENT.LONG_PASSWORD | CLIENT.LONG_FLAG | CLIENT.PROTOCOL_41 | CLIENT.TRANSACTIONS | CLIENT.SECURE_CONNECTION |
      CLIENT.MULTI_STATEMENTS | CLIENT.MULTI_RESULTS | CLIENT.PLUGIN_AUTH | (database ? CLIENT.CONNECT_WITH_DB : 0);
    const head = (f) => cat(u32le(f), u32le(0x01000000), new Uint8Array([45]), new Uint8Array(23));  // flags, max packet, utf8mb4_general_ci, filler
    let seq = 1;
    if (tls) {
      if (!((capLow | (capHigh << 16)) & CLIENT.SSL)) throw new Error('This server does not offer TLS');
      flags |= CLIENT.SSL;
      seq = write(seq, head(flags));  // the SSLRequest: the login packet's first 32 bytes, nothing more
      if (pos !== buf.length) throw new Error('unexpected data before the TLS handshake');  // plaintext injected ahead of TLS
      const s = await startTls({ reader, writer, close: () => conn.close() }, tls);
      reader = s.readable.getReader(); writer = s.writable.getWriter(); closeSocket = s.close;
      buf = new Uint8Array(0); pos = 0;
    }
    seq = write(seq, cat(
      head(flags),
      cstr(user), new Uint8Array([first.length]), first, database ? cstr(database) : new Uint8Array(0), cstr(plugin),
    ));
    let via = plugin;  // which login path actually completed, for diagnostics and tests
    for (;;) {
      const { seq: rs, payload: p } = await readPacket();
      seq = rs + 1;
      if (p[0] === 0x00) break;  // OK
      if (p[0] === 0xFF) throw parseError(p);
      if (p[0] === 0xFE) {  // AuthSwitchRequest: another login method, with a fresh salt
        const nameEnd = p.indexOf(0, 1);
        const name = dec.decode(p.subarray(1, nameEnd));
        salt = p.subarray(nameEnd + 1, p.length > nameEnd + 21 ? nameEnd + 21 : p.length);
        const t = await tokenFor(name, salt);
        if (!t) throw new Error(`The server wants the "${name}" login, which is not supported`);
        seq = write(seq, t);
        plugin = name;
        via = name;
      } else if (p[0] === 0x01) {  // caching_sha2_password: 0x03 = cached, send nothing; 0x04 = full login; else a public key
        if (p[1] === 0x03) { via = 'caching_sha2_password (cached)'; continue; }
        if (p[1] === 0x04 && tls) { via = 'caching_sha2_password (full, TLS)'; seq = write(seq, cstr(password)); }  // the channel is encrypted: the password may go as is
        else if (p[1] === 0x04) { via = 'caching_sha2_password (full, RSA)'; seq = write(seq, new Uint8Array([0x02])); }  // no TLS: ask for the RSA public key
        else seq = write(seq, await sha2Encrypted(password, salt, dec.decode(p.subarray(1))));
      } else throw new Error('Unexpected reply while logging in');
    }
    return { readPacket, write, close, threadId, via };
  } catch (e) {
    await close();
    throw e;
  }
}

export async function connect(params) {
  const { database } = params;
  const c = await open(params);
  let busy = Promise.resolve();
  let running = false;

  // With a `sink`, rows go to sink.rows(batch) instead of being collected (no 1000-row cap), and sink.columns(names, types)
  // opens each result set (a script's later result set starts it afresh). A failing sink cancels the statement and the rest
  // is read and discarded, so the connection stays in step with the server; the sink's error is what is thrown.
  const run = (sql, sink = null) => {
    const p = busy.then(async () => {
      running = true;
      try {
        c.write(0, cat(new Uint8Array([0x03]), enc.encode(sql)));  // COM_QUERY
        let columns = [], types = [], meta = [], rows = [], truncated = false, tag = '', error = null;
        let batch = [], sinkError = null, cancelling = null;
        const toSink = async (fn) => {
          if (sinkError) return;
          try { await fn(); } catch (e) { sinkError = e; cancelling = cancel().catch(() => {}); }
        };
        const flushBatch = async () => { const b = batch; batch = []; if (b.length) await toSink(() => sink.rows(b)); };

        for (let more = true; more && !error;) {  // one pass per result set
          const { payload: first } = await c.readPacket();
          if (first[0] === 0xFF) { error = parseError(first); break; }
          if (first[0] === 0x00) {  // OK: a statement with no rows
            const [affected, at] = lenenc(first, 1);
            const [, at2] = lenenc(first, at);
            more = ((first[at2] | (first[at2 + 1] << 8)) & MORE_RESULTS) !== 0;
            tag = `${thousands(affected)} row${affected === 1 ? '' : 's'} affected`;
            continue;
          }
          const [nCols] = lenenc(first, 0);
          columns = []; types = []; meta = []; rows = []; truncated = false; batch = [];
          for (let i = 0; i < nCols; i++) {
            const { payload: d } = await c.readPacket();
            let o = 0;
            let name;
            for (let k = 0; k < 6; k++) { const [s, at] = lenencStr(d, o); o = at; if (k === 4) name = s; }  // catalog, schema, table, org_table, NAME, org_name
            o += 1;  // length of the fixed fields (0x0c)
            const charset = d[o] | (d[o + 1] << 8), type = d[o + 6];
            columns.push(name); types.push(typeName(type, charset)); meta.push({ type, charset });
          }
          await c.readPacket();  // EOF after the column definitions
          if (sink) await toSink(() => sink.columns(columns, types));
          for (;;) {
            const { payload: p } = await c.readPacket();
            if (p[0] === 0xFE && p.length < 9) { more = (((p[3] | (p[4] << 8))) & MORE_RESULTS) !== 0; break; }  // EOF
            if (p[0] === 0xFF) { error = parseError(p); break; }
            if (!sink && rows.length >= MAX_ROWS) { truncated = true; continue; }
            if (sinkError) continue;  // draining
            const row = [];
            let o = 0;
            for (let i = 0; i < nCols; i++) {
              if (p[o] === 0xFB) { row.push(null); o += 1; continue; }
              const [len, at] = lenenc(p, o);
              row.push(decodeValue(p.subarray(at, at + len), meta[i], !!sink));
              o = at + len;
            }
            if (sink) { batch.push(row); if (batch.length >= 256) await flushBatch(); } else rows.push(row);
          }
        }
        if (cancelling) await cancelling;  // the KILL must land before the next statement can start, or it would hit that one
        if (sink && !error) await flushBatch();
        if (sinkError) throw sinkError;
        if (error) throw error;
        return { columns, types, rows, truncated, tag };
      } finally { running = false; }
    });
    busy = p.catch(() => {});
    return p;
  };

  // Stop the running statement: KILL QUERY from a second connection (same login). The statement then fails with error
  // 1317 on its own connection, which stays usable. ponytail: a cancel landing just as a statement ends can hit the next
  // one; and a statement that is only SLEEP() returns 1 when killed instead of failing.
  async function cancel() {
    if (!running) return false;
    const k = await open(params);
    try {
      k.write(0, cat(new Uint8Array([0x03]), enc.encode(`KILL QUERY ${c.threadId}`)));
      await k.readPacket();
    } finally { await k.close(); }
    return true;
  }

  // One row per column so the editor can complete table.column. With a default database only that one is listed
  // (names unqualified); with none, every user schema is, as schema.table.
  const tables = async () => {
    const where = database ? 'c.table_schema = database()' : "c.table_schema not in ('mysql','information_schema','performance_schema','sys')";
    const { rows } = await run(`select c.table_schema, c.table_name, t.table_type, c.column_name
      from information_schema.columns c join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
      where ${where} order by c.table_schema, c.table_name, c.ordinal_position`);
    const byRef = new Map();
    for (const [s, t, type, col] of rows) {
      const ref = `${q(s)}.${q(t)}`;
      if (!byRef.has(ref)) byRef.set(ref, { name: database ? t : `${s}.${t}`, ref, type: type === 'VIEW' ? 'view' : 'table', columns: [] });
      byRef.get(ref).columns.push(col);
    }
    return [...byRef.values()];
  };

  return {
    via: c.via,
    cancel,
    query: (sql) => run(sql),
    stream: (sql, sink) => run(sql, sink),
    tables,
    select: (ref, limit, offset) => run(`select * from ${ref} limit ${+limit} offset ${+offset}`),
    close: async () => { await c.close(); },
  };
}
