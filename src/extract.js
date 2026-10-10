// Reasoning memory, part 1: Facts.
// A Fact is something the user told us (or did) that should change how the bot behaves next time.
// Every fact keeps provenance (DERIVED_FROM the interaction), a timestamp and a time-to-live, so
// the renderer can show the latest version, how often it was said, and drop it when it goes stale.
import { T } from "./sources.js";
import { scrub } from "./pii.js";
import { addDays, addMin, daysBetween, cmpTs } from "./time.js";

// ttl = days a fact stays active after it was last asserted; pri = order in "Do not re-ask".
export const FACTS = {
  do_not_call: { ttl: 180, pri: 1, say: "Asked IndiaMART to stop these calls" },
  wrong_contact: { ttl: 180, pri: 1, say: "Said this is the wrong number / not the right person" },
  already_met_executive: { ttl: 45, pri: 2, say: "Already met / in touch with an IndiaMART executive" },
  exec_contact: { ttl: 30, pri: 2, say: "Answered an IndiaMART executive call" },
  frustrated: { ttl: 30, pri: 2, say: "Annoyed by repeated calls" },
  meeting_fixed: { ttl: 21, pri: 3, say: "Meeting fixed through VANI" },
  callback_requested: { ttl: 7, pri: 3, say: "Asked for a call back" },
  seller_request: { ttl: 30, pri: 3, say: "Raised a request on a VANI call" },
  wants_whatsapp: { ttl: 60, pri: 3, say: "Wants details on WhatsApp, not read out on calls" },
  not_interested_paid: { ttl: 30, pri: 4, say: "Not interested in paid plans right now" },
  payment_intent: { ttl: 30, pri: 4, say: "Said they are about to pay / have paid" },
  asked_if_bot: { ttl: 90, pri: 5, say: "Asked whether they were talking to a bot (be upfront that VANI is AI)" },
  sourcing_interest: { ttl: 90, pri: 9, say: "Sourcing as a buyer" },
};

// English rules run on VANI call summaries (LLM-written, English). [type, pattern, unless]
const EN = [
  ["do_not_call", /\b(stop (?:the |these |further |any further |all |the further )?(?:calls|calling)|not to call|do not call|don't call|no (?:more|further) calls|update (?:their|the|his|her) system to stop|remove (?:their|his|her) (?:number|contact)|stop contacting)\b/i],
  ["wrong_contact", /\b(wrong number|not the (?:right|correct) person|not (?:the )?owner of|no longer (?:associated|with the)|not associated with)\b/i],
  ["already_met_executive", /\b(executive|sales (?:person|representative|team)|someone from indiamart|indiamart (?:team|representative|person)|representative)\b[^.]{0,80}\b(already|visited|has met|had met|met (?:with )?(?:him|her|them)|came to)\b|\balready (?:been )?(?:in (?:contact|touch)|spoken|met|visited|talked)\b[^.]{0,60}\b(executive|indiamart|someone|representative)\b|\bin (?:contact|touch) with [A-Za-z]+(?: [A-Za-z]+)? from indiamart\b/i],
  ["frustrated", /\b(frustrat\w*|annoy\w*|irritat\w*|angr\w*|too many calls|frequent calls|repeated(?:ly)? call\w*|keeps? calling)\b/i],
  ["not_interested_paid", /\b(not interested|disinterest\w*|no interest|declined)\b[^.]{0,50}\b(paid|plan|subscription|package|services?)\b|\basked for free leads\b|\b(?:does not|doesn't|did not) want to pay\b/i, /\b(later|eventually|then) agreed\b/i],
  ["payment_intent", /\b(about to|ready to|going to|will) (?:make (?:a |the )?)?pay(?:ment)?\b|\b(?:made|make) (?:a |the )?payment\b/i],
  ["asked_if_bot", /\basked (?:if|whether)[^.]{0,50}\b(bot|robot|real (?:person|human)|human|automated|an ai)\b/i],
  ["wants_whatsapp", /\b(lead|seller|he|she|they)\b[^.]{0,40}\b(requested|asked|wanted|prefer\w*)\b[^.]{0,40}\bwhatsapp\b/i],
  ["callback_requested", /\b(lead|seller|he|she|they)\b[^.]{0,60}\b(call (?:him |her |them )?back|callback|call later|call again|call (?:him |her |them )?(?:after|tomorrow|in the evening|next))\b/i],
];

// Hinglish / Hindi rules run on what the seller actually said (transcripts, WhatsApp, live sessions).
const HI = [
  ["do_not_call", /(call (?:mat|na|nahi) kar|phone (?:mat|na) kar|dobara (?:call|phone) (?:mat|na)|baar baar (?:call|phone)|call band kar|stop call|don'?t call|कॉल मत|फोन मत)/i],
  ["wrong_contact", /(galat number|wrong number)/i],
  ["already_met_executive", /((executive|aadmi|banda|sir|madam|team|rahul|wale)[^.?!]{0,40}(aa(?:ya|ye|yi)|aa chuk|mil (?:chuk|liy|gay|ke)|baat ho (?:gayi|chuki|gai))|meeting ho (?:gayi|chuki|gai))/i],
  ["not_interested_paid", /((paid|plan|package|subscription)[^.?!]{0,25}(nahi|nhi|mat)|nahi lena|interest nahi|zaroorat nahi)/i],
  ["wants_whatsapp", /whats ?app\s*(?:pe|par|pr|me|mein)?\s*(?:hi\s*)?(?:bhej|send|daal|share|kar)/i],
  ["callback_requested", /(baad (?:me|mein) (?:call|baat|phone)|kal (?:call|baat|phone)|call back|thodi der (?:me|mein|baad)|abhi busy|gaadi chala)/i, /whats ?app/i],
  ["frustrated", /(pareshan|tang aa|irritat|dimag kharab|kitni baar)/i],
  ["asked_if_bot", /(bot ho|robot|machine ho|recording hai|insaan ho|real person|ai ho)/i],
  ["payment_intent", /(payment (?:kar|ho) (?:di|diya|dunga|denge|gaya|gayi)|paise (?:de|bhej) (?:diye|dunga))/i],
];

const sentences = (t) => String(t).split(/(?<=[.!?।])\s+/);
// Keep the part of a long sentence around the match, so the quote shows the reason, not the preamble.
function around(sent, re) {
  if (sent.length <= 120) return sent;
  const m = re.exec(sent);
  const start = Math.max(0, m.index - 45);
  return (start ? "…" : "") + sent.slice(start, start + 115).trim() + (start + 115 < sent.length ? "…" : "");
}
export function matchFacts(text, rules = [...EN, ...HI]) {
  const out = [];
  if (!text) return out;
  for (const [type, re, unless] of rules) {
    if (out.some((o) => o.type === type)) continue;
    const sent = sentences(text).find((s) => re.test(s) && !(unless && unless.test(s)));
    if (sent) out.push({ type, evidence: around(sent, re) });
  }
  return out;
}

const NUMW = { one: 1, two: 2, three: 3, four: 4, five: 5, ek: 1, do: 2, teen: 3, char: 4, paanch: 5 };
// "tomorrow at 5 PM", "after two days", "kal 4 baje" -> an IST timestamp relative to base.
export function parseWhen(text, base) {
  if (!text || !base) return null;
  const t = text.toLowerCase();
  if (/half an hour|30 minutes|aadhe ghante/.test(t)) return addMin(base, 30);
  let days = null, hour = null, mins = 0;
  if (/day after tomorrow|parso/.test(t)) days = 2;
  else if (/\btomorrow\b|next day|\bkal\b/.test(t)) days = 1;
  let m = t.match(/after (\w+) days?|(\w+) din (?:baad|me|mein)/);
  if (m) { const w = m[1] || m[2]; const n = Number(w) || NUMW[w]; if (n) days = n; }
  m = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?|baje)/);
  if (m) {
    hour = Number(m[1]); mins = Number(m[2] || 0);
    if (m[3][0] === "p" && hour < 12) hour += 12;
    if (m[3][0] === "b" && hour < 8) hour += 12;
  } else if (/evening|shaam/.test(t)) hour = 18;
  else if (/afternoon|dopahar/.test(t)) hour = 14;
  else if (/morning|subah/.test(t)) hour = 11;
  if (days === null && hour === null) return null;
  const day = addDays(base, days || 0).slice(0, 10);
  return `${day} ${String(hour ?? 11).padStart(2, "0")}:${String(mins).padStart(2, "0")}:00`;
}

const CHANNEL = { BotCall: "VANI call", BotTurn: "VANI call", VaniSession: "VANI", ChatTurn: "WhatsApp", ExecCall: "exec call", PNSCall: "PNS call", Seller: "profile flag" };

export function addFact(g, { owner, type, ts, evidence, ref, value, due, channel }) {
  const key = owner.glid || `B${owner.buyer}`;
  const id = `F:${key}:${type}:${ref}`;
  if (g.get(id)) return null;
  const n = g.upsert({ id, label: "Fact", tier: T.R, ...owner, ts, props: { type, evidence: scrub(evidence, { max: 170, names: false }), value, due, channel } });
  g.link(id, "ABOUT", owner.glid ? `S:${owner.glid}` : `B:${owner.buyer}`);
  if (ref && !ref.startsWith("profile")) g.link(id, "DERIVED_FROM", ref);
  return n;
}

// Called for every node on ingest. Only interaction nodes produce facts.
export function extractFor(g, n) {
  const p = n.props;
  switch (n.label) {
    case "Seller": {
      const v = p.vani || {};
      const owner = { glid: n.glid };
      if (v.dnc) addFact(g, { owner, type: "do_not_call", ts: null, evidence: "profile: do_not_call_requested = 1", ref: "profile", channel: CHANNEL.Seller });
      if (v.frustrated) addFact(g, { owner, type: "frustrated", ts: null, evidence: "profile: showed_frustration = 1", ref: "profile", channel: CHANNEL.Seller });
      if (v.in_touch_exec) addFact(g, { owner, type: "already_met_executive", ts: null, evidence: "profile: already_in_touch_with_executive = 1", ref: "profile", channel: CHANNEL.Seller });
      if (v.asked_if_bot) addFact(g, { owner, type: "asked_if_bot", ts: null, evidence: "profile: asked_if_talking_to_bot = 1", ref: "profile", channel: CHANNEL.Seller });
      return;
    }
    case "BotCall": {
      if (!n.glid) return;
      const owner = { glid: n.glid };
      for (const f of matchFacts(p.summary, EN)) {
        const due = f.type === "callback_requested" ? parseWhen(f.evidence, n.ts) : null;
        addFact(g, { owner, ...f, ts: n.ts, ref: n.id, due, channel: CHANNEL.BotCall });
      }
      if (p.disposition === "Meeting Fixed") {
        const ev = sentences(p.summary || "").find((s) => /meeting/i.test(s)) || "Disposition: Meeting Fixed";
        addFact(g, { owner, type: "meeting_fixed", ts: n.ts, evidence: ev, ref: n.id, due: parseWhen(ev, n.ts), channel: CHANNEL.BotCall });
      }
      if (p.disposition === "Call Later / Busy" && (p.duration || 0) >= 8) {
        addFact(g, { owner, type: "callback_requested", ts: n.ts, evidence: sentences(p.summary || "Call Later / Busy").slice(-1)[0], ref: n.id, due: parseWhen(p.summary, n.ts), channel: CHANNEL.BotCall });
      }
      return;
    }
    case "BotTurn": {
      if (p.speaker !== "seller" || !n.glid) return;
      const parent = g.get(p.call);
      const ts = parent?.ts || n.ts;
      if (!ts) return;
      // Same ref as the call, so a fact said in the transcript and the summary is counted once.
      for (const f of matchFacts(p.text, HI)) addFact(g, { owner: { glid: n.glid }, ...f, ts, ref: p.call, channel: CHANNEL.BotTurn });
      return;
    }
    case "ChatTurn": {
      if (!n.glid) return;
      const owner = { glid: n.glid };
      if (p.user) for (const f of matchFacts(p.user, HI)) addFact(g, { owner, ...f, ts: n.ts, ref: p.session, channel: CHANNEL.ChatTurn });
      const product = /Enquiry for \*(.+?)\* has been sent/i.exec(p.raw_bot || "")?.[1];
      if (product) addFact(g, { owner, type: "sourcing_interest", ts: n.ts, evidence: `Posted a buy requirement on WhatsApp: ${product}`, value: scrub(product, { max: 60 }), ref: p.session, channel: CHANNEL.ChatTurn });
      return;
    }
    case "ExecCall": {
      if (n.glid && p.answered && p.customer_sec >= 20) {
        addFact(g, { owner: { glid: n.glid }, type: "exec_contact", ts: n.ts, evidence: `${p.module} call answered, ${p.customer_sec}s with employee ${p.employee}`, value: p.employee, ref: n.id, channel: CHANNEL.ExecCall });
      }
      return;
    }
    case "PNSCall": {
      if (n.glid && p.role === "BUYER" && p.products) {
        addFact(g, { owner: { glid: n.glid }, type: "sourcing_interest", ts: n.ts, evidence: `Called a supplier about ${p.products}`, value: p.products, ref: n.id, channel: CHANNEL.PNSCall });
      }
      return;
    }
    case "VaniSession": {
      const owner = n.glid ? { glid: n.glid } : { buyer: n.buyer };
      // Outcomes a Sarvam agent reported as structured values (src/sarvam.js), so no text rule has to find them.
      for (const f of p.facts || []) {
        if (FACTS[f.type]) addFact(g, { owner, type: f.type, ts: n.ts, evidence: f.evidence || FACTS[f.type].say, ref: n.id, due: f.due || null, channel: `VANI ${p.channel}` });
      }
      for (const t of p.turns || []) {
        if (t.speaker === "bot") continue;
        for (const f of matchFacts(t.text, [...HI, ...EN])) {
          const due = f.type === "callback_requested" ? parseWhen(t.text, t.ts) : null;
          addFact(g, { owner, ...f, ts: t.ts, ref: n.id, due, channel: `VANI ${p.channel}` });
        }
      }
      return;
    }
    default:
  }
}

// The active view: latest assertion per fact type, how often it was said, whether it has expired,
// and conflict resolution (newer event > older event > profile snapshot).
export function factView(g, owner, asOf) {
  const all = (owner.glid ? g.owned(owner.glid, "Fact") : g.ofBuyer(owner.buyer, "Fact")).filter((f) => !f.ts || f.ts <= asOf);
  const groups = new Map();
  for (const f of all) {
    const t = f.props.type;
    if (!groups.has(t)) groups.set(t, []);
    groups.get(t).push(f);
  }
  const view = {};
  for (const [type, list] of groups) {
    const events = list.filter((f) => f.ts).sort(cmpTs);
    const latest = events.at(-1) || list[0];
    const def = FACTS[type];
    const active = events.length ? daysBetween(latest.ts, asOf) <= def.ttl : true;
    const refs = new Set(events.map((f) => f.id.split(":").slice(3).join(":")));
    view[type] = { type, ...def, active, latest, first: events[0] || null, count: refs.size, fromProfile: !events.length };
  }
  const meeting = view.meeting_fixed;
  const met = view.already_met_executive;
  if (meeting?.active && met && !met.fromProfile && met.latest.ts > meeting.latest.ts) {
    meeting.active = false;
    meeting.resolved = "seller later said the executive already met them";
  }
  const cb = view.callback_requested;
  if (cb?.active && owner.glid) {
    const after = (x) => x.ts > cb.latest.ts && x.ts <= asOf;
    const reached = [...g.owned(owner.glid, "BotCall").filter((x) => (x.props.duration || 0) >= 10),
      ...g.owned(owner.glid, "ExecCall").filter((x) => x.props.answered),
      ...g.owned(owner.glid, "VaniSession").filter((x) => x.props.channel === "voice" && (x.props.turns || []).length > 1)].some(after);
    if (reached) { cb.active = false; cb.resolved = "reached again after the request"; }
  }
  return view;
}
