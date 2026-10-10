// In-process property graph: the context graph's storage engine.
// Nodes carry a tier (long_term / short_term / reasoning), an owner seller GLID (glid) and/or a buyer GLID (buyer),
// and a timestamp. Two owner indexes make "everything about GLID X" a direct lookup, which is what keeps
// per-event re-rendering in the millisecond range.

export class ContextGraph {
  constructor() {
    this.nodes = new Map();
    this.out = new Map();
    this.in = new Map();
    this.byGlid = new Map();
    this.byBuyer = new Map();
    this.edgeCount = 0;
  }

  static #index(map, key, label, id) {
    let byLabel = map.get(key);
    if (!byLabel) map.set(key, (byLabel = new Map()));
    let ids = byLabel.get(label);
    if (!ids) byLabel.set(label, (ids = []));
    ids.push(id);
  }

  upsert({ id, label, tier, glid = null, buyer = null, ts = null, props = {} }) {
    let n = this.nodes.get(id);
    if (!n) {
      n = { id, label, tier, glid: null, buyer: null, ts: null, props: {} };
      this.nodes.set(id, n);
    }
    if (glid && !n.glid) { n.glid = glid; ContextGraph.#index(this.byGlid, glid, label, id); }
    if (buyer && !n.buyer) { n.buyer = buyer; ContextGraph.#index(this.byBuyer, buyer, label, id); }
    if (ts && (!n.ts || ts < n.ts)) n.ts = ts;
    for (const k in props) {
      const v = props[k];
      if (v !== undefined && v !== null && v !== "") n.props[k] = v;
    }
    return n;
  }

  link(src, rel, dst) {
    let rels = this.out.get(src);
    if (!rels) this.out.set(src, (rels = new Map()));
    let dsts = rels.get(rel);
    if (!dsts) rels.set(rel, (dsts = new Set()));
    if (dsts.has(dst)) return false;
    dsts.add(dst);
    let inRels = this.in.get(dst);
    if (!inRels) this.in.set(dst, (inRels = new Map()));
    let srcs = inRels.get(rel);
    if (!srcs) inRels.set(rel, (srcs = new Set()));
    srcs.add(src);
    this.edgeCount++;
    return true;
  }

  get(id) { return this.nodes.get(id); }

  outN(id, rel) {
    const s = this.out.get(id)?.get(rel);
    return s ? [...s].map((x) => this.nodes.get(x)).filter(Boolean) : [];
  }

  inN(id, rel) {
    const s = this.in.get(id)?.get(rel);
    return s ? [...s].map((x) => this.nodes.get(x)).filter(Boolean) : [];
  }

  owned(glid, label) { return (this.byGlid.get(glid)?.get(label) || []).map((id) => this.nodes.get(id)); }
  ofBuyer(buyer, label) { return (this.byBuyer.get(buyer)?.get(label) || []).map((id) => this.nodes.get(id)); }
  labelsOf(glid) { return [...(this.byGlid.get(glid)?.keys() || [])]; }

  *edges() {
    for (const [src, rels] of this.out) for (const [rel, dsts] of rels) for (const dst of dsts) yield [src, rel, dst];
  }

  stats() {
    const byLabel = {};
    for (const n of this.nodes.values()) byLabel[n.label] = (byLabel[n.label] || 0) + 1;
    return { nodes: this.nodes.size, edges: this.edgeCount, byLabel };
  }
}
