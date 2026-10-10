// Node <-> Neo4j property mapping. Neo4j properties may only be primitives, so arrays and objects are stored
// as JSON strings and the node lists which keys those are (_json). System fields keep their plain names
// (id, tier, glid, buyer, ts) because the exported Cypher and queries.cypher use them; an application prop
// that collides with one is stored as "p:<key>". _n is the creation sequence number: it restores insertion order.

const RESERVED = new Set(["id", "tier", "glid", "buyer", "ts", "_n", "_json"]);
const isPrimitive = (v) => typeof v === "string" || typeof v === "number" || typeof v === "boolean";

// toInt: optional (n) => driver Integer, so whole numbers are stored as Neo4j integers instead of floats.
export function encodeNode(node, seq, toInt = (n) => n) {
  const p = { id: node.id, tier: node.tier };
  if (node.glid) p.glid = node.glid;
  if (node.buyer) p.buyer = node.buyer;
  if (node.ts) p.ts = node.ts;
  const json = [];
  for (const [k, v] of Object.entries(node.props)) {
    if (v === undefined || v === null) continue;
    const key = RESERVED.has(k) ? `p:${k}` : k;
    if (isPrimitive(v)) p[key] = typeof v === "number" && Number.isInteger(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER ? toInt(v) : v;
    else { p[key] = JSON.stringify(v); json.push(key); }
  }
  p._json = json;
  if (seq !== undefined) p._n = toInt(seq);
  return p;
}

// raw: the node's property map as returned by the driver (integers already converted to JS numbers).
export function decodeNode(label, raw) {
  const json = new Set(raw._json || []);
  const props = {};
  for (const [k, v] of Object.entries(raw)) {
    if (RESERVED.has(k)) continue;
    const key = k.startsWith("p:") ? k.slice(2) : k;
    props[key] = json.has(k) ? JSON.parse(v) : v;
  }
  return { id: raw.id, label, tier: raw.tier, glid: raw.glid ?? null, buyer: raw.buyer ?? null, ts: raw.ts ?? null, props, n: raw._n ?? 0 };
}
