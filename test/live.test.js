import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { lineDiff, liveHub } from "../src/live.js";
import { graphDiff, snapOwned } from "../src/graphdiff.js";
import { ContextGraph } from "../src/graph.js";
import { toolCall } from "../src/sarvam.js";

test("lineDiff marks added and removed lines in file order and ignores generated_at", () => {
  const a = "---\ngenerated_at: 1\nname: X\n---\n## Open loops\n- buyer waiting";
  const b = "---\ngenerated_at: 2\nname: X\n---\n## Open loops\n- Seller asked VANI: photos\n- buyer waiting";
  assert.deepEqual(lineDiff(a, b).filter(([k]) => k !== " "), [["+", "- Seller asked VANI: photos"]]);
  assert.deepEqual(lineDiff("a\nb", "a\nc").filter(([k]) => k !== " "), [["-", "b"], ["+", "c"]]);
  assert.deepEqual(lineDiff("", "x"), [["-", ""], ["+", "x"]]);
});

test("graphDiff reports new nodes, changed properties and new edges around a seller", () => {
  const g = new ContextGraph();
  g.upsert({ id: "S:1", label: "Seller", tier: "long_term", glid: "1", props: { company: "A" } });
  const before = snapOwned(g, ["1"]);
  g.upsert({ id: "S:1", label: "Seller", tier: "long_term", glid: "1", props: { city: "Pune" } });
  g.upsert({ id: "F:1", label: "Fact", tier: "reasoning", glid: "1", ts: "2026-10-10 10:00:00", props: { type: "seller_request" } });
  g.link("F:1", "ABOUT", "S:1");
  const d = graphDiff(before, snapOwned(g, ["1"]));
  assert.deepEqual(d.created.map((n) => [n.id, n.label]), [["F:1", "Fact"]]);
  assert.deepEqual(d.updated.map((n) => [n.id, n.changes.city]), [["S:1", [null, "Pune"]]]);
  assert.deepEqual(d.rels, [["F:1", "ABOUT", "S:1"]]);
  assert.equal(d.cypher.length, 3);
  assert.match(d.cypher[0], /^MERGE \(n:Node \{id: 'F:1'\}\) SET n:Fact:Reasoning/);
});

test("liveHub replays its buffer to a late page and streams new events", () => {
  const hub = liveHub();
  hub.emit("context", { glid: "1" });
  const frames = [];
  const res = { writeHead() {}, write: (f) => frames.push(f) };
  let close;
  const req = { headers: {}, on: (e, f) => { if (e === "close") close = f; } };
  hub.stream(req, res);
  hub.emit("tool_in", { kind: "request" });
  assert.equal(frames.length, 2);
  assert.match(frames[0], /"type":"context"/);
  assert.match(frames[1], /^id: 2\n/);
  close();
  hub.emit("end", {});
  assert.equal(frames.length, 2, "a closed page gets nothing more");
});

test("a tool call changes the seller's graph and file, and the request outranks a waiting buyer (real data)", async (t) => {
  const { DATA_DIR } = await import("../src/config.js");
  if (!fs.existsSync(path.join(DATA_DIR, "gc_seller_profile.csv"))) return t.skip("input/ CSVs not present");
  const { MemoryStore } = await import("../src/store/memory.js");
  const { renderSeller } = await import("../src/render.js");
  const glid = "272316904"; // has a buyer waiting for a reply
  const store = await new MemoryStore({ log: null, quiet: true, sellers: [glid] }).init();
  const at = "2026-10-03 10:05:00";
  assert.notEqual(renderSeller(store.graph, glid, { asOf: at }).fm.loops[0]?.type, "seller_request");
  const ev = toolCall("request", { glid, request_type: "buylead_issue", details: "Buy leads are from wrong cities" }, { ts: "2026-10-03 10:00:00" }).event;
  const { changes } = await store.apply(ev, { diff: true });
  assert.equal(changes.length, 1);
  const labels = changes[0].created.map((n) => n.label);
  assert.ok(labels.includes("Fact") && labels.includes("VaniSession"), labels.join(","));
  assert.ok(changes[0].rels.some(([, r, d]) => r === "ABOUT" && d === `S:${glid}`));
  assert.equal(renderSeller(store.graph, glid, { asOf: at }).fm.loops[0].type, "seller_request");
});
