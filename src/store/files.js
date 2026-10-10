// Files-only store: serve the bot from context files that already exist, without building the graph.
// The bot reads only the seller's .md file, so reads are plain file reads. When a conversation ends, the event is
// applied by a small in-memory store that loads just that seller's rows (the selective load), and the seller's file
// is regenerated. Nothing here touches buyers or the other sellers.
import fs from "node:fs";
import path from "node:path";
import { MemoryStore } from "./memory.js";
import { parseMd } from "../mdparse.js";
import { writeContext } from "../render.js";
import { sellerOf } from "../sources.js";
import { OUT_DIR, EVENT_LOG } from "../config.js";

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export class FileStore {
  kind = "files";
  #stores = new Map(); // glid -> MemoryStore holding only that seller
  #dirty = new Set(); // sellers whose graph changed since their file was written

  constructor({ outDir = OUT_DIR, log = EVENT_LOG } = {}) {
    this.outDir = outDir;
    this.log = log;
    this.dir = path.join(outDir, "sellers");
  }

  async init() {
    const have = fs.existsSync(this.dir) && fs.readdirSync(this.dir).some((f) => f.endsWith(".md"));
    if (!have) throw new Error(`No context files in ${this.dir}. Create some first: node cli.js build --glid <glid,glid,...>  (or node cli.js build for all sellers)`);
    return this;
  }

  async close() { this.#stores.clear(); }

  #file(id) {
    if (!/^\d+$/.test(String(id))) throw new HttpError(400, `Invalid GLID "${id}" (digits only)`);
    return path.join(this.dir, `${id}.md`);
  }

  async hasSeller(id) { return /^\d+$/.test(String(id)) && fs.existsSync(this.#file(id)); }

  // Read the existing file; or, right after a save, render the updated graph and rewrite the file.
  async write(role, id, opts = {}, view = null) {
    if (role === "buyer") throw new HttpError(404, "Buyer files are not available in files-only mode (they need every seller's data).");
    const file = this.#file(id);
    const fresh = view || (this.#dirty.delete(String(id)) ? this.#stores.get(String(id))?.graph : null);
    if (fresh) return writeContext(fresh, "seller", id, { ...opts, outDir: this.outDir });
    if (!fs.existsSync(file)) throw new HttpError(404, `No context file for ${id}. Create it with: node cli.js build --glid ${id}`);
    const t0 = performance.now();
    const md = fs.readFileSync(file, "utf8");
    return { file, md, fm: parseMd(md).fm, ms: performance.now() - t0 };
  }

  // Front matter of every existing file (for the console's sample picker).
  async *listFm() {
    for (const f of fs.readdirSync(this.dir).filter((x) => x.endsWith(".md"))) {
      yield { glid: f.slice(0, -3), fm: parseMd(fs.readFileSync(path.join(this.dir, f), "utf8")).fm };
    }
  }

  async #storeFor(glid) {
    let s = this.#stores.get(glid);
    if (!s) this.#stores.set(glid, (s = await new MemoryStore({ log: this.log, quiet: true, sellers: [glid] }).init()));
    return s;
  }

  #logOnly(ev) {
    fs.mkdirSync(path.dirname(this.log), { recursive: true });
    fs.appendFileSync(this.log, JSON.stringify({ source: ev.source, row: ev.row, received_at: new Date().toISOString() }) + "\n");
  }

  async apply(events, { persist = false } = {}) {
    const list = [].concat(events);
    const out = { sellers: new Set(), buyers: new Set(), view: null };
    for (const ev of list) {
      const glid = sellerOf(ev);
      if (!glid) { if (persist) this.#logOnly(ev); continue; } // e.g. a buyer session: kept in the log, no file here
      let store;
      try { store = await this.#storeFor(glid); }
      catch (e) {
        if (!/^Input data not found/.test(e.message)) throw e;
        if (persist) this.#logOnly(ev);
        out.warning = `Saved to the event log only: ${e.message}`;
        continue;
      }
      const a = await store.apply(ev, { persist });
      a.sellers.forEach((x) => { out.sellers.add(x); this.#dirty.add(String(x)); });
      if (list.length === 1) out.view = a.view;
    }
    return out;
  }

  // The seller's graph (loads that seller's rows the first time). Used for the Sarvam agent's call-start variables.
  async neighbourhood(glid) { return (await this.#storeFor(String(glid))).graph; }

  async counts() { return { sellers: fs.readdirSync(this.dir).filter((f) => f.endsWith(".md")).length }; }
  async stats() { return this.counts(); }
}
