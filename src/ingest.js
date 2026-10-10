import fs from "node:fs";
import path from "node:path";
import { readCsv } from "./csv.js";
import { SOURCES, LOAD_ORDER, normalize, eventTs, statusRank, sellerOf } from "./sources.js";
import { extractFor, factView } from "./extract.js";
import { toMs } from "./time.js";

// Event-sourced ingestion. State = the CSV snapshot + an append-only event log (live events and bot
// sessions), so the graph can always be rebuilt and every file traced back to the events behind it.
export class Pipeline {
  constructor(graph, { log = null } = {}) {
    this.g = graph;
    this.log = log;
  }

  // Apply one event. Returns the GLIDs whose context files must be re-rendered.
  apply(ev, { extract = true, persist = false } = {}) {
    const g = this.g;
    const { nodes, edges } = normalize(ev);
    const touched = [];
    for (const spec of nodes) {
      const prev = g.get(spec.id);
      if (ev.source === "whatsapp" && prev && statusRank(prev.props.status) > statusRank(spec.props.status)) {
        // Duplicate message_id = status snapshot; never downgrade read -> delivered.
        for (const k of ["status", "delivered_at", "read_at"]) delete spec.props[k];
      }
      if (spec.label === "ChatSession" && prev?.props.last_ts && prev.props.last_ts > spec.ts) spec.props.last_ts = prev.props.last_ts;
      else if (spec.label === "ChatSession") spec.props.last_ts = spec.ts;
      touched.push(g.upsert(spec));
    }
    for (const [a, rel, b] of edges) g.link(a, rel, b);

    if (ev.source === "bot_call_turns") {
      const turn = touched[0];
      const parent = g.get(turn.props.call);
      if (parent?.ts && !turn.ts) turn.ts = parent.ts;
    }
    if (ev.source === "bot_calls") {
      for (const t of g.outN(touched[0].id, "HAS_TURN")) if (!t.ts) t.ts = touched[0].ts;
    }
    if (extract && (ev.source === "enquiries" || ev.source === "buyer_calls")) {
      const n = touched[0];
      this.linkPair(n.glid, n.buyer);
    }
    const affected = { sellers: new Set(), buyers: new Set() };
    for (const n of touched) {
      if (n.label === "Category" || n.label === "Mcat" || n.label === "Employee" || n.label === "Product") continue;
      if (n.glid) affected.sellers.add(n.glid);
      if (n.buyer) affected.buyers.add(n.buyer);
    }
    if (ev.source === "vani_session") {
      this.linkDecisions(touched);
      for (const a of this.applyActions(ev.row)) {
        a.sellers.forEach((x) => affected.sellers.add(x));
        a.buyers.forEach((x) => affected.buyers.add(x));
      }
    }
    if (extract) for (const n of touched) extractFor(g, n);
    if (persist && this.log) {
      fs.mkdirSync(path.dirname(this.log), { recursive: true });
      fs.appendFileSync(this.log, JSON.stringify({ source: ev.source, row: ev.row, received_at: new Date().toISOString() }) + "\n");
    }
    return affected;
  }

  // A buyer call followed within 60 min by an enquiry from the same buyer: the enquiry came from the call
  // (98% of PNSBLENQ enquiries). The reverse order means the buyer called after enquiring.
  linkPair(glid, buyer) {
    if (!glid || !buyer) return;
    const calls = this.g.owned(glid, "BuyerCall").filter((c) => c.buyer === buyer && c.ts);
    if (!calls.length) return;
    const enqs = this.g.owned(glid, "Enquiry").filter((e) => e.buyer === buyer && e.ts);
    for (const e of enqs) {
      for (const c of calls) {
        const d = (toMs(e.ts) - toMs(c.ts)) / 60000;
        if (d >= 0 && d <= 60) this.g.link(c.id, "LED_TO", e.id);
        else if (d < 0 && d >= -60) this.g.link(e.id, "FOLLOWED_BY", c.id);
      }
    }
  }

  linkAll() {
    for (const [glid, byLabel] of this.g.byGlid) {
      if (!byLabel.has("BuyerCall") || !byLabel.has("Enquiry")) continue;
      const buyers = new Set(this.g.owned(glid, "BuyerCall").map((c) => c.buyer).filter(Boolean));
      for (const b of buyers) this.linkPair(glid, b);
    }
  }

  // When VANI forwards a quote/answer inside a session, it is posted to the enquiry thread — the same event
  // a seller reply from the app would create. Both parties' context files then update from data.
  applyActions(row) {
    const out = [];
    (row.decisions || []).forEach((d, i) => {
      if (d.action !== "act" || !String(d.key).startsWith("ENQ:") || !d.quote) return;
      const enq = this.g.get(d.key);
      if (!enq) return;
      const fromSeller = (d.from || row.role) !== "buyer";
      const seq = this.g.outN(enq.id, "HAS_MESSAGE").reduce((m, x) => Math.max(m, x.props.seq || 0), 0) + 1;
      out.push(this.apply({ source: "enquiry_messages", row: {
        reply_id: `vani-${row.session_id}-${i}`, query_id: d.key.slice(4), sequence: String(seq),
        sender_glid: fromSeller ? enq.glid : enq.buyer, receiver_glid: fromSeller ? enq.buyer : enq.glid,
        reply_date: d.ts, subject: "via VANI", reply_text: d.quote, read_status: "0", first_read_date: "", template_flag: "vani",
        seller_glid: enq.glid, message_from: fromSeller ? "seller" : "buyer" } }));
    });
    return out;
  }

  // Decisions name the fact types they relied on; link them to the actual Fact nodes (USED edges).
  linkDecisions(touched) {
    for (const d of touched.filter((n) => n.label === "Decision")) {
      const owner = d.glid ? { glid: d.glid } : { buyer: d.buyer };
      const view = factView(this.g, owner, d.ts);
      for (const type of d.props.facts || []) if (view[type]?.latest) this.g.link(d.id, "USED", view[type].latest.id);
    }
  }

  // Bulk load the CSV snapshot. Events newer than `until` are returned (sorted) instead of applied,
  // so the freshness benchmark can replay them as a live stream. With `sellers` (a Set of GLIDs) only those
  // sellers' rows are read into the graph; every other row is skipped.
  loadAll({ dataDir, until = null, sellers = null, onProgress = () => {} }) {
    const deferred = [];
    // A message can be recorded under a different seller than its enquiry (5 such messages in the data). With a
    // selection, keep a message when its enquiry was loaded, so the enquiry's seller still sees it.
    const enquiryIds = sellers ? new Set() : null;
    for (const source of LOAD_ORDER) {
      let n = 0;
      for (const row of readCsv(path.join(dataDir, SOURCES[source].file))) {
        const ev = { source, row };
        if (sellers) {
          if (!sellers.has(sellerOf(ev)) && !(source === "enquiry_messages" && enquiryIds.has(row.query_id))) continue;
          if (source === "enquiries") enquiryIds.add(row.query_id);
        }
        const ts = eventTs(ev);
        n++;
        if (until && ts && ts > until) { deferred.push({ ...ev, ts }); continue; }
        this.apply(ev, { extract: false });
      }
      onProgress(source, n);
    }
    this.linkAll();
    for (const n of this.g.nodes.values()) extractFor(this.g, n);
    deferred.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    return deferred;
  }

  replayLog(file = this.log, { sellers = null } = {}) {
    if (!file || !fs.existsSync(file)) return 0;
    let n = 0;
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const ev = JSON.parse(line);
      if (sellers && !sellers.has(sellerOf(ev))) continue;
      this.apply({ source: ev.source, row: ev.row });
      n++;
    }
    return n;
  }
}
