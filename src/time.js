// All timestamps are naive IST strings "YYYY-MM-DD HH:MM:SS". Arithmetic treats them as UTC,
// which is safe because we never mix them with real time zones (extractions are shifted on ingest).

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const toMs = (s) => Date.parse(String(s).slice(0, 19).replace(" ", "T") + "Z");
export const fromMs = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

export function norm(s) {
  if (!s) return null;
  const t = String(s).trim().replace("T", " ").slice(0, 19);
  if (/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(t)) return t;
  if (/^\d{4}-\d\d-\d\d \d\d:\d\d$/.test(t)) return t + ":00";
  return null;
}

export const addMin = (s, m) => fromMs(toMs(s) + m * 60000);
export const addDays = (s, d) => addMin(s, d * 1440);
// gc_buyer_call_extractions.call_date is UTC; every other file is IST.
export const utcToIst = (s) => (norm(s) ? addMin(norm(s), 330) : null);
export const daysBetween = (a, b) => (toMs(b) - toMs(a)) / 86400000;
export const dmy = (s) => (s ? `${Number(s.slice(8, 10))} ${MON[Number(s.slice(5, 7)) - 1]}` : "");
export const dmyhm = (s) => (s ? `${dmy(s)} ${s.slice(11, 16)}` : "");
export const cmpTs = (a, b) => (a.ts === b.ts ? 0 : !a.ts ? -1 : !b.ts ? 1 : a.ts < b.ts ? -1 : 1);
