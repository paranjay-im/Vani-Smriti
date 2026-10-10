// Live feed for the demo dashboard (src/live.html): everything the context layer does during a Sarvam call — the context
// it served, each tool call and its answer, the seller file before/after, the graph changes — pushed to the browser as
// Server-Sent Events. Local only: the tunnel guard in sarvam.js refuses /live/* from outside.
const KEEP = 300; // events replayed to a page that connects mid-call

export function liveHub() {
  const buffer = [];
  const clients = new Set();
  let seq = 0;

  const emit = (type, data) => {
    const ev = { id: ++seq, type, at: new Date().toISOString(), data };
    buffer.push(ev);
    if (buffer.length > KEEP) buffer.shift();
    const frame = `id: ${ev.id}\nevent: live\ndata: ${JSON.stringify(ev)}\n\n`;
    for (const res of clients) res.write(frame);
    return ev;
  };

  // GET /live/events: replays the buffer (or only what follows Last-Event-ID after a reconnect), then streams.
  const stream = (req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive" });
    const after = Number(req.headers["last-event-id"] || 0);
    for (const ev of buffer) if (ev.id > after) res.write(`id: ${ev.id}\nevent: live\ndata: ${JSON.stringify(ev)}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(": ping\n\n"), 15000);
    ping.unref?.(); // never keeps the process alive on its own
    req.on("close", () => { clearInterval(ping); clients.delete(res); });
  };

  const clear = () => { buffer.length = 0; };
  return { emit, stream, clear, get size() { return buffer.length; } };
}

// Line diff of two context files (longest common subsequence), ignoring the generated_at stamp. Returns
// [[" " | "+" | "-", line], ...] in file order, which reads like a unified diff.
const VOLATILE = /^generated_at:/;
export function lineDiff(a, b) {
  const A = (a || "").split("\n").filter((l) => !VOLATILE.test(l));
  const B = (b || "").split("\n").filter((l) => !VOLATILE.test(l));
  const n = A.length, m = B.length;
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push([" ", A[i]]); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) out.push(["-", A[i++]]);
    else out.push(["+", B[j++]]);
  }
  while (i < n) out.push(["-", A[i++]]);
  while (j < m) out.push(["+", B[j++]]);
  return out;
}
