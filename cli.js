#!/usr/bin/env node
// Global Context — context layer CLI. Run `node cli.js help`.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { openStore, openScratchStore, rebuild } from "./src/store/index.js";
import { estimateTokens } from "./src/render.js";
import { VaniBot } from "./src/bot.js";
import { runDemo, genericScript } from "./src/demo.js";
import { runFreshness } from "./src/freshness.js";
import { execPrep, campaigns, dashboard } from "./src/reuse.js";
import { exportNeo4j } from "./src/export.js";
import { graphHtml } from "./src/viz.js";
import { startServer } from "./src/server.js";
import { buildEvent } from "./src/synthetic.js";
import { llmReady } from "./src/llm.js";
import { AS_OF, DEMO_LOG, EVENT_LOG, OUT_DIR, PORT, ROOT, SAMPLE_BUYERS, SAMPLE_SELLERS, SARVAM, STORE_KIND } from "./src/config.js";

const [cmd = "help", ...args] = process.argv.slice(2);
const opt = (name, def = undefined) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return def;
  return args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : true;
};
const pos = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--") && !["--buyer", "--llm", "--inbound", "--all"].includes(args[i - 1])));
const role = opt("buyer") ? "buyer" : "seller";
// --glid 1,2,3 and/or --glids-file path (one GLID per line, # comments) -> array of seller GLIDs, or null for "all".
function selectedGlids() {
  const list = [];
  const flag = opt("glid");
  if (flag === true) throw new Error("--glid needs a value, e.g. --glid 93557756,245234426");
  if (flag) list.push(...String(flag).split(","));
  const file = opt("glids-file");
  if (file === true) throw new Error("--glids-file needs a path");
  if (file) {
    if (!fs.existsSync(file)) throw new Error(`--glids-file: ${file} not found`);
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) list.push(...line.replace(/#.*$/, "").split(/[,\s]+/));
  }
  const glids = [...new Set(list.map((g) => g.trim()).filter(Boolean))];
  const bad = glids.filter((g) => !/^\d+$/.test(g));
  if (bad.length) throw new Error(`Invalid GLID(s): ${bad.join(", ")} (a GLID is digits only)`);
  return flag || file ? glids : null;
}

// build for chosen sellers: load only their rows (memory) or read the existing database (neo4j), write only their files.
async function buildSelected(glids) {
  const t0 = performance.now();
  let store;
  if (STORE_KIND === "neo4j") {
    store = await openStore({ kind: "neo4j", log: EVENT_LOG });
    await store.assertLoaded("GC_STORE=neo4j node cli.js build");
  } else {
    store = await openStore({ kind: "memory", log: EVENT_LOG, sellers: glids });
  }
  const t1 = performance.now();
  const written = [], missing = [];
  for (const g of glids) {
    if (!(await store.hasSeller(g))) { missing.push(g); continue; }
    written.push({ glid: g, tokens: (await store.write("seller", g, { asOf: AS_OF })).fm.tokens });
  }
  const counts = await store.counts();
  await store.close?.();
  console.log(`  selected ${glids.length} · written ${written.length} to ${rel(OUT_DIR)}/sellers/ · load ${((t1 - t0) / 1000).toFixed(1)}s (${counts.nodes.toLocaleString()} nodes) · render ${((performance.now() - t1) / 1000).toFixed(1)}s`);
  if (written.length) console.log(`  tokens: ${written.map((w) => `${w.glid}=${w.tokens}`).join(", ")}`);
  if (missing.length) console.error(`  warning: no seller profile for ${missing.join(", ")}: skipped, nothing written`);
  console.log("  other files in out/ were not touched and may be older than this run; build_stats.json is only written by a full build");
  if (!written.length) process.exitCode = 1;
}

// serve --files-only: serve the bot from context files that already exist; do not build the graph.
function filesOnlyFlag() {
  if (!opt("files-only")) return false;
  if (STORE_KIND === "neo4j") throw new Error("--files-only reads existing files and is not combined with GC_STORE=neo4j (the Neo4j server already starts without loading the CSVs)");
  return true;
}

const useLlm = async () => {
  if (!(opt("llm") || process.env.GC_LLM === "1")) return false;
  if (await llmReady()) return true;
  console.error("  --llm: @anthropic-ai/sdk is not installed (run `npm install`); using rule-based replies.");
  return false;
};
const rel = (f) => path.relative(ROOT, f);

const HELP = `Global Context — context layer (Node ${process.versions.node})

  node cli.js build [--glid a,b] [--glids-file f]
                                        Load all CSVs + event log into the context graph; write every seller.md and the sample buyer.md files.
                                        With --glid / --glids-file: load and write only those sellers (other files are left alone)
  node cli.js show <glid> [--buyer]     Print a context file
  node cli.js demo [--llm] [--glid a,b] Voice call -> write-back -> WhatsApp resume for the sample users (out/demo/); --glid runs any sellers
  node cli.js chat <glid> [--buyer] [--channel voice|whatsapp] [--inbound] [--llm]
                                        Talk to VANI yourself; the session is written back and the file refreshed
  node cli.js freshness [--cutoff "2026-09-25 23:59:59"] [--limit N] [--glid a,b]
                                        Replay real events after the cutoff as a live stream; measure event -> file delay
  node cli.js ui [--port ${PORT}] [--llm]     Test console in the browser (separate test data, resettable)
  node cli.js serve [--port ${PORT}] [--llm] [--files-only]
                                        HTTP context service + VANI Live at http://localhost:<port>/ (POST /events, GET /context/seller/<glid>, /sarvam/*).
                                        --files-only: serve only the sellers whose out/sellers/<glid>.md already exist; no CSV load
  node cli.js emit <glid> [--type enquiry|whatsapp|botcall] [--text "..."] [--product "..."] [--port ${PORT}]
                                        Send a synthetic live event to the running service and print the measured delay
  node cli.js test-seller [<glid>|--clear] [--port ${PORT}]
                                        Pick the seller the Sarvam agent talks to in text chat / dashboard tests (no glid passed)
  node cli.js prep <glid>               Executive call prep card generated from seller.md (non-bot use)
  node cli.js campaign                  WhatsApp campaign audiences + dialer suppression list + dashboard from the files
  node cli.js export-neo4j [--all]      CSV + Cypher for Neo4j (default: sample users' neighbourhoods)
  node cli.js graph <glid>              HTML view of one seller's context graph
`;

async function main() {
  const selected = selectedGlids();
  switch (cmd) {
    case "build": {
      if (selected) return buildSelected(selected);
      // CSVs + event log are always read into memory first. With GC_STORE=neo4j that graph is then copied into
      // Neo4j (replacing what was there) and every file is rendered back out of the database.
      const t0 = performance.now();
      const mem = await openStore({ kind: "memory", log: EVENT_LOG });
      const t1 = performance.now();
      let store = mem;
      if (STORE_KIND === "neo4j") {
        store = await openStore({ kind: "neo4j", log: EVENT_LOG });
        await store.bulkLoad(mem.graph, { onProgress: (what, k) => process.stderr.write(`  neo4j  ${what.padEnd(16)} ${String(k).padStart(7)}\n`) });
      }
      const t1b = performance.now();
      const toks = [];
      let n = 0;
      for await (const { glid, graph } of store.sellerViews()) {
        toks.push((await store.write("seller", glid, { asOf: AS_OF }, graph)).fm.tokens);
        n++;
      }
      for (const b of SAMPLE_BUYERS) await store.write("buyer", b, { asOf: AS_OF });
      const t2 = performance.now();
      toks.sort((a, b) => a - b);
      const q = (p) => toks[Math.floor(p * (toks.length - 1))];
      const stats = { as_of: AS_OF, store: store.kind, load_s: +((t1 - t0) / 1000).toFixed(1), ...(store.kind === "neo4j" ? { neo4j_load_s: +((t1b - t1) / 1000).toFixed(1) } : {}), render_s: +((t2 - t1b) / 1000).toFixed(1), sellers: n, buyers: SAMPLE_BUYERS.length,
        tokens: { p50: q(0.5), p90: q(0.9), p99: q(0.99), max: toks.at(-1) }, graph: await store.stats() };
      fs.mkdirSync(OUT_DIR, { recursive: true });
      fs.writeFileSync(path.join(OUT_DIR, "build_stats.json"), JSON.stringify(stats, null, 2));
      await store.close?.();
      console.log(`  wrote ${n} seller.md + ${SAMPLE_BUYERS.length} buyer.md to ${rel(OUT_DIR)} in ${stats.render_s}s · tokens p50 ${stats.tokens.p50}, p90 ${stats.tokens.p90}, max ${stats.tokens.max}`);
      console.log(`  samples: ${SAMPLE_SELLERS.map((s) => `out/sellers/${s}.md`).join(", ")}; ${SAMPLE_BUYERS.map((b) => `out/buyers/${b}.md`).join(", ")}`);
      return;
    }
    case "show": {
      const id = pos[0];
      const f = path.join(OUT_DIR, role === "buyer" ? "buyers" : "sellers", `${id}.md`);
      if (!fs.existsSync(f)) {
        const store = await openStore({ log: EVENT_LOG, quiet: true, sellers: role === "seller" && /^\d+$/.test(id) ? [id] : null });
        await store.write(role, id, { asOf: AS_OF });
        await store.close?.();
      }
      process.stdout.write(fs.readFileSync(f, "utf8"));
      return;
    }
    case "demo": {
      const llm = await useLlm();
      fs.rmSync(DEMO_LOG, { force: true });
      const store = await openScratchStore({ log: DEMO_LOG, quiet: false, sellers: selected });
      const scripts = JSON.parse(fs.readFileSync(path.join(ROOT, "demo", "scripts.json"), "utf8"));
      const only = opt("only");
      const results = [];
      const roles = selected ? ["seller"] : ["seller", "buyer"];
      const scriptsFor = (r) => (selected ? Object.fromEntries(selected.map((g) => [g, scripts.seller?.[g] || genericScript()])) : scripts[r] || {});
      for (const r of roles) {
        for (const [id, script] of Object.entries(scriptsFor(r))) {
          if (only && only !== id) continue;
          if (selected && !(await store.hasSeller(id))) { console.error(`  warning: no seller profile for ${id}: demo skipped`); continue; }
          const res = await runDemo({ store, role: r, glid: id, script, llm });
          results.push(res);
          const m = res.metrics;
          console.log(`  ${r} ${id}: skipped ${m.questions_skipped}/${m.cold_questions} cold questions · re-asked ${m.re_asks} · calls suppressed ${m.calls_suppressed} · resumed across channels: ${m.resumed_across_channels ? "yes" : "no"} · file refresh ${m.refresh_ms.join(" / ")} ms → ${rel(res.file)}`);
        }
      }
      const idx = ["# Demo runs", "", "Seller/buyer lines are synthetic (demo/scripts.json). Bot lines come from the context files and the policy layer.", "",
        "| User | Cold questions | Skipped | Re-asked | Calls suppressed | Resumed across channels | File refresh (ms) |", "|---|---|---|---|---|---|---|",
        ...results.map(({ file, metrics: m }) => `| [${m.role} ${m.glid}](${path.basename(file)}) | ${m.cold_questions} | ${m.questions_skipped} | ${m.re_asks} | ${m.calls_suppressed} | ${m.resumed_across_channels ? "yes" : "no"} | ${m.refresh_ms.join(", ")} |`), ""];
      fs.writeFileSync(path.join(OUT_DIR, "demo", "README.md"), idx.join("\n"));
      await store.close?.();
      return;
    }
    case "chat": {
      const llm = await useLlm();
      const id = pos[0];
      const channel = opt("channel", "voice");
      const store = await openStore({ log: EVENT_LOG, quiet: true, sellers: role === "seller" && /^\d+$/.test(id) ? [id] : null });
      const at = opt("at", AS_OF);
      const { file, md } = await store.write(role, id, { asOf: at });
      const bot = new VaniBot({ md, channel, direction: opt("inbound") ? "inbound" : "outbound", now: at, llm });
      console.log(`  loaded ${rel(file)} (${estimateTokens(md)} tokens) · ${channel} · type your replies, empty line to end\n`);
      // Line iterator instead of rl.question(): works for a terminal and for piped input alike.
      const rl = readline.createInterface({ input: process.stdin, terminal: false });
      const lines = rl[Symbol.asyncIterator]();
      const who = role === "buyer" ? "Buyer" : "Seller";
      const ask = async () => {
        process.stdout.write(`${who}: `);
        const { value, done } = await lines.next();
        if (!process.stdin.isTTY && !done) process.stdout.write(`${value}\n`);
        return done ? "" : value;
      };
      const first = opt("inbound") ? await ask() : null;
      const s = await bot.start(first);
      if (s.suppressed) console.log("  [policy] outbound call not placed: contact_policy = do_not_call");
      else console.log(`VANI: ${s.text}`);
      for (const q of bot.skipped) console.log(`  [skipped] ${q.id}: ${q.known(bot)}`);
      while (!bot.ended) {
        const line = await ask();
        if (!line.trim()) break;
        console.log(`VANI: ${await bot.reply(line)}`);
      }
      rl.close();
      const t0 = performance.now();
      const done = await store.apply(bot.end(), { persist: true });
      const w = await store.write(role, id, { asOf: bot.clock }, done.view);
      await store.close?.();
      console.log(`\n  session written back; ${rel(w.file)} refreshed in ${(performance.now() - t0).toFixed(1)} ms`);
      return;
    }
    case "freshness": {
      const r = await runFreshness({ cutoff: opt("cutoff", "2026-09-25 23:59:59"), limit: Number(opt("limit", 0)), sellers: selected });
      console.log(`  replayed ${r.events} events · p50 ${r.all.p50.toFixed(2)} ms · p95 ${r.all.p95.toFixed(2)} ms · p99 ${r.all.p99.toFixed(2)} ms · max ${r.all.max.toFixed(2)} ms → ${rel(r.file)}`);
      return;
    }
    case "serve":
      await startServer({ port: Number(opt("port", PORT)), llm: await useLlm(), filesOnly: filesOnlyFlag() });
      return;
    case "ui": {
      // Test console on its own event log and output folder, so testing never changes the real files.
      const port = Number(opt("port", PORT));
      await startServer({ port, llm: await useLlm(), log: path.join(ROOT, "store", "ui_events.jsonl"), outDir: path.join(OUT_DIR, "ui"), eager: false, scratch: !filesOnlyFlag(), filesOnly: filesOnlyFlag() });
      console.log(`  open http://localhost:${port}/console in your browser  (Ctrl+C to stop)`);
      return;
    }
    case "test-seller": {
      const base = `http://localhost:${Number(opt("port", PORT))}/sarvam/test-seller`;
      const set = pos[0] !== undefined || opt("clear");
      const r = await fetch(base, set ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ glid: opt("clear") ? "" : pos[0] }) } : {});
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || r.statusText);
      console.log(j.glid ? `  Sarvam test seller: ${j.glid}` : "  no test seller set: calls without a glid run cold");
      if (j.glid) { // what the agent will load at call start
        const c = await fetch(base.replace("test-seller", "context"), { headers: { "x-gc-token": SARVAM.token } }).then((x) => x.json());
        console.log(c.found === "1" ? `  ${c.seller_company_name} · ${c.seller_city}
  opens with: ${c.call_reason}` : "  not found in the data: the agent will call it cold");
      }
      return;
    }
    case "emit": {
      const glid = pos[0];
      const type = opt("type", "enquiry");
      const ts = `2026-10-03 ${new Date().toTimeString().slice(0, 8)}`;
      const events = buildEvent({ type, glid, ts, text: opt("text", null), product: opt("product", "Sample Product"), city: opt("city", "Pune"), disposition: opt("disposition", "General (talked)") });
      const port = Number(opt("port", PORT));
      const t0 = performance.now();
      const res = await fetch(`http://localhost:${port}/events`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(events) });
      const out = await res.json();
      const rt = performance.now() - t0;
      console.log(`  [synthetic ${type} event at ${ts}] server: event -> files written in ${out.latency_ms} ms · HTTP round trip ${rt.toFixed(1)} ms · files: ${out.files.join(", ")}`);
      const md = await (await fetch(`http://localhost:${port}/context/seller/${glid}`)).text();
      const fm = md.split("\n").filter((l) => /^(flags|contact_policy|loops|generated_at|watermark): /.test(l));
      console.log(fm.map((l) => `    ${l}`).join("\n"));
      return;
    }
    case "prep": {
      const f = path.join(OUT_DIR, "sellers", `${pos[0]}.md`);
      if (!fs.existsSync(f)) throw new Error(`${rel(f)} not found — run \`node cli.js build\` first`);
      const card = execPrep(fs.readFileSync(f, "utf8"));
      const out = path.join(OUT_DIR, "reuse", `exec_prep_${pos[0]}.md`);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, card);
      console.log(card);
      console.log(`  → ${rel(out)}`);
      return;
    }
    case "campaign": {
      const c = campaigns();
      const d = dashboard();
      console.log(`  read ${c.files} seller.md files → ${c.buyer_waiting} sellers for the "buyer waiting" WhatsApp nudge, ${c.suppression} on the dialer suppression list, ${c.catalog_photos} for the catalog-photo nudge`);
      console.log(`  → ${rel(c.dir)}/campaign_buyer_waiting.csv, dialer_suppression_list.csv, campaign_catalog_photos.csv, ${rel(d)}`);
      return;
    }
    case "export-neo4j": {
      const { graph } = await openStore({ kind: "memory", log: EVENT_LOG, quiet: true });
      const r = exportNeo4j(graph, { sellers: SAMPLE_SELLERS, buyers: SAMPLE_BUYERS, all: Boolean(opt("all")) });
      console.log(`  ${r.nodes.toLocaleString()} nodes (${r.labels} labels), ${r.rels.toLocaleString()} relationships (${r.relTypes} types) → ${rel(r.dir)}/ (load.cypher, queries.cypher)`);
      return;
    }
    case "graph": {
      const store = await openStore({ log: EVENT_LOG, quiet: true, sellers: /^\d+$/.test(pos[0] || "") ? [pos[0]] : null });
      const r = graphHtml(await store.neighbourhood(pos[0]), pos[0]);
      await store.close?.();
      console.log(`  ${r.nodes} nodes, ${r.edges} edges → ${rel(r.file)}`);
      return;
    }
    default:
      console.log(HELP);
  }
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
