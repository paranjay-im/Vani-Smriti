import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseWhen, toTurns, outcomeFacts, sarvamToSession, toolCall, sellerVars, callReason, AGENT_DEFAULTS, DEFAULT_REASON } from "../src/sarvam.js";

const TS = "2026-10-03 10:00:00";

test("parseWhen reads the shapes an agent sends", () => {
  assert.equal(parseWhen("2026-10-11", "16:00"), "2026-10-11 16:00:00");
  assert.equal(parseWhen("2026-10-11", "4 PM"), "2026-10-11 16:00:00");
  assert.equal(parseWhen("2026-10-11", "4:30pm"), "2026-10-11 16:30:00");
  assert.equal(parseWhen("2026-10-11", "12 am"), "2026-10-11 00:00:00");
  assert.equal(parseWhen("2026-10-11T11:15"), "2026-10-11 11:15:00");
  assert.equal(parseWhen("2026-10-11 16:00:00"), "2026-10-11 16:00:00");
  assert.equal(parseWhen("kal", "4 PM"), null);
  assert.equal(parseWhen("2026-10-11"), null); // a day without a time is not bookable
  assert.equal(parseWhen("2026-10-11", "shaam"), null);
});

test("toTurns maps Sarvam's transcript list and a plain-text transcript", () => {
  const a = toTurns([{ role: "agent", en_text: "Hello, am I speaking with PT More Enterprises?" }, { role: "user", en_text: "Yes", indic_text: "haan ji" }], TS);
  assert.deepEqual(a.map((t) => t.speaker), ["bot", "seller"]);
  assert.equal(a[1].text, "Yes | haan ji");
  const b = toTurns("agent: Namaste\nuser: abhi busy hoon,\nkal call karna", TS);
  assert.deepEqual(b.map((t) => [t.speaker, t.text]), [["bot", "Namaste"], ["seller", "abhi busy hoon, kal call karna"]]);
  assert.deepEqual(toTurns(null, TS), []);
});

test("outcomeFacts turns output variables into facts and skips what a tool already saved", () => {
  const v = { disposition_label: "Meeting Fixed", meeting_fixed: "1", meeting_datetime: "2026-10-11 16:00", meeting_location: "Vijay Nagar, Indore" };
  const f = outcomeFacts(v);
  assert.equal(f.length, 1);
  assert.equal(f[0].type, "meeting_fixed");
  assert.equal(f[0].due, "2026-10-11 16:00:00");
  assert.deepEqual(outcomeFacts(v, new Set(["meeting_fixed"])), []);
  assert.deepEqual(outcomeFacts({ objection_type: "Wrong Contact / Business Not Applicable" }).map((x) => x.type), ["wrong_contact"]);
  assert.deepEqual(outcomeFacts({ do_not_call_requested: "1", objection_type: "Explicit Disinterest / Refusal" }).map((x) => x.type), ["do_not_call"]);
});

test("sarvamToSession accepts a Sarvam webhook payload", () => {
  const ev = sarvamToSession({
    app_id: "a", app_version: 1, attempt_id: "att1", campaign_id: "c", cohort_id: "h", completion_status: "completed",
    user_identifier: "245234426", user_phone_number: "+910000000000", duration: 95,
    interaction_id: "int-1",
    interaction_transcript: [{ role: "agent", en_text: "Hello" }, { role: "user", en_text: "Call me tomorrow at 5 PM" }],
    output_agent_variables: { disposition_label: "Call Later / Busy", callback_datetime: "2026-10-11 17:00" },
  }, { ts: TS });
  assert.equal(ev.source, "vani_session");
  assert.equal(ev.row.glid, "245234426");
  assert.equal(ev.row.session_id, "sarvam-int-1");
  assert.equal(ev.row.turns.length, 2);
  assert.equal(ev.row.end_ts, "2026-10-03 10:02:00");
  assert.deepEqual(ev.row.facts.map((f) => [f.type, f.due]), [["callback_requested", "2026-10-11 17:00:00"]]);
  assert.match(ev.row.summary, /Call Later/);
  assert.equal(sarvamToSession({ interaction_id: "x" }, { ts: TS }), null); // no seller: nothing to write
  // the test seller (fallback) beats a digits-only user_identifier, which may be a phone number; a passed glid beats both
  assert.equal(sarvamToSession({ interaction_id: "y", user_identifier: "919800000000" }, { ts: TS, glid: "93557756" }).row.glid, "93557756");
  assert.equal(sarvamToSession({ interaction_id: "z", glid: "245234426" }, { ts: TS, glid: "93557756" }).row.glid, "245234426");
});

test("toolCall validates a meeting before saving it", () => {
  const bad = toolCall("meeting", { glid: "245234426", meeting_date: "2026-10-11", meeting_time: "9 PM", locality: "Vijay Nagar", city: "Indore" }, { ts: TS });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /working hours/);
  assert.equal(toolCall("meeting", { glid: "245234426", meeting_date: "2026-10-11", meeting_time: "4 PM" }, { ts: TS }).ok, false); // no location
  const ok = toolCall("meeting", { glid: "245234426", interaction_id: "i9", meeting_date: "2026-10-11", meeting_time: "4 PM", locality: "Vijay Nagar", city: "Indore" }, { ts: TS });
  assert.equal(ok.ok, true);
  assert.equal(ok.event.row.session_id, "sarvam-i9-meeting");
  assert.deepEqual(ok.event.row.facts.map((f) => [f.type, f.due]), [["meeting_fixed", "2026-10-11 16:00:00"]]);
  assert.equal(toolCall("dnc", { glid: "abc" }, { ts: TS }).ok, false);
  assert.equal(toolCall("callback", { glid: "1" }, { ts: TS }).ok, false);
});

test("sellerVars without a graph still gives every prompt variable", () => {
  const v = sellerVars(null, "999", { fm: null, md: "", asOf: TS });
  for (const k of Object.keys(AGENT_DEFAULTS)) assert.ok(k in v, k);
  for (const k of ["seller_context", "seller_company_name", "pitch_hook", "lead_bucket", "do_not_call_requested", "already_in_touch_with_executive", "initial_message"]) assert.ok(k in v, k);
  assert.equal(v.found, "0");
  assert.ok(Object.values(v).every((x) => typeof x === "string"));
});

// Real data: a meeting booked by the agent shows up in the seller's file and in the next call's variables.
test("a booked meeting is written back and read by the next call (real data)", async (t) => {
  const { DATA_DIR, AS_OF } = await import("../src/config.js");
  if (!fs.existsSync(path.join(DATA_DIR, "gc_seller_profile.csv"))) return t.skip("input/ CSVs not present");
  const { MemoryStore } = await import("../src/store/memory.js");
  const { renderSeller } = await import("../src/render.js");
  const glid = "100160824";
  const store = await new MemoryStore({ log: null, quiet: true, sellers: [glid] }).init();
  const before = sellerVars(store.graph, glid, { fm: renderSeller(store.graph, glid, { asOf: AS_OF }).fm, md: "", asOf: AS_OF });
  assert.equal(before.found, "1");
  assert.ok(before.seller_company_name);
  const ts = "2026-10-03 10:00:00";
  const r = toolCall("meeting", { glid, interaction_id: "t1", meeting_date: "2026-10-11", meeting_time: "11:30", locality: "Main Market", city: before.seller_city || "Delhi" }, { ts });
  await store.apply(r.event);
  const asOf = "2026-10-03 10:05:00";
  const { md, fm } = renderSeller(store.graph, glid, { asOf });
  assert.ok(fm.flags.includes("meeting_fixed"), "flag set");
  assert.match(md, /Meeting fixed through VANI for 11 Oct 11:30/);
  const after = sellerVars(store.graph, glid, { fm, md, asOf });
  assert.equal(after.already_in_touch_with_executive, "1");
  assert.equal(after.lead_bucket, "follow_up");
  assert.equal(after.last_meeting_date, "3 Oct");
  assert.ok(!after.seller_context.startsWith("---"), "front matter stripped");
});

test("log_seller_request records a request, and the call opens with the seller's open loop", () => {
  assert.equal(toolCall("request", { glid: "245234426", request_type: "catalog_update" }, { ts: TS }).ok, false); // no details
  const r = toolCall("request", { glid: "245234426", interaction_id: "i7", request_type: "enquiry_reply", details: "Reply to the Ahmedabad buyer: Rs 450 per kg, MOQ 10 kg, dispatch in 3 days" }, { ts: TS });
  assert.equal(r.ok, true);
  assert.deepEqual(r.event.row.facts.map((f) => f.type), ["seller_request"]);
  assert.match(r.event.row.facts[0].evidence, /^Reply to a waiting buyer: Reply to the Ahmedabad buyer: Rs 450/);
  assert.match(toolCall("request", { glid: "1", request_type: "nonsense", details: "x" }, { ts: TS }).event.row.facts[0].evidence, /^Other request/);
  assert.equal(callReason({ loops: [{ type: "unanswered_enquiry", on: "30 Sep", product: "Brazing Rod", city: "Ahmedabad" }] }),
    "a buyer from Ahmedabad sent an enquiry for Brazing Rod on 30 Sep and has had no reply yet");
  assert.match(callReason({ loops: [] }, { product_count: 4 }), /only 4 products/);
  assert.equal(callReason({ loops: [] }, { product_count: 40, cqs: 80 }), "");
  assert.equal(sellerVars(null, "999", { fm: null, md: "", asOf: TS }).call_reason, DEFAULT_REASON);
});

test("a logged request becomes an open loop in the seller's file (real data)", async (t) => {
  const { DATA_DIR } = await import("../src/config.js");
  if (!fs.existsSync(path.join(DATA_DIR, "gc_seller_profile.csv"))) return t.skip("input/ CSVs not present");
  const { MemoryStore } = await import("../src/store/memory.js");
  const { renderSeller } = await import("../src/render.js");
  const glid = "100160824";
  const store = await new MemoryStore({ log: null, quiet: true, sellers: [glid] }).init();
  await store.apply(toolCall("request", { glid, request_type: "photo_help", details: "Add 3 photos of steel almirah sent on WhatsApp" }, { ts: "2026-10-03 10:00:00" }).event);
  const { md, fm } = renderSeller(store.graph, glid, { asOf: "2026-10-03 10:05:00" });
  assert.equal(fm.loops[0].type, "seller_request");
  assert.match(md, /Seller asked VANI: Product photos: Add 3 photos of steel almirah/);
  assert.match(md, /Follow up on the seller's open request/);
  const v = sellerVars(store.graph, glid, { fm, md, asOf: "2026-10-03 10:05:00" });
  assert.match(v.call_reason, /^following up on the seller's earlier request: Product photos/);
});
