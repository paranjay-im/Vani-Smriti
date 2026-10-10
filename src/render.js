// seller.md / buyer.md renderer. Deterministic (no LLM on the freshness path), fixed section order,
// trimmed to a token budget. Front matter is the machine interface (other teams parse it);
// the body is what the bot's prompt reads.
import fs from "node:fs";
import path from "node:path";
import { AS_OF, LOOKBACK_DAYS as LB, MD_TOKEN_BUDGET, OUT_DIR } from "./config.js";
import { cmpTs, daysBetween, dmy, dmyhm } from "./time.js";
import { handle } from "./pii.js";
import { factView, FACTS } from "./extract.js";

export const estimateTokens = (s) => Math.ceil(s.length / 4);
const desc = (a, b) => -cmpTs(a, b);
const trim = (s, n) => (s && s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s || "");
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : "–");
const top = (items, n) => {
  const m = new Map();
  for (const x of items) if (x) m.set(x, (m.get(x) || 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]).slice(0, n);
};
const fmLine = (k, v) => `${k}: ${JSON.stringify(v)}`;
// Product titles are spoken by the bot: shorten at a natural break ("Air Bra / AIR FOLDER BRA - ..." -> "Air Bra").
export function shortProduct(p) {
  let s = String(p || "").split(/\s[\/|-]\s|,|\(/)[0].trim();
  if (s.length > 40) s = s.slice(0, 40).replace(/\s+\S*$/, "");
  s = s.replace(/\s+(with|for|and|of|in|to|&)$/i, "");
  return s || String(p || "").slice(0, 40);
}

// seller_request: what the seller asked VANI for on an earlier call; followed up before anything new (after promises).
const LOOP_RANK = { promise: 0, seller_request: 0.5, buyer_waiting_reply: 1, callback_due: 2, meeting_check: 3, missed_buyer_call: 4,
  unanswered_enquiry: 5, whatsapp_unfinished: 6, photo_pending: 7, seller_asked_buyer: 1, waiting_on_seller: 2, seller_replied_unread: 3 };

const INTENT_TOPIC = (intent) =>
  /^Msite_BL/i.test(intent) ? "posting a buy requirement"
    : /^Photo/i.test(intent) ? "adding product photos"
      : /Callback|Call_Feedback/i.test(intent) ? "giving call feedback"
        : /CSAT|fdbk/i.test(intent) ? "giving feedback"
          : /Product|Catalog|Photo_Menu/i.test(intent) ? "updating the catalog"
            : intent ? intent.replace(/_/g, " ").toLowerCase() : "chatting";

// The one sentence of a VANI summary that says what the seller said, not what the agent did.
function keySentence(summary) {
  const ss = String(summary || "").split(/(?<=[.!?])\s+/).filter(Boolean);
  const said = ss.find((s) => /\b(lead|seller|he|she|they)\b[^.]*\b(stated|mentioned|informed|requested|said|asked|agreed|declined|expressed|confirmed|interrupted|refused|wanted|acknowledged)\b/i.test(s) && !/^The agent/i.test(s));
  const s = said || ss.find((x) => !/^The agent (?:from IndiaMART )?(called|initiated|introduced|contacted)/i.test(x)) || ss[0] || "";
  return s.replace(/\bThe lead\b/g, "Seller").replace(/\bthe lead\b/g, "the seller").replace(/\bthe agent\b/gi, "VANI");
}

function bestTime(hours) {
  if (hours.length < 3) return null;
  const bins = new Map();
  for (const h of hours) { const b = Math.floor(h / 2) * 2; bins.set(b, (bins.get(b) || 0) + 1); }
  const [b] = [...bins].sort((x, y) => y[1] - x[1])[0];
  return `${String(b).padStart(2, "0")}:00-${String(b + 2).padStart(2, "0")}:00`;
}

function languages(pns, turns) {
  const c = new Map();
  const add = (l, w = 1) => c.set(l, (c.get(l) || 0) + w);
  for (const x of pns) for (const l of x.props.languages || []) add(l);
  for (const t of turns) {
    if (t.props.speaker !== "seller") continue;
    const s = t.props.text || "";
    if (/[ऀ-ॿ]/.test(s)) add("Hindi", 2);
    else if (/[઀-૿]/.test(s)) add("Gujarati", 2);
    else if (/\b(haan|nahi|ji|kya|hai|hoon|aap|bol|raha|theek)\b/i.test(s)) add("Hindi", 1);
    else if (/[a-z]{3,}/i.test(s)) add("English", 1);
  }
  return [...c].sort((a, b) => b[1] - a[1]).slice(0, 2).map((x) => x[0]);
}

function careLines(view) {
  return Object.values(view)
    .filter((f) => f.active && f.type !== "sourcing_interest" && f.type !== "seller_request") // requests are open loops
    .sort((a, b) => a.pri - b.pri || cmpTs(b.latest, a.latest))
    .map((f) => {
      const when = f.fromProfile ? "profile flag (date unknown)" : `${dmy(f.latest.ts)} via ${f.latest.props.channel}`;
      const times = f.count > 1 ? ` · ${f.count}× since ${dmy(f.first.ts)}` : "";
      const due = f.latest.props.due ? ` · for ${dmyhm(f.latest.props.due)}` : "";
      const quote = !f.fromProfile && f.latest.props.evidence ? ` — "${trim(f.latest.props.evidence, 100)}"` : "";
      return `- ${f.say} — ${when}${times}${due}${quote}`;
    });
}

// Open promises from the bot's own decision trace: what the next session on another channel must resume.
// A promise is open until a later "fulfil" decision with the same key.
function openPromises(g, decisions, asOf) {
  const lastFulfil = new Map();
  for (const d of decisions) if (d.props.action === "fulfil" && (!lastFulfil.get(d.props.key) || d.ts > lastFulfil.get(d.props.key))) lastFulfil.set(d.props.key, d.ts);
  return decisions
    .filter((d) => d.props.action === "promise" && !(lastFulfil.get(d.props.key) >= d.ts) && daysBetween(d.ts, asOf) <= LB.resume)
    .map((d) => Object.assign(d, { sessionSummary: g.get(d.props.session)?.props.summary }))
    .sort(desc);
}
// Loops the bot already closed (a "fulfil" decision on that loop) stay closed.
const closedKeys = (decisions) => new Set(decisions.filter((d) => d.props.action === "fulfil").map((d) => d.props.key));

function frontMatter(fm) {
  return ["---", ...Object.entries(fm).map(([k, v]) => fmLine(k, v)), "---"].join("\n");
}

// Assemble the file, dropping lower-priority detail until it fits the token budget.
function fit(build, budget) {
  const levels = [
    { conv: 5, recent: 3, loops: 4, care: 6, extra: true },
    { conv: 4, recent: 2, loops: 4, care: 5, extra: true },
    { conv: 3, recent: 2, loops: 3, care: 5, extra: false },
    { conv: 2, recent: 1, loops: 3, care: 4, extra: false },
    { conv: 1, recent: 1, loops: 2, care: 3, extra: false },
    { conv: 1, recent: 0, loops: 2, care: 2, extra: false },
  ];
  let md = "";
  for (const lv of levels) {
    md = build(lv);
    if (estimateTokens(md) + 2 <= budget) break;
  }
  return md.replace(/^tokens: \d+$/m, `tokens: ${estimateTokens(md)}`);
}

function cold(role, id, asOf, generatedAt) {
  const fm = { glid: id, role, name: null, as_of: asOf.slice(0, 16), generated_at: generatedAt, cold_start: true, contact_policy: "ok", flags: [], loops: [], tokens: 0 };
  const md = `${frontMatter(fm)}\n# ${role === "seller" ? "Seller" : "Buyer"} ${id}\n\nNo profile or history on record. Use the generic opening, ask the basics once (business, products or requirement, city) and save the answers.\n`;
  return { md: md.replace(/^tokens: \d+$/m, `tokens: ${estimateTokens(md)}`), fm };
}

// ---------------------------------------------------------------- seller.md
export function renderSeller(g, glid, { asOf = AS_OF, generatedAt = new Date().toISOString(), budget = MD_TOKEN_BUDGET } = {}) {
  const S = g.get(`S:${glid}`);
  if (!S) return cold("seller", glid, asOf, generatedAt);
  const p = S.props;
  const upto = (n) => !n.ts || n.ts <= asOf;
  const own = (label) => g.owned(glid, label).filter(upto);
  const within = (days) => (n) => n.ts && n.ts <= asOf && daysBetween(n.ts, asOf) <= days;
  const thread = (e) => g.outN(e.id, "HAS_MESSAGE").filter(upto).sort(cmpTs);

  const enq90 = own("Enquiry").filter(within(LB.enquiries)).sort(desc);
  const calls90 = own("BuyerCall").filter(within(LB.buyer_calls)).sort(desc);
  const bl45 = own("BuyLead").filter(within(LB.buyleads)).filter((b) => !b.props.sentinel).sort(desc);
  const wa30 = own("WhatsAppMsg").filter(within(LB.whatsapp));
  const chats = own("ChatSession").filter(within(LB.chatbot)).sort(desc);
  const bot = own("BotCall").filter(within(LB.bot_calls)).sort(desc);
  const vs = own("VaniSession").sort(desc);
  const exec = own("ExecCall").filter(within(LB.exec_calls)).sort(desc);
  const pns = own("PNSCall").filter(within(LB.pns_calls)).sort(desc);
  const turns = own("BotTurn");
  const decisions = own("Decision");
  const view = factView(g, { glid }, asOf);
  // A fact the bot explicitly closed (e.g. "did the meeting happen?" -> "haan") is no longer active.
  const closedByBot = closedKeys(decisions);
  for (const f of Object.values(view)) if (f.active && closedByBot.has(f.latest?.id)) { f.active = false; f.resolved = "closed by VANI"; }
  const active = (t) => view[t]?.active;

  const threads = new Map(enq90.map((e) => [e.id, thread(e)]));
  const replied = (e) => threads.get(e.id).some((m) => m.props.from === "seller");
  const city = (e) => e.props.buyer_city || "?";

  // ---- open loops (computed from short-term memory + reasoning memory)
  const loops = [];
  for (const d of openPromises(g, decisions, asOf)) {
    loops.push({ type: "promise", on: dmy(d.ts), ts: d.ts, ref: d.props.key, text: d.props.text, said: d.props.said, target: d.props.target, from: d.props.channel, summary: d.sessionSummary });
  }
  let unanswered = 0;
  for (const e of enq90) {
    if (daysBetween(e.ts, asOf) > LB.open_loops) break;
    const msgs = threads.get(e.id).filter((m) => !m.props.boilerplate);
    const last = msgs.at(-1);
    const buyerAsk = last && last.props.from === "buyer" ? last : null;
    const sameBuyer = loops.some((l) => l.buyer === handle(e.buyer));
    if (buyerAsk && !sameBuyer) {
      loops.push({ type: "buyer_waiting_reply", on: dmy(buyerAsk.ts), ts: buyerAsk.ts, product: shortProduct(e.props.product), city: city(e), buyer: handle(e.buyer), ask: trim(buyerAsk.props.text, 60), ref: e.id });
    } else if (!replied(e)) {
      unanswered++;
      if (!sameBuyer && unanswered <= 2) loops.push({ type: "unanswered_enquiry", on: dmy(e.ts), ts: e.ts, product: shortProduct(e.props.product), city: city(e), buyer: handle(e.buyer), ref: e.id });
    }
  }
  for (const c of calls90) {
    if (daysBetween(c.ts, asOf) > 7) break;
    if (c.props.connected || !c.buyer) continue;
    if (calls90.some((x) => x.buyer === c.buyer && x.ts > c.ts && x.props.connected)) continue;
    if (loops.some((l) => l.type === "missed_buyer_call" && l.buyer === handle(c.buyer))) continue;
    loops.push({ type: "missed_buyer_call", on: dmy(c.ts), ts: c.ts, city: c.props.circle || "?", buyer: handle(c.buyer), ref: c.id });
  }
  if (active("callback_requested")) {
    const f = view.callback_requested.latest;
    loops.push({ type: "callback_due", on: dmy(f.ts), ts: f.ts, due: f.props.due || null, ref: f.id });
  }
  if (active("meeting_fixed")) {
    const f = view.meeting_fixed.latest;
    loops.push({ type: "meeting_check", on: dmy(f.ts), ts: f.ts, due: f.props.due || null, ref: f.id });
  }
  // Requests the seller raised with VANI (latest 3 still open): after any VANI promise, before buyer loops.
  const requests = own("Fact").filter((f) => f.props.type === "seller_request" && f.ts && daysBetween(f.ts, asOf) <= FACTS.seller_request.ttl).sort(desc).slice(0, 3);
  loops.splice(loops.filter((l) => l.type === "promise").length, 0, ...requests.map((f) => ({ type: "seller_request", on: dmy(f.ts), ts: f.ts, text: trim(f.props.evidence || "", 140), ref: f.id })));
  const lastChat = chats[0];
  if (lastChat && daysBetween(lastChat.ts, asOf) <= 7) {
    const ct = g.outN(lastChat.id, "HAS_TURN").filter(upto).sort(cmpTs);
    const last = ct.at(-1);
    if (last && last.props.bot && !last.props.user && /\?|How many|Share|Please|Enter|Select/i.test(last.props.bot) && last.props.bot !== "[card]") {
      loops.push({ type: "whatsapp_unfinished", on: dmy(last.ts), ts: last.ts, topic: INTENT_TOPIC(last.props.intent), ask: trim(last.props.bot, 70), ref: lastChat.id });
    }
  }
  const photo = own("ChatTurn").filter(within(30)).filter((t) => /^Photo uploaded but not added/i.test(t.props.intent || "")).sort(desc)[0];
  if (photo) loops.push({ type: "photo_pending", on: dmy(photo.ts), ts: photo.ts, ref: photo.id });
  const closed = closedKeys(decisions);
  for (let i = loops.length - 1; i >= 0; i--) if (loops[i].type !== "promise" && closed.has(loops[i].ref)) loops.splice(i, 1);
  loops.sort((a, b) => LOOP_RANK[a.type] - LOOP_RANK[b.type] || -cmpTs(a, b));

  const LOOP_TEXT = {
    promise: (l) => `VANI promised on ${l.from} to ${l.text}${l.said ? ` (seller said "${trim(l.said, 60)}")` : ""}`,
    buyer_waiting_reply: (l) => `Buyer ${l.buyer} (${l.city}) on ${l.product}: "${l.ask}" — no seller reply yet`,
    unanswered_enquiry: (l) => `Buyer ${l.buyer} (${l.city}) enquired for ${l.product} — no seller reply yet${unanswered > 2 ? ` (+${unanswered - 2} more unanswered)` : ""}`,
    missed_buyer_call: (l) => `Buyer ${l.buyer} (${l.city}) called — not connected, no call back since`,
    callback_due: (l) => `Seller asked for a call back${l.due ? ` at ${dmyhm(l.due)}` : ""}`,
    meeting_check: (l) => l.due && l.due > asOf
      ? `Meeting fixed through VANI for ${dmyhm(l.due)} — upcoming; do not pitch another`
      : `Meeting fixed through VANI${l.due ? ` for ${dmyhm(l.due)}` : ""} — confirm it happened before pitching again`,
    whatsapp_unfinished: (l) => `On WhatsApp the seller was ${l.topic} and stopped at "${l.ask}"`,
    photo_pending: () => `Uploaded product photos on WhatsApp that were not added to the catalog`,
    seller_request: (l) => `Seller asked VANI: ${l.text} — follow up and confirm it is done`,
  };

  // ---- conversations across channels
  const conv = [];
  for (const b of bot) conv.push({ ts: b.ts, ch: "VANI call", dropped: (b.props.duration || 0) < 10, text: `${b.props.disposition} — ${trim(keySentence(b.props.summary), 150)}` });
  for (const s of vs) conv.push({ ts: s.ts, ch: `VANI ${s.props.channel}`, text: trim(s.props.summary || s.props.outcome, 160) });
  const execDays = new Map();
  for (const x of exec.filter((x) => x.props.answered)) {
    const d = x.ts.slice(0, 10);
    const cur = execDays.get(d) || { ts: x.ts, n: 0, max: 0, emp: x.props.employee };
    cur.n++; cur.max = Math.max(cur.max, x.props.customer_sec);
    execDays.set(d, cur);
  }
  for (const v of execDays.values()) conv.push({ ts: v.ts, ch: "Exec call", text: `${v.n} answered call${v.n > 1 ? "s" : ""}, longest ${Math.round(v.max / 60)} min (employee ${v.emp})` });
  for (const s of chats.slice(0, 6)) {
    const ct = g.outN(s.id, "HAS_TURN").filter(upto).sort(cmpTs);
    const said = ct.map((t) => t.props.user).filter((u) => u && u !== "[link]" && !/^(yes|no|ok|\d+)$/i.test(u))[0];
    const intent = ct.map((t) => t.props.intent).filter(Boolean)[0];
    conv.push({ ts: s.ts, ch: "WhatsApp bot", text: `${INTENT_TOPIC(intent)}${said ? `: "${trim(said, 70)}"` : ""}` });
  }
  for (const e of enq90) {
    const sm = threads.get(e.id).filter((m) => m.props.from === "seller").at(-1);
    if (sm) conv.push({ ts: sm.ts, ch: "Enquiry reply", text: `${trim(e.props.product, 40)}: seller wrote "${trim(sm.props.text, 70)}"` });
  }
  for (const x of pns.filter((x) => x.props.role === "SELLER")) conv.push({ ts: x.ts, ch: "Buyer call (AI notes)", text: `${trim(x.props.products, 60)}${x.props.prices ? ` · quoted ${x.props.prices}` : ""}` });
  conv.sort(desc);
  // Collapse runs of dropped VANI calls into one line.
  const convLines = [];
  for (const c of conv) {
    const prev = convLines.at(-1);
    if (c.dropped && prev?.dropped) { prev.n++; prev.first = c.ts; continue; }
    if (prev && prev.ch === c.ch && prev.text === c.text) continue;
    convLines.push({ ...c, n: 1 });
  }
  const convText = (c) => (c.dropped && c.n > 1 ? `- ${dmy(c.first)}–${dmy(c.ts)} · VANI call · ${c.n} calls dropped or ended after the greeting` : `- ${dmy(c.ts)} · ${c.ch} · ${c.text}`);

  // ---- leads
  const repliedN = enq90.filter(replied).length;
  const unread = enq90.filter((e) => !e.props.read).length;
  const conn = calls90.filter((c) => c.props.connected);
  const avgTalk = conn.length ? Math.round(conn.reduce((s, c) => s + c.props.talk, 0) / conn.length) : 0;
  const asked = top(enq90.map((e) => e.props.product), 3).map(([k, v]) => `${trim(k, 32)} (${v})`);
  const recent = [
    ...enq90.slice(0, 3).map((e) => ({ ts: e.ts, t: `${dmy(e.ts)} enquiry · ${trim(e.props.product, 40)} · ${handle(e.buyer)}, ${city(e)} · ${replied(e) ? "replied" : "no reply"}` })),
    ...calls90.slice(0, 3).map((c) => ({ ts: c.ts, t: `${dmy(c.ts)} buyer call · ${c.props.connected ? `connected ${c.props.talk}s` : "missed"} · ${c.buyer ? handle(c.buyer) : "unknown"}, ${c.props.circle || "?"}` })),
    ...bl45.slice(0, 2).map((b) => ({ ts: b.ts, t: `${dmy(b.ts)} bought a buy-lead${b.props.keyword ? ` · ${b.props.keyword}` : ""} · ${b.props.credits} credits` })),
  ].sort(desc);

  // ---- engagement
  const hours = [
    ...bot.filter((b) => (b.props.duration || 0) >= 15).map((b) => +b.ts.slice(11, 13)),
    ...conn.map((c) => +c.ts.slice(11, 13)),
    ...exec.filter((x) => x.props.answered).map((x) => +x.ts.slice(11, 13)),
  ];
  const best = bestTime(hours);
  const lang = languages(pns, turns);
  const api = wa30.filter((w) => w.props.sender === "API");
  const waRead = api.filter((w) => w.props.status === "read" || w.props.read_at).length;
  const waUser = wa30.filter((w) => w.props.sender === "USER").length;
  const disp = top(bot.map((b) => b.props.disposition), 4).map(([k, v]) => `${k.toLowerCase()} ${v}`).join(", ");
  const lastActive = [
    ...own("EnquiryMessage").filter((m) => m.props.from === "seller").map((m) => ({ ts: m.ts, ch: "enquiry reply" })),
    ...own("WhatsAppMsg").filter((w) => w.props.sender === "USER").map((w) => ({ ts: w.ts, ch: "WhatsApp" })),
    ...own("BotCall").filter((b) => (b.props.duration || 0) >= 10).map((b) => ({ ts: b.ts, ch: "VANI call" })),
    ...own("BuyerCall").filter((c) => c.props.connected).map((c) => ({ ts: c.ts, ch: "buyer call" })),
    ...vs.filter((s) => (s.props.turns || []).some((t) => t.speaker !== "bot")).map((s) => ({ ts: s.ts, ch: `VANI ${s.props.channel}` })),
  ].filter((x) => x.ts).sort(desc)[0];

  // ---- as a buyer
  const sourcing = top([
    ...pns.filter((x) => x.props.role === "BUYER").flatMap((x) => String(x.props.products).split(/;\s*/)),
    ...Object.values(view).filter((f) => f.type === "sourcing_interest").map((f) => f.latest.props.value),
  ].map((s) => trim(String(s || "").trim(), 40)), 4).map(([k]) => k);

  // ---- policy + next best action
  const recentCalls = bot.filter((b) => daysBetween(b.ts, asOf) <= 7).length;
  const contactPolicy = active("do_not_call") ? "do_not_call" : active("wrong_contact") ? "verify_identity" : active("frustrated") || recentCalls >= 3 ? "cooldown" : "ok";
  const channelPref = active("wants_whatsapp") || (waUser >= 3 && api.length && waRead / api.length >= 0.6) ? "whatsapp" : "voice";
  const actions = [];
  if (contactPolicy === "do_not_call") actions.push("Do not place outbound VANI calls. If the seller writes in, acknowledge the stop request first, then only help with their buyers.");
  if (contactPolicy === "verify_identity") actions.push("Confirm you are speaking to the business before sharing anything.");
  if (active("already_met_executive") || active("exec_contact")) actions.push("Do not pitch a meeting: an executive is already engaged. Offer help with open buyer loops instead.");
  else if (active("meeting_fixed")) {
    const due = view.meeting_fixed.latest.props.due;
    actions.push(due && due > asOf ? `An executive visit is booked for ${dmyhm(due)}: do not pitch another; confirm it still suits the seller.` : "Confirm whether the VANI-fixed meeting happened before any new pitch.");
  }
  if (loops[0]?.type === "promise") actions.push(`Resume: ${loops[0].text}.`);
  if (active("seller_request")) actions.push("Follow up on the seller's open request before raising anything new.");
  else if (loops.some((l) => l.type === "buyer_waiting_reply" || l.type === "unanswered_enquiry")) actions.push("Help the seller reply to the waiting buyer (ask for price/MOQ, VANI drafts the reply).");
  if (channelPref === "whatsapp") actions.push("Send details on WhatsApp instead of reading them out on a call.");
  if (contactPolicy === "cooldown") actions.push("Keep it under a minute; no repeat calls this week.");
  if (!actions.length) actions.push(`Pitch profile improvement with their numbers: ${enq90.length} enquiries and ${calls90.length} buyer calls in 90 days.`);

  const kycMissing = Object.entries(p.kyc || {}).filter(([, v]) => v === false).map(([k]) => k);
  const kyc = kycMissing.length ? `KYC gaps: ${kycMissing.join(", ")}` : "KYC ✓ mobile · email · GST · PAN";
  const coldStart = !enq90.length && !calls90.length && !bot.length && !wa30.length && !chats.length && !vs.length;
  const watermark = [...g.labelsOf(glid)].flatMap((l) => own(l)).reduce((m, n) => (n.ts && n.ts > m ? n.ts : m), "");
  const resume = loops.find((l) => l.type === "promise") || null;
  const flags = Object.values(view).filter((f) => f.active && f.type !== "sourcing_interest").sort((a, b) => a.pri - b.pri).map((f) => f.type);

  const fm = {
    glid, role: "seller", name: p.company, city: `${p.city}, ${p.state}`, as_of: asOf.slice(0, 16), watermark: watermark.slice(0, 16),
    generated_at: generatedAt, cold_start: coldStart, segment: p.paid ? "paid" : "free", contact_policy: contactPolicy, flags,
    loops: loops.filter((l) => l.type !== "promise").slice(0, 3).map(({ ts, buyer: _b, summary: _s, ...l }) => l),
    resume: resume && { from: resume.from, on: resume.on, said: trim(resume.said, 60), promise: resume.text, key: resume.ref, target: resume.target,
    },
    channel_pref: channelPref, lang, best_time: best,
    stats: { enq_90d: enq90.length, replied_90d: repliedN, buyer_calls_90d: calls90.length, buyleads_45d: bl45.length, vani_answered: own("BotCall").length, wa_read_30d: api.length ? +(waRead / api.length).toFixed(2) : null },
    tokens: 0,
  };

  const build = (lv) => {
    const L = [frontMatter(fm), `# Seller · ${p.company} · ${p.city}, ${p.state}`, ""];
    L.push(`**Who:** ${[p.business_type, p.nature, p.turnover && `turnover ${p.turnover}`, p.gst_year && `GST since ${p.gst_year}`].filter(Boolean).join(" · ")} · ${p.paid ? "Paid" : "Free"} (${p.customer_type || "?"}) · ${kyc}`);
    L.push(`**Sells:** ${(p.categories || []).join(", ") || "not listed"}${asked.length ? ` · buyers ask for: ${asked.join(", ")}` : ""}`);
    L.push("", "## Do not re-ask / handle with care");
    const care = careLines(view);
    L.push(...(care.length ? care.slice(0, lv.care) : ["- Nothing on record."]));
    L.push("", "## Open loops");
    L.push(...(loops.length ? loops.slice(0, lv.loops).map((l) => `- ${l.on} · ${LOOP_TEXT[l.type](l)}`) : ["- None."]));
    L.push("", `## Leads (last ${LB.enquiries} days)`);
    L.push(`- Enquiries: ${enq90.length} from ${new Set(enq90.map((e) => e.buyer)).size} buyers · seller replied to ${repliedN} (${pct(repliedN, enq90.length)}) · ${unread} unread`);
    L.push(`- Buyer calls: ${calls90.length} · ${conn.length} connected (avg talk ${avgTalk}s) · ${calls90.length - conn.length} missed`);
    if (bl45.length || p.paid) L.push(`- Buy-leads bought (${LB.buyleads}d): ${bl45.length}${bl45.length ? ` · ${bl45.reduce((s, b) => s + (b.props.credits || 0), 0)} credits · top: ${top(bl45.map((b) => b.props.keyword), 3).map(([k]) => k).join(", ")}` : ""}`);
    if (recent.length && lv.recent) L.push(`- Recent: ${recent.slice(0, lv.recent).map((r) => r.t).join(" | ")}`);
    L.push("", "## Conversation history (latest first, all channels)");
    L.push(...(convLines.length ? convLines.slice(0, lv.conv).map(convText) : ["- No conversations in the lookback window."]));
    L.push("", "## Engagement");
    L.push(`- VANI: ${own("BotCall").length} answered of ${p.vani?.attempts ?? "?"} attempts${disp ? ` (${disp})` : ""}${best ? ` · reachable ${best}` : ""}${lang.length ? ` · speaks ${lang.join(", ")}` : ""}`);
    const wa = api.length || waUser ? `WhatsApp (${LB.whatsapp}d): ${api.length} from IndiaMART, ${pct(waRead, api.length)} read · ${waUser} from seller` : `WhatsApp (${LB.whatsapp}d): no messages`;
    L.push(`- ${wa}${lastActive ? ` · last active ${dmy(lastActive.ts)} (${lastActive.ch})` : ""}`);
    if (lv.extra && (p.eng?.product_count != null || p.eng?.cqs != null)) L.push(`- Catalog: ${p.eng?.product_count ?? "?"} products · quality score ${p.eng?.cqs ?? "?"}`);
    if (lv.extra && sourcing.length) L.push("", "## As a buyer", `- Sourcing: ${sourcing.join(", ")}`);
    L.push("", "## Next best action", ...actions.slice(0, 3).map((a) => `- ${a}`));
    return L.join("\n") + "\n";
  };
  const md = fit(build, budget);
  fm.tokens = estimateTokens(md);
  return { md, fm };
}

// ---------------------------------------------------------------- buyer.md
const MODULE_CHANNEL = (m) => (/^(IMOB|ANDWEB|ANDROID)$/.test(m) ? "Android app/m-site" : /^(IOSWEB|IOS)$/.test(m) ? "iOS" : /^ASTBUY$/.test(m) ? "post-requirement form" : /^PNSBLENQ$/.test(m) ? "phone call" : "website");

export function renderBuyer(g, buyer, { asOf = AS_OF, generatedAt = new Date().toISOString(), budget = MD_TOKEN_BUDGET } = {}) {
  const B = g.get(`B:${buyer}`);
  if (!B) return cold("buyer", buyer, asOf, generatedAt);
  const p = B.props;
  const upto = (n) => !n.ts || n.ts <= asOf;
  const own = (label) => g.ofBuyer(buyer, label).filter(upto);
  const within = (days) => (n) => n.ts && n.ts <= asOf && daysBetween(n.ts, asOf) <= days;
  const enq = own("Enquiry").filter(within(LB.enquiries)).sort(desc);
  const calls = own("BuyerCall").filter(within(LB.buyer_calls)).sort(desc);
  const picked = own("BuyLead").filter(within(LB.buyleads)).length;
  const vs = own("VaniSession").sort(desc);
  const decisions = own("Decision");
  const seller = (glid) => g.get(`S:${glid}`)?.props || {};
  const asSeller = g.get(`S:${buyer}`);
  const view = factView(g, { buyer }, asOf);

  const rows = enq.map((e) => {
    const msgs = g.outN(e.id, "HAS_MESSAGE").filter(upto).sort(cmpTs).filter((m) => !m.props.boilerplate);
    const s = seller(e.glid);
    return { e, msgs, s, sellerMsgs: msgs.filter((m) => m.props.from === "seller"), last: msgs.at(-1) };
  });
  const loops = [];
  for (const d of openPromises(g, decisions, asOf)) loops.push({ type: "promise", on: dmy(d.ts), ts: d.ts, ref: d.props.key, text: d.props.text, said: d.props.said, target: d.props.target, from: d.props.channel, summary: d.sessionSummary });
  const seen = new Set();
  for (const r of rows) {
    if (daysBetween(r.e.ts, asOf) > LB.open_loops * 2) break;
    const key = `${r.e.glid}|${r.e.props.product}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const base = { product: shortProduct(r.e.props.product), seller: r.s.company || "a seller", seller_city: r.s.city, ref: r.e.id };
    const lastFrom = r.last?.props.from;
    if (lastFrom === "seller" && /\?|quantity|price|kitna|kitni|kab|location|requirement|details/i.test(r.last.props.text)) {
      loops.push({ type: "seller_asked_buyer", on: dmy(r.last.ts), ts: r.last.ts, ask: trim(r.last.props.text, 60), ...base });
    } else if (lastFrom === "seller" && !r.last.props.read) {
      loops.push({ type: "seller_replied_unread", on: dmy(r.last.ts), ts: r.last.ts, ...base });
    } else if (lastFrom === "buyer" || !r.sellerMsgs.length) {
      const ts = r.last?.ts || r.e.ts;
      loops.push({ type: "waiting_on_seller", on: dmy(ts), ts, seen: r.e.props.read, ...base, ask: lastFrom === "buyer" ? trim(r.last.props.text, 60) : null });
    }
  }
  const closed = closedKeys(decisions);
  for (let i = loops.length - 1; i >= 0; i--) if (loops[i].type !== "promise" && closed.has(loops[i].ref)) loops.splice(i, 1);
  loops.sort((a, b) => LOOP_RANK[a.type] - LOOP_RANK[b.type] || -cmpTs(a, b));
  const LOOP_TEXT = {
    promise: (l) => `VANI promised on ${l.from} to ${l.text}`,
    seller_asked_buyer: (l) => `${l.seller} asked "${l.ask}" about ${l.product} — buyer has not answered`,
    seller_replied_unread: (l) => `${l.seller} replied about ${l.product} — buyer has not opened it`,
    waiting_on_seller: (l) => `Waiting on ${l.seller} (${l.seller_city || "?"}) for ${l.product}${l.ask ? ` — buyer asked "${l.ask}"` : ""} · seller ${l.seen ? "has read it" : "has not opened it"}`,
  };

  const sellers = new Map();
  for (const e of enq) { const s = sellers.get(e.glid) || { enq: 0, calls: 0 }; s.enq++; sellers.set(e.glid, s); }
  for (const c of calls) { const s = sellers.get(c.glid) || { enq: 0, calls: 0 }; s.calls++; sellers.set(c.glid, s); }
  const lookingFor = top(enq.map((e) => e.props.product), 4).map(([k]) => trim(k, 50));
  const conv = [];
  for (const r of rows) for (const m of r.msgs.slice(-2)) conv.push({ ts: m.ts, t: `${m.props.from === "seller" ? r.s.company || "Seller" : "Buyer"} on ${trim(r.e.props.product, 35)}: "${trim(m.props.text, 80)}"` });
  for (const c of calls.slice(0, 4)) conv.push({ ts: c.ts, t: `Called ${seller(c.glid).company || "a seller"} — ${c.props.connected ? `talked ${c.props.talk}s` : "not connected"}` });
  for (const s of vs) conv.push({ ts: s.ts, t: `VANI ${s.props.channel}: ${trim(s.props.summary, 120)}` });
  conv.sort(desc);
  const lastActive = [enq[0]?.ts, calls[0]?.ts, ...rows.flatMap((r) => r.msgs.filter((m) => m.props.from === "buyer").map((m) => m.ts))].filter(Boolean).sort().at(-1);
  const kyc = asSeller ? `verified via their seller account (${Object.entries(asSeller.props.kyc || {}).filter(([, v]) => v).map(([k]) => k).join(", ") || "none"})` : "unknown — no buyer KYC source in this dataset";
  const flags = Object.values(view).filter((f) => f.active).map((f) => f.type);
  const actions = [];
  if (loops[0]?.type === "promise") actions.push(`Resume: ${loops[0].text}.`);
  if (loops.some((l) => l.type === "seller_asked_buyer")) actions.push("Ask the buyer to answer the seller's open question; continue that thread, do not restart the requirement.");
  if (loops.some((l) => l.type === "waiting_on_seller")) actions.push("Tell the buyer where their enquiry stands (read/unread) and offer to nudge the seller or suggest similar suppliers.");
  if (!actions.length) actions.push(lookingFor.length ? `Ask if the requirement for ${lookingFor[0]} is still open.` : "Ask what they are looking for.");

  const fm = {
    glid: buyer, role: "buyer", name_hint: p.name_hint || null, city: [p.city, p.state].filter(Boolean).join(", ") || p.circle || null,
    as_of: asOf.slice(0, 16), generated_at: generatedAt, cold_start: !enq.length && !calls.length && !vs.length,
    contact_policy: view.do_not_call?.active ? "do_not_call" : "ok", flags, kyc: asSeller ? "via_seller_account" : "unknown",
    looking_for: lookingFor, loops: loops.filter((l) => l.type !== "promise").slice(0, 3).map(({ ts, summary: _s, ...l }) => l),
    resume: loops[0]?.type === "promise" ? { from: loops[0].from, on: loops[0].on, said: trim(loops[0].said, 60), promise: loops[0].text, key: loops[0].ref, target: loops[0].target,
    } : null,
    stats: { enq_90d: enq.length, sellers_90d: sellers.size, calls_90d: calls.length, requirement_picked_by: picked },
    tokens: 0,
  };
  const build = (lv) => {
    const L = [frontMatter(fm), `# Buyer · ${p.name_hint ? `${p.name_hint} · ` : ""}${fm.city || "location unknown"}`, ""];
    L.push(`**Who:** ${[p.designation, p.company && `at ${p.company}`, p.country].filter(Boolean).join(" ") || "no business details"} · KYC: ${kyc}`);
    L.push(`**Looking for:** ${lookingFor.join(", ") || "nothing in the last 90 days"}`);
    L.push("", "## Open loops", ...(loops.length ? loops.slice(0, lv.loops).map((l) => `- ${l.on} · ${LOOP_TEXT[l.type](l)}`) : ["- None."]));
    L.push("", `## Enquiries and status (last ${LB.enquiries} days)`);
    L.push(...(rows.length ? rows.slice(0, lv.recent + 2).map((r) => `- ${dmy(r.e.ts)} · ${trim(r.e.props.product, 50)} → ${r.s.company || "seller"} (${r.s.city || "?"}) · seller ${r.e.props.read ? "read it" : "has not opened it"} · ${r.sellerMsgs.length ? "seller replied" : "no reply yet"}`) : ["- None."]));
    L.push("", "## Sellers contacted", `- ${[...sellers].slice(0, 5).map(([gl, s]) => `${seller(gl).company || gl} (${seller(gl).city || "?"}): ${s.enq} enquiries, ${s.calls} calls`).join(" · ") || "None."}`);
    L.push("", "## Conversation history (latest first)", ...(conv.length ? conv.slice(0, lv.conv).map((c) => `- ${dmy(c.ts)} · ${c.t}`) : ["- None."]));
    L.push("", "## Engagement");
    L.push(`- ${enq.length} enquiries to ${sellers.size} sellers · ${calls.length} calls (${calls.filter((c) => c.props.connected).length} connected) · uses ${[...new Set(enq.map((e) => MODULE_CHANNEL(e.props.module)))].join(", ") || "–"}${lastActive ? ` · last active ${dmy(lastActive)}` : ""}`);
    if (picked) L.push(`- Their posted requirements were picked up by ${picked} supplier purchase${picked > 1 ? "s" : ""} (count only; suppliers not named)`);
    L.push("", "## Next best action", ...actions.slice(0, 3).map((a) => `- ${a}`));
    return L.join("\n") + "\n";
  };
  const md = fit(build, budget);
  fm.tokens = estimateTokens(md);
  return { md, fm };
}

// Atomic write (tmp + rename) so the bot never reads a half-written file. On Windows a scanner or indexer
// can briefly lock a file that is rewritten many times a second, so the rename is retried with a short backoff.
const SLEEP = new Int32Array(new SharedArrayBuffer(4));
function atomicWrite(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  for (let i = 0; i < 8; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      if (!["EPERM", "EACCES", "EBUSY"].includes(e.code)) throw e;
      Atomics.wait(SLEEP, 0, 0, 5 * (i + 1));
    }
  }
  fs.writeFileSync(file, data);
  fs.rmSync(tmp, { force: true });
}

export function writeContext(g, role, id, opts = {}) {
  const t0 = performance.now();
  const { md, fm } = role === "buyer" ? renderBuyer(g, id, opts) : renderSeller(g, id, opts);
  const dir = path.join(opts.outDir || OUT_DIR, role === "buyer" ? "buyers" : "sellers");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.md`);
  atomicWrite(file, md);
  return { file, md, fm, ms: performance.now() - t0 };
}

