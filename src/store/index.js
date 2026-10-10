// Picks the graph store: GC_STORE=memory (default; rebuilt from the CSVs on every start) or GC_STORE=neo4j.
import { STORE_KIND, NEO4J, NEO4J_TEST } from "../config.js";
import { MemoryStore } from "./memory.js";
import { NeoStore } from "./neo.js";

// kind: "memory" | "neo4j". For memory, `until` / `quiet` are passed to loadGraph; for neo4j they are ignored
// because the graph already lives in the database (use `build` to (re)load it).
// sellers: optional list of GLIDs; the in-memory store then loads only those sellers' rows.
export async function openStore({ kind = STORE_KIND, log = null, until = null, quiet = false, cfg = NEO4J, sellers = null } = {}) {
  if (kind === "neo4j") return new NeoStore({ log, cfg }).init();
  if (kind === "memory") return new MemoryStore({ log, until, quiet, sellers }).init();
  throw new Error(`Unknown GC_STORE "${kind}" (use memory or neo4j)`);
}

// Load the CSV snapshot (+ `log`, events up to `until`) in memory and, for a Neo4j store, copy it into the database.
// Returns the in-memory store, which also carries `.deferred` (the events after `until`) for the freshness replay.
export async function rebuild(store, { log = null, until = null, quiet = true, sellers = null } = {}) {
  const mem = await new MemoryStore({ log, until, quiet, sellers }).init();
  if (store.kind === "neo4j") {
    const t0 = performance.now();
    await store.bulkLoad(mem.graph, { onProgress: (what, n) => quiet || process.stderr.write(`  neo4j  ${what.padEnd(16)} ${String(n).padStart(7)}\n`) });
    if (!quiet) process.stderr.write(`  neo4j: bulk load ${((performance.now() - t0) / 1000).toFixed(1)}s\n`);
  }
  return mem;
}

// A store that is safe to mutate and throw away (demo, freshness benchmark, test console). With Neo4j this is the
// separate test instance (NEO4J_TEST_URI, default port 7688), freshly loaded, so the real graph is never touched.
export async function openScratchStore({ log = null, until = null, quiet = true, sellers = null } = {}) {
  if (STORE_KIND !== "neo4j") return new MemoryStore({ log, until, quiet, sellers }).init();
  const store = await new NeoStore({ log, cfg: NEO4J_TEST }).init();
  const mem = await rebuild(store, { log, until, quiet, sellers });
  store.deferred = mem.deferred;
  return store;
}
