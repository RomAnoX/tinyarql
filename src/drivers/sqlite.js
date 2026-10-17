import { Database } from 'tjs:sqlite';

const q = (id) => '"' + id.replace(/"/g, '""') + '"';
const MAX_ROWS = 1000;

// prepare() silently runs only the first statement, so split on top-level semicolons
// (outside '…' "…" `…` strings and -- / /* */ comments) and run them in order.
export function splitStatements(sql) {
  const out = [];
  let start = 0, i = 0;
  while (i < sql.length) {
    const c = sql[i], two = sql.substr(i, 2);
    if (c === "'" || c === '"' || c === '`') { i = sql.indexOf(c, i + 1); i = i < 0 ? sql.length : i + 1; }
    else if (two === '--') { i = sql.indexOf('\n', i); i = i < 0 ? sql.length : i + 1; }
    else if (two === '/*') { i = sql.indexOf('*/', i + 2); i = i < 0 ? sql.length : i + 2; }
    else if (c === ';') { out.push(sql.slice(start, i)); start = ++i; }
    else i++;
  }
  out.push(sql.slice(start));
  return out.filter((t) => t.replace(/--.*|\/\*[\s\S]*?\*\//g, '').trim());
}

export async function connect({ path }) {
  const db = new Database(path);
  // tjs:sqlite is sync and has no column metadata, so columns come from the first row.
  // ponytail: a bare query with zero rows shows no headers; select() falls back to table_info.
  const run = (sql) => {
    let all = [];
    for (const stmt of splitStatements(sql)) all = db.prepare(stmt).all();  // result of the last statement
    const columns = all.length ? Object.keys(all[0]) : [];
    const rows = all.slice(0, MAX_ROWS).map((r) => columns.map((c) => r[c]));
    return { columns, types: columns.map(() => null), rows, truncated: all.length > MAX_ROWS, tag: '' };
  };
  return {
    query: async (sql) => run(sql),
    // Same contract as the Postgres driver's stream(). tjs:sqlite has no cursor, so the last statement's rows are all
    // read at once (earlier statements run first, as in query()), then handed over in batches.
    // ponytail: a zero-row result has no column names to write (tjs:sqlite reports them only from a row).
    stream: async (sql, sink) => {
      const stmts = splitStatements(sql), last = stmts.pop();
      for (const stmt of stmts) db.prepare(stmt).all();
      const all = db.prepare(last).all();
      if (!all.length) return { columns: [], types: [], rows: [], truncated: false, tag: '' };
      const columns = Object.keys(all[0]);
      await sink.columns(columns, columns.map(() => null));
      for (let i = 0; i < all.length; i += 256) await sink.rows(all.slice(i, i + 256).map((r) => columns.map((c) => r[c])));
      return { columns, types: [], rows: [], truncated: false, tag: '' };
    },
    tables: async () =>
      run("select name, type from sqlite_master where type in ('table','view') and name not like 'sqlite_%' order by name")
        .rows.map(([name, type]) => ({
          name, ref: q(name), type,
          columns: run(`pragma table_info(${q(name)})`).rows.map((c) => c[1]),
        })),
    select: async (ref, limit, offset) => {
      const r = run(`select * from ${ref} limit ${+limit} offset ${+offset}`);
      if (!r.columns.length) r.columns = run(`pragma table_info(${ref})`).rows.map((c) => c[1]);
      return r;
    },
    close: async () => db.close(),
  };
}
