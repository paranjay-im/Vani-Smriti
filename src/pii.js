import { createHash } from "node:crypto";

// The export claims phones/emails are excluded, but message text still carries them
// ("Call me on 98xxxxxxxx"), so everything that reaches a context file or the bot goes through scrub().
const PHONE = /(?<!\d)(?:\+?91[\s-]?|0)?[6-9]\d{2}[\s-]?\d{3}[\s-]?\d{4}(?!\d)/g;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const URL = /\b(?:https?:\/\/|www\.)\S+/gi;
// "Hi Lakshmi Patel, thanks..." -> "Hi [name], thanks..." (the other party's personal name)
const GREETING = /\b(Hi|Hii|Hello|Dear|Hey|Namaste)\s+[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?/g;
const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };

export function scrub(text, { max = 0, names = true } = {}) {
  if (!text) return "";
  let s = String(text)
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m])
    .replace(/&[A-Za-z]+;/g, "")
    .replace(/\s+/g, " ")
    .trim();
  s = s.replace(URL, "[link]").replace(EMAIL, "[email]").replace(PHONE, "[phone]");
  if (names) s = s.replace(GREETING, "$1 [name]");
  if (max && s.length > max) s = s.slice(0, max - 1).trimEnd() + "…";
  return s;
}

// Stable pseudonym so a seller.md can say "buyer B-7F3A" without naming the buyer.
export const handle = (glid) => "B-" + createHash("sha1").update("gc:" + glid).digest("hex").slice(0, 4).toUpperCase();

// Last line of defence on anything the bot is about to say.
export function guard(text) {
  const out = String(text).replace(EMAIL, "[email]").replace(PHONE, "[phone]");
  return { text: out, redacted: out !== text };
}
