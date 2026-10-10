import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SOURCES, SELLER_KEY, sellerOf } from "../src/sources.js";
import { ContextGraph } from "../src/graph.js";
import { Pipeline } from "../src/ingest.js";

// The repo's small fixture: the 11 CSVs filtered to 3 sellers.
const SAMPLE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "analysis", "sample_sellers", "csv");

test("every CSV source has a seller column", () => {
  for (const source of Object.keys(SOURCES)) assert.ok(SELLER_KEY[source], `no seller column for ${source}`);
});

test("sellerOf reads the right column for each source", () => {
  assert.equal(sellerOf({ source: "profile", row: { fk_glusr_usr_id: "1" } }), "1");
  assert.equal(sellerOf({ source: "enquiries", row: { seller_glid: "2", buyer_glid: "9" } }), "2");
  assert.equal(sellerOf({ source: "whatsapp", row: { glid: "3" } }), "3");
  assert.equal(sellerOf({ source: "bot_call_turns", row: { fk_glusr_usr_id: "4" } }), "4");
  assert.equal(sellerOf({ source: "vani_session", row: { glid: "5", role: "seller" } }), "5");
});

test("sellerOf returns null for a buyer session, an unknown source or a blank value", () => {
  assert.equal(sellerOf({ source: "vani_session", row: { glid: "5", role: "buyer" } }), null);
  assert.equal(sellerOf({ source: "nope", row: { glid: "5" } }), null);
  assert.equal(sellerOf({ source: "profile", row: { fk_glusr_usr_id: "" } }), null);
});

function load(sellers) {
  const g = new ContextGraph();
  new Pipeline(g).loadAll({ dataDir: SAMPLE, sellers });
  return g;
}

test("loading one seller keeps only that seller's nodes and the same seller profile", () => {
  const all = load(null);
  const sellerIds = [...all.nodes.values()].filter((n) => n.label === "Seller").map((n) => n.glid);
  assert.ok(sellerIds.length >= 2, "fixture should hold several sellers");
  const one = sellerIds[0];
  const some = load(new Set([one]));
  const owners = new Set([...some.nodes.values()].map((n) => n.glid).filter(Boolean));
  assert.deepEqual([...owners], [one]);
  assert.ok(some.nodes.size < all.nodes.size);
  assert.deepEqual(some.get(`S:${one}`).props, all.get(`S:${one}`).props);
  // everything the full load owns for this seller is present in the filtered load
  for (const label of all.labelsOf(one)) assert.equal(some.owned(one, label).length, all.owned(one, label).length, label);
});

test("an unknown GLID loads nothing", () => {
  assert.equal(load(new Set(["no-such-glid"])).nodes.size, 0);
});

// Real data: enquiry ENQ:3167201387 belongs to seller 266707625 but one of its messages is recorded under seller
// 116504812. A selective load of the enquiry's seller must still include that message.
test("a message recorded under another seller is kept for the enquiry's seller (real data)", async (t) => {
  const { loadGraph } = await import("../src/load.js");
  const { DATA_DIR } = await import("../src/config.js");
  const fs = await import("node:fs");
  if (!fs.existsSync(path.join(DATA_DIR, "gc_enquiry_messages.csv"))) return t.skip("input/ CSVs not present");
  const { graph } = loadGraph({ quiet: true, sellers: ["266707625"] });
  const ids = graph.outN("ENQ:3167201387", "HAS_MESSAGE").map((m) => m.id);
  assert.ok(ids.includes("EM:2413048808"), "foreign-owned message missing");
});
