// Context service + test console. Event-driven: POST /events -> ingest -> re-render affected files ->
// respond with the measured delay. The bot (or any team) reads files with GET /context/:role/:glid.
// GET / serves the test console (src/ui.html).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { openStore, openScratchStore, rebuild } from "./store/index.js";
import { FileStore } from "./store/files.js";
import { renderSeller } from "./render.js";
import { VaniBot } from "./bot.js";
import { parseMd } from "./mdparse.js";
import { eventTs } from "./sources.js";
import { buildEvent } from "./synthetic.js";
import { addMin } from "./time.js";
import { sarvamRoutes } from "./sarvam.js";
import { AS_OF, EVENT_LOG, OUT_DIR, PORT, ROOT, SAMPLE_BUYERS, SAMPLE_SELLERS, SARVAM } from "./config.js";

const UI = path.join(ROOT, "src", "ui.html");

// ---- Sarvam speech, for local voice calls from the console ----
async function sarvam(pathname, init) {
  const r = await fetch(SARVAM.base + pathname, { ...init, headers: { "api-subscription-key": SARVAM.key, ...(init.headers || {}) } });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Sarvam ${pathname} ${r.status}: ${data.error?.message || JSON.stringify(data).slice(0, 200)}`);
  return data;
}
const transliterate = (input, from, to) => sarvam("/transliterate", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ input: input.slice(0, 1000), source_language_code: from, target_language_code: to }),
}).then((d) => d.transliterated_text || input);

// WAV in -> Roman-script text out. VANI's intent rules read Roman Hinglish: Saaras returns it directly (mode translit);
// any Devanagari that still comes back is romanised.
async function speechToText(wav) {
  const fd = new FormData();
  fd.append("file", new Blob([wav], { type: "audio/wav" }), "turn.wav");
  fd.append("model", SARVAM.stt_model);
  fd.append("language_code", "unknown");
  if (SARVAM.stt_model.startsWith("saaras")) fd.append("mode", "translit"); // Roman script straight from the model
  const d = await sarvam("/speech-to-text", { method: "POST", body: fd });
  const heard = (d.transcript || "").trim();
  const lang = d.language_code && d.language_code !== "en-IN" ? d.language_code : "hi-IN";
  const text = /[ऀ-෿]/.test(heard) ? await transliterate(heard, lang, "en-IN") : heard;
  return { text, heard, language_code: d.language_code || null };
}

// Roman Hinglish in -> base64 WAV out. Written in Devanagari first so Hindi words are pronounced as Hindi.
async function textToSpeech(text) {
  const clean = text.replace(/[\u{1F000}-\u{1FFFF}☀-➿]/gu, "").trim();
  const spoken = await transliterate(clean, "en-IN", "hi-IN").catch(() => clean);
  const d = await sarvam("/text-to-speech", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: spoken.slice(0, 1500), target_language_code: "hi-IN", speaker: SARVAM.speaker, model: SARVAM.tts_model }),
  });
  return { audio: (d.audios || [])[0] || null, spoken };
}

// scratch: run on a throwaway copy of the graph (the test console). With GC_STORE=neo4j that is the separate test
// instance, reloaded on every start and reset; without it the real database is only connected to.
export async function startServer({ port = PORT, llm = false, log = EVENT_LOG, outDir = OUT_DIR, eager = true, scratch = false, filesOnly = false } = {}) {
  let store, clock, samples;
  const latencies = [];
  const sessions = new Map();

  // Open the store (memory: load CSVs + replay this server's event log; neo4j: connect). The clock resumes after the newest logged event.
  async function boot({ reload = false } = {}) {
    await store?.close?.();
    if (filesOnly) store = await new FileStore({ outDir, log }).init();
    else if (scratch) store = await openScratchStore({ log, quiet: false });
    else {
      store = await openStore({ log });
      if (store.kind === "neo4j" && reload) await rebuild(store, { log, quiet: false });
      if (store.kind === "neo4j") await store.assertLoaded("GC_STORE=neo4j node cli.js build");
    }
    clock = AS_OF;
    if (fs.existsSync(log)) {
      for (const line of fs.readFileSync(log, "utf8").split("\n")) {
        if (!line.trim()) continue;
        const ev = JSON.parse(line);
        const ts = ev.row.end_ts || eventTs(ev);
        if (ts && ts > clock) clock = addMin(ts, 1);
      }
    }
    samples = await pickSamples();
    // Pre-rendering all 5,000 files at start is for the in-memory store. With Neo4j each file is rendered when it is read
    // (`build` writes them all), so the server starts as soon as it is connected.
    if (eager && !filesOnly && store.kind === "memory") {
      for await (const { glid, graph } of store.sellerViews()) await store.write("seller", glid, { asOf: clock, outDir }, graph);
      for (const b of SAMPLE_BUYERS) await store.write("buyer", b, { asOf: clock, outDir });
    }
  }

  // A handful of interesting users for the console's picker.
  async function pickSamples() {
    const out = [];
    const add = async (role, glid, tag) => {
      if (out.some((s) => s.glid === glid && s.role === role)) return;
      let fm;
      try { ({ fm } = await store.write(role, glid, { asOf: clock, outDir })); }
      catch (e) { if (filesOnly && e.status) return; throw e; } // files-only: skip samples without a file
      out.push({ role, glid, tag, name: fm.name || fm.name_hint || glid, city: fm.city, contact_policy: fm.contact_policy, flags: fm.flags || [], loops: (fm.loops || []).length });
    };
    for (const g of SAMPLE_SELLERS) await add("seller", g, "demo");
    for (const b of SAMPLE_BUYERS) await add("buyer", b, "demo");
    const want = { do_not_call: 3, buyer_waiting: 3, meeting_fixed: 3, whatsapp_unfinished: 2, cold_start: 2 };
    // Files-only reads the front matter of existing files; the other stores render each seller to find interesting ones.
    const fms = store.listFm ? store.listFm() : (async function* () { for await (const { glid, graph } of store.sellerViews()) yield { glid, fm: renderSeller(graph, glid, { asOf: clock }).fm }; })();
    for await (const { glid: g, fm } of fms) {
      if (!Object.values(want).some((n) => n > 0)) break;
      const types = (fm.loops || []).map((l) => l.type);
      const pick = fm.contact_policy === "do_not_call" ? "do_not_call" : types.includes("buyer_waiting_reply") ? "buyer_waiting"
        : (fm.flags || []).includes("meeting_fixed") ? "meeting_fixed" : types.includes("whatsapp_unfinished") ? "whatsapp_unfinished" : fm.cold_start ? "cold_start" : null;
      if (pick && want[pick] > 0) { want[pick]--; await add("seller", g, pick); }
    }
    return out;
  }

  const read = (role, id) => store.write(role, id, { asOf: clock, outDir });
  const ingest = async (events) => {
    const received = performance.now();
    for (const ev of events) {
      const ts = eventTs(ev);
      if (ts && ts > clock) clock = ts;
    }
    const { sellers, buyers, view, warning } = await store.apply(events, { persist: true });
    const files = [];
    for (const g of sellers) if (view ? view.get(`S:${g}`) : await store.hasSeller(g)) files.push(path.relative(outDir, (await store.write("seller", g, { asOf: clock, outDir }, view)).file));
    for (const b of buyers) files.push(path.relative(outDir, (await store.write("buyer", b, { asOf: clock, outDir }, view)).file));
    const ms = performance.now() - received;
    latencies.push(ms);
    return { files, latency_ms: +ms.toFixed(2), ...(warning ? { warning } : {}) };
  };
  const botView = (bot) => ({
    ended: bot.ended,
    turns: bot.turns,
    decisions: bot.decisions,
    skipped: bot.skipped.map((q) => ({ id: q.id, ask: q.ask, reason: q.known(bot) })),
  });

  const body = (req) => new Promise((resolve, reject) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
  });
  const raw = (req) => new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
  const send = (res, code, data, type = "application/json") => {
    res.writeHead(code, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store" });
    res.end(type === "application/json" ? JSON.stringify(data, null, 2) : data);
  };

  const sarvam = sarvamRoutes({ store: () => store, clock: () => clock, setClock: (t) => { clock = t; }, ingest, outDir, send, body });

  await boot();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://x");
      const parts = url.pathname.split("/").filter(Boolean);
      const route = `${req.method} ${url.pathname}`;
      if (await sarvam(req, res, url, route)) return; // also blocks everything else for requests from the public tunnel

      if (route === "GET /" || route === "GET /ui") return send(res, 200, fs.readFileSync(UI, "utf8"), "text/html");
      if (route === "GET /health") return send(res, 200, { ok: true, clock, ...(await store.counts()), store: store.kind, ...(filesOnly ? { mode: "files-only" } : {}), sessions: sessions.size, llm });
      if (route === "GET /api/samples") return send(res, 200, { clock, samples });
      if (req.method === "GET" && parts[0] === "context" && parts.length === 3) {
        const w = await read(parts[1], parts[2]);
        if (url.searchParams.get("format") === "json") return send(res, 200, { ...parseMd(w.md), md: w.md, file: path.relative(outDir, w.file), render_ms: +w.ms.toFixed(2), clock });
        return send(res, 200, w.md, "text/markdown");
      }
      if (route === "POST /events") {
        const b = await body(req);
        return send(res, 200, await ingest(Array.isArray(b) ? b : [b]));
      }
      if (route === "POST /api/emit") {
        const b = await body(req);
        const ev = buildEvent({ ...b, ts: addMin(clock, 1) });
        return send(res, 200, { event: ev, ...(await ingest([ev])) });
      }
      if (route === "POST /api/reset") {
        if (filesOnly) return send(res, 400, { error: "reset is not available in files-only mode: the files would stay modified" });
        sessions.clear();
        fs.rmSync(log, { force: true });
        await boot({ reload: true });
        return send(res, 200, { ok: true, clock });
      }
      if (route === "GET /metrics") {
        const s = [...latencies].sort((a, b) => a - b);
        const q = (p) => (s.length ? +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(2) : null);
        return send(res, 200, { events_requests: s.length, p50_ms: q(0.5), p95_ms: q(0.95), max_ms: q(1) });
      }
      if (route === "POST /bot/start") {
        const b = await body(req);
        const role = b.role || "seller";
        const md = (await read(role, b.glid)).md;
        const bot = new VaniBot({ md, channel: b.channel || "voice", direction: b.direction || "outbound", now: clock, llm });
        const cold = bot.coldOpening();
        const start = await bot.start(b.text || null);
        sessions.set(bot.session_id, bot);
        return send(res, 200, { session_id: bot.session_id, suppressed: start.suppressed, reply: start.text, cold, ...botView(bot) });
      }
      if (req.method === "POST" && parts[0] === "bot" && parts[2] === "turn") {
        const bot = sessions.get(parts[1]);
        if (!bot) return send(res, 404, { error: "unknown session" });
        const { text } = await body(req);
        return send(res, 200, { reply: await bot.reply(text), ...botView(bot) });
      }
      if (req.method === "POST" && parts[0] === "bot" && parts[2] === "end") {
        const bot = sessions.get(parts[1]);
        if (!bot) return send(res, 404, { error: "unknown session" });
        sessions.delete(parts[1]);
        const ev = bot.end();
        // Next session starts after this one ended, so session times never collide. The clock moves first so the
        // file written by this save already includes the session.
        if (addMin(ev.row.end_ts, 2) > clock) clock = addMin(ev.row.end_ts, 2);
        const r = await ingest([ev]);
        return send(res, 200, { summary: ev.row.summary, outcome: ev.row.outcome, clock, ...r });
      }
      if (route === "GET /voice/status") return send(res, 200, { sarvam: !!SARVAM.key, stt_model: SARVAM.stt_model, tts_model: SARVAM.tts_model, speaker: SARVAM.speaker });
      if (route === "POST /voice/stt" || route === "POST /voice/tts") {
        if (!SARVAM.key) return send(res, 503, { error: "SARVAM_API_KEY is not set" });
        const t0 = performance.now();
        const out = route === "POST /voice/stt" ? await speechToText(await raw(req)) : await textToSpeech((await body(req)).text || "");
        return send(res, 200, { ...out, ms: Math.round(performance.now() - t0) });
      }
      return send(res, 404, { error: "not found", routes: ["GET /", "GET /health", "GET /api/samples", "GET /context/:role/:glid[?format=json]", "POST /events", "POST /api/emit", "POST /api/reset", "GET /metrics", "POST /bot/start", "POST /bot/:id/turn", "POST /bot/:id/end", "GET /voice/status", "POST /voice/stt", "POST /voice/tts", "GET /sarvam/context?glid=", "POST /sarvam/meeting", "POST /sarvam/callback", "POST /sarvam/dnc", "POST /sarvam/end", "GET /sarvam/runtime/*", "GET /sarvam/config", "GET|POST /sarvam/test-seller"] });
    } catch (e) {
      return send(res, e.status || 500, { error: e.message });
    }
  });
  server.listen(port, () => process.stderr.write(`  context service on http://localhost:${port}  (clock ${clock}${llm ? ", LLM phrasing on" : ""})\n`));
  return server;
}
