// What one event changed in the graph, for people to read (the live dashboard). Store-agnostic: it compares two
// snapshots of the nodes owned by the event's sellers (Seller node + everything indexed under the GLID) and the edges
// touching them. The memory store snapshots its whole graph's slice; the Neo4j store snapshots the hydrated view, which is
// exactly what its commit then writes.

const PREVIEW = 160; // characters of a property value shown in the diff

const short = (v) => {
  const t = typeof v === "string" ? v : JSON.stringify(v);
  return t.length > PREVIEW ? `${t.slice(0, PREVIEW - 1)}…` : t;
};

// { nodes: Map id -> {label, tier, ts, props(JSON)}, edges: Set "src\trel\tdst" } for these seller GLIDs.
export function snapOwned(g, glids) {
  const ids = new Set();
  for (const glid of glids) {
    ids.add(`S:${glid}`);
    for (const list of g.byGlid.get(String(glid))?.values() || []) for (const id of list) ids.add(id);
  }
  const nodes = new Map();
  const edges = new Set();
  for (const id of ids) {
    const n = g.get(id);
    if (!n) continue;
    nodes.set(id, { label: n.label, tier: n.tier, ts: n.ts, props: JSON.stringify(n.props) });
    for (const [rel, dsts] of g.out.get(id) || []) for (const d of dsts) edges.add(`${id}\t${rel}\t${d}`);
    for (const [rel, srcs] of g.in.get(id) || []) for (const s of srcs) edges.add(`${s}\t${rel}\t${id}`);
  }
  return { nodes, edges };
}

// Differences between two snapshots. Nodes and edges are never deleted by events, so only additions and changes exist.
export function graphDiff(before, after, { store = "memory" } = {}) {
  const created = [];
  const updated = [];
  for (const [id, a] of after.nodes) {
    const b = before.nodes.get(id);
    if (!b) { created.push({ id, label: a.label, tier: a.tier, ts: a.ts, props: Object.fromEntries(Object.entries(JSON.parse(a.props)).map(([k, v]) => [k, short(v)])) }); continue; }
    if (b.props === a.props && b.ts === a.ts) continue;
    const pb = JSON.parse(b.props), pa = JSON.parse(a.props);
    const changes = {};
    for (const k of new Set([...Object.keys(pb), ...Object.keys(pa)])) {
      if (JSON.stringify(pb[k]) !== JSON.stringify(pa[k])) changes[k] = [pb[k] === undefined ? null : short(pb[k]), pa[k] === undefined ? null : short(pa[k])];
    }
    if (b.ts !== a.ts) changes.ts = [b.ts, a.ts];
    if (Object.keys(changes).length) updated.push({ id, label: a.label, tier: a.tier, changes });
  }
  const rels = [...after.edges].filter((e) => !before.edges.has(e)).map((e) => e.split("\t"));
  return { store, created, updated, rels, cypher: cypherFor(created, updated, rels) };
}

// The statements the Neo4j store runs for these changes (neo.js #commit), one per item, written out for reading.
// The store itself batches them with UNWIND; this is the same write in a form a person can follow.
const q = (s) => `'${String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
function cypherFor(created, updated, rels) {
  const tier = { long_term: "LongTerm", short_term: "ShortTerm", reasoning: "Reasoning" };
  const out = [];
  for (const n of created) out.push(`MERGE (n:Node {id: ${q(n.id)}}) SET n:${n.label}:${tier[n.tier] || n.tier}, n += {${Object.keys(n.props).slice(0, 6).join(", ")}${Object.keys(n.props).length > 6 ? ", …" : ""}}`);
  for (const n of updated) out.push(`MATCH (n:Node {id: ${q(n.id)}}) SET ${Object.keys(n.changes).map((k) => `n.${k} = …`).join(", ")}`);
  for (const [s, r, d] of rels) out.push(`MATCH (a:Node {id: ${q(s)}}), (b:Node {id: ${q(d)}}) MERGE (a)-[:${r}]->(b)`);
  return out;
}
