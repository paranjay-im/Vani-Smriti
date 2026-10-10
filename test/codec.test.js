import test from "node:test";
import assert from "node:assert/strict";
import { encodeNode, decodeNode } from "../src/store/codec.js";

// Simulates the database: the driver (with disableLosslessIntegers) hands back plain JS values.
const roundTrip = (node, seq = 7) => decodeNode(node.label, JSON.parse(JSON.stringify(encodeNode(node, seq))));

test("scalars survive: strings, whole numbers, floats, booleans, unicode", () => {
  const node = { id: "X:1", label: "Enquiry", tier: "short_term", glid: "10", buyer: "20", ts: "2026-10-01 09:00:00",
    props: { product: "Steel बर्तन 🙏", read: true, qty: 120, price: 45.5, zero: 0, no: false } };
  const back = roundTrip(node);
  assert.deepEqual(back.props, node.props);
  assert.equal(back.glid, "10");
  assert.equal(back.buyer, "20");
  assert.equal(back.ts, node.ts);
  assert.equal(back.tier, "short_term");
  assert.equal(back.n, 7);
});

test("arrays and objects are stored as JSON and come back equal", () => {
  const props = { kyc: { mobile: true, gst: false }, turns: [{ speaker: "bot", text: "Namaste" }, { speaker: "seller", text: "haan" }], facts: ["a", "b"], empty: [] };
  const back = roundTrip({ id: "VS:1", label: "VaniSession", tier: "short_term", props });
  assert.deepEqual(back.props, props);
});

test("null, undefined and missing props are dropped, and ownerless nodes stay ownerless", () => {
  const back = roundTrip({ id: "C:1", label: "Category", tier: "long_term", props: { name: "Pumps", note: null, gone: undefined } });
  assert.deepEqual(back.props, { name: "Pumps" });
  assert.equal(back.glid, null);
  assert.equal(back.buyer, null);
  assert.equal(back.ts, null);
});

test("an application prop named like a system field is kept apart from it", () => {
  // Decision nodes carry their own `ts` prop next to the node timestamp.
  const props = { ts: "2026-10-01 10:00:00", id: "inner", glid: "not-the-owner", action: "promise" };
  const back = roundTrip({ id: "D:1:0", label: "Decision", tier: "reasoning", glid: "99", ts: "2026-10-01 10:00:01", props });
  assert.deepEqual(back.props, props);
  assert.equal(back.id, "D:1:0");
  assert.equal(back.glid, "99");
  assert.equal(back.ts, "2026-10-01 10:00:01");
});

test("whole numbers go through the integer converter, floats and unsafe integers do not", () => {
  const seen = [];
  const p = encodeNode({ id: "X", label: "L", tier: "long_term", props: { a: 3, b: 3.5, c: 2 ** 60 } }, 1, (n) => { seen.push(n); return n; });
  assert.deepEqual(seen.sort(), [1, 3]); // _n and a
  assert.equal(p.b, 3.5);
});
