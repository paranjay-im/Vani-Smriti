// Proves the Neo4j store renders exactly what the in-memory store renders.
//   1. render parity : CSVs + event log -> memory graph and -> Neo4j (test instance); every seller file and the sample
//                      buyer files must be identical (generated_at and line endings ignored).
//   2. event parity  : load both up to a cutoff, replay the next N real events through both stores; after every event the
//                      files it affected must be identical.
// Needs the test instance:  docker compose --profile test up -d neo4j-test   and NEO4J_PASSWORD in .env.
// Usage: node tools/parity.mjs [--events 300] [--cutoff "2026-09-25 23:59:59"] [--skip-render]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryStore } from "../src/store/memory.js";
import { NeoStore } from "../src/store/neo.js";
import { NEO4J_TEST, EVENT_LOG, AS_OF, SAMPLE_BUYERS } from "../src/config.js";

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : process.argv[i + 1]?.startsWith("--") || process.argv[i + 1] === undefined ? true : process.argv[i + 1]; };
const nEvents = Number(arg("events", 300));
const cutoff = arg("cutoff", "2026-09-25 23:59:59");
const norm = (t) => t.replace(/\r\n/g, "\n").replace(/^generated_at: .*$/m, "generated_at: -");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gc-parity-"));
const dirs = { mem: path.join(tmp, "mem"), neo: path.join(tmp, "neo") };
const t = () => performance.now();
let failures = 0;

function firstDiff(a, b) {
  const A = norm(a).split("\n"), B = norm(b).split("\n");
  for (let i = 0; i < Math.max(A.length, B.length); i++) if (A[i] !== B[i]) return `line ${i + 1}\n      mem: ${A[i]}\n      neo: ${B[i]}`;
  return "(no line differs)";
}
function compareFile(role, id) {
  const sub = role === "buyer" ? "buyers" : "sellers";
  const a = path.join(dirs.mem, sub, `${id}.md`), b = path.join(dirs.neo, sub, `${id}.md`);
  const A = fs.readFileSync(a, "utf8"), B = fs.readFileSync(b, "utf8");
  return norm(A) === norm(B) ? null : firstDiff(A, B);
}

// Edges whose source or target node does not exist (orphan transcript turns). Memory keeps them; Neo4j cannot.
const countDangling = (g) => { let n = 0; for (const [s, , d] of g.edges()) if (!g.get(s) || !g.get(d)) n++; return n; };

const neoStore = (log) => new NeoStore({ log, cfg: NEO4J_TEST }).init();

// ---------------------------------------------------------------- 1. render parity
if (!arg("skip-render", false)) {
  console.log("1. render parity: build from CSVs + event log, render every seller from memory and from Neo4j");
  const mem = await new MemoryStore({ log: EVENT_LOG, quiet: true }).init();
  const neo = await neoStore(EVENT_LOG);
  let t0 = t();
  const loaded = await neo.bulkLoad(mem.graph);
  console.log(`   bulk load: ${loaded.nodes.toLocaleString()} nodes, ${loaded.edges.toLocaleString()} edges in ${((t() - t0) / 1000).toFixed(1)} s`);
  const sm = mem.graph.stats(), sn = await neo.stats();
  const dangling = countDangling(mem.graph);
  if (sm.nodes !== sn.nodes || sm.edges - dangling !== sn.edges) { failures++; console.log(`   FAIL counts: memory ${sm.nodes}/${sm.edges - dangling}, neo4j ${sn.nodes}/${sn.edges}`); }
  else console.log(`   counts match: ${sn.nodes.toLocaleString()} nodes / ${sn.edges.toLocaleString()} edges (${dangling} edges in memory point at a node that does not exist and are not stored in Neo4j)`);
  t0 = t();
  const ids = [];
  for await (const { glid, graph } of neo.sellerViews()) { await neo.write("seller", glid, { asOf: AS_OF, outDir: dirs.neo }, graph); ids.push(glid); }
  for (const b of SAMPLE_BUYERS) await neo.write("buyer", b, { asOf: AS_OF, outDir: dirs.neo });
  console.log(`   rendered ${ids.length} sellers + ${SAMPLE_BUYERS.length} buyers from Neo4j in ${((t() - t0) / 1000).toFixed(1)} s`);
  for await (const { glid, graph } of mem.sellerViews()) await mem.write("seller", glid, { asOf: AS_OF, outDir: dirs.mem }, graph);
  for (const b of SAMPLE_BUYERS) await mem.write("buyer", b, { asOf: AS_OF, outDir: dirs.mem });
  let bad = 0;
  for (const g of ids) { const d = compareFile("seller", g); if (d) { bad++; if (bad <= 3) console.log(`   DIFF seller ${g}: ${d}`); } }
  for (const b of SAMPLE_BUYERS) { const d = compareFile("buyer", b); if (d) { bad++; console.log(`   DIFF buyer ${b}: ${d}`); } }
  console.log(bad ? `   FAIL: ${bad} files differ` : `   OK: ${ids.length + SAMPLE_BUYERS.length} files identical`);
  failures += bad ? 1 : 0;
  await neo.close();
}

// ---------------------------------------------------------------- 2. event parity
console.log(`2. event parity: load up to ${cutoff}, replay ${nEvents} real events through both stores`);
const mem = await new MemoryStore({ until: cutoff, quiet: true }).init();
const seed = await new MemoryStore({ until: cutoff, quiet: true }).init();
const neo = await neoStore(null);
await neo.bulkLoad(seed.graph);
const events = mem.deferred.slice(0, nEvents);
let checked = 0, bad = 0;
const lat = { mem: [], neo: [] };
for (const ev of events) {
  let t0 = t();
  const am = await mem.apply(ev);
  lat.mem.push(t() - t0);
  t0 = t();
  const an = await neo.apply(ev);
  lat.neo.push(t() - t0);
  const same = (x, y) => [...x].sort().join() === [...y].sort().join();
  if (!same(am.sellers, an.sellers) || !same(am.buyers, an.buyers)) { bad++; console.log(`   DIFF affected owners for ${ev.source} @ ${ev.ts}: mem ${[...am.sellers]}/${[...am.buyers]} neo ${[...an.sellers]}/${[...an.buyers]}`); continue; }
  const opts = (d) => ({ asOf: ev.ts, outDir: dirs[d] });
  for (const g of am.sellers) {
    if (!mem.graph.get(`S:${g}`)) continue;
    await mem.write("seller", g, opts("mem"), am.view);
    await neo.write("seller", g, opts("neo"), an.view);
    const d = compareFile("seller", g); checked++;
    if (d) { bad++; if (bad <= 5) console.log(`   DIFF seller ${g} after ${ev.source} @ ${ev.ts}: ${d}`); }
  }
  for (const b of am.buyers) {
    await mem.write("buyer", b, opts("mem"), am.view);
    await neo.write("buyer", b, opts("neo"), an.view);
    const d = compareFile("buyer", b); checked++;
    if (d) { bad++; if (bad <= 5) console.log(`   DIFF buyer ${b} after ${ev.source} @ ${ev.ts}: ${d}`); }
  }
}
const pct = (a, p) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))].toFixed(1);
console.log(bad ? `   FAIL: ${bad} differences in ${checked} file comparisons over ${events.length} events` : `   OK: ${checked} file comparisons over ${events.length} events, all identical`);
console.log(`   apply latency (apply only, no render)  memory p50 ${pct(lat.mem, 0.5)} ms p95 ${pct(lat.mem, 0.95)} ms · neo4j p50 ${pct(lat.neo, 0.5)} ms p95 ${pct(lat.neo, 0.95)} ms`);
failures += bad ? 1 : 0;
const sm = mem.graph.stats(), sn = await neo.stats();
const danglingAfter = countDangling(mem.graph);
if (sm.nodes !== sn.nodes || sm.edges - danglingAfter !== sn.edges) { failures++; console.log(`   FAIL counts after replay: memory ${sm.nodes}/${sm.edges - danglingAfter}, neo4j ${sn.nodes}/${sn.edges}`); }
else console.log(`   counts after replay match: ${sn.nodes.toLocaleString()} / ${sn.edges.toLocaleString()}`);
await neo.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? "PARITY FAILED" : "PARITY OK");
process.exit(failures ? 1 : 0);
