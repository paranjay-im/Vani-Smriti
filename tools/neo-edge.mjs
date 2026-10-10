// Edge-case checks for the Neo4j store, run against the TEST instance (docker compose --profile test up -d neo4j-test):
//   1. 20 events fired at once at one store are serialised;  2. two stores writing at once lose updates (known limit);
//   3. a transaction that fails half way is rolled back.   Usage: node tools/neo-edge.mjs   (adds a few synthetic events to the test instance)
import { NeoStore } from "../src/store/neo.js";
import { ContextGraph } from "../src/graph.js";
import { buildEvent } from "../src/synthetic.js";
import { NEO4J_TEST } from "../src/config.js";

const glid = "245234426";
const store = await new NeoStore({ log: null, cfg: NEO4J_TEST }).init();
const count = async (label, g) => (await store.hydrate({ sellers: [g] })).owned(g, label).length;

// 1. 20 events fired at once at ONE store (the supported case): the queue must serialise them.
const before = await count("Enquiry", glid);
const events = Array.from({ length: 20 }, (_, i) => buildEvent({ type: "enquiry", glid, ts: `2026-10-04 10:${String(i).padStart(2, "0")}:00`, product: `Concurrent ${i}`, city: "Pune" }));
const t0 = performance.now();
await Promise.all(events.map((e) => store.apply(e)));
const after = await count("Enquiry", glid);
console.log(`1. concurrent applies on one store: enquiries ${before} -> ${after} (expected +${events.length}) in ${(performance.now() - t0).toFixed(0)} ms: ${after - before === events.length ? "PASS" : "FAIL"}`);
const g = await store.hydrate({ sellers: [glid] });
const seqs = [...g.nodes.values()].map((n) => n.id);
console.log(`   node ids unique after hydrate: ${new Set(seqs).size === seqs.length ? "PASS" : "FAIL"}`);

// 2. Two separate store objects writing the same seller at once (NOT supported): show what can happen.
const other = await new NeoStore({ log: null, cfg: NEO4J_TEST }).init();
const b2 = await count("Enquiry", glid);
const e2 = Array.from({ length: 10 }, (_, i) => buildEvent({ type: "enquiry", glid, ts: `2026-10-04 11:${String(i).padStart(2, "0")}:00`, product: `TwoWriters ${i}`, city: "Pune" }));
await Promise.all(e2.map((e, i) => (i % 2 ? other : store).apply(e)));
const a2 = await count("Enquiry", glid);
console.log(`2. two stores writing at once: enquiries ${b2} -> ${a2} (expected +${e2.length}): ${a2 - b2 === e2.length ? "no lost update this time" : "LOST UPDATES (documented limit: one writer process)"}`);
await other.close();

// 3. Rollback: an event whose edge type is rejected AFTER its node statements ran must leave nothing behind.
const orig = ContextGraph.prototype.link;
ContextGraph.prototype.link = function (s, r, d) { return orig.call(this, s, r === "HAS_MESSAGE" ? "BAD TYPE" : r, d); };
const marker = `rollback-${Date.now()}`;
const bad = { source: "enquiry_messages", row: { reply_id: marker, query_id: "3167201387", sequence: "99", sender_glid: "1", receiver_glid: "2", reply_date: "2026-10-04 12:00:00", subject: "x", reply_text: "should be rolled back", read_status: "0", first_read_date: "", template_flag: "", seller_glid: "266707625", message_from: "seller" } };
let threw = null;
try { await store.apply(bad); } catch (e) { threw = e.message; }
ContextGraph.prototype.link = orig;
const still = (await store.hydrate({ sellers: ["266707625"] })).get(`EM:${marker}`);
console.log(`3. rollback: apply threw "${threw}"; node left in database: ${still ? "YES -> FAIL" : "no -> PASS"}`);
// and the store still works afterwards
await store.apply(buildEvent({ type: "enquiry", glid, ts: "2026-10-04 13:00:00", product: "After rollback", city: "Pune" }));
console.log(`   store usable after the failure: PASS`);
await store.close();
