// Compare two output folders file by file (sellers/ and buyers/), ignoring the generated_at line and line endings.
// Usage: node tools/compare-out.mjs <dirA> <dirB> [sub ...] [--subset]     (default sub: sellers buyers)
//   --subset  compare only the files that exist in dirB (e.g. a selective build against a full build)
// Exit code 0 when identical, 1 otherwise. Used to prove one graph store, or one load mode, renders exactly what another does.
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const subset = argv.includes("--subset");
const [a, b, ...subs] = argv.filter((x) => x !== "--subset");
if (!a || !b) { console.error("usage: node tools/compare-out.mjs <dirA> <dirB> [sub ...] [--subset]"); process.exit(2); }
const norm = (t) => t.replace(/\r\n/g, "\n").replace(/^generated_at: .*$/m, "generated_at: -");
let compared = 0, differing = 0, missing = 0;
const examples = [];
for (const sub of subs.length ? subs : ["sellers", "buyers"]) {
  const da = path.join(a, sub), db = path.join(b, sub);
  const driver = subset ? db : da;
  if (!fs.existsSync(driver)) continue;
  for (const f of fs.readdirSync(driver).filter((x) => x.endsWith(".md"))) {
    const fa = path.join(da, f), fb = path.join(db, f);
    if (!fs.existsSync(fa) || !fs.existsSync(fb)) { missing++; if (examples.length < 5) examples.push(`${sub}/${f}: missing in ${fs.existsSync(fa) ? "B" : "A"}`); continue; }
    compared++;
    if (norm(fs.readFileSync(fa, "utf8")) !== norm(fs.readFileSync(fb, "utf8"))) {
      differing++;
      if (examples.length < 5) examples.push(`${sub}/${f}: differs`);
    }
  }
}
console.log(JSON.stringify({ compared, differing, missing }));
for (const e of examples) console.log("  " + e);
process.exit(differing || missing ? 1 : 0);
