# Sarvam agent spec: VANI Seller Meeting Booker

Use this to rebuild the agent on another Sarvam workspace, for example a personal account or a fresh hackathon workspace, through the Sarvam Voice Agents MCP (`https://mcp.sarvam.ai/voice-agents`) or the dashboard. For how it works, see [`../docs/23-sarvam-voice-agent.md`](../docs/23-sarvam-voice-agent.md).

Live agent: `VANI-Seller-6921b562-b28e`. The hackathon workspace is `01a110de-571d-738d-948b-b1b185c8e4b0`; v6 is committed: the Seller Assistant, built from `sarvam/assistant_prompt.md` with the extra tool `log_seller_request` (`POST <PUBLIC>/sarvam/request`, body `glid`, `request_type`, `details`) and input variable `call_reason`; see [`../docs/26-vani-seller-assistant.md`](../docs/26-vani-seller-assistant.md). v5 is the organisers' meeting booker described below.

## Build order

The platform validates the prompt against the declared variables and tools, so create them first.

1. **Create the agent** from a blank template: channel `v2v`, single-prompt mode, one state `start`.
2. **Secret**: `configure_secret` with name `gc_context_token` and the value of `GC_SARVAM_TOKEN` from `context_layer/.env`. Write it down as `<SECRET_ID>`.
3. **Variables** ([below](#variables)). Set every one to `is_agent_updatable: false`. This workspace refuses to commit when mid-call updates are on. Outputs use `update_post_interaction: true` plus an extraction prompt.
4. **Tools** ([below](#tools)). Replace `<PUBLIC>` with the tunnel URL from `npm run tunnel`.
5. **Prompt**: `node tools/make-prompt.mjs`, then put the contents of `sarvam/system_prompt.md` in `states.start.instructions`. Set `states.start.tool_names` = `schedule_meeting_tool`, `mark_do_not_call_tool`, `schedule_callback_tool`. The prompt refers to them as `tool:name`, followed by a space before any punctuation.
6. **Settings** ([below](#settings)).
7. **Check with a dry run, then commit.** Copy the new ids into `context_layer/.env`: `SARVAM_ORG_ID`, `SARVAM_WORKSPACE_ID`, `SARVAM_APP_ID`, `SARVAM_APP_VERSION`.
8. **Test** with one `send_chat` before any voice or phone test ([docs §8.3](../docs/23-sarvam-voice-agent.md#83-test-on-the-platform-cheapest-first)).

## Variables

All variables are strings unless marked as an enum. Each value in the Default column is what the variable starts with; `load_seller_context` overwrites most of them at call start.

### Inputs (`needs_initial_value: false`)

| Name | Default |
|---|---|
| `glid` | empty: the server then uses its test seller (`node cli.js test-seller <glid>`); phone tests and campaigns pass `app_variables {glid}`. `load_seller_context` saves the resolved `glid` back |
| `seller_context`, `call_restrictions` (`None.`), `call_datetime` | loaded at start |
| `seller_company_name` (`the IndiaMART seller`), `seller_city`, `seller_locality`, `seller_state`, `initial_message` | loaded at start. Keep defaults neutral (`lead_bucket` `profile_review`, empty `seller_context`), never a real seller's data |
| `lead_bucket`, `pitch_hook`, `category_name`, `inquiry_city`, `enquiry_count_30d`, `products_total`, `products_missing_photos` | loaded at start |
| `already_in_touch_with_executive` (`0`), `last_meeting_date`, `past_objections` | loaded at start |
| `bot_name` `Payal`; `meeting_day_label` `kal`; `meeting_slot_start` `10:00 AM`; `meeting_slot_end` `7:00 PM`; `meeting_blocked_dates` empty; `same_day_meeting_allowed` `0`; `min_lead_minutes` `120`; `phone_meeting_allowed` `0`; `lead_bot_version` `context-layer-1` | loaded at start (from `AGENT_DEFAULTS` in `src/sarvam.js`) |
| `executive_name`, `redial_reason`, `call_step`, `turn_intent` | empty |
| `call_attempt_count` `1`, `current_phase` `IDENTITY`, `off_topic_counter` `0` | fixed |

### Outputs (`update_post_interaction: true`)

| Name | Type | Extraction prompt (short form) |
|---|---|---|
| `disposition_label` | enum: Meeting Fixed, Call Later / Busy, Not Interested, General (talked) | the call outcome |
| `meeting_fixed` | `0`/`1` | `1` if a visit was booked with a confirmed day, time and place |
| `meeting_datetime` | `YYYY-MM-DD HH:MM` | the booked meeting, 24-hour |
| `meeting_location` | text | locality and city in English |
| `callback_datetime` | `YYYY-MM-DD HH:MM` | the callback time if the seller gave one |
| `objection_type` | enum of 9: Seller Unavailability & Scheduling Constraints; Callback / Deferred Engagement (Neutral); Call Quality / Technical Failures; No Seller Response / Engagement Drop; Explicit Disinterest / Refusal; Call Handling / Executive Gaps; Wrong Contact / Business Not Applicable; Product / Service / Business Mismatch; Existing Engagement / Past Experience | the main objection |
| `do_not_call_requested` | `0`/`1` | `1` if the seller clearly asked to stop calls |
| `identity_confirmed` | `0`/`1` | the right business confirmed |
| `meeting_interest` | Yes / No / Later | interest in a visit |
| `additional_details` | text | 1–2 English sentences useful for the next call |
| `call_summary` | text | 1–2 lines on what happened |

## Tools

Every HTTP tool uses this auth: `{"type": "api_key", "name": "X-GC-Token", "location": "header", "value": {"secret_id": "<SECRET_ID>"}}`.

| Name | Type / lifecycle | Method and URL | Inputs | Other |
|---|---|---|---|---|
| `load_seller_context` | `webhook_on_start` / `on_start` | `GET <PUBLIC>/sarvam/context` | query `glid` ← agent variable `glid` | timeout 10 s; `save_to_variables`: `glid` plus each of the 28 response keys listed in the input table (`seller_context`, `call_restrictions`, …, `call_datetime`) → the variable of the same name |
| `schedule_meeting_tool` | `webhook` / `run` | `POST <PUBLIC>/sarvam/meeting` | `glid` ← variable; LLM params: `meeting_date` (YYYY-MM-DD, worked out from today's date), `meeting_time` (HH:MM 24-hour), `locality` (English), `city` (English) | `resp_template: "{{ message }}"`; `on_failure`: "The booking system did not respond. Tell the seller the slot could not be booked right now and that IndiaMART will call back to confirm." |
| `schedule_callback_tool` | `webhook` / `run` | `POST <PUBLIC>/sarvam/callback` | `glid`; LLM params: `callback_date`, `callback_time` | `resp_template: "{{ message }}"` |
| `mark_do_not_call_tool` | `webhook` / `run` | `POST <PUBLIC>/sarvam/dnc` | `glid`; LLM param `reason` (optional) | `resp_template: "{{ message }}"` |
| `save_call_outcome` | `webhook_on_end` / `on_end` | `POST <PUBLIC>/sarvam/end` | `glid` ← variable; system variables `interaction_id`, `interaction_transcript`, `call_duration_seconds` (sent as `duration`), `interaction_start_time` (sent as `start_datetime`), `user_identifier`; agent variables: every output listed above except `call_summary` | timeout 15 s |

Core tools to keep enabled: `end_interaction`, `handle_voicemail`, `change_output_language`.

System variables are valid only in on_start and on_end tools. The valid names are: `interaction_id`, `interaction_transcript`, `call_duration_seconds`, `interaction_start_time`, `interaction_end_time`, `user_identifier`, `user_identifier_type`, `current_date`, `current_datetime`, `current_day`, `current_time`, `language_name`, `agent_phone_number`, `app_id`, `app_version`, `attempt_id`, `campaign_id`, `provider_ref_id`.

## Settings

| Setting | Value |
|---|---|
| Languages | initial Hindi; supported and language identification: Hindi, English, Telugu; style `classic_colloquial_with_custom_code_mixed_words`; numbers in Indic |
| Voice | `text_to_speech_config` v2, `internal_id 01a0cf17-0b6e-79f0-b8ab-7392cabc497b` (Ishita – Hinglish Support Agent), pace 1.15 |
| Greeting | `Hello, this is a call from IndiaMART.` (writing the English intro regenerates the translations). Never put an on_start variable in it: the greeting is spoken before on_start results are saved |
| Thread windows | 30 / 30 / 30, token-based truncation |
| Temperature | 0.5 |
| Interaction | interrupt during playback on; max 900 s; native function calling |
| Nudges | 6 s "Hello, can you hear me?"; 8 s "It seems you may be busy right now. IndiaMART will call you again at a better time."; end after consecutive nudges |
| Voicemail | detection on; message: "Namaste, this is IndiaMART calling about a free visit from our sales executive to help your business get more buyer enquiries. We will call you again soon. Thank you." |
| Background | quiet office, -42 dBFS |
| Evaluation | rule "Meeting booked or callback captured": `disposition_label equals Meeting Fixed` OR `callback_datetime not_equals ""` |

## Gotchas met while building

- The prompt is refused if it uses an undeclared variable. `language_name` and `current_datetime` cannot be used in the prompt on this plan. The prompt is also refused if a tool it names is missing from `states.start.tool_names`.
- `tool:name,` is read as a tool called `name,`, so put a space before punctuation.
- A dry run passed with `current_datetime` in the prompt, but the real update was refused.
- A commit is refused while any variable has `is_agent_updatable: true` on this workspace.
- `send_chat` cannot pass variables: it uses the defaults, though on_start still runs. `place_test_call` passes `app_variables` and needs a verified number.
- After a tunnel restart, update all five URLs and **commit**. A committed version keeps the old URLs.
