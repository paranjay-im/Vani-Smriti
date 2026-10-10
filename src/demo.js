// End-to-end demo for one user: context file -> voice call -> write-back -> refreshed file -> WhatsApp
// that resumes the call. Seller/buyer lines come from demo/scripts.json and are SYNTHETIC (labelled).
import fs from "node:fs";
import path from "node:path";
import { VaniBot } from "./bot.js";
import { parseMd } from "./mdparse.js";
import { OUT_DIR } from "./config.js";

// Demo files go to their own folder so out/sellers keeps the snapshot state.
const FILES = path.join(OUT_DIR, "demo", "files");
import { dmyhm } from "./time.js";

const VOLATILE = /^(generated_at|tokens|as_of|watermark): /;
function diff(a, b) {
  const A = new Set(a.split("\n").filter((l) => !VOLATILE.test(l)));
  const B = new Set(b.split("\n").filter((l) => !VOLATILE.test(l)));
  return [...[...A].filter((l) => !B.has(l)).map((l) => `- ${l}`), ...[...B].filter((l) => !A.has(l)).map((l) => `+ ${l}`)];
}

async function runSession({ md, channel, direction, at, lines, llm }) {
  const bot = new VaniBot({ md, channel, direction, now: at, llm });
  const cold = bot.coldOpening();
  const inbound = direction === "inbound";
  const start = await bot.start(inbound ? lines[0] : null);
  for (const u of inbound ? lines.slice(1) : lines) {
    if (bot.ended) break;
    await bot.reply(u);
  }
  return { bot, cold, start, event: bot.end() };
}

function sessionMd(n, title, s, file, before, roleLabel) {
  const { bot, cold, start } = s;
  const L = [`## ${n}. ${title}`, ""];
  L.push(`Context file read by the bot: \`${path.relative(OUT_DIR, file)}\` (${parseMd(before).fm.tokens} tokens).`, "");
  L.push("| | Cold-start VANI (no file) | VANI with the context file |", "|---|---|---|");
  L.push(`| Opening | ${cold.text} | ${start.suppressed ? "**Call not placed** — contact_policy is do_not_call" : start.text.replace(/\|/g, "/")} |`);
  L.push(`| Questions it would ask | ${cold.questions.length} | ${cold.questions.length - bot.skipped.length} (skipped ${bot.skipped.length}: ${bot.skipped.map((q) => q.id).join(", ") || "none"}) |`, "");
  if (!start.suppressed) {
    L.push(`**Transcript** (${roleLabel} lines are synthetic, scripted for the demo):`, "");
    for (const t of bot.turns) L.push(`> **${t.speaker === "bot" ? "VANI" : t.speaker === "buyer" ? "Buyer" : "Seller"}** (${t.ts.slice(11, 16)}): ${t.text}  `);
    L.push("");
  }
  L.push("**Decision trace** (reasoning memory, written back to the graph):", "");
  for (const d of bot.decisions) {
    const extra = [d.question && `\`${d.question}\``, d.reason, d.text && `→ ${d.text}`, d.facts?.length && `facts: ${d.facts.join(", ")}`].filter(Boolean).join(" · ");
    L.push(`- **${d.action}** ${extra}`);
  }
  L.push("");
  return L;
}

// Used by `demo --glid` for sellers that have no hand-written script in demo/scripts.json.
export const genericScript = () => ({
  story: "Generic scripted demo: no hand-written story exists for this seller, so the seller lines are a fixed synthetic script (the seller is driving and asks for WhatsApp, then thanks the bot).",
  voice: { at: "2026-10-03 11:30:00", direction: "outbound", lines: ["Haan ji, bol raha hoon.", "Abhi gaadi chala raha hoon, WhatsApp pe bhej do."] },
  whatsapp: { at: "2026-10-03 13:10:00", direction: "outbound", lines: ["Thik hai, thank you"] },
});

export async function runDemo({ store, role = "seller", glid, script, llm = false }) {
  const t0 = performance.now();
  const v1 = await store.write(role, glid, { asOf: script.voice.at , outDir: FILES });
  const before1 = fs.readFileSync(v1.file, "utf8");
  const roleLabel = role === "buyer" ? "Buyer" : "Seller";
  const out = [`# Demo · ${role} ${glid} · ${parseMd(before1).fm.name || parseMd(before1).fm.name_hint || ""}`, "", `> ${script.story}`, ""];
  if (llm) out.push("> Replies phrased by Claude (policy decisions are still made by the rule engine).", "");

  // 1. voice
  const s1 = await runSession({ md: before1, channel: "voice", direction: script.voice.direction || "outbound", at: script.voice.at, lines: script.voice.lines, llm });
  out.push(...sessionMd(1, `Voice call · ${dmyhm(script.voice.at)} (${script.voice.direction || "outbound"})`, s1, v1.file, before1, roleLabel));
  const ta = performance.now();
  const a1 = await store.apply(s1.event, { persist: true });
  const v2 = await store.write(role, glid, { asOf: s1.bot.clock , outDir: FILES }, a1.view);
  const lat1 = performance.now() - ta;
  const after1 = fs.readFileSync(v2.file, "utf8");
  out.push(`**Write-back:** session event ingested, facts extracted, file regenerated in **${lat1.toFixed(1)} ms**. Changes:`, "", "```diff", ...diff(before1, after1), "```", "");

  // 2. WhatsApp — the bot reads the refreshed file
  const s2 = await runSession({ md: after1, channel: "whatsapp", direction: script.whatsapp.direction || "outbound", at: script.whatsapp.at, lines: script.whatsapp.lines, llm });
  out.push(...sessionMd(2, `WhatsApp · ${dmyhm(script.whatsapp.at)} (${script.whatsapp.direction || "outbound"})`, s2, v2.file, after1, roleLabel));
  const tb = performance.now();
  const a2 = await store.apply(s2.event, { persist: true });
  const v3 = await store.write(role, glid, { asOf: s2.bot.clock , outDir: FILES }, a2.view);
  const lat2 = performance.now() - tb;
  const after2 = fs.readFileSync(v3.file, "utf8");
  out.push(`**Write-back:** file regenerated in **${lat2.toFixed(1)} ms**. Changes:`, "", "```diff", ...diff(after1, after2), "```", "");

  const resumed = s2.bot.decisions.some((d) => d.action === "fulfil" && s1.bot.decisions.some((p) => p.action === "promise" && p.key === d.key));
  const reAsks = [...s1.bot.turns, ...s2.bot.turns].filter((t) => t.speaker === "bot").filter((t) => [...s1.bot.skipped, ...s2.bot.skipped].some((q) => t.text.includes(q.ask))).length;
  const metrics = {
    glid, role,
    cold_questions: (s1.start.suppressed ? 0 : s1.cold.questions.length) + s2.cold.questions.length,
    questions_skipped: s1.bot.skipped.length + s2.bot.skipped.length,
    re_asks: reAsks,
    calls_suppressed: s1.start.suppressed ? 1 : 0,
    resumed_across_channels: resumed,
    refresh_ms: [+lat1.toFixed(1), +lat2.toFixed(1)],
  };
  out.push("## Result", "", "| Metric | Value |", "|---|---|",
    `| Questions a cold bot asks (sessions that took place) | ${metrics.cold_questions} |`,
    `| Skipped because the file already answered them | ${metrics.questions_skipped} |`,
    `| Questions re-asked | ${metrics.re_asks} |`,
    `| Outbound calls suppressed by contact policy | ${metrics.calls_suppressed} |`,
    `| Promise made on voice fulfilled on WhatsApp | ${resumed ? "yes" : "no"} |`,
    `| Activity → updated file | ${metrics.refresh_ms.map((m) => `${m} ms`).join(", ")} |`,
    "", `Final file: \`${path.relative(OUT_DIR, v3.file)}\` · demo ran in ${((performance.now() - t0) / 1000).toFixed(2)} s.`, "");

  const dir = path.join(OUT_DIR, "demo");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${role}_${glid}.md`);
  fs.writeFileSync(file, out.join("\n"));
  return { file, metrics };
}
