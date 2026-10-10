# skills.md: build journey and tools used

## Tools and skills

| Tool | What we used it for |
|---|---|
| **Sarvam Voice Agents platform** | the agent itself: an LLM prompt with input variables, the Ishita voice (female, to match "bol rahi hoon"), Hindi/English/Telugu, on_start, mid-call and on_end HTTP tools, post-call output variables, evaluation, voicemail message, versions |
| **Sarvam MCP server** (`sarvam-voice-agents`) | built and changed the agent entirely from the coding agent: `configure_agent`, `configure_app_tool`, `configure_secret`, `agents commit`, `send_chat` text tests, `place_test_call`, `analytics` (interaction traces, tool reports), playbooks and config schema as reference |
| **Sarvam Web SDK** (`sarvam-conv-ai-sdk@0.0.42`) | browser voice calls on the live dashboard: `ConversationAgent` + `BrowserAudioInterface`, `agent_variables: {glid}` to pick the seller, live transcript, state and audio-level callbacks. Bundled once with esbuild; the API key stays on the server behind a proxy |
| **Sarvam speech APIs** (Saaras v4 STT, Bulbul v3 TTS) | the developer console's own voice path, before the agent existed |
| **Cloudflare quick tunnel** (`cloudflared@0.7.3`) | gives the local service a public HTTPS URL for the agent's tools |
| **Neo4j 5.26** (Docker) | the context graph: 432K nodes and 536K relationships, three memory tiers, with each event committed in one transaction |
| **Node.js 20**, zero runtime dependencies | ingest, graph, rendering, HTTP service, SSE live feed |
| **Claude Code** | pair-programming the context layer, the Sarvam integration (through the Sarvam MCP), tests, docs and this dashboard |

## Build journey

### 1. The context layer (before any voice)
- **Load.** The 11 CSVs (5,000 sellers, ~62 MB) are loaded into one graph keyed by GLID, with three memory tiers: long-term (who), short-term (every interaction) and reasoning (facts with evidence and expiry, plus bot decisions).
- **Extract.** Regex rules in English and Hinglish turn calls, transcripts and chats into facts such as "asked to stop calling", "meeting fixed" or "already met an executive".
- **Render.** Each seller gets a `seller.md` of at most 700 tokens (median 420): profile, open loops ranked by urgency, contact policy, and a next best action.
- **Write back.** Any event (a call, a chat, a tool call) is appended to an event log, applied to the graph, and re-renders the affected files in milliseconds.

### 2. Putting it on Sarvam (agent versions)

| Version | What changed and why |
|---|---|
| v1 | First build from the organisers' seller-side prompt. Minimal, documented fixes: tool syntax `tool:<name>`, closing order, Telugu language check, the context file inserted once as a block, and the current date sent by our service. Tools: `load_seller_context` (on_start), meeting, callback, do-not-call, `save_call_outcome` (on_end). |
| v2 | Outcomes moved to post-call extraction (output variables); new tunnel URL. |
| v3 | Tunnel URL change. |
| v4 | **No hardcoded seller.** The `glid` default is empty and the server picks a test seller (`node cli.js test-seller <glid>`), so any seller can be tested from Sarvam's UI without editing the agent. |
| v5 | **The greeting names no one.** The greeting is spoken before the start-of-call variables arrive, so "Am I speaking with {company}?" moved to the first LLM turn. |
| v6 | **Seller Assistant.** The data showed sellers need help more than meetings (80% of enquiries unanswered, 38% of buyer calls missed, median catalogue score 16). New prompt (a third of the old one): VANI is IndiaMART's virtual sales executive and opens with `call_reason`, the seller's most urgent open loop. New tool `log_seller_request` with 9 request types. |
| v7 | Tool URLs moved to the current tunnel. The live dashboard and Neo4j store were added around it. |

### 3. Lessons from testing (each became a fix)
- **"I'll note it" without calling the tool.** The agent said "note kar leti hoon" and called nothing. Fix: a rule that a request counts as noted only when the tool was called, in the same turn the seller agrees.
- **A tool called together with `end_interaction` never runs.** The do-not-call request was lost, and only the closing message was spoken. Fixes:
  - other tools first, on their own;
  - the closing message carries everything still to be said;
  - an already-blocked seller gets the exact closing line from the server.
- **Calls dated 5 Oct instead of 10 Oct.** The server used a data clock (the dataset's as-of date). It now moves to real IST time on every Sarvam request, and old events were re-dated.
- **Post-call extraction labels calls that had no objection.** A booked meeting came back as "Existing Engagement", so that label is ignored when the call ended well.
- **Output variables arrive empty at the end-of-call tool,** so the mid-call tools carry the outcomes.
- **Open-loop ranking had a hole.** `seller_request` was missing from the rank table, so a request was not reliably the next call's opening. It now ranks right after promises.
- **The Web SDK needs the Voice Agents API key** (Settings → API Key), not the speech API key (`sk_…`), which is refused with "Invalid API key format".

### 4. Making it visible: VANI Live
The voice call only shows half the system. `/live` streams every step to the browser over Server-Sent Events, so viewers see the whole loop as it happens:
- what the agent was told
- each tool call
- the event
- the Neo4j graph diff
- the `seller.md` diff
- the next call's opening
