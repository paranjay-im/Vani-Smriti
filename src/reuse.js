// Non-bot consumers of the SAME files: executive call prep, WhatsApp campaign audiences, a sales dashboard.
// They only read seller.md / buyer.md (front matter + sections) — no access to the graph or raw data.
import fs from "node:fs";
import path from "node:path";
import { parseMd } from "./mdparse.js";
import { OUT_DIR } from "./config.js";
import { toCsv } from "./csv.js";

export function readAll(role = "seller") {
  const dir = path.join(OUT_DIR, role === "buyer" ? "buyers" : "sellers");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => ({ file: path.join(dir, f), ...parseMd(fs.readFileSync(path.join(dir, f), "utf8")) }));
}

const POLICY = {
  do_not_call: "**Do not call.** The seller asked IndiaMART to stop calling. Use WhatsApp, and only if there is something for them (e.g. a waiting buyer).",
  verify_identity: "Call, but confirm you are speaking to the business first — they said it may be the wrong number.",
  cooldown: "Call only if needed and keep it short — recently frustrated or called 3+ times this week.",
  ok: "OK to call.",
};

// 1. Executive call prep card, generated from seller.md.
export function execPrep(md) {
  const { fm, sections } = parseMd(md);
  const flags = new Set(fm.flags || []);
  const dont = [];
  if (flags.has("already_met_executive") || flags.has("exec_contact")) dont.push("Don't re-introduce IndiaMART or pitch a first meeting: they have already met an executive.");
  if (flags.has("not_interested_paid")) dont.push("Don't open with plan pricing: they declined paid plans recently.");
  if (flags.has("frustrated")) dont.push("Don't run a long script: they are annoyed by repeated calls.");
  if (flags.has("wants_whatsapp")) dont.push("Don't read details out: send them on WhatsApp.");
  if (!dont.length) dont.push("Nothing specific on record.");
  return [
    `# Executive call prep · ${fm.name} (${fm.glid})`, "",
    `_Generated from \`seller.md\` (${fm.generated_at}), the same file VANI reads. Data up to ${fm.watermark || fm.as_of}._`, "",
    `**Call or not:** ${POLICY[fm.contact_policy] || POLICY.ok}`,
    `**Best time:** ${fm.best_time || "unknown"} · **Language:** ${(fm.lang || []).join(", ") || "unknown"} · **Prefers:** ${fm.channel_pref || "voice"} · **Account:** ${fm.segment}, ${fm.city}`, "",
    "## Before you dial", ...(sections["Do not re-ask / handle with care"] || ["- Nothing on record."]), "",
    "## Talking points (open loops)", ...(sections["Open loops"] || ["- None."]), "",
    "## Don't", ...dont.map((d) => `- ${d}`), "",
    "## Their numbers", ...(sections[Object.keys(sections).find((k) => k.startsWith("Leads"))] || []), ...(sections.Engagement || []), "",
  ].join("\n");
}

// 2. WhatsApp campaign audiences, straight from front matter.
export function campaigns() {
  const files = readAll("seller");
  const dir = path.join(OUT_DIR, "reuse");
  fs.mkdirSync(dir, { recursive: true });
  const nudge = [];
  const suppress = [];
  const photos = [];
  for (const { fm } of files) {
    const loop = (fm.loops || []).find((l) => l.type === "buyer_waiting_reply" || l.type === "unanswered_enquiry");
    if (loop && fm.contact_policy !== "verify_identity") {
      nudge.push({ glid: fm.glid, name: fm.name, city: fm.city, contact_policy: fm.contact_policy, product: loop.product, buyer_city: loop.city, since: loop.on,
        message: `Namaste ${fm.name} 🙏 ${loop.city} ke ek buyer ne ${loop.product} ke baare mein poocha hai (${loop.on}). Reply karne ke liye "REPLY" likhiye.` });
    }
    if (fm.contact_policy === "do_not_call" || fm.contact_policy === "cooldown") suppress.push({ glid: fm.glid, name: fm.name, contact_policy: fm.contact_policy, flags: (fm.flags || []).join("|") });
    if ((fm.loops || []).some((l) => l.type === "photo_pending")) photos.push({ glid: fm.glid, name: fm.name, city: fm.city, message: `Namaste ${fm.name} 🙏 Aapki WhatsApp par bheji photos abhi catalog mein nahi hain. Add karne ke liye "ADD" likhiye.` });
  }
  fs.writeFileSync(path.join(dir, "campaign_buyer_waiting.csv"), toCsv(["glid", "name", "city", "contact_policy", "product", "buyer_city", "since", "message"], nudge));
  fs.writeFileSync(path.join(dir, "dialer_suppression_list.csv"), toCsv(["glid", "name", "contact_policy", "flags"], suppress));
  fs.writeFileSync(path.join(dir, "campaign_catalog_photos.csv"), toCsv(["glid", "name", "city", "message"], photos));
  return { files: files.length, buyer_waiting: nudge.length, suppression: suppress.length, catalog_photos: photos.length, dir };
}

// 3. Sales dashboard: aggregate what is in the files.
export function dashboard() {
  const files = readAll("seller");
  const count = (fn) => {
    const m = new Map();
    for (const x of files) for (const k of [].concat(fn(x.fm) ?? [])) m.set(k, (m.get(k) || 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1]);
  };
  const toks = files.map((x) => x.fm.tokens).sort((a, b) => a - b);
  const pctl = (p) => toks[Math.floor(p * (toks.length - 1))];
  const table = (title, rows) => [`## ${title}`, "", "| | sellers | share |", "|---|---|---|", ...rows.map(([k, v]) => `| ${k} | ${v} | ${((100 * v) / files.length).toFixed(1)}% |`), ""];
  const L = [
    "# Seller context dashboard", "", `Built only from the front matter of ${files.length} seller.md files.`, "",
    `File size (tokens): p50 ${pctl(0.5)} · p90 ${pctl(0.9)} · p99 ${pctl(0.99)} · max ${toks.at(-1)} · cold start: ${files.filter((x) => x.fm.cold_start).length}`, "",
    ...table("Contact policy", count((fm) => fm.contact_policy)),
    ...table("Active flags", count((fm) => fm.flags)),
    ...table("Open loops (top 3 per seller)", count((fm) => [...new Set((fm.loops || []).map((l) => l.type))])),
    ...table("Preferred channel", count((fm) => fm.channel_pref)),
    ...table("Segment", count((fm) => fm.segment)),
  ];
  const dir = path.join(OUT_DIR, "reuse");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "dashboard.md"), L.join("\n"));
  return path.join(dir, "dashboard.md");
}
