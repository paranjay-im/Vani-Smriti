// Synthetic live events for testing (CLI `emit` and the UI). Same columns as the real CSVs, so they go
// through exactly the same ingest path. GLIDs 9000000xx mark synthetic buyers.
export function buildEvent({ type = "enquiry", glid, ts, text = null, product = "Sample Product", city = "Pune", disposition = "General (talked)" }) {
  const id = String(Date.now()) + String(Math.floor(Math.random() * 1000)).padStart(3, "0");
  switch (type) {
    case "enquiry":
      return { source: "enquiries", row: {
        query_id: id, enquiry_date: ts, buyer_glid: "900000001", seller_glid: glid, subject: `Enquiry for ${product} via IndiaMART`,
        message: text || `I am interested in ${product}`, mcat_id: "", product_name: product, source_module: "IMOB", read_status: "0",
        first_read_date: "", buyer_city: city, buyer_state: "", buyer_country: "India", buyer_company: "", buyer_designation: "" } };
    case "whatsapp":
      return { source: "chatbot", row: {
        chat_id: id, glid, session_id: `live-${id}`, source: "WhatsApp", user_message: text || "Call mat karo, WhatsApp pe bhejo",
        bot_reply: "", intent: "", action_type: "typed", entry_date: ts } };
    case "botcall":
      return { source: "bot_calls", row: {
        attempt_id: id, fk_glusr_usr_id: glid, redis_bucket: "PIM", lead_bot_version: "main_vani", call_attempt_count: "1",
        call_start_time: ts, lead_call_duration: "45",
        lead_call_summary: text || "The lead said an executive already visited them and asked the agent to stop further calls.",
        disposition_label: disposition, meeting_fixed: disposition === "Meeting Fixed" ? "1" : "0", has_turn_transcript: "0" } };
    default:
      throw new Error("type must be enquiry, whatsapp or botcall");
  }
}
