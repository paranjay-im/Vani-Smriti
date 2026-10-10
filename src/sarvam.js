// Sarvam Voice Agents integration: the agent runs on Sarvam's platform and this context layer is its memory.
//   on_start tool  -> GET  /sarvam/context?glid=   the seller's context file + the prompt's input variables
//   mid-call tools -> POST /sarvam/meeting | /sarvam/callback | /sarvam/dnc | /sarvam/request   outcomes written into the graph at once
//   on_end tool    -> POST /sarvam/end             transcript + output variables -> one vani_session event
// The same /sarvam/end also accepts Sarvam's call webhook payload (deployments and campaigns).
import fs from "node:fs";
import path from "node:path";
import { factView } from "./extract.js";
import { addMin, daysBetween, dmy, norm } from "./time.js";
import { ROOT, SARVAM } from "./config.js";

// Values the organisers' prompt needs that no record holds: who the agent is and when executives can visit.
export const AGENT_DEFAULTS = {
  bot_name: "Payal",
  meeting_day_label: "kal",
  meeting_slot_start: "10:00 AM",
  meeting_slot_end: "7:00 PM",
  meeting_blocked_dates: "",
  same_day_meeting_allowed: "0",
  min_lead_minutes: "120",
  phone_meeting_allowed: "0",
  executive_name: "",
  redial_reason: "",
  lead_bot_version: "context-layer-1",
  call_attempt_count: "1",
  turn_intent: "",
  current_phase: "IDENTITY",
  off_topic_counter: "0",
};
export const GREETING = "Hello, this is a call from IndiaMART.";
const SLOT = { from: 10 * 60, to: 19 * 60 }; // executive working window, minutes after midnight
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
// "2026-10-10 18:30, Saturday" in India time. The platform's own current_datetime cannot be used inside this prompt.
export function nowIst(now = Date.now()) {
  const d = new Date(now + 330 * 60000);
  return `${d.toISOString().slice(0, 16).replace("T", " ")}, ${DAYS[d.getUTCDay()]}`;
}
const LANGS = ["Hindi", "English", "Telugu"];

const mostCommon = (xs) => {
  const c = new Map();
  for (const x of xs.filter(Boolean)) c.set(x, (c.get(x) || 0) + 1);
  return [...c].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
};
// The first thing worth raising, from the seller's open loops (render.js front matter), so the call opens with help
// the records support rather than a pitch. Buyers are never named: only their city and product.
const LOOP_REASON = {
  buyer_waiting_reply: (l) => `a buyer from ${l.city} is waiting for the seller's reply about ${l.product}`,
  unanswered_enquiry: (l) => `a buyer from ${l.city} sent an enquiry for ${l.product} on ${l.on} and has had no reply yet`,
  missed_buyer_call: (l) => `a buyer from ${l.city} called the seller on ${l.on} and the call was missed`,
  callback_due: (l) => `the seller asked IndiaMART to call back${l.due ? ` (${l.due.slice(0, 16)})` : ""}`,
  meeting_check: (l) => `the executive visit fixed${l.due ? ` for ${l.due.slice(0, 16)}` : ""}: confirm it still suits the seller if it is upcoming, or ask whether it happened and helped`,
  whatsapp_unfinished: (l) => `on IndiaMART's WhatsApp the seller was ${l.topic} and the chat stopped midway`,
  photo_pending: () => "product photos the seller sent on WhatsApp were not added to the catalogue (photos must be at least 500 by 500 pixels)",
  seller_request: (l) => `following up on the seller's earlier request: ${l.text}`,
};
export const DEFAULT_REASON = "a check on how IndiaMART is working for the seller and whether anything in the account needs help";
export function callReason(fm, eng = {}) {
  for (const l of fm?.loops || []) if (LOOP_REASON[l.type]) return LOOP_REASON[l.type](l);
  const n = eng.product_count, q = eng.cqs;
  if (n != null && n < 10) return `the seller's catalogue lists only ${n} products, so buyers searching IndiaMART find few of them`;
  if (q != null && q < 50) return `the seller's catalogue quality score is ${q} out of 100; better photos, prices and specifications bring more enquiries`;
  return "";
}

const stripFrontMatter = (md) => md.replace(/^---\n[\s\S]*?\n---\n+/, "").trim();

// Plain sentences the prompt states at the top. The prompt's own {% if %} blocks on these flags were not followed in
// testing, so the rule reaches the model as text that does not depend on template evaluation.
export function restrictions({ dnc = false, inTouch = false, lastMeet = "" } = {}) {
  if (dnc) return "This seller has already asked IndiaMart to stop calling, and the request is already recorded. As soon as identity is confirmed, call end_interaction with this closing message in the seller's language: Maaf kijiye, aapko pareshaan karne ke liye kshama chahti hoon. Aapki baat note hai, aapko is baare mein ab call nahi kiya jayega. Dhanyavaad. Offer no help, mention no buyer and ask no question.";
  if (inTouch) return `This seller is already in touch with an IndiaMart executive${lastMeet ? ` (last recorded: ${lastMeet})` : ""}. Do not offer another executive visit unless the seller asks for one; help directly, and if a visit was fixed, ask once whether it happened and went well.`;
  return "None.";
}

// Every input variable of the prompt, as strings (Sarvam variables are text). `graph` must hold the seller.
export function sellerVars(graph, glid, { fm, md, asOf }) {
  const S = graph?.get(`S:${glid}`);
  const base = { ...AGENT_DEFAULTS, glid: String(glid), found: S ? "1" : "0", seller_context: md ? stripFrontMatter(md) : "" };
  const company = S?.props.company || fm?.name || "";
  base.seller_company_name = company || "the IndiaMART seller";
  // The agent's greeting, spoken before these variables arrive, so it cannot name the business (prompt change 15).
  base.initial_message = GREETING;
  if (!S) return { ...base, call_restrictions: restrictions(), seller_city: "", seller_locality: "", seller_state: "", language_name: "Hindi", lead_bucket: "profile_review",
    pitch_hook: "a free review of the seller's IndiaMART profile and catalogue", call_reason: DEFAULT_REASON, category_name: "", inquiry_city: "", enquiry_count_30d: "",
    products_total: "", products_missing_photos: "", already_in_touch_with_executive: "0", last_meeting_date: "", do_not_call_requested: "0", past_objections: "" };

  const p = S.props;
  const upto = (n) => !n.ts || n.ts <= asOf;
  const enq30 = graph.owned(glid, "Enquiry").filter((e) => upto(e) && e.ts && daysBetween(e.ts, asOf) <= 30);
  const bl45 = graph.owned(glid, "BuyLead").filter((b) => upto(b) && b.ts && daysBetween(b.ts, asOf) <= 45);
  const view = factView(graph, { glid }, asOf);
  const met = [view.meeting_fixed, view.already_met_executive].filter((f) => f && f.active);
  const inTouch = met.length > 0 || p.vani?.in_touch_exec === true;
  const lastMeet = met.map((f) => f.latest?.ts).filter(Boolean).sort().at(-1);
  const lang = (fm?.lang || []).find((l) => LANGS.includes(l)) || "Hindi";
  const inquiryCity = mostCommon(enq30.map((e) => e.props.buyer_city));
  const category = (p.categories || [])[0] || p.parent_category || "";

  // Why this seller is being called. Only reasons the records support; the prompt forbids invented ones.
  let lead_bucket, pitch_hook;
  // A do-not-call seller should not be dialled at all (campaign lists exclude them). If the call happens anyway, the reason
  // the agent follows most closely says to stop: in testing the agent pitched despite the restriction text alone.
  if (fm?.contact_policy === "do_not_call") { lead_bucket = "do_not_call"; pitch_hook = "no pitch: this seller asked IndiaMart to stop calling, so apologise once, confirm they will not be called again, and end the call"; }
  else if (inTouch) { lead_bucket = "follow_up"; pitch_hook = "a follow-up after the seller's previous meeting with an IndiaMART executive"; }
  else if (bl45.length) { lead_bucket = "buy_leads"; pitch_hook = `the seller bought ${bl45.length} buy leads on IndiaMART in the last 45 days`; }
  else if (enq30.length) { lead_bucket = "category_enquiries"; pitch_hook = `the seller received ${enq30.length} buyer enquiries in the last 30 days${inquiryCity ? `, including from buyers in ${inquiryCity}` : ""}`; }
  else { lead_bucket = "profile_review"; pitch_hook = "a free review of the seller's IndiaMART profile and catalogue"; }

  const dnc = fm?.contact_policy === "do_not_call";
  return {
    ...base,
    call_restrictions: restrictions({ dnc, inTouch, lastMeet: lastMeet ? dmy(lastMeet) : "" }),
    call_reason: dnc ? pitch_hook : callReason(fm, p.eng) || pitch_hook,
    seller_city: p.city || "",
    seller_locality: p.locality || "",
    seller_state: p.state || "",
    language_name: lang,
    lead_bucket,
    pitch_hook,
    category_name: category,
    inquiry_city: enq30.length ? inquiryCity : "",
    enquiry_count_30d: enq30.length ? String(enq30.length) : "",
    products_total: p.eng?.product_count != null ? String(p.eng.product_count) : "",
    products_missing_photos: "",
    already_in_touch_with_executive: inTouch ? "1" : "0",
    last_meeting_date: lastMeet ? dmy(lastMeet) : "",
    do_not_call_requested: dnc ? "1" : "0",
    past_objections: String(p.vani?.objections || "").slice(0, 200),
  };
}

// ---------------------------------------------------------------- call results -> vani_session events

const s = (v) => (v === null || v === undefined ? "" : String(v).trim());
const yes = (v) => ["1", "true", "yes"].includes(s(v).toLowerCase());
const clip = (t, n = 160) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

// "2026-10-11 16:00", "2026-10-11T4:00 PM", or a date plus a time ("16:00", "4 PM", "4:30pm") -> "YYYY-MM-DD HH:MM:SS".
// A date without a time, or anything unreadable, gives null: the caller asks the seller again.
export function parseWhen(date, time = "") {
  const d = s(date);
  const day = d.slice(0, 10);
  if (!/^\d{4}-\d\d-\d\d$/.test(day)) return null;
  const t = s(time) || d.slice(10).replace(/^T/, "").trim();
  const m = /^(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*(am|pm)?$/i.exec(t);
  if (!m) return null;
  let h = Number(m[1]);
  if (m[3]) h = (h % 12) + (m[3].toLowerCase() === "pm" ? 12 : 0);
  if (h > 23 || Number(m[2] || 0) > 59) return null;
  return norm(`${day} ${String(h).padStart(2, "0")}:${m[2] || "00"}:00`);
}

// Transcript as Sarvam sends it (list of {role, en_text, indic_text}) or as a plain "agent: …\nuser: …" string.
export function toTurns(transcript, ts) {
  let list = [];
  if (Array.isArray(transcript)) list = transcript;
  else if (typeof transcript === "string" && transcript.trim()) {
    try { const j = JSON.parse(transcript); if (Array.isArray(j)) list = j; } catch { /* plain text */ }
    if (!list.length) {
      for (const line of transcript.split(/\r?\n/)) {
        const m = /^\s*(agent|bot|assistant|ai|user|customer|seller|human)\s*[:\-]\s*(.+)$/i.exec(line);
        if (m) list.push({ role: /agent|bot|assistant|ai/i.test(m[1]) ? "agent" : "user", en_text: m[2] });
        else if (list.length && line.trim()) list.at(-1).en_text += ` ${line.trim()}`;
      }
    }
  }
  return list.map((t, i) => {
    const en = s(t.en_text ?? t.text ?? t.content);
    const indic = s(t.indic_text);
    const role = s(t.role ?? t.speaker).toLowerCase();
    return { speaker: /agent|bot|assistant/.test(role) ? "bot" : "seller", text: clip(indic && indic !== en ? `${en} | ${indic}` : en, 400), ts: addMin(ts, i * 0.25) };
  }).filter((t) => t.text);
}

// Facts the call established, from the agent's output variables. `skip` holds the types a mid-call tool already recorded.
export function outcomeFacts(v, skip = new Set()) {
  const out = [];
  const add = (type, evidence, due = null) => { if (!skip.has(type) && !out.some((f) => f.type === type)) out.push({ type, evidence, due }); };
  if (yes(v.do_not_call_requested)) add("do_not_call", "Asked IndiaMART to stop calls (Sarvam agent call)");
  if (yes(v.meeting_fixed)) add("meeting_fixed", `Meeting booked by the Sarvam agent${s(v.meeting_datetime) ? ` for ${s(v.meeting_datetime)}` : ""}${s(v.meeting_location) ? ` at ${s(v.meeting_location)}` : ""}`, parseWhen(v.meeting_datetime));
  if (s(v.callback_datetime)) add("callback_requested", `Asked to be called back at ${s(v.callback_datetime)}`, parseWhen(v.callback_datetime));
  const obj = s(v.objection_type);
  if (/Wrong Contact/i.test(obj)) add("wrong_contact", "Said this is the wrong number / not the right business");
  if (/Existing Engagement/i.test(obj)) add("already_met_executive", "Said they are already in touch with an IndiaMART executive");
  if (/Explicit Disinterest/i.test(obj) && !yes(v.do_not_call_requested)) add("not_interested_paid", "Not interested in a meeting with an executive right now");
  return out;
}

const session = ({ id, glid, ts, endTs, summary, outcome, turns = [], facts = [], channel = "voice", extra = {} }) => ({
  source: "vani_session",
  row: { session_id: id, glid: String(glid), role: "seller", channel, direction: "outbound", ts, end_ts: endTs, summary, outcome, turns, decisions: [], facts, llm: "sarvam", ...extra },
});

// The whole call, from our on_end tool body or a Sarvam webhook payload. Returns null when no seller can be identified.
// skip: fact types already saved by mid-call tools, as a Set or a function glid -> Set.
export function sarvamToSession(payload, { ts, glid: fallbackGlid = null, skip = new Set() } = {}) {
  const vars = { ...(payload.final_agent_variables || {}), ...(payload.output_agent_variables || {}), ...payload };
  const glid = s(vars.glid || payload.metadata?.glid || fallbackGlid || payload.user_identifier);
  if (!/^\d+$/.test(glid)) return null;
  const iid = s(payload.interaction_id || payload.attempt_id) || `t${Date.now()}`;
  const turns = toTurns(payload.interaction_transcript ?? payload.transcript ?? payload.call_transcript, ts);
  const minutes = Math.max(1, Math.ceil(Number(payload.duration || payload.call_length || 0) / 60) || Math.ceil(turns.length / 4));
  const disposition = s(vars.disposition_label) || (turns.length ? "General (talked)" : "No conversation");
  const details = [s(vars.issues_raised) && `Raised: ${s(vars.issues_raised)}`, s(vars.help_given) && `Done: ${s(vars.help_given)}`, s(vars.additional_details)].filter(Boolean).join(" ");
  return session({
    id: `sarvam-${iid}`, glid, ts, endTs: addMin(ts, minutes),
    summary: clip(`Sarvam agent call: ${disposition}${s(vars.objection_type) ? ` (${s(vars.objection_type)})` : ""}${details ? `. ${details}` : ""}.`, 420),
    outcome: disposition, turns, facts: outcomeFacts(vars, typeof skip === "function" ? skip(glid) : skip),
    extra: { interaction_id: iid, meeting_datetime: s(vars.meeting_datetime) || null, callback_datetime: s(vars.callback_datetime) || null },
  });
}

// What log_seller_request may record. Keys are the tool's request_type values.
export const REQUEST_TYPES = {
  enquiry_reply: "Reply to a waiting buyer",
  catalog_update: "Catalogue or product update",
  photo_help: "Product photos",
  account_update: "Profile or account details change",
  buylead_issue: "Buy lead problem",
  payment_query: "Payment, plan or renewal question",
  complaint: "Complaint",
  buying_requirement: "Wants to buy (sourcing requirement)",
  other: "Other request",
};

// Mid-call tools. Each validates what the agent sends, and on success records one fact right away, so the outcome
// survives even if the end-of-call hook never arrives. Returns { ok, message, event? }; the message is what the agent hears.
export function toolCall(kind, b, { ts }) {
  const glid = s(b.glid);
  if (!/^\d+$/.test(glid)) return { ok: false, message: "The seller could not be identified, so nothing was saved." };
  const iid = s(b.interaction_id) || `t${Date.now()}`;
  const mk = (type, evidence, due, summary) => ({
    ok: true,
    event: session({ id: `sarvam-${iid}-${kind}`, glid, ts, endTs: addMin(ts, 1), summary, outcome: summary, facts: [{ type, evidence, due }], extra: { interaction_id: iid } }),
  });
  if (kind === "meeting") {
    const when = parseWhen(b.meeting_date, b.meeting_time);
    const place = [s(b.locality), s(b.city)].filter(Boolean).join(", ");
    if (!when) return { ok: false, message: "The date or time was not clear. Confirm one specific day and time with the seller." };
    if (!place) return { ok: false, message: "The meeting location is missing. Confirm the locality and city with the seller." };
    const mins = Number(when.slice(11, 13)) * 60 + Number(when.slice(14, 16));
    if (mins < SLOT.from || mins > SLOT.to) return { ok: false, message: "That time is outside the executive's working hours of 10 AM to 7 PM. Offer the nearest time inside that window." };
    const r = mk("meeting_fixed", `Meeting booked by the Sarvam agent for ${when.slice(0, 16)} at ${place}`, when, `Meeting booked for ${when.slice(0, 16)} at ${place}`);
    return { ...r, message: `Meeting booked for ${when.slice(0, 16)} at ${place}.` };
  }
  if (kind === "callback") {
    const when = parseWhen(b.callback_date, b.callback_time) || parseWhen(b.callback_datetime);
    const said = s(b.callback_datetime) || [s(b.callback_date), s(b.callback_time)].filter(Boolean).join(" ");
    if (!when && !said) return { ok: false, message: "No callback time was given. Ask once for a day and time." };
    const r = mk("callback_requested", `Asked to be called back at ${when ? when.slice(0, 16) : said}`, when, `Callback requested for ${when ? when.slice(0, 16) : said}`);
    return { ...r, message: `Callback saved for ${when ? when.slice(0, 16) : said}.` };
  }
  if (kind === "request") {
    const label = REQUEST_TYPES[s(b.request_type)] || REQUEST_TYPES.other;
    const details = s(b.details);
    if (!details) return { ok: false, message: "The request details are missing. Ask the seller exactly what they need, in one question, then call the tool again." };
    const r = mk("seller_request", `${label}: ${clip(details, 160)}`, null, `Seller request noted (${label})`);
    return { ...r, message: `Noted for the IndiaMART team: ${label}. Tell the seller it is recorded on their account and the team will follow up. Do not promise a time.` };
  }
  if (kind === "dnc") {
    const r = mk("do_not_call", `Asked IndiaMART to stop calls${s(b.reason) ? `: ${clip(s(b.reason), 120)}` : ""} (Sarvam agent call)`, null, "Seller asked not to be called again");
    return { ...r, message: "Do-not-call request saved. The seller will not be called again for this." };
  }
  return { ok: false, message: `Unknown tool ${kind}` };
}

// ---------------------------------------------------------------- HTTP routes

const PUBLIC_ROUTES = new Set(["GET /sarvam/context", "POST /sarvam/end", "POST /sarvam/meeting", "POST /sarvam/callback", "POST /sarvam/dnc", "POST /sarvam/request"]);
const fromTunnel = (req) => Boolean(req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"]);

// Returns a handler (req, res, url, route) -> true when it answered. It also guards the whole server: a request that
// came through the public tunnel may only reach the Sarvam routes above, and those need the shared token when one is set.
export function sarvamRoutes({ store, clock, setClock, ingest, outDir, send, body }) {
  const done = new Set(); // whole-call sessions already applied (a webhook may be delivered twice)
  // seller -> fact types saved by mid-call tools during the current call. Mid-call tools get no interaction id from the
  // platform (system variables reach only on_start / on_end tools), so the seller is the key; a record older than two
  // hours belongs to an earlier call.
  const recorded = new Map();
  const savedFor = (glid) => { const r = recorded.get(glid); return r && Date.now() - r.at < 2 * 3600e3 ? r.types : new Set(); };
  const payloadLog = path.join(ROOT, "store", "sarvam_payloads.jsonl");
  const note = (kind, data) => {
    try {
      fs.mkdirSync(path.dirname(payloadLog), { recursive: true });
      fs.appendFileSync(payloadLog, JSON.stringify({ at: new Date().toISOString(), kind, data }) + "\n");
    } catch { /* logging must never break a call */ }
  };
  const nextTs = () => { const t = clock(); setClock(addMin(t, 1)); return addMin(t, 1); };
  // The seller to use when the agent sends no glid. Text chat and the dashboard test cannot inject variables, so the
  // agent's glid default is empty and this picks the seller instead; a phone test or campaign passes its own glid.
  // Set locally with POST /sarvam/test-seller; kept in store/ so it survives a restart.
  const testFile = path.join(ROOT, "store", "sarvam_test_seller.txt");
  let testGlid = SARVAM.test_glid;
  try { testGlid = fs.readFileSync(testFile, "utf8").trim() || testGlid; } catch { /* not set yet */ }
  const glidOr = (g) => s(g) || testGlid;

  return async function handle(req, res, url, route) {
    const isSarvam = url.pathname.startsWith("/sarvam/");
    if (fromTunnel(req) && !PUBLIC_ROUTES.has(route)) { send(res, 403, { error: "not available through the public tunnel" }); return true; }
    if (!isSarvam) return false;
    if (PUBLIC_ROUTES.has(route) && SARVAM.token && req.headers["x-gc-token"] !== SARVAM.token) { send(res, 401, { error: "missing or wrong X-GC-Token" }); return true; }

    // Local only (the tunnel guard above refuses it): which seller a test chat or dashboard call talks to.
    if (route === "GET /sarvam/test-seller") { send(res, 200, { glid: testGlid }); return true; }
    if (route === "POST /sarvam/test-seller") {
      const g = s((await body(req)).glid);
      if (g && !/^\d+$/.test(g)) { send(res, 400, { error: "glid must be digits, or empty to clear" }); return true; }
      testGlid = g;
      fs.mkdirSync(path.dirname(testFile), { recursive: true });
      fs.writeFileSync(testFile, g);
      send(res, 200, { glid: testGlid });
      return true;
    }

    if (route === "GET /sarvam/context") {
      const glid = glidOr(url.searchParams.get("glid"));
      let vars;
      if (!/^\d+$/.test(glid)) vars = sellerVars(null, glid || "0", { fm: null, md: "", asOf: clock() });
      else {
        try {
          const w = await store().write("seller", glid, { asOf: clock(), outDir });
          const graph = store().neighbourhood ? await store().neighbourhood(glid).catch(() => null) : null;
          vars = sellerVars(graph, glid, { fm: w.fm, md: w.md, asOf: clock() });
        } catch (e) {
          if (!e.status) throw e;
          vars = sellerVars(null, glid, { fm: null, md: "", asOf: clock() }); // no file: the call still goes on, cold
        }
      }
      vars.call_datetime = nowIst(); // real time of the call: meetings are booked in real days, not on the data clock
      note("context", { glid, found: vars.found });
      send(res, 200, vars);
      return true;
    }
    if (["POST /sarvam/meeting", "POST /sarvam/callback", "POST /sarvam/dnc", "POST /sarvam/request"].includes(route)) {
      const b = await body(req);
      b.glid = glidOr(b.glid);
      const kind = route.split("/").at(-1);
      note(kind, b);
      const r = toolCall(kind, b, { ts: nextTs() });
      if (r.ok) {
        const g = r.event.row.glid;
        if (!recorded.has(g) || Date.now() - recorded.get(g).at >= 2 * 3600e3) recorded.set(g, { types: new Set(), at: Date.now() });
        recorded.get(g).types.add(r.event.row.facts[0].type);
        const w = await ingest([r.event]);
        send(res, 200, { ok: true, message: r.message, files: w.files });
      } else send(res, 200, { ok: false, message: r.message });
      return true;
    }
    if (route === "POST /sarvam/end") {
      const b = await body(req);
      note("end", b);
      const ev = sarvamToSession(b, { ts: clock(), glid: testGlid || null, skip: savedFor });
      if (!ev) { send(res, 200, { ok: false, message: "no seller GLID in the payload; logged only" }); return true; }
      if (done.has(ev.row.session_id)) { send(res, 200, { ok: true, duplicate: true }); return true; }
      done.add(ev.row.session_id);
      recorded.delete(ev.row.glid); // the call is over
      if (addMin(ev.row.end_ts, 2) > clock()) setClock(addMin(ev.row.end_ts, 2));
      const w = await ingest([ev]);
      send(res, 200, { ok: true, session_id: ev.row.session_id, turns: ev.row.turns.length, facts: ev.row.facts.map((f) => f.type), ...w });
      return true;
    }
    // What the console needs to start a session with the agent (ids only, never the key).
    if (route === "GET /sarvam/config") {
      const ready = Boolean(SARVAM.key && SARVAM.org_id && SARVAM.workspace_id && SARVAM.app_id);
      send(res, 200, { ready, org_id: SARVAM.org_id, workspace_id: SARVAM.workspace_id, app_id: SARVAM.app_id, app_version: SARVAM.app_version || null });
      return true;
    }
    // Web SDK: the browser asks us for the signed WebSocket URL; we add the API key so it never reaches the page.
    if (req.method === "GET" && url.pathname.startsWith("/sarvam/runtime/")) {
      if (!SARVAM.key) { send(res, 503, { error: "SARVAM_API_KEY is not set" }); return true; }
      const target = SARVAM.runtime + url.pathname.slice("/sarvam/runtime/".length) + url.search;
      const r = await fetch(target, { headers: { "X-API-Key": SARVAM.key } });
      res.writeHead(r.status, { "content-type": r.headers.get("content-type") || "application/json", "cache-control": "no-store" });
      res.end(Buffer.from(await r.arrayBuffer()));
      return true;
    }
    return false;
  };
}
