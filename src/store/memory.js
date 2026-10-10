// In-memory store: the whole graph is rebuilt from the CSVs plus the event log on every start.
// Same interface as NeoStore, so it is the fallback (GC_STORE=memory) and the oracle the Neo4j store is tested against.
import { loadGraph } from "../load.js";
import { writeContext } from "../render.js";
import { graphDiff, snapOwned } from "../graphdiff.js";

export class MemoryStore {
  kind = "memory";

  constructor({ log = null, quiet = false, until = null, sellers = null } = {}) {
    this.sellers = sellers;
    this.log = log;
    this.quiet = quiet;
    this.until = until;
  }

  async init() {
    ({ graph: this.graph, pipe: this.pipe, deferred: this.deferred } = loadGraph({ log: this.log, quiet: this.quiet, until: this.until, sellers: this.sellers }));
    return this;
  }

  async close() {}

  // Apply one event or a list. Returns the owners to re-render and the graph to render them from.
  // diff: also return, per event, what changed in the graph around the event's seller (for the live dashboard).
  async apply(events, { persist = false, diff = false } = {}) {
    const out = { sellers: new Set(), buyers: new Set(), view: this.graph, changes: [] };
    for (const ev of [].concat(events)) {
      const glids = ev.row?.glid ? [String(ev.row.glid)] : [];
      const before = diff && glids.length ? snapOwned(this.graph, glids) : null;
      const a = this.pipe.apply(ev, { persist });
      if (before) out.changes.push({ glid: glids[0], ...graphDiff(before, snapOwned(this.graph, glids), { store: this.kind }) });
      a.sellers.forEach((x) => out.sellers.add(x));
      a.buyers.forEach((x) => out.buyers.add(x));
    }
    return out;
  }

  // Render and write one context file. `view` is a graph returned by apply() or sellerViews() that already holds the owner.
  async write(role, id, opts = {}, view = null) {
    return writeContext(view ?? this.graph, role, id, opts);
  }

  async hasSeller(glid) { return Boolean(this.graph.get(`S:${glid}`)); }

  // Yields { glid, graph } for every seller, in creation order. The graph is only valid until the next iteration.
  async *sellerViews() {
    for (const g of this.graph.byGlid.keys()) if (this.graph.get(`S:${g}`)) yield { glid: g, graph: this.graph };
  }

  // A graph holding at least this seller's own nodes and their direct neighbours (for the graph view).
  async neighbourhood(glid) { return this.graph; }

  async stats() { return this.graph.stats(); }
  async counts() { return { nodes: this.graph.nodes.size, edges: this.graph.edgeCount }; }
}
