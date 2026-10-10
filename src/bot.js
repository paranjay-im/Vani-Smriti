// VANI simulator. Reads ONLY the context file (seller.md / buyer.md), exactly as the production bot would.
// Policy layer (deterministic): contact policy, questions it must not ask, agenda from open loops,
// cross-channel resume from the bot's own promises. Phrasing: Hinglish templates, or Claude with --llm.
// Every choice is recorded as a Decision (reasoning memory) and written back to the graph at the end.
import { parseMd } from "./mdparse.js";
import { guard } from "./pii.js";
import { addMin } from "./time.js";
import { AGENT_NAME } from "./config.js";
import { llmReply } from "./llm.js";

// The questions a cold VANI script asks. `known` returns why the bot can skip it, from the file alone.
export const CATALOG = {
  seller: [
    { id: "products", ask: "Aap kaun se products bechte hain?", facts: [], known: (c) => (c.sells ? `products on file: ${c.sells}` : null) },
    { id: "city", ask: "Aap kis city se hain?", facts: [], known: (c) => (c.fm.city ? `city on file: ${c.fm.city}` : null) },
    {
      id: "meeting_pitch", ask: "Kya main hamare executive ke saath aapki meeting fix kar doon?",
      facts: ["already_met_executive", "exec_contact", "meeting_fixed", "not_interested_paid"],
      known: (c) => (c.has("already_met_executive") ? "already met an IndiaMART executive" : c.has("exec_contact") ? "an executive is already in contact"
        : c.has("meeting_fixed") ? "a meeting is already fixed" : c.has("not_interested_paid") ? "recently declined paid plans" : null),
    },
    {
      id: "paid_interest", ask: "Kya aap IndiaMART ke paid plans mein interested hain?", facts: ["not_interested_paid", "payment_intent"],
      known: (c) => (c.fm.segment === "paid" ? "already a paid customer" : c.has("not_interested_paid") ? "said not interested in paid plans"
        : c.has("payment_intent") ? "said they are about to pay" : null),
    },
    { id: "best_time", ask: "Aapse baat karne ka sahi time kya hai?", facts: [], known: (c) => (c.fm.best_time ? `reachable ${c.fm.best_time} (from answered calls)` : null) },
    { id: "channel_pref", ask: "Details call par bataun ya WhatsApp par bhejun?", facts: ["wants_whatsapp"], known: (c) => (c.fm.channel_pref === "whatsapp" ? "prefers WhatsApp" : null) },
  ],
  buyer: [
    { id: "requirement", ask: "Aapko kya chahiye?", facts: [], known: (c) => (c.fm.looking_for?.length ? `requirement on file: ${c.fm.looking_for.join(", ")}` : null) },
    { id: "city", ask: "Aap kis city se hain?", facts: [], known: (c) => (c.fm.city ? `city on file: ${c.fm.city}` : null) },
    { id: "suppliers", ask: "Kya aapne kisi supplier se baat ki hai?", facts: [], known: (c) => (c.fm.stats?.sellers_90d ? `contacted ${c.fm.stats.sellers_90d} seller(s)` : null) },
  ],
};

const INTENTS = [
  ["stop_calls", /(call (?:mat|na|nahi) kar|phone (?:mat|na) kar|dobara call mat|baar baar call|stop call|don'?t call|call band)/i],
  ["wrong", /(galat number|wrong number)/i],
  ["already_met", /((executive|aadmi|banda|rahul|team|sir)[^.?!]{0,40}(aa(?:ya|ye|yi)|aa chuk|mil (?:chuk|liy|gay|ke)|baat ho (?:gayi|chuki|gai))|meeting ho (?:gayi|chuki|gai))/i],
  ["not_paid", /((paid|plan|package)[^.?!]{0,25}(nahi|nhi|mat)|nahi lena|interest nahi)/i],
  ["paid_done", /(payment (?:kar|ho) (?:di|diya|gaya|gayi)|paid (?:kar|ho) (?:diya|gaya))/i],
  ["wants_whatsapp", /whats ?app/i],
  ["busy", /(busy|gaadi|driving|baad (?:me|mein)|later|kal call|abhi nahi)/i],
  ["price", /((?:₹|rs\.?|inr)\s*\d|\d[\d,]*\s*(?:₹|rs\b|rupe|rupay)|price\s*\d|\bmoq\b|\d+\s*(?:pcs|piece|pair|kg))/i],
  ["ask_which", /(kaun ?si|kaunsa|kya hai|which|details|batao|bataiye|bhejo|bhej do)/i],
  ["bot_q", /(bot ho|robot|machine|recording|insaan|real person|ai ho)/i],
  ["affirm", /^(haan|ha|han|ji|yes|ok|okay|theek|thik|sure|bilkul|hello|hi|hey|namaste|achha)\b/i],
  ["deny", /^(nahi|nhi|no|mat|na)\b/i],
  ["bye", /(thank|dhanyavad|dhanyawad|shukriya|bye|bas itna)/i],
];
export const detectIntents = (text) => new Set(INTENTS.filter(([, re]) => re.test(text)).map(([k]) => k));
const PRICE = INTENTS.find(([k]) => k === "price")[1];
// The sentence(s) of an utterance that match a pattern (so a quote does not drag along "send it on WhatsApp").
const sentencesMatching = (text, re) => {
  const parts = text.split(/(?<=[.!?])\s+/).filter((s) => re.test(s));
  return (parts.length ? parts.join(" ") : text).trim().slice(0, 90);
};

const CH = { voice: "call", whatsapp: "WhatsApp" };

export class VaniBot {
  constructor({ md, channel = "voice", direction = "outbound", now, llm = false, agent = AGENT_NAME }) {
    const { fm, body } = parseMd(md);
    this.md = md;
    this.fm = fm;
    this.role = fm.role || "seller";
    this.glid = fm.glid;
    this.channel = channel;
    this.direction = direction;
    this.agent = agent;
    this.llm = llm;
    this.startTs = now;
    this.clock = now;
    this.flags = new Set(fm.flags || []);
    this.sells = /\*\*Sells:\*\*\s*([^·\n]+)/.exec(body)?.[1]?.trim() || null;
    this.turns = [];
    this.decisions = [];
    this.notes = [];
    this.skipped = [];
    this.ended = false;
    this.outcome = "completed";
    this.session_id = `${channel}-${fm.glid}-${String(now).replace(/\D/g, "")}`;
    this.agenda = this.#buildAgenda();
    this.current = null;
    this.awaiting = null;
  }

  has(type) { return this.flags.has(type); }
  get name() { return this.role === "buyer" ? (this.fm.name_hint ? `${this.fm.name_hint} ji` : "") : this.fm.name ? `${this.fm.name} ji` : ""; }
  #tick() { this.clock = addMin(this.clock, this.channel === "voice" ? 0.25 : 0.75); return this.clock; }
  #decide(d) { this.decisions.push({ ts: this.clock, ...d }); }

  // ---------------------------------------------------------------- agenda from the file
  #buildAgenda() {
    const fm = this.fm;
    const items = [];
    const loops = fm.loops || [];
    const resume = fm.resume && fm.resume.target === this.channel ? fm.resume : null;
    const loopItem = (l) => (this.role === "buyer" ? this.#buyerItem(l) : this.#sellerItem(l));
    if (resume) {
      const loop = loops.find((l) => l.ref === resume.key && l.type !== "promise");
      const base = loop ? loopItem(loop) : null;
      items.push({
        key: resume.key, kind: "resume", facts: ["wants_whatsapp"],
        say: `${resume.on} ko ${CH[resume.from?.replace("VANI ", "")] || "call"} par aapne kaha tha "${resume.said}" — jaisa kaha tha, ${base ? `yeh rahi details: ${base.detail}` : `call ka summary: ${resume.promise.replace(/^send this call summary:?\s*/, "") || "aapki baatein note kar li hain."}`}`,
        detail: base?.detail, awaitAfter: base?.awaitAfter || null, product: base?.product, promise: resume.promise, resumeOf: resume,
      });
    }
    for (const l of loops) {
      if (l.type === "promise" || (resume && l.ref === resume.key)) continue;
      const it = loopItem(l);
      if (it) items.push(it);
    }
    if (!items.length) items.push(this.role === "buyer" ? this.#buyerDefault() : this.#sellerDefault());
    return items;
  }

  #sellerItem(l) {
    const detail = `Buyer ${l.city || ""} se hain, ${l.product || "aapke product"} ke liye. Aap price aur MOQ bata dijiye — main unhe reply bhej deti hoon.`;
    const promise = `send the ${l.product || "buyer"} enquiry details (buyer from ${l.city || "?"})`;
    switch (l.type) {
      case "buyer_waiting_reply":
        return { key: l.ref, kind: l.type, product: l.product, say: `${l.on} ko ${l.city} ke ek buyer ne ${l.product} par poocha hai: "${l.ask}" — abhi reply baaki hai. Kya main reply bhejne mein madad karun?`, detail, awaitAfter: "price", promise };
      case "unanswered_enquiry":
        return { key: l.ref, kind: l.type, product: l.product, say: `${l.on} ko ${l.city} ke ek buyer ki ${l.product} ki enquiry aayi hai, uska reply abhi baaki hai. Madad karun?`, detail, awaitAfter: "price", promise };
      case "missed_buyer_call":
        return { key: l.ref, kind: l.type, say: `${l.on} ko ${l.city} se ek buyer ka call connect nahi ho paya tha. Unki call-back details bhej doon?`, detail: "Main call-back details WhatsApp par bhej deti hoon.", promise: `send call-back details of the buyer from ${l.city}` };
      case "meeting_check":
        return { key: l.ref, kind: l.type, facts: ["meeting_fixed"], say: `${l.on} ko VANI ke through aapki meeting fix hui thi — kya woh ho gayi?`, detail: "Theek hai, main executive se dobara time confirm karwa deti hoon.", awaitAfter: null, promise: "re-confirm the meeting time with the executive" };
      case "callback_due":
        return { key: l.ref, kind: l.type, facts: ["callback_requested"], say: "Aapne call back ke liye kaha tha, isliye call kiya.", detail: "Bataiye, main kaise madad karun?" };
      case "whatsapp_unfinished":
        return { key: l.ref, kind: l.type, say: `WhatsApp par aap ${l.topic} kar rahe the aur "${l.ask}" par ruk gaye the — wahin se aage badhaayein?`, detail: "Bas wahi detail bata dijiye, baaki main bhar deti hoon.", promise: `continue the WhatsApp flow (${l.topic})` };
      case "photo_pending":
        return { key: l.ref, kind: l.type, say: "Aapne WhatsApp par product photos bheji thi jo catalog mein add nahi hui. Unhe add karwa doon?", detail: "Main photos catalog team ko bhej deti hoon.", promise: "add the WhatsApp photos to the catalog" };
      default:
        return null;
    }
  }

  #sellerDefault() {
    const s = this.fm.stats || {};
    if (this.fm.segment === "paid") return { key: "checkin", kind: "default", say: "Aapke account par sab theek chal raha hai? Kisi buyer ya lead mein madad chahiye?", detail: "Bataiye, main dekh leti hoon." };
    return { key: "profile_tips", kind: "default", say: `Pichhle 90 din mein aapko ${s.enq_90d ?? 0} enquiries aur ${s.buyer_calls_90d ?? 0} buyer calls mile hain. Profile thodi behtar karke aur buyers mil sakte hain — tips bhejun?`, detail: "Main 3 quick tips WhatsApp par bhej deti hoon.", promise: "send 3 profile-improvement tips" };
  }

  #buyerItem(l) {
    switch (l.type) {
      case "seller_asked_buyer":
        return { key: l.ref, kind: l.type, product: l.product, direct: true, say: `${l.on} ko ${l.seller} ne aapki ${l.product} enquiry par poocha tha: "${l.ask}" — aapka jawab bata dijiye, main unhe bhej deti hoon.`, detail: "Aapka jawab seller ko bhej deti hoon.", awaitAfter: "answer", promise: `send the buyer's answer to ${l.seller}` };
      case "waiting_on_seller":
        return { key: l.ref, kind: l.type, product: l.product, say: `${l.on} ko aapne ${l.seller} se ${l.product} ke baare mein poocha tha${l.ask ? ` ("${l.ask}")` : ""}. Seller ne ${l.seen ? "message dekh liya hai" : "abhi message khola nahi"}, par reply nahi aaya. Unhe yaad dila doon, ya milte-julte suppliers bhejun?`, detail: `${l.seller} ko reminder bhej diya hai, aur ${l.product} ke 2-3 milte-julte suppliers agle message mein bhej rahi hoon.`, promise: `share 2-3 alternative suppliers for ${l.product}` };
      case "seller_replied_unread":
        return { key: l.ref, kind: l.type, product: l.product, say: `${l.seller} ne aapki ${l.product} enquiry ka jawab bheja hai — aapne abhi dekha nahi. Sunaun?`, detail: "Main unka jawab WhatsApp par forward kar deti hoon.", promise: `forward ${l.seller}'s reply` };
      default:
        return null;
    }
  }

  #buyerDefault() {
    const lf = this.fm.looking_for?.[0];
    return lf
      ? { key: "requirement_open", kind: "default", say: `Kya aapki ${lf} ki requirement abhi bhi open hai?`, detail: "Main 2-3 verified suppliers WhatsApp par bhej deti hoon.", promise: `share suppliers for ${lf}` }
      : { key: "requirement_new", kind: "default", say: "Bataiye, aaj kis cheez ki requirement hai?", detail: "Noted." };
  }

  // ---------------------------------------------------------------- baseline: what a cold bot would do
  coldOpening() {
    const qs = CATALOG[this.role].map((q) => q.ask);
    const text = this.channel === "voice"
      ? `Namaste, main ${this.agent}, IndiaMART se bol rahi hoon. Kya main ${this.fm.name || this.fm.name_hint || "aapke business"} se baat kar rahi hoon? ${qs[0]}`
      : "Namaste! IndiaMART mein aapka swagat hai 🙏 Bataiye, main aapki kya madad kar sakti hoon?";
    return { text, questions: qs };
  }

  // ---------------------------------------------------------------- conversation
  async start(firstUserText = null) {
    if (firstUserText) this.#hear(firstUserText);
    // Pre-call policy: an outbound call to someone who asked us to stop is never placed.
    if (this.channel === "voice" && this.direction === "outbound" && this.fm.contact_policy === "do_not_call") {
      this.#decide({ action: "suppress_call", reason: "contact_policy = do_not_call in the context file", facts: ["do_not_call"], text: "Outbound VANI call not placed; seller can still be helped on WhatsApp if they write in" });
      this.notes.push("outbound call suppressed: seller had asked IndiaMART to stop calling");
      this.outcome = "suppressed_do_not_call";
      this.ended = true;
      return { suppressed: true, text: null };
    }
    for (const q of CATALOG[this.role]) {
      const why = q.known(this);
      if (why) {
        this.skipped.push(q);
        this.#decide({ action: "skip_question", question: q.id, ask: q.ask, reason: why, facts: q.facts.filter((f) => this.has(f)) });
      }
    }
    this.current = this.agenda.shift();
    const resuming = this.current.kind === "resume";
    const acks = [];
    if (this.has("do_not_call")) acks.push("Aapke kehne par hum ab aapko call nahi kar rahe.");
    if (!resuming && (this.has("already_met_executive") || this.has("exec_contact"))) acks.push("Aapki hamare executive se baat ho chuki hai, isliye meeting ki baat nahi karungi.");
    else if (!resuming && this.has("not_interested_paid")) acks.push("Paid plan ki baat nahi karungi.");
    if (this.has("asked_if_bot")) acks.push("Main IndiaMART ki AI assistant hoon.");
    if (this.fm.contact_policy === "cooldown") acks.push("Bas ek minute lungi.");
    if (this.current.kind === "resume") {
      this.#decide({ action: "fulfil", key: this.current.key, reason: `promise made on ${this.current.resumeOf.from} ${this.current.resumeOf.on}`, text: this.current.promise, facts: ["wants_whatsapp"] });
      this.notes.push(`resumed from ${this.current.resumeOf.from}: ${this.current.promise}`);
      this.awaiting = this.current.awaitAfter;
    } else {
      this.awaiting = this.current.direct ? this.current.awaitAfter : "help";
    }
    this.#decide({ action: "opening", reason: `agenda: ${this.current.kind}`, facts: [...(this.current.facts || []), ...[...this.flags].filter((f) => ["do_not_call", "already_met_executive", "exec_contact", "not_interested_paid", "asked_if_bot"].includes(f))] });
    const hi = this.channel === "voice" ? `Namaste ${this.name}! Main ${this.agent}, IndiaMART se.` : `Namaste ${this.name} 🙏`;
    const text = [hi.replace(/\s+!/, "!"), ...acks, this.current.say].join(" ");
    return { suppressed: false, text: await this.#say(text, `Open the ${this.channel} conversation using the context file; agenda item: ${this.current.kind}`) };
  }

  async reply(text) {
    if (this.ended) return null;
    this.#hear(text);
    const it = detectIntents(text);
    const out = [];
    const cur = this.current;
    let advance = false;

    if (it.has("wrong")) {
      out.push("Maaf kijiye, galat number lag gaya. Main record theek karwa deti hoon.");
      this.notes.push("said it is the wrong number");
      this.outcome = "wrong_contact";
      return this.#close(out, "close: wrong number");
    }
    if (it.has("stop_calls")) {
      out.push("Maafi chahti hoon — aage se aapko call nahi aayegi. Zaroori buyer updates sirf WhatsApp par bhejungi.");
      this.#decide({ action: "policy_update", reason: "seller asked to stop calls", text: "stop outbound calls", facts: ["do_not_call"] });
      this.notes.push("asked IndiaMART to stop calling");
      this.agenda = [];
      this.outcome = "do_not_call";
      return this.#close(out, "close politely after a stop-calls request");
    }
    if (it.has("bot_q")) out.push("Ji, main IndiaMART ki AI assistant hoon.");
    if (it.has("already_met")) {
      out.push("Achha, executive se baat ho chuki hai — main meeting ki baat dobara nahi karungi.");
      this.#decide({ action: "policy_update", reason: "seller confirmed the executive meeting happened", text: "drop the meeting pitch", facts: ["already_met_executive"] });
      this.notes.push("confirmed the executive meeting already happened");
      if (cur?.kind === "meeting_check") advance = true;
    }
    if (it.has("not_paid")) {
      out.push("Samajh gayi, plan ki baat nahi karungi.");
      this.notes.push("not interested in paid plans");
    }
    if (it.has("paid_done")) this.notes.push("said the payment is done");
    // A quote/answer belongs to the open buyer loop it mentions, which may not be the item being discussed.
    const pool = [cur, ...this.agenda].filter((x) => x && (x.awaitAfter === "price" || x.awaitAfter === "answer"));
    const stems = (x) => String(x.product || "").toLowerCase().split(/\W+/).filter((w) => w.length > 3).map((w) => w.slice(0, Math.max(4, w.length - 2)));
    const target = it.has("price") ? pool.find((x) => stems(x).some((w) => text.toLowerCase().includes(w))) || pool[0] : null;
    if (target) {
      const quote = sentencesMatching(text, PRICE).replace(/[.\s]+$/, "");
      out.push(`Noted ✅ "${quote}" — main yeh ${this.role === "buyer" ? "seller" : "buyer"} ko bhej deti hoon.`);
      this.#decide({ action: "act", key: target.key, reason: "user shared the missing detail", text: `forward "${quote}" for ${target.product || target.kind}`, quote, from: this.role });
      this.#decide({ action: "fulfil", key: target.key, reason: "loop closed in this session", text: target.promise || target.kind });
      this.notes.push(`shared "${quote}" for ${target.product || target.kind}; VANI forwarded it`);
      this.outcome = "loop_closed";
      if (target === cur) advance = true;
      else {
        this.agenda = this.agenda.filter((x) => x !== target);
        out.push(cur.say);
      }
    }
    if (it.has("wants_whatsapp")) {
      // If this turn already closed the current item, the promise is about what comes next (or a call summary).
      const target = advance ? this.agenda[0] : cur || this.agenda[0];
      out.push("Bilkul — main abhi WhatsApp par bhej deti hoon.");
      if (this.channel !== "whatsapp") {
        this.#decide({ action: "promise", target: "whatsapp", key: target?.key || "summary", said: sentencesMatching(text, /whats ?app/i), text: target?.promise || "send this call summary", facts: [] });
        this.notes.push(`asked for details on WhatsApp — VANI promised to ${target?.promise || "send a summary"}`);
        this.outcome = "promised_whatsapp";
      }
      if (it.has("busy")) return this.#close(out, "close: seller is busy, follow up on WhatsApp");
      advance = true;
    } else if (it.has("busy")) {
      out.push("Koi baat nahi, main baad mein call karti hoon.");
      this.#decide({ action: "promise", target: "voice", key: "callback", said: text.trim().slice(0, 80), text: "call back later", facts: [] });
      this.notes.push("busy — asked for a call back");
      this.outcome = "callback";
      return this.#close(out, "close: seller is busy");
    }
    if (!advance && cur?.kind === "meeting_check" && it.has("affirm")) {
      out.push("Badhiya.");
      this.#decide({ action: "fulfil", key: cur.key, reason: "seller confirmed the VANI-fixed meeting happened", text: "meeting check closed", facts: ["meeting_fixed"] });
      this.notes.push("confirmed the VANI-fixed meeting happened");
      advance = true;
    }
    if (!advance && (!out.length || it.has("ask_which") || (it.has("affirm") && this.awaiting === "help"))) {
      if (cur && this.awaiting === "help" && (it.has("affirm") || it.has("ask_which"))) {
        out.push(cur.detail);
        this.awaiting = cur.awaitAfter || null;
        if (!this.awaiting) advance = true;
      } else if (cur?.kind === "meeting_check" && it.has("deny")) {
        out.push(cur.detail);
        this.#decide({ action: "promise", target: "voice", key: cur.key, said: text.trim().slice(0, 80), text: cur.promise, facts: ["meeting_fixed"] });
        advance = true;
      } else if (it.has("deny")) {
        out.push("Theek hai.");
        advance = true;
      } else if (it.has("bye")) {
        return this.#close(out, "close");
      } else if (!out.length) {
        out.push("Ji, samajh gayi.");
        advance = true;
      }
    }
    if (it.has("bye") && !advance) return this.#close(out, "close");
    if (advance) {
      this.current = this.agenda.shift() || null;
      if (this.current) { out.push(this.current.say); this.awaiting = "help"; }
      else return this.#close(out, "close: agenda done");
    }
    return this.#say(out.join(" "), `Respond to the user; current agenda item: ${this.current?.kind || "none"}`);
  }

  async #close(out, goal) {
    out.push(this.channel === "voice" ? "Dhanyavaad, aapka din shubh ho!" : "Dhanyavaad 🙏 Kuch aur chahiye ho to yahin likhiye.");
    this.ended = true;
    return this.#say(out.join(" "), goal);
  }

  #hear(text) { this.turns.push({ speaker: this.role, text, ts: this.#tick() }); }

  async #say(ruleText, goal) {
    let text = ruleText;
    if (this.llm) {
      const policy = [
        `Channel: ${this.channel} (${this.direction}). Goal: ${goal}.`,
        this.skipped.length ? `Do NOT ask: ${this.skipped.map((q) => `"${q.ask}" (${q.known(this)})`).join("; ")}.` : "",
        `Suggested reply from the rule engine: ${ruleText}`,
      ].filter(Boolean).join("\n");
      text = (await llmReply({ contextMd: this.md, history: this.turns, policy })) || ruleText;
    }
    const g = guard(text);
    if (g.redacted) this.#decide({ action: "redact", reason: "privacy guard removed a phone number or email from the reply" });
    this.turns.push({ speaker: "bot", text: g.text, ts: this.#tick() });
    return g.text;
  }

  // Hinglish recap of what VANI did in this session, for a "send me the summary" promise.
  #recap() {
    const acts = this.decisions.filter((d) => d.action === "act" && d.quote);
    return acts.length ? acts.map((d) => `aapka "${d.quote}" ${this.role === "buyer" ? "seller" : "buyer"} ko bhej diya gaya hai.`).join(" ") : "aapki baatein note kar li hain.";
  }

  end() {
    for (const d of this.decisions) if (d.action === "promise" && d.key === "summary") d.text = `send this call summary: ${this.#recap()}`;
    const summary = this.notes.length ? `${this.notes.join("; ")}.` : this.outcome === "completed" ? "Conversation completed, nothing new learned." : this.outcome;
    return {
      source: "vani_session",
      row: {
        session_id: this.session_id, glid: this.glid, role: this.role, channel: this.channel, direction: this.direction,
        ts: this.startTs, end_ts: this.clock, summary, outcome: this.outcome, turns: this.turns, decisions: this.decisions, llm: this.llm,
      },
    };
  }
}
