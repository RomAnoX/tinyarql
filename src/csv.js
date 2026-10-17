// RFC 4180 CSV: CRLF line ends; a field is quoted when it holds a comma, quote, CR or LF (or leading/trailing space) and
// quotes are doubled. NULL is an empty field and an empty string is "", so the two stay distinguishable.
// ponytail: no spreadsheet-formula escaping ("=", "+", "-", "@" are written as they are, so exported values stay exact),
// and no UTF-8 byte-order mark (Excel may need Data > From Text to read accents).
const hex = (u8) => '0x' + [...u8].map((b) => b.toString(16).padStart(2, '0')).join('');

export function csvField(v) {
  if (v === null || v === undefined) return '';
  const s = v instanceof Uint8Array ? hex(v) : typeof v === 'string' ? v : String(v);
  if (s === '') return '""';
  return /[",\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const csvLine = (values) => values.map(csvField).join(',') + '\r\n';

// Writes a CSV file in pieces to `<path>.part` and renames it over `path` only when finished, so a failed or stopped export
// never destroys the file it was going to replace. start() may be called again (a script's later statement replaces the
// result): it begins the file afresh.
const enc = new TextEncoder();
export function createCsvWriter(path) {
  const part = `${path}.part`;
  let fh = null, buf = '';
  const flush = async () => { if (buf) { const chunk = enc.encode(buf); buf = ''; await fh.write(chunk); } };
  return {
    get started() { return fh !== null; },
    async start(columns) {
      if (fh) await fh.close();
      fh = await tjs.open(part, 'w');
      buf = csvLine(columns);
    },
    async write(rows) {
      for (const r of rows) buf += csvLine(r);
      if (buf.length > 65536) await flush();
    },
    async finish() {
      await flush();
      await fh.close();
      fh = null;
      try { await tjs.remove(path); } catch {}  // Windows will not rename over an existing file
      await tjs.rename(part, path);
    },
    async abort() {
      try { if (fh) await fh.close(); } catch {}
      fh = null;
      try { await tjs.remove(part); } catch {}
    },
  };
}
