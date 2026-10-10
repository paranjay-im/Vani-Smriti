import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(here, "..");

// Optional context_layer/.env (KEY=value lines) for settings such as NEO4J_PASSWORD. Real env vars win.
try {
  for (const line of fs.readFileSync(path.join(ROOT, ".env"), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
  }
} catch {}
// The 11 gc_*.csv input files live in context_layer/input/; override with GC_DATA_DIR.
export const DATA_DIR = process.env.GC_DATA_DIR || path.join(ROOT, "input");
export const OUT_DIR = process.env.GC_OUT_DIR || path.join(ROOT, "out");
export const STORE_DIR = path.join(ROOT, "store");
export const EVENT_LOG = process.env.GC_EVENT_LOG || path.join(STORE_DIR, "events.jsonl");
export const DEMO_LOG = path.join(STORE_DIR, "demo_events.jsonl");

// The dataset ends on 2 Oct 2026; every lookback is measured back from this "now".
export const AS_OF = process.env.GC_AS_OF || "2026-10-02 23:59:59";

// Lookback per source, in days. Reasons are in README.md ("Lookback windows").
export const LOOKBACK_DAYS = {
  enquiries: 90,
  buyer_calls: 90,
  buyleads: 45,
  whatsapp: 30,
  chatbot: 60,
  pns_calls: 90,
  bot_calls: 120,
  exec_calls: 60,
  open_loops: 14,
  resume: 7,
};

// seller.md / buyer.md must stay under this many tokens (estimated as chars / 4).
export const MD_TOKEN_BUDGET = Number(process.env.GC_TOKEN_BUDGET || 700);

export const SAMPLE_SELLERS = ["272316904", "93557756", "245234426"];
export const SAMPLE_BUYERS = ["133582003", "120622712", "242720526"];

export const PORT = Number(process.env.GC_PORT || 8787);
export const AGENT_NAME = "Payal";

// Graph store: "memory" (rebuilt from the CSVs on every start) or "neo4j" (the graph lives in Neo4j).
export const STORE_KIND = process.env.GC_STORE || "memory";
export const NEO4J = {
  uri: process.env.NEO4J_URI || "bolt://localhost:7687",
  user: process.env.NEO4J_USER || "neo4j",
  password: process.env.NEO4J_PASSWORD || "",
  database: process.env.NEO4J_DATABASE || "neo4j",
};

// Disposable second instance (docker compose --profile test): demo, freshness and the test console run here.
export const NEO4J_TEST = { ...NEO4J, uri: process.env.NEO4J_TEST_URI || "bolt://localhost:7688" };

// Sarvam. The Voice Agent on Sarvam's platform calls this service (src/sarvam.js); the key, org, workspace and app ids
// let the console start a live session with that agent. stt/tts are the console's own speech path, used without the
// agent; without a key the console falls back to the browser's speech recognition and synthesis.
export const SARVAM = {
  key: process.env.SARVAM_API_KEY || "",
  // Voice Agents API key (agents dashboard: Settings -> API Key) for the Web SDK proxy. Not the same as the speech-API
  // key above (sk_...), which the runtime refuses with "Invalid API key format".
  agents_key: process.env.SARVAM_AGENTS_API_KEY || "",
  base: process.env.SARVAM_BASE_URL || "https://api.sarvam.ai",
  runtime: process.env.SARVAM_RUNTIME_URL || "https://apps.sarvam.ai/api/app-runtime/",
  org_id: process.env.SARVAM_ORG_ID || "",
  workspace_id: process.env.SARVAM_WORKSPACE_ID || "",
  app_id: process.env.SARVAM_APP_ID || "",
  app_version: process.env.SARVAM_APP_VERSION || "",
  // The agent's intro message. Sarvam's end-of-call transcript leaves it out (it plays before the conversation), so
  // VANI Live adds it as the first line. Keep it equal to the agent's intro in its initial language.
  greeting: process.env.SARVAM_GREETING || "नमस्ते, मैं इंडियामार्ट से बोल रही हूँ।",
  token: process.env.GC_SARVAM_TOKEN || "", // shared secret the agent's tools send as X-GC-Token
  test_glid: process.env.GC_SARVAM_TEST_GLID || "", // seller used when the agent sends no glid (text chat, dashboard test)
  stt_model: process.env.SARVAM_STT_MODEL || "saaras:v4",
  tts_model: process.env.SARVAM_TTS_MODEL || "bulbul:v3",
  speaker: process.env.SARVAM_TTS_SPEAKER || "priya",
};

// LLM phrasing is opt-in (--llm or GC_LLM=1). The policy layer is always deterministic.
export const LLM_MODEL = process.env.GC_MODEL || "claude-opus-5-5";
