// Ego-graph of one user's context graph (HTML, vis-network from unpkg). Buyers appear only as handles.
import fs from "node:fs";
import path from "node:path";
import { OUT_DIR } from "./config.js";
import { handle } from "./pii.js";
import { cmpTs, dmy } from "./time.js";

const SHOW = ["Enquiry", "EnquiryMessage", "BuyerCall", "BuyLead", "ChatSession", "PNSCall", "BotCall", "ExecCall", "VaniSession"];
const COLOR = { long_term: "#2f6db5", short_term: "#1f8a5c", reasoning: "#b5462f" };

export function graphHtml(g, glid, { limit = 45 } = {}) {
  const root = g.get(`S:${glid}`);
  if (!root) throw new Error(`No seller ${glid}`);
  const picked = new Set([root.id]);
  const inter = SHOW.flatMap((l) => g.owned(glid, l)).filter((n) => n.ts).sort((a, b) => -cmpTs(a, b)).slice(0, limit);
  for (const n of inter) picked.add(n.id);
  for (const n of [...g.owned(glid, "Fact"), ...g.owned(glid, "Decision")].filter((n) => n.ts).sort((a, b) => -cmpTs(a, b)).slice(0, 30)) picked.add(n.id);
  for (const id of [...picked]) {
    for (const rels of [g.out.get(id), g.in.get(id)]) for (const set of rels?.values() || []) for (const x of set) {
      const n = g.get(x);
      if (n && ["Buyer", "Category", "Product", "Employee"].includes(n.label)) picked.add(x);
    }
  }
  const label = (n) => {
    switch (n.label) {
      case "Seller": return n.props.company;
      case "Buyer": return `Buyer ${handle(n.buyer)}`;
      case "Category": case "Product": return n.props.name;
      case "Employee": return `Exec ${n.props.employee_id}`;
      case "Fact": return `Fact: ${n.props.type}\n${dmy(n.ts)}`;
      case "Decision": return `Decision: ${n.props.action}${n.props.question ? ` (${n.props.question})` : ""}`;
      case "BotCall": return `VANI call\n${dmy(n.ts)} · ${n.props.disposition}`;
      default: return `${n.label}\n${dmy(n.ts)}`;
    }
  };
  const nodes = [...picked].map((id) => g.get(id)).filter(Boolean).map((n) => ({
    id: n.id, label: label(n), color: COLOR[n.tier], shape: n.label === "Seller" ? "star" : n.tier === "reasoning" ? "diamond" : n.tier === "long_term" ? "dot" : "box",
    font: { color: n.tier === "short_term" ? "#ffffff" : undefined, size: 12 }, size: n.label === "Seller" ? 30 : 12,
  }));
  const edges = [];
  for (const [src, rel, dst] of g.edges()) if (picked.has(src) && picked.has(dst)) edges.push({ from: src, to: dst, label: rel, arrows: "to", font: { size: 9, align: "middle" } });
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Context Graph ${glid}</title>
<script src="https://unpkg.com/vis-network@9.1.9/standalone/umd/vis-network.min.js"></script>
<style>:root{--bg:#fafaf8;--ink:#1d1d1b}@media (prefers-color-scheme:dark){:root{--bg:#151513;--ink:#ecebe6}}
body{margin:0;background:var(--bg);color:var(--ink);font:14px system-ui,sans-serif}header{padding:12px 16px}#g{height:calc(100vh - 70px)}
.k{display:inline-block;width:10px;height:10px;border-radius:2px;margin:0 4px 0 12px}</style></head><body>
<header><b>${root.props.company}</b> (${glid}) — context graph ·
<span class="k" style="background:${COLOR.long_term}"></span>long-term (knowledge)
<span class="k" style="background:${COLOR.short_term}"></span>short-term (interactions)
<span class="k" style="background:${COLOR.reasoning}"></span>reasoning (facts &amp; decisions)</header>
<div id="g"></div>
<script>
new vis.Network(document.getElementById("g"), { nodes: new vis.DataSet(${JSON.stringify(nodes)}), edges: new vis.DataSet(${JSON.stringify(edges)}) },
 { physics: { solver: "forceAtlas2Based", stabilization: { iterations: 250 } }, interaction: { hover: true } });
</script></body></html>`;
  const dir = path.join(OUT_DIR, "graphs");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${glid}.html`);
  fs.writeFileSync(file, html);
  return { file, nodes: nodes.length, edges: edges.length };
}
