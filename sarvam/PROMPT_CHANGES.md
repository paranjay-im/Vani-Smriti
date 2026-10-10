# Changes to the organisers' prompt

Source: `Sarvam Prompt - Seller Side VANI.docx` (repo root, unchanged). The agent runs `system_prompt.md`, which is the docx text with the minimal changes below. `system_prompt.original.txt` is the plain-text extraction of the docx for diffing.

Regenerate: `node tools/make-prompt.mjs` (fails if the docx changes so that a fix no longer applies).

| # | Why | Matches |
|---|---|---|
| 1 | Claiming 10+ years of experience contradicts 'never claim to be a human'. | 1 |
| 2-schedule_meeting_tool | Sarvam references tools as tool:<name> (prompt calls use 'call tool:<name>'). | 3 |
| 2-schedule_callback_tool | Sarvam references tools as tool:<name> (prompt calls use 'call tool:<name>'). | 3 |
| 2-mark_do_not_call_tool | Sarvam references tools as tool:<name> (prompt calls use 'call tool:<name>'). | 3 |
| 2-end | Sarvam's end call is written 'call end_interaction'. | 3 |
| 2-end2 | Sarvam's end call is written 'call end_interaction'. | 1 |
| 3 | Ending the call before speaking would cut off the closing line. | 1 |
| 3b | Same closing order for the connectivity row. | 1 |
| 3c | Same closing order after a booking. | 1 |
| 3d | Same closing order in the closing rules. | 1 |
| 4 | 'Never promise to send anything' contradicted 'continue from a promise in the file'. | 1 |
| 5 | Facts from the context file were excluded by 'only values given in this prompt's variables'. | 1 |
| 6 | Day and time capture needs the current date and time; the context service sends call_datetime (the platform's current_datetime cannot be used inside the prompt). | 1 |
| 7 | meeting_day and meeting_time are not declared; the collected value is meeting_datetime. | 1 |
| 8 | REDIAL had no condition, so a fresh call could open as a redial. | 1 |
| 8b | Close the REDIAL condition. | 1 |
| 9 | Sarvam's language_name is 'Telugu' (capitalised), so the lowercase test never matched. | 1 |
| 9b | Tidy the matching endif. | 1 |
| 10 | The tools need exact input formats; the server checks the working window. | 1 |
| 11 | {{ seller_context }} (about 2,000 characters) was substituted three times mid-sentence; now once, as a block. | 1 |
| 11b | Seller context block. | 1 |
| 11c | Refer to the block by name. | 1 |
| 12 | A space before punctuation after a tool reference, as the platform parses tool:name, as a different tool. | 4 |
| 13 | language_name is not available to the prompt (variable_not_found), so the Telugu block is unconditional and says when it applies. | 1 |
| 13b | Remove the matching endif. | 1 |
| 14 | A do-not-call seller was pitched in testing although its {% if %} block applied; the restriction now comes as text (call_restrictions) at the top. | 1 |
| 15 | The greeting is spoken before on_start variables arrive, so it cannot name the business; the first agent turn asks the identity question instead. | 1 |
| 15b | Identity question moves from the greeting to the first agent turn. | 1 |
| 15c | Same, in the pitch section. | 1 |

Not changed in the text (handled by the agent config and the context service): seller_locality fallback, 30-day enquiry figures, pitch_hook / lead_bucket derivation, calendar defaults, female bot_name and voice, thread window, do-not-call sellers skipped before dialling.
