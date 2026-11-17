// File names for exporting saved queries. Names are free text, files are not: strip what no OS accepts in a name.
// ponytail: Windows reserved names (CON, NUL, ...) are not special-cased; this app has only been run on macOS.
export function safeFileName(name) {
  const s = String(name).replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '_').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 100).trim();
  return s || 'query';
}
