// Stand-in for api.sarvam.ai, only to exercise our /voice/* routes without a real key.
// Usage: node tools/fake-sarvam.mjs   then start the server with SARVAM_API_KEY=testkey SARVAM_BASE_URL=http://localhost:9911
import http from "node:http";
const seen = [];
http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    seen.push({ url: req.url, key: req.headers["api-subscription-key"], type: req.headers["content-type"], bytes: body.length });
    res.setHeader("content-type", "application/json");
    if (req.url === "/__seen") return res.end(JSON.stringify(seen));
    if (req.url === "/speech-to-text") return res.end(JSON.stringify({ transcript: "मुझे व्हाट्सएप पर भेज दो", language_code: "hi-IN" }));
    if (req.url === "/transliterate") {
      const j = JSON.parse(body.toString());
      return res.end(JSON.stringify({ transliterated_text: j.target_language_code === "en-IN" ? "mujhe whatsapp par bhej do" : "नमस्ते" }));
    }
    if (req.url === "/text-to-speech") return res.end(JSON.stringify({ audios: ["QUJDREVG"] }));
    res.statusCode = 404; res.end(JSON.stringify({ error: { message: "not found" } }));
  });
}).listen(9911, () => console.log("fake sarvam on 9911"));
