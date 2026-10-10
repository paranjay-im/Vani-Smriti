// Optional LLM phrasing for VANI. The policy layer (what not to ask, what to resume, contact policy)
// stays deterministic in bot.js; Claude only words the reply. Any failure falls back to the rule text.
import fs from "node:fs";
import path from "node:path";
import { LLM_MODEL, ROOT } from "./config.js";

let sdk = null;
async function loadSdk() {
  if (sdk !== null) return sdk;
  try {
    sdk = (await import("@anthropic-ai/sdk")).default;
  } catch {
    sdk = false;
  }
  return sdk;
}

export const BOT_PROMPT = fs.readFileSync(path.join(ROOT, "bot_prompt.md"), "utf8");

export async function llmReady() {
  return Boolean(await loadSdk());
}

let client = null;
let disabled = false;
// Missing credentials or a network failure: warn once, then stay on rule-based replies for the run.
function giveUp(why) {
  if (!disabled) process.stderr.write(`  [llm] ${why} — using rule-based replies for the rest of this run\n`);
  disabled = true;
  return null;
}

// history: [{speaker: "bot"|"seller"|"buyer", text}] ; policy: string from the bot's policy layer.
export async function llmReply({ contextMd, history, policy }) {
  const Anthropic = await loadSdk();
  if (!Anthropic || disabled) return null;
  client ||= new Anthropic();
  const messages = [];
  for (const t of history) {
    const role = t.speaker === "bot" ? "assistant" : "user";
    const last = messages.at(-1);
    if (last && last.role === role) last.content += `\n${t.text}`;
    else messages.push({ role, content: t.text });
  }
  if (!messages.length || messages[0].role !== "user") messages.unshift({ role: "user", content: "[conversation started]" });
  if (messages.at(-1).role !== "user") messages.push({ role: "user", content: "[waiting for VANI]" });
  // Operator instructions for this turn go in a mid-conversation system message, not in the user's words.
  messages.push({ role: "system", content: policy });
  try {
    const response = await client.beta.messages.create({
      model: LLM_MODEL,
      max_tokens: 1024,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low" },
      system: [
        { type: "text", text: BOT_PROMPT, cache_control: { type: "ephemeral" } },
        { type: "text", text: `<context_file>\n${contextMd}\n</context_file>` },
      ],
      messages,
    });
    if (response.stop_reason === "refusal") return null;
    const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    return text || null;
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) return giveUp(`API error ${error.status}: ${error.message}`);
    if (error instanceof Anthropic.APIError) {
      process.stderr.write(`  [llm] API error ${error.status}: ${error.message} — using the rule-based reply for this turn\n`);
      return null;
    }
    return giveUp(error.message.split(". ")[0]);
  }
}
