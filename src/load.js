import { ContextGraph } from "./graph.js";
import { Pipeline } from "./ingest.js";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config.js";
import { SOURCES } from "./sources.js";

// Build the context graph from the CSV snapshot, then replay the event log (live events + bot sessions).
export function loadGraph({ log = null, until = null, quiet = false, sellers = null } = {}) {
  const t0 = performance.now();
  const missing = Object.values(SOURCES).map((s) => s.file).filter((f) => !fs.existsSync(path.join(DATA_DIR, f)));
  if (missing.length) throw new Error(`Input data not found in ${DATA_DIR}: missing ${missing.join(", ")}. Put the 11 gc_*.csv files in context_layer/input/ (or set GC_DATA_DIR).`);
  const graph = new ContextGraph();
  const pipe = new Pipeline(graph, { log });
  const deferred = pipe.loadAll({
    dataDir: DATA_DIR,
    until,
    sellers: sellers && new Set(sellers),
    onProgress: (src, n) => quiet || process.stderr.write(`  loaded ${src.padEnd(17)} ${String(n).padStart(7)} rows\n`),
  });
  const replayed = log ? pipe.replayLog(log, { sellers: sellers && new Set(sellers) }) : 0;
  const ms = performance.now() - t0;
  if (!quiet) {
    const s = graph.stats();
    process.stderr.write(`  graph: ${s.nodes.toLocaleString()} nodes, ${s.edges.toLocaleString()} edges · ${replayed} logged events replayed · ${(ms / 1000).toFixed(1)}s\n`);
  }
  return { graph, pipe, deferred, ms };
}
