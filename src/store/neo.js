// Neo4j store: the context graph lives in Neo4j. The renderer, fact extractor and Pipeline are synchronous and
// read the graph ~40 times per file, so they never talk to Neo4j directly. Instead:
//   read  : one Cypher read hydrates a seller's (or buyer's) nodes and the edges between them into a small
//           throwaway ContextGraph, and the existing code runs on that;
//   write : the event is applied to that small graph, the nodes and edges that changed are diffed out,
//           and written back in one transaction.
// Every node is (:Node:<Label>:<Tier> {id, tier, glid, buyer, ts, ...props, _n}); every relationship has _e.
// _n / _e are creation sequence numbers: hydration orders by them so insertion order (which the renderer's
// stable sorts depend on) survives a round trip through the database.
import fs from "node:fs";
import path from "node:path";
import { ContextGraph } from "../graph.js";
import { Pipeline } from "../ingest.js";
import { normalize } from "../sources.js";
import { writeContext } from "../render.js";
import { graphDiff, snapOwned } from "../graphdiff.js";
import { NEO4J } from "../config.js";
import { encodeNode, decodeNode } from "./codec.js";

const TIER_LABEL = { long_term: "LongTerm", short_term: "ShortTerm", reasoning: "Reasoning" };
const TIER_LABELS = new Set(Object.values(TIER_LABEL));
const GLOBAL = new Set(["Category", "Mcat", "Employee", "Product"]); // shared nodes: never an owner
const SAFE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const BATCH = 5000;
const key = (s, r, d) => `${s}\u0000${r}\u0000${d}`;
const sig = (n) => JSON.stringify([n.ts, n.glid, n.buyer, n.props]);
const chunks = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };

export class NeoStore {
  kind = "neo4j";
  #tail = Promise.resolve();

  constructor({ log = null, cfg = NEO4J } = {}) {
    this.log = log;
    this.cfg = cfg;
  }

  async init() {
    let mod;
    try { mod = (await import("neo4j-driver")).default; }
    catch { throw new Error("GC_STORE=neo4j needs the neo4j-driver package: run `npm install` in context_layer/"); }
    this.neo = mod;
    this.driver = mod.driver(this.cfg.uri, mod.auth.basic(this.cfg.user, this.cfg.password), { disableLosslessIntegers: true });
    try { await this.driver.verifyConnectivity({ database: this.cfg.database }); }
    catch (e) {
      await this.driver.close();
      throw new Error(`Cannot reach Neo4j at ${this.cfg.uri} (${e.code || e.message}). Start it with \`docker compose up -d neo4j\` and check NEO4J_PASSWORD in .env.`);
    }
    await this.ensureSchema();
    return this;
  }

  async close() { await this.driver?.close(); }

  #session() { return this.driver.session({ database: this.cfg.database }); }
  async #read(fn) { const s = this.#session(); try { return await s.executeRead(fn); } finally { await s.close(); } }
  async #write(fn) { const s = this.#session(); try { return await s.executeWrite(fn); } finally { await s.close(); } }
  // One writer at a time: the pipeline's read-modify-write of a neighbourhood must not interleave.
  #serial(fn) { const run = this.#tail.then(fn); this.#tail = run.catch(() => {}); return run; }
  #int = (n) => this.neo.int(n);

  async ensureSchema() {
    const s = this.#session();
    try {
      await s.run("CREATE CONSTRAINT node_id IF NOT EXISTS FOR (n:Node) REQUIRE n.id IS UNIQUE");
      await s.run("CREATE INDEX node_glid IF NOT EXISTS FOR (n:Node) ON (n.glid)");
      await s.run("CREATE INDEX node_buyer IF NOT EXISTS FOR (n:Node) ON (n.buyer)");
      await s.run("CREATE CONSTRAINT meta_key IF NOT EXISTS FOR (m:Meta) REQUIRE m.k IS UNIQUE");
    } finally { await s.close(); }
  }

  async wipe() {
    const s = this.#session();
    try { await s.run("MATCH (n) CALL { WITH n DETACH DELETE n } IN TRANSACTIONS OF 10000 ROWS"); } finally { await s.close(); }
  }

  // ---------------------------------------------------------------- bulk load (the ETL step behind `build`)
  // Copies a fully built in-memory graph into an empty database. Creation order becomes _n / _e.
  async bulkLoad(graph, { onProgress = () => {} } = {}) {
    await this.wipe();
    const byLabel = new Map();
    let n = 0;
    for (const node of graph.nodes.values()) {
      if (!byLabel.has(node.label)) byLabel.set(node.label, []);
      byLabel.get(node.label).push({ p: encodeNode(node, ++n, this.#int) });
    }
    for (const [label, rows] of byLabel) {
      if (!SAFE.test(label)) throw new Error(`unsafe label ${label}`);
      const tier = TIER_LABEL[graph.nodes.get(rows[0].p.id).tier];
      for (const part of chunks(rows, BATCH)) {
        await this.#write((tx) => tx.run(`UNWIND $rows AS r CREATE (n:Node:\`${label}\`:\`${tier}\`) SET n = r.p`, { rows: part }));
      }
      onProgress(label, rows.length);
    }
    const byRel = new Map();
    let e = 0;
    for (const [s, r, d] of graph.edges()) {
      if (!graph.get(s) || !graph.get(d)) continue; // same rule as export: dangling ids are dropped
      if (!byRel.has(r)) byRel.set(r, []);
      byRel.get(r).push({ s, d, e: this.#int(++e) });
    }
    for (const [rel, rows] of byRel) {
      if (!SAFE.test(rel)) throw new Error(`unsafe relationship type ${rel}`);
      for (const part of chunks(rows, BATCH)) {
        await this.#write((tx) => tx.run(`UNWIND $rows AS r MATCH (a:Node {id: r.s}) MATCH (b:Node {id: r.d}) CREATE (a)-[x:\`${rel}\` {_e: r.e}]->(b)`, { rows: part }));
      }
      onProgress(rel, rows.length);
    }
    await this.#write((tx) => tx.run("MERGE (m:Meta {k: 'seq'}) SET m.n = $n, m.e = $e", { n: this.#int(n), e: this.#int(e) }));
    return { nodes: n, edges: e };
  }

  // ---------------------------------------------------------------- reads
  // Load every node owned by these sellers / buyers (plus, for buyers, the Seller nodes their enquiries point at;
  // with expand, also every long-term node directly connected) and the edges among them.
  async hydrate({ sellers = [], buyers = [], expand = false } = {}) {
    const found = await this.#read(async (tx) => {
      const recs = new Map();
      const take = (res) => {
        for (const r of res.records) {
          const node = r.get("n");
          if (!recs.has(node.properties.id)) recs.set(node.properties.id, decodeNode(node.labels.find((l) => l !== "Node" && !TIER_LABELS.has(l)), node.properties));
        }
      };
      if (sellers.length) take(await tx.run("MATCH (n:Node) WHERE n.glid IN $ids RETURN n", { ids: sellers }));
      if (buyers.length) {
        take(await tx.run("MATCH (n:Node) WHERE n.buyer IN $ids RETURN n", { ids: buyers }));
        const want = new Set(buyers.map((b) => `S:${b}`));
        for (const r of recs.values()) if (r.glid) want.add(`S:${r.glid}`);
        const missing = [...want].filter((id) => !recs.has(id));
        if (missing.length) take(await tx.run("MATCH (n:Node) WHERE n.id IN $ids RETURN n", { ids: missing }));
      }
      // A message or transcript turn may belong to another seller than its parent; the parent's file still counts it.
      if (recs.size) take(await tx.run("MATCH (a:Node)-[:HAS_MESSAGE|HAS_TURN]-(n:Node) WHERE a.id IN $ids AND NOT n.id IN $ids RETURN DISTINCT n", { ids: [...recs.keys()] }));
      if (expand && recs.size) take(await tx.run("MATCH (a:Node)--(n:LongTerm) WHERE a.id IN $ids RETURN DISTINCT n", { ids: [...recs.keys()] }));
      const ids = [...recs.keys()];
      const edges = ids.length
        ? (await tx.run("MATCH (a:Node)-[r]->(b:Node) WHERE a.id IN $ids AND b.id IN $ids RETURN a.id AS s, type(r) AS t, b.id AS d, r._e AS e ORDER BY e", { ids })).records.map((r) => [r.get("s"), r.get("t"), r.get("d")])
        : [];
      return { nodes: [...recs.values()].sort((a, b) => a.n - b.n), edges };
    });
    const g = new ContextGraph();
    for (const n of found.nodes) g.upsert(n);
    for (const [s, t, d] of found.edges) g.link(s, t, d);
    // What the database held, so commit() can write only what the pipeline changed.
    g._snap = { nodes: new Map(found.nodes.map((n) => [n.id, sig(g.get(n.id))])), edges: new Set(found.edges.map(([s, t, d]) => key(s, t, d))) };
    g._owners = { sellers: new Set(sellers), buyers: new Set(buyers) };
    return g;
  }

  async hasSeller(glid) {
    return this.#read(async (tx) => (await tx.run("MATCH (n:Node {id: $id}) RETURN count(n) AS c", { id: `S:${glid}` })).records[0].get("c") > 0);
  }

  async neighbourhood(glid) { return this.hydrate({ sellers: [glid], expand: true }); }

  // Yields { glid, graph } for every seller in creation order, 100 sellers per hydrate.
  async *sellerViews(size = 100) {
    const glids = await this.#read(async (tx) => (await tx.run("MATCH (n:Seller) RETURN n.glid AS g ORDER BY n._n")).records.map((r) => r.get("g")));
    for (const part of chunks(glids, size)) {
      const graph = await this.hydrate({ sellers: part });
      for (const glid of part) yield { glid, graph };
    }
  }

  async counts() {
    return this.#read(async (tx) => ({
      nodes: (await tx.run("MATCH (n:Node) RETURN count(n) AS c")).records[0].get("c"),
      edges: (await tx.run("MATCH (:Node)-[r]->(:Node) RETURN count(r) AS c")).records[0].get("c"),
    }));
  }

  // bulkLoad writes the Meta node last, so a database that has nodes but no Meta was cut short (build stopped half way).
  // Serving from it would silently render wrong files, so callers stop with a clear message instead.
  async assertLoaded(buildCmd) {
    const c = await this.counts();
    if (!c.nodes) throw new Error(`Neo4j holds no graph yet. Run \`${buildCmd}\` first.`);
    const meta = await this.#read(async (tx) => (await tx.run("MATCH (m:Meta {k: 'seq'}) RETURN count(m) AS c")).records[0].get("c"));
    if (!meta) throw new Error(`The Neo4j graph is incomplete (${c.nodes.toLocaleString()} nodes, ${c.edges.toLocaleString()} relationships; a build was stopped before it finished). Run \`${buildCmd}\` again to reload it.`);
  }

  async stats() {
    return this.#read(async (tx) => {
      const nodes = (await tx.run("MATCH (n:Node) RETURN count(n) AS c")).records[0].get("c");
      const edges = (await tx.run("MATCH (:Node)-[r]->(:Node) RETURN count(r) AS c")).records[0].get("c");
      const byLabel = {};
      for (const r of (await tx.run("MATCH (n:Node) RETURN [l IN labels(n) WHERE NOT l IN ['Node','LongTerm','ShortTerm','Reasoning']][0] AS l, count(*) AS c")).records) byLabel[r.get("l")] = r.get("c");
      return { nodes, edges, byLabel };
    });
  }

  // ---------------------------------------------------------------- writes
  // Seller / buyer GLIDs an event can read or change. vani_session actions also touch the enquiries they name.
  async ownersOf(ev) {
    const sellers = new Set();
    const buyers = new Set();
    for (const n of normalize(ev).nodes) {
      if (GLOBAL.has(n.label)) continue;
      if (n.glid) sellers.add(n.glid);
      if (n.buyer) buyers.add(n.buyer);
    }
    if (ev.source === "vani_session") {
      const enq = (ev.row.decisions || []).map((d) => String(d.key)).filter((k) => k.startsWith("ENQ:"));
      if (enq.length) {
        const rows = await this.#read(async (tx) => (await tx.run("MATCH (e:Node) WHERE e.id IN $ids RETURN e.glid AS g, e.buyer AS b", { ids: enq })).records);
        for (const r of rows) { if (r.get("g")) sellers.add(r.get("g")); if (r.get("b")) buyers.add(r.get("b")); }
      }
    }
    return { sellers: [...sellers], buyers: [...buyers] };
  }

  // Apply events one by one (hydrate -> Pipeline.apply -> diff -> one transaction). Returns the owners whose files
  // must be re-rendered, and, for a single event, the graph to render them from.
  // diff: also return, per event, what the commit wrote around the event's seller (for the live dashboard).
  async apply(events, { persist = false, diff = false } = {}) {
    const list = [].concat(events);
    const out = { sellers: new Set(), buyers: new Set(), view: null, changes: [] };
    for (const ev of list) {
      const a = await this.#serial(async () => {
        const owners = await this.ownersOf(ev);
        const g = await this.hydrate(owners);
        const glids = ev.row?.glid ? [String(ev.row.glid)] : [];
        const before = diff && glids.length ? snapOwned(g, glids) : null;
        const affected = new Pipeline(g).apply(ev, { persist: false });
        await this.#commit(g);
        if (before) out.changes.push({ glid: glids[0], ...graphDiff(before, snapOwned(g, glids), { store: this.kind }) });
        if (persist && this.log) {
          fs.mkdirSync(path.dirname(this.log), { recursive: true });
          fs.appendFileSync(this.log, JSON.stringify({ source: ev.source, row: ev.row, received_at: new Date().toISOString() }) + "\n");
        }
        return { affected, g };
      });
      a.affected.sellers.forEach((x) => out.sellers.add(x));
      a.affected.buyers.forEach((x) => out.buyers.add(x));
      if (list.length === 1) out.view = a.g;
    }
    return out;
  }

  async #commit(g) {
    const snap = g._snap;
    const fresh = [];
    const dirty = [];
    for (const n of g.nodes.values()) {
      const before = snap.nodes.get(n.id);
      if (before === undefined) fresh.push(n);
      else if (before !== sig(n)) dirty.push(n);
    }
    const rels = [];
    for (const [s, r, d] of g.edges()) if (!snap.edges.has(key(s, r, d))) rels.push([s, r, d]);
    if (!fresh.length && !dirty.length && !rels.length) return;
    await this.#write(async (tx) => {
      const c = (await tx.run(
        "MERGE (m:Meta {k: 'seq'}) ON CREATE SET m.n = 0, m.e = 0 SET m.n = m.n + $dn, m.e = m.e + $de RETURN m.n AS n, m.e AS e",
        { dn: this.#int(fresh.length), de: this.#int(rels.length) })).records[0];
      let n0 = c.get("n") - fresh.length;
      let e0 = c.get("e") - rels.length;
      const byLabel = new Map();
      for (const [list, isNew] of [[fresh, true], [dirty, false]]) {
        for (const n of list) {
          if (!SAFE.test(n.label)) throw new Error(`unsafe label ${n.label}`);
          const k = `${n.label}|${TIER_LABEL[n.tier]}`;
          if (!byLabel.has(k)) byLabel.set(k, []);
          byLabel.get(k).push({ p: encodeNode(n, undefined, this.#int), n: this.#int(isNew ? ++n0 : 0) });
        }
      }
      for (const [k, rows] of byLabel) {
        const [label, tier] = k.split("|");
        for (const part of chunks(rows, BATCH)) {
          // += merges: shared nodes (Product, Mcat, ...) were not hydrated, so a partial upsert must not erase them.
          await tx.run(`UNWIND $rows AS r MERGE (n:Node {id: r.p.id}) ON CREATE SET n._n = r.n SET n:\`${label}\`:\`${tier}\`, n += r.p`, { rows: part });
        }
      }
      const byRel = new Map();
      for (const [s, r, d] of rels) {
        if (!SAFE.test(r)) throw new Error(`unsafe relationship type ${r}`);
        if (!byRel.has(r)) byRel.set(r, []);
        byRel.get(r).push({ s, d, e: this.#int(++e0) });
      }
      for (const [rel, rows] of byRel) {
        await tx.run(`UNWIND $rows AS r MATCH (a:Node {id: r.s}) MATCH (b:Node {id: r.d}) MERGE (a)-[x:\`${rel}\`]->(b) ON CREATE SET x._e = r.e`, { rows });
      }
    });
    // The graph now equals the database; a later apply() on the same view starts from here.
    g._snap = { nodes: new Map([...g.nodes.values()].map((n) => [n.id, sig(n)])), edges: new Set([...g.edges()].map(([s, r, d]) => key(s, r, d))) };
  }

  // Render and write one context file. Uses `view` if it already holds the owner, otherwise hydrates.
  async write(role, id, opts = {}, view = null) {
    const has = view?._owners ? view._owners[role === "buyer" ? "buyers" : "sellers"].has(id) : Boolean(view);
    const g = has ? view : await this.hydrate(role === "buyer" ? { buyers: [id] } : { sellers: [id] });
    return writeContext(g, role, id, opts);
  }
}
