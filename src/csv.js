import fs from "node:fs";

// RFC 4180 parser: quoted fields, "" escapes, embedded newlines, CRLF. Yields one object per row.
export function* parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const n = text.length;
  let i = 0;
  let header = null;
  while (i < n) {
    const row = [];
    for (;;) {
      let val;
      if (text[i] === '"') {
        const parts = [];
        let j = i + 1;
        for (;;) {
          const q = text.indexOf('"', j);
          if (q < 0) { parts.push(text.slice(j)); i = n; break; }
          parts.push(text.slice(j, q));
          if (text[q + 1] === '"') { parts.push('"'); j = q + 2; continue; }
          i = q + 1;
          break;
        }
        val = parts.join("");
      } else {
        let j = i;
        while (j < n) {
          const c = text.charCodeAt(j);
          if (c === 44 || c === 10 || c === 13) break;
          j++;
        }
        val = text.slice(i, j);
        i = j;
      }
      row.push(val);
      if (text[i] === ",") { i++; continue; }
      if (text[i] === "\r") i++;
      if (text[i] === "\n") i++;
      break;
    }
    if (!header) { header = row; continue; }
    if (row.length === 1 && row[0] === "") continue;
    const o = {};
    for (let k = 0; k < header.length; k++) o[header[k]] = row[k] ?? "";
    yield o;
  }
}

export const readCsv = (file) => parseCsv(fs.readFileSync(file, "utf8"));

const cell = (v) => {
  if (v === null || v === undefined) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const toCsv = (cols, rows) => [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\n") + "\n";
