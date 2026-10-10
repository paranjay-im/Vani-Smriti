// Build context_layer/sarvam/system_prompt.md from the organisers' docx, applying the minimal fixes listed in
// PROMPT_CHANGES.md. Every replacement must match exactly once, or the script stops.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const xml = execSync(`unzip -p "${ROOT}/Sarvam Prompt - Seller Side VANI.docx" word/document.xml`, { maxBuffer: 1e8 }).toString("utf8");
let t = xml.replace(/<w:p[ >][\s\S]*?<\/w:p>/g, (p) => p.replace(/<w:tab\/>/g, "\t").replace(/<[^>]+>/g, "") + "\n")
  .replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").trim() + "\n";
const original = t;

const changes = [];
const rep = (n, why, a, b, all = false) => {
  const count = t.split(a).length - 1;
  if (!count || (!all && count !== 1)) throw new Error(`change ${n}: expected ${all ? ">=1" : "1"} match, found ${count}: ${a.slice(0, 80)}`);
  t = all ? t.split(a).join(b) : t.replace(a, () => b);
  changes.push({ n, why, from: a, to: b, count });
};

// 1. Honesty: no human-style experience claim for a virtual assistant.
rep(1, "Claiming 10+ years of experience contradicts 'never claim to be a human'.",
  "You are {{ bot_name }}, a Business Development Executive at IndiaMart with 10+ years of experience helping sellers grow their business on IndiaMart.",
  "You are {{ bot_name }}, IndiaMart's virtual Business Development assistant who helps sellers grow their business on IndiaMart.");

// 2. Tool call syntax of the Sarvam platform.
for (const tool of ["schedule_meeting_tool", "schedule_callback_tool", "mark_do_not_call_tool"]) {
  rep(`2-${tool}`, "Sarvam references tools as tool:<name> (prompt calls use 'call tool:<name>').", `@ ${tool}`, `tool:${tool}`, true);
}
rep("2-end", "Sarvam's end call is written 'call end_interaction'.", "invoke end_interaction", "call end_interaction", true);
rep("2-end2", "Sarvam's end call is written 'call end_interaction'.", "Every closing path must call end_interaction. Never end a call without invoking it.", "Every closing path must call end_interaction. Never end a call without it.");

// 3. One closing order everywhere: set variables, speak the closing line, then end the call.
rep(3, "Ending the call before speaking would cut off the closing line.",
  "When a terminal condition below is reached: set the listed variables (in order), call end_interaction, then speak the closing line.",
  "When a terminal condition below is reached: set the listed variables (in order), speak the closing line in the seller's current language (the lines below are Hindi examples), then call end_interaction.");
rep("3b", "Same closing order for the connectivity row.",
  "set end_interaction to true, then say in the seller's language:",
  "say in the seller's language, then call end_interaction:");
rep("3c", "Same closing order after a booking.",
  "Invoke end_interaction and speak the Meeting booked closing line from the table.",
  "Speak the Meeting booked closing line from the table, then call end_interaction.");
rep("3d", "Same closing order in the closing rules.",
  "Before ending, set the correct @ disposition_label, then @ meeting_fixed, then every other required variable.",
  "Before ending, set the correct @ disposition_label, then @ meeting_fixed, then every other required variable. Then speak the closing line, then call end_interaction.");

// 4. Contradictions about the context file.
rep(4, "'Never promise to send anything' contradicted 'continue from a promise in the file'.",
  "If the file lists a promise made earlier (for example details to be sent on WhatsApp), continue from it instead of starting over.",
  "If the file lists a promise made earlier (for example details to be sent on WhatsApp), acknowledge it in one short clause and say the sales executive will cover it in the meeting; do not promise to send anything yourself.");
rep(5, "Facts from the context file were excluded by 'only values given in this prompt's variables'.",
  "Facts you may use: only values given in this prompt's variables ({{ pitch_hook }}, {{ category_name }}, {{ enquiry_count_30d }}, {{ products_total }}, {{ products_missing_photos }}, {{ inquiry_city }}).",
  "Facts you may use: only values given in this prompt's variables ({{ pitch_hook }}, {{ category_name }}, {{ enquiry_count_30d }}, {{ products_total }}, {{ products_missing_photos }}, {{ inquiry_city }}) and the facts written in {{ seller_context }}.");

// 6. The agent needs today's date and time for 'kal', 'isi time', same-day rules and AM/PM.
rep(6, "Day and time capture needs the current date and time; the context service sends call_datetime (the platform's current_datetime cannot be used inside the prompt).",
  "CONVERSATION CONTEXT:\nThe call is outbound.",
  "CONVERSATION CONTEXT:\nCurrent date, time and day (India): {{ call_datetime }}. Use it to turn \"aaj\", \"kal\", \"parso\" and \"isi time\" into a date and time.\nThe call is outbound.");

// 7. Variables used but never declared.
rep(7, "meeting_day and meeting_time are not declared; the collected value is meeting_datetime.",
  "day {{ meeting_day }}, time {{ meeting_time }}, location {{ meeting_location }}",
  "day and time {{ meeting_datetime }}, location {{ meeting_location }}");

// 8. The REDIAL section applied to every call.
rep(8, "REDIAL had no condition, so a fresh call could open as a redial.",
  "REDIAL - Seller dropped or call reconnected\n",
  "{% if redial_reason != \"\" %}\nREDIAL - Seller dropped or call reconnected\n");
rep("8b", "Close the REDIAL condition.",
  "Apply the same ask limits as the original call; attempts from the dropped call still count.\n",
  "Apply the same ask limits as the original call; attempts from the dropped call still count.\n{% endif %}\n");

// 9. Language name is "Telugu" on the platform.
rep(9, "Sarvam's language_name is 'Telugu' (capitalised), so the lowercase test never matched.",
  "{%if language_name == 'telugu'%}", "{% if language_name|lower == 'telugu' %}");
rep("9b", "Tidy the matching endif.", "{%endif%}", "{% endif %}");

// 10. Tool inputs: say what each tool takes, in the format the server validates.
rep(10, "The tools need exact input formats; the server checks the working window.",
  "How: confirm all three with the seller (one short recap sentence) -> translate location to English if needed -> call with date, time, locality and city -> wait for the response",
  "How: confirm all three with the seller (one short recap sentence) -> translate location to English if needed -> call tool:schedule_meeting_tool with meeting_date (YYYY-MM-DD), meeting_time (HH:MM, 24-hour), locality and city -> wait for the response");

// 11. Insert the seller context file once, as its own block, instead of three times inside sentences.
rep(11, "{{ seller_context }} (about 2,000 characters) was substituted three times mid-sentence; now once, as a block.",
  "Before asking anything, check whether the answer is already known from {{ seller_context }}, the profile fields below, or earlier in the conversation.",
  "Before asking anything, check whether the answer is already known from the seller context file (under Resources & Their Limits), the profile fields below, or earlier in the conversation.");
rep("11b", "Seller context block.",
  "Seller context: {{ seller_context }} is a short file generated from IndiaMart records. Use it to open",
  "Seller context file (generated from IndiaMart records at the start of this call):\n<seller_context>\n{{ seller_context }}\n</seller_context>\nUse it to open");
rep("11c", "Refer to the block by name.",
  "and the facts written in {{ seller_context }}.", "and the facts written in the seller context file.");

// 12. Sarvam reads "tool:name," as a tool called "name,": a space must come before punctuation after a tool reference.
{
  const before = t;
  t = t.replace(/tool:(schedule_meeting_tool|schedule_callback_tool|mark_do_not_call_tool)([.,;:])/g, "tool:$1 $2");
  changes.push({ n: 12, why: "A space before punctuation after a tool reference, as the platform parses tool:name, as a different tool.", count: (before.match(/tool:\w+[.,;:]/g) || []).length });
}

// 13. language_name cannot be read inside the prompt on this platform, so the Telugu rules are stated for Telugu turns.
rep(13, "language_name is not available to the prompt (variable_not_found), so the Telugu block is unconditional and says when it applies.",
  "{% if language_name|lower == 'telugu' %}\n", "When the conversation is in Telugu:\n");
rep("13b", "Remove the matching endif.",
  "Never translate brand names, company names, locality names, product names or model codes into Telugu.\n{% endif %}\n",
  "Never translate brand names, company names, locality names, product names or model codes into Telugu.\n");

// 14. The do-not-call and already-met rules sit in {% if %} blocks the agent did not follow in testing (a do-not-call
// seller was pitched). The context service sends them as a sentence (call_restrictions) stated first, unconditionally.
rep(14, "A do-not-call seller was pitched in testing although its {% if %} block applied; the restriction now comes as text (call_restrictions) at the top.",
  "Global Instructions - Role & Persona:\n",
  "Call restrictions for this seller (highest priority, overrides every instruction below): {{ call_restrictions }}\nGlobal Instructions - Role & Persona:\n");

// 15. The platform speaks the greeting before the on_start tool's variables are saved, so a greeting that names the
// business used the agent's default instead of the seller's name. The greeting now only says IndiaMART is calling, and
// the agent's first turn (which has the seller's variables) asks the identity question.
rep(15, "The greeting is spoken before on_start variables arrive, so it cannot name the business; the first agent turn asks the identity question instead.",
  "The opening line has already been delivered: {{ initial_message }}.",
  "The opening line has already been delivered: {{ initial_message }}. It did not name the business, so the identity question has not been asked yet.");
rep("15b", "Identity question moves from the greeting to the first agent turn.",
  "Opening (already delivered): confirm the business name, for example \"Hello, kya aap {{ seller_company_name }} se bol rahe hain?\"",
  "Opening: the greeting only said IndiaMART is calling. In your first turn, whatever the seller replied to the greeting, ask the identity question, for example \"Kya meri baat {{ seller_company_name }} se ho rahi hai?\", and wait for the answer.");
rep("15c", "Same, in the pitch section.",
  "Open with the predefined line: {{ initial_message }}\nDefault structure: \"Hello, kya aap {{ seller_company_name }} se bol rahe hain?\" Wait for confirmation, then introduce yourself and give the pitch.",
  "The predefined line ({{ initial_message }}) has already been spoken; it did not name the business.\nDefault structure: ask \"Kya meri baat {{ seller_company_name }} se ho rahi hai?\" Wait for confirmation, then introduce yourself and give the pitch.");

fs.mkdirSync(`${ROOT}/context_layer/sarvam`, { recursive: true });
fs.writeFileSync(`${ROOT}/context_layer/sarvam/system_prompt.md`, t);
fs.writeFileSync(`${ROOT}/context_layer/sarvam/system_prompt.original.txt`, original);
const md = ["# Changes to the organisers' prompt", "", "Source: `Sarvam Prompt - Seller Side VANI.docx` (repo root, unchanged). The agent runs `system_prompt.md`, which is the docx text with the minimal changes below. `system_prompt.original.txt` is the plain-text extraction of the docx for diffing.", "",
  "Regenerate: `node tools/make-prompt.mjs` (fails if the docx changes so that a fix no longer applies).", "", "| # | Why | Matches |", "|---|---|---|",
  ...changes.map((c) => `| ${c.n} | ${c.why} | ${c.count} |`), "",
  "Not changed in the text (handled by the agent config and the context service): seller_locality fallback, 30-day enquiry figures, pitch_hook / lead_bucket derivation, calendar defaults, female bot_name and voice, thread window, do-not-call sellers skipped before dialling.", ""];
fs.writeFileSync(`${ROOT}/context_layer/sarvam/PROMPT_CHANGES.md`, md.join("\n"));
console.log(JSON.stringify({ changes: changes.length, chars: t.length, original: original.length }));
