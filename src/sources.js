// One normaliser per source: a raw row (CSV or live event, same column names) -> nodes + edges.
// Tiers follow the context-graph model: long_term = who the user is, short_term = what happened,
// reasoning = facts and decisions derived from what happened (see extract.js and bot.js).
import { norm, utcToIst } from "./time.js";
import { scrub } from "./pii.js";

export const T = { L: "long_term", S: "short_term", R: "reasoning" };

export const SOURCES = {
  profile: { file: "gc_seller_profile.csv", ts: () => null },
  bot_calls: { file: "gc_bot_calls.csv", ts: (r) => norm(r.call_start_time) },
  bot_call_turns: { file: "gc_bot_call_turns.csv", ts: () => null },
  exec_calls: { file: "gc_executive_calls.csv", ts: (r) => norm(r.call_start_time) },
  buyer_calls: { file: "gc_buyer_calls_received.csv", ts: (r) => norm(r.call_datetime) },
  enquiries: { file: "gc_enquiries_received.csv", ts: (r) => norm(r.enquiry_date) },
  enquiry_messages: { file: "gc_enquiry_messages.csv", ts: (r) => norm(r.reply_date) },
  buyleads: { file: "gc_buyleads_bought.csv", ts: (r) => norm(r.purchase_date) },
  whatsapp: { file: "gc_whatsapp_messages.csv", ts: (r) => norm(r.entry_date) },
  chatbot: { file: "gc_whatsapp_chatbot_conversations.csv", ts: (r) => norm(r.entry_date) },
  pns_calls: { file: "gc_buyer_call_extractions.csv", ts: (r) => utcToIst(r.call_date) },
};
// Parents before children, calls before enquiries (so call -> enquiry links resolve on bulk load).
export const LOAD_ORDER = ["profile", "bot_calls", "bot_call_turns", "exec_calls", "buyer_calls", "enquiries",
  "enquiry_messages", "buyleads", "whatsapp", "chatbot", "pns_calls"];

// The column that holds the seller's GLID in each source (and in the runtime vani_session event).
// Lets a run be limited to chosen sellers: a seller's context file depends only on that seller's own rows.
export const SELLER_KEY = {
  profile: "fk_glusr_usr_id", bot_calls: "fk_glusr_usr_id", bot_call_turns: "fk_glusr_usr_id", exec_calls: "fk_glusr_usr_id",
  buyer_calls: "seller_glid", enquiries: "seller_glid", enquiry_messages: "seller_glid", buyleads: "seller_glid",
  whatsapp: "glid", chatbot: "glid", pns_calls: "glid", vani_session: "glid",
};
// The seller an event belongs to, or null (a buyer-role vani_session, an unknown source, a blank value).
export function sellerOf(ev) {
  const key = SELLER_KEY[ev.source];
  if (!key || (ev.source === "vani_session" && ev.row.role === "buyer")) return null;
  return ev.row[key] || null;
}

export const eventTs = (ev) => (SOURCES[ev.source] ? SOURCES[ev.source].ts(ev.row) : norm(ev.row.ts));

const num = (v) => (v === "" || v === undefined || v === null || Number.isNaN(Number(v)) ? null : Number(v));
const flag = (v) => (v === "" || v === undefined || v === null ? null : Number(v) >= 1);
const STATUS_RANK = { read: 4, delivered: 3, sent: 2, failed: 1 };
export const statusRank = (s) => STATUS_RANK[String(s || "").toLowerCase()] || 0;

function nameHint(subject) {
  const m = /\bfrom\s+([A-Za-z][A-Za-z.]{1,20})(?:\s+[A-Za-z.]+)*\s+via IndiaMART\s*$/i.exec(subject || "")
    || /\bfrom\s+([A-Za-z]{2,20})\b/i.exec(subject || "");
  if (!m || /^(mr|mrs|ms|miss|dr|sir|shri|smt|m\/s)\.?$/i.test(m[1])) return null;
  return m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
}
const langs = (s) => [...String(s || "").matchAll(/'([^']+)'/g)].map((m) => m[1][0].toUpperCase() + m[1].slice(1).toLowerCase());
const cleanBotReply = (t) => (!t ? "" : t.trim().startsWith("{") ? "[card]" : scrub(t, { max: 160 }));
const productKey = (glid, name) => `P:${glid}:${name.toLowerCase().slice(0, 80)}`;

export function normalize(ev) {
  const r = ev.row;
  const N = [];
  const E = [];
  const ts = eventTs(ev);
  switch (ev.source) {
    case "profile": {
      const g = r.fk_glusr_usr_id;
      const eng = {};
      for (const k in r) if (k.startsWith("eng_")) eng[k.slice(4)] = num(r[k]);
      const cats = [r.top_category_1, r.top_category_2, r.top_category_3].filter(Boolean);
      N.push({
        id: `S:${g}`, label: "Seller", tier: T.L, glid: g,
        props: {
          company: r.company_name, city: r.seller_city, district: r.seller_district, state: r.seller_state,
          pincode: r.seller_pincode, locality: r.seller_locality, business_type: r.business_type,
          turnover: r.annual_turnover, nature: r.nature_of_business, gst_year: r.gst_registration_year,
          categories: cats, parent_category: r.top_parent_category, category_group: r.top_category_group,
          customer_type: r.customer_type, paid: r.is_paid === "-1", listing_status: r.listing_status,
          kyc: { mobile: flag(r.mobile_verified_flag), email: flag(r.email_verified_flag), gst: flag(r.gst_verified_flag), pan: flag(r.is_pan_number_available) },
          eng,
          vani: {
            attempts: num(r.bot_attempts), answered: num(r.bot_answered), answer_rate: num(r.bot_answer_rate),
            dispositions: r.past_dispositions_detailed, objections: r.past_objections,
            asked_if_bot: flag(r.asked_if_talking_to_bot), frustrated: flag(r.showed_frustration),
            in_touch_exec: flag(r.already_in_touch_with_executive), dnc: flag(r.do_not_call_requested),
          },
        },
      });
      for (const c of cats) {
        const id = `C:${c.toLowerCase()}`;
        N.push({ id, label: "Category", tier: T.L, props: { name: c } });
        E.push([`S:${g}`, "LISTS_CATEGORY", id]);
      }
      break;
    }
    case "enquiries": {
      const g = r.seller_glid, b = r.buyer_glid, id = `ENQ:${r.query_id}`;
      N.push({
        id, label: "Enquiry", tier: T.S, glid: g, buyer: b, ts,
        props: {
          product: scrub(r.product_name, { max: 70 }), mcat: r.mcat_id, module: r.source_module,
          message: scrub(r.message, { max: 240 }), read: r.read_status !== "0", first_read: norm(r.first_read_date),
          buyer_city: r.buyer_city, buyer_state: r.buyer_state, buyer_country: r.buyer_country,
        },
      });
      N.push({ id: `B:${b}`, label: "Buyer", tier: T.L, buyer: b, props: {
        city: r.buyer_city, state: r.buyer_state, country: r.buyer_country, designation: r.buyer_designation,
        company: scrub(r.buyer_company, { max: 60 }), name_hint: nameHint(r.subject) } });
      E.push([`B:${b}`, "SENT", id], [id, "TO", `S:${g}`]);
      if (r.product_name) {
        const pid = productKey(g, r.product_name);
        N.push({ id: pid, label: "Product", tier: T.L, glid: g, props: { name: scrub(r.product_name, { max: 70 }) } });
        E.push([`S:${g}`, "SELLS", pid], [id, "ABOUT", pid]);
      }
      if (r.mcat_id && r.mcat_id !== "-1") {
        N.push({ id: `M:${r.mcat_id}`, label: "Mcat", tier: T.L, props: { mcat_id: r.mcat_id } });
        E.push([id, "IN_MCAT", `M:${r.mcat_id}`]);
      }
      break;
    }
    case "enquiry_messages": {
      const fromSeller = r.message_from === "seller";
      const id = `EM:${r.reply_id}`;
      const text = scrub(r.reply_text, { max: 220 });
      N.push({
        id, label: "EnquiryMessage", tier: T.S, glid: r.seller_glid, buyer: fromSeller ? r.receiver_glid : r.sender_glid, ts,
        props: { from: r.message_from, seq: num(r.sequence), text, template: r.template_flag, read: r.read_status !== "0",
          boilerplate: /^Additional details from Buyer/i.test(text) },
      });
      E.push([`ENQ:${r.query_id}`, "HAS_MESSAGE", id]);
      break;
    }
    case "buyer_calls": {
      const g = r.seller_glid, b = r.buyer_glid, id = `BC:${r.call_id}`;
      N.push({ id, label: "BuyerCall", tier: T.S, glid: g, buyer: b || null, ts, props: {
        connected: r.call_status === "Connected", duration: num(r.duration_sec), talk: Math.max(0, num(r.talk_sec) || 0),
        circle: r.caller_circle, mcat: r.mcat_id, transfer: r.transfer_flag } });
      E.push([id, "TO", `S:${g}`]);
      if (b) {
        N.push({ id: `B:${b}`, label: "Buyer", tier: T.L, buyer: b, props: { circle: r.caller_circle } });
        E.push([`B:${b}`, "CALLED", id]);
      }
      if (r.mcat_id) {
        N.push({ id: `M:${r.mcat_id}`, label: "Mcat", tier: T.L, props: { mcat_id: r.mcat_id } });
        E.push([id, "IN_MCAT", `M:${r.mcat_id}`]);
      }
      break;
    }
    case "buyleads": {
      const g = r.seller_glid, b = r.buyer_glid, id = `BL:${r.purchase_id}`;
      N.push({ id, label: "BuyLead", tier: T.S, glid: g, buyer: b || null, ts, props: {
        lead_id: r.buylead_id, sentinel: String(r.buylead_id).startsWith("-"), credits: num(r.credits_used),
        mode: r.purchase_mode, type: r.purchase_type, module: r.module, keyword: (r.keyword || "").split("_")[0],
        position: num(r.list_position), mcat_rank: r.mcat_rank, distance_km: num(r.distance_city) } });
      E.push([`S:${g}`, "BOUGHT", id]);
      if (b) {
        N.push({ id: `B:${b}`, label: "Buyer", tier: T.L, buyer: b, props: {} });
        E.push([id, "FROM_BUYER", `B:${b}`]);
      }
      break;
    }
    case "whatsapp": {
      N.push({ id: `WA:${r.message_id}`, label: "WhatsAppMsg", tier: T.S, glid: r.glid, ts, props: {
        number: r.source, sender: r.message_sender, campaign: r.campaign_name, status: String(r.message_status).toLowerCase(),
        delivered_at: norm(r.delivered_at), read_at: norm(r.read_at) } });
      E.push([`WA:${r.message_id}`, "TO", `S:${r.glid}`]);
      break;
    }
    case "chatbot": {
      const sid = `CS:${r.session_id || r.chat_id}`, id = `CT:${r.chat_id}`;
      N.push({ id: sid, label: "ChatSession", tier: T.S, glid: r.glid, ts, props: { channel: "whatsapp", source: r.source } });
      N.push({ id, label: "ChatTurn", tier: T.S, glid: r.glid, ts, props: {
        session: sid, user: scrub(r.user_message, { max: 160 }), bot: cleanBotReply(r.bot_reply), intent: r.intent,
        action: r.action_type, campaign: r.campaign_name, raw_bot: (r.bot_reply || "").slice(0, 300) } });
      E.push([sid, "HAS_TURN", id], [sid, "WITH", `S:${r.glid}`]);
      break;
    }
    case "pns_calls": {
      const id = `PX:${r.file_id}`;
      N.push({ id, label: "PNSCall", tier: T.S, glid: r.glid, ts, props: {
        role: r.seller_role_on_call, intent: r.file_intent, b2b: r.is_b2b === "True", languages: langs(r.languages),
        products: scrub(r.products_discussed, { max: 120 }), categories: r.categories, prices: r.prices_quoted,
        specs: scrub(r.specs_discussed, { max: 160 }), stock: r.stock_status, duration: num(r.file_duration_sec) } });
      E.push([`S:${r.glid}`, "ON_CALL", id]);
      break;
    }
    case "bot_calls": {
      const id = `VC:${r.attempt_id}`;
      N.push({ id, label: "BotCall", tier: T.S, glid: r.fk_glusr_usr_id, ts, props: {
        channel: "voice", disposition: r.disposition_label, duration: num(r.lead_call_duration),
        summary: scrub(r.lead_call_summary, { max: 700, names: false }), attempt_no: num(r.call_attempt_count),
        bucket: r.redis_bucket, version: r.lead_bot_version, meeting_fixed: r.meeting_fixed === "1",
        has_transcript: r.has_turn_transcript === "1" } });
      E.push([id, "TO", `S:${r.fk_glusr_usr_id}`]);
      break;
    }
    case "bot_call_turns": {
      const id = `VT:${r.attempt_id}:${r.turn_no}`;
      N.push({ id, label: "BotTurn", tier: T.S, glid: r.fk_glusr_usr_id, props: {
        call: `VC:${r.attempt_id}`, turn: num(r.turn_no), speaker: r.speaker, start: num(r.start_sec), text: scrub(r.text, { max: 300, names: false }) } });
      E.push([`VC:${r.attempt_id}`, "HAS_TURN", id]);
      break;
    }
    case "exec_calls": {
      const id = `EX:${r.click_to_call_id}`;
      N.push({ id, label: "ExecCall", tier: T.S, glid: r.fk_glusr_usr_id, ts, props: {
        module: r.module, answered: r.status === "Answered", duration: num(r.call_duration),
        customer_sec: num(r.call_duration_customer) || 0, employee: r.fk_employeeid } });
      N.push({ id: `E:${r.fk_employeeid}`, label: "Employee", tier: T.L, props: { employee_id: r.fk_employeeid } });
      E.push([`E:${r.fk_employeeid}`, "CALLED", id], [id, "TO", `S:${r.fk_glusr_usr_id}`]);
      break;
    }
    // Runtime event written by the bot at the end of every voice call or chat (see bot.js).
    case "vani_session": {
      const id = `VS:${r.session_id}`;
      const owner = r.role === "buyer" ? { buyer: r.glid } : { glid: r.glid };
      const target = r.role === "buyer" ? `B:${r.glid}` : `S:${r.glid}`;
      N.push({ id, label: "VaniSession", tier: T.S, ...owner, ts, props: {
        channel: r.channel, direction: r.direction, role: r.role, summary: r.summary, outcome: r.outcome,
        end_ts: r.end_ts, turns: r.turns, synthetic: true, llm: r.llm, ...(r.facts?.length ? { facts: r.facts } : {}) } });
      E.push([id, "WITH", target]);
      (r.decisions || []).forEach((d, i) => {
        const did = `D:${r.session_id}:${i}`;
        N.push({ id: did, label: "Decision", tier: T.R, ...owner, ts: d.ts || ts, props: { ...d, channel: r.channel, session: id } });
        E.push([did, "IN", id], [did, "FOR", target]);
      });
      break;
    }
    default:
      throw new Error(`Unknown source "${ev.source}"`);
  }
  return { nodes: N, edges: E };
}
