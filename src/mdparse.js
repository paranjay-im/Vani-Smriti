// Parse a context file: JSON-valued front matter + markdown body split into sections.
// Every consumer (bot, exec prep, campaigns, dashboard) reads files through this, never the graph.
export function parseMd(md) {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(md);
  const fm = {};
  const body = m ? m[2] : md;
  if (m) {
    for (const line of m[1].split("\n")) {
      const i = line.indexOf(": ");
      if (i < 0) continue;
      const k = line.slice(0, i);
      const v = line.slice(i + 2);
      try { fm[k] = JSON.parse(v); } catch { fm[k] = v; }
    }
  }
  const sections = {};
  let cur = "_head";
  for (const line of body.split("\n")) {
    const h = /^## (.+)$/.exec(line);
    if (h) { cur = h[1]; sections[cur] = []; continue; }
    (sections[cur] ||= []).push(line);
  }
  for (const k in sections) sections[k] = sections[k].filter((l) => l.trim());
  return { fm, body, sections };
}
