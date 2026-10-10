// Freshness benchmark: load the snapshot up to a cutoff, then replay every later event in time order
// as a live stream. Each event is ingested, facts are re-extracted, and every affected seller.md /
// buyer.md is re-rendered and written. Latency = event received -> last affected file on disk.
import fs from "node:fs";
import path from "node:path";
import { openScratchStore } from "./store/index.js";
import { OUT_DIR } from "./config.js";
import { toCsv } from "./csv.js";

const q = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(p * arr.length))];
const summary = (ms) => {
  const s = [...ms].sort((a, b) => a - b);
  return { n: s.length, mean: s.reduce((a, b) => a + b, 0) / (s.length || 1), p50: q(s, 0.5), p95: q(s, 0.95), p99: q(s, 0.99), max: s.at(-1) };
};
const f = (x) => (x === undefined ? "–" : x.toFixed(2));

export async function runFreshness({ cutoff = "2026-09-25 23:59:59", limit = 0, sellers = null } = {}) {
  const t0 = performance.now();
  // With GC_STORE=neo4j this loads the snapshot into the disposable test instance and replays against it.
  const store = await openScratchStore({ until: cutoff, quiet: true, sellers });
  const deferred = store.deferred;
  const loadMs = performance.now() - t0;
  const dir = path.join(OUT_DIR, "freshness");
  const filesDir = path.join(dir, "files");
  fs.rmSync(filesDir, { recursive: true, force: true });
  const events = limit ? deferred.slice(0, limit) : deferred;
  const rows = [];
  for (const ev of events) {
    const t = performance.now();
    const affected = await store.apply(ev);
    let files = 0;
    for (const g of affected.sellers) if (affected.view ? affected.view.get(`S:${g}`) : await store.hasSeller(g)) { await store.write("seller", g, { asOf: ev.ts, outDir: filesDir }, affected.view); files++; }
    // Buyer files need every seller's data, so a selective run (sellers loaded alone) renders seller files only.
    if (!sellers) for (const b of affected.buyers) { await store.write("buyer", b, { asOf: ev.ts, outDir: filesDir }, affected.view); files++; }
    rows.push({ source: ev.source, event_ts: ev.ts, glid: [...affected.sellers][0] || "", buyer: [...affected.buyers][0] || "", files, ms: +(performance.now() - t).toFixed(3) });
  }
  await store.close?.();
  const all = summary(rows.map((r) => r.ms));
  const bySource = {};
  for (const r of rows) (bySource[r.source] ||= []).push(r.ms);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "latencies.csv"), toCsv(["source", "event_ts", "glid", "buyer", "files", "ms"], rows));
  const L = [
    "# Freshness evidence", "",
    `${sellers ? `**Selected sellers only: ${sellers.join(", ")}.** ` : ""}Snapshot loaded up to **${cutoff}** (${(loadMs / 1000).toFixed(1)} s). Then **${rows.length.toLocaleString()} real events** from ${events[0]?.ts || "–"} to ${events.at(-1)?.ts || "–"} were replayed one by one as a live stream.`,
    "For each event: ingest → link → extract facts → re-render every affected seller.md and buyer.md → atomic write to disk. The clock stops when the last file is written.", "",
    "| | events | mean ms | p50 ms | p95 ms | p99 ms | max ms |", "|---|---|---|---|---|---|---|",
    `| **all** | ${all.n} | ${f(all.mean)} | ${f(all.p50)} | ${f(all.p95)} | ${f(all.p99)} | ${f(all.max)} |`,
    ...Object.entries(bySource).sort((a, b) => b[1].length - a[1].length).map(([s, ms]) => { const x = summary(ms); return `| ${s} | ${x.n} | ${f(x.mean)} | ${f(x.p50)} | ${f(x.p95)} | ${f(x.p99)} | ${f(x.max)} |`; }),
    "", `Files written: ${rows.reduce((s, r) => s + r.files, 0).toLocaleString()} (to \`out/freshness/files/\`). Per-event rows: \`out/freshness/latencies.csv\`.`,
    "", "Measured in-process on this machine (Node " + process.versions.node + "). The HTTP path (`POST /events` on the server) adds the request round-trip; `node cli.js emit` reports both.", "",
  ];
  fs.writeFileSync(path.join(dir, "report.md"), L.join("\n"));
  return { all, bySource: Object.fromEntries(Object.entries(bySource).map(([k, v]) => [k, summary(v)])), file: path.join(dir, "report.md"), events: rows.length };
}
