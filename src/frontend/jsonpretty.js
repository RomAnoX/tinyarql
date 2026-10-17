// Pretty-prints JSON *text* without turning it into JS values. JSON.stringify(JSON.parse(x)) would round integers
// beyond 2^53 and reorder integer-like keys ({"b":1,"2":2} -> {"2":2,"b":1}); this keeps numbers, key order and
// string escapes exactly as the database returned them. The input must already be valid JSON (parseJson checks).
// One walk yields tokens, so the same code makes the plain text (copy) and the coloured HTML (display).
function jsonTokens(text, indent = '  ') {
  const out = [], n = text.length;
  let i = 0, depth = 0;
  const newline = () => out.push({ t: 'ws', s: '\n' + indent.repeat(Math.max(0, depth)) });
  const skipSpace = (k) => { while (k < n && ' \t\n\r'.includes(text[k])) k++; return k; };
  while (i < n) {
    const c = text[i];
    if (' \t\n\r'.includes(c)) { i++; continue; }
    if (c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out.push({ t: text[skipSpace(j + 1)] === ':' ? 'key' : 'str', s: text.slice(i, j + 1) });
      i = j + 1;
    } else if (c === '{' || c === '[') {
      const next = skipSpace(i + 1), close = c === '{' ? '}' : ']';
      if (text[next] === close) { out.push({ t: 'punct', s: c + close }); i = next + 1; }  // empty container stays on one line
      else { out.push({ t: 'punct', s: c }); depth++; newline(); i++; }
    } else if (c === '}' || c === ']') {
      depth--; newline(); out.push({ t: 'punct', s: c }); i++;
    } else if (c === ',') {
      out.push({ t: 'punct', s: ',' }); newline(); i++;
    } else if (c === ':') {
      out.push({ t: 'punct', s: ': ' }); i++;
    } else {  // number, true, false, null
      let j = i;
      while (j < n && !',]}: \t\n\r'.includes(text[j])) j++;
      const s = text.slice(i, j);
      out.push({ t: s === 'true' || s === 'false' ? 'bool' : s === 'null' ? 'null' : 'num', s });
      i = j;
    }
  }
  return out;
}

const prettyJson = (text) => jsonTokens(text).map((tok) => tok.s).join('');

// Coloured HTML for the Json view. Past ~200k characters a span per token gets heavy, so large documents are
// shown indented but uncoloured.
const JSON_COLOR_MAX = 200000;
function jsonHtml(text) {
  if (text.length > JSON_COLOR_MAX) return esc(prettyJson(text));
  return jsonTokens(text).map((tok) => tok.t === 'ws' || tok.t === 'punct' ? esc(tok.s) : `<span class="j-${tok.t}">${esc(tok.s)}</span>`).join('');
}
