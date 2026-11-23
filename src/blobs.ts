import { DurableObject } from "cloudflare:workers";
import type { Store } from "./worker";

export const MAX_BLOB_BYTES = 100_000_000;
const CHUNK_BYTES = 2 * 1024 * 1024;
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((n) => n.toString(16).padStart(2, "0")).join("");
type BlobRow = { id: string; size: number };
type PutResult = "ok" | "mismatch" | "changed";

type Env = { STORE: DurableObjectNamespace<Store> };

export class Blobs extends DurableObject<Env> {
  private sql = this.ctx.storage.sql;
  private initialized = this.ctx.storage.kv.get<boolean>("initialized") === true;
  private erased = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    if (!this.initialized) return;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM chunks WHERE id IN (SELECT id FROM files WHERE hash IS NULL)");
      this.sql.exec("DELETE FROM files WHERE hash IS NULL");
    });
  }

  missing(hashes: string[]): string[] | null {
    if (this.erased) return null;
    if (!this.initialized) return hashes;
    const found = new Set<string>();
    for (let i = 0; i < hashes.length; i += 100) {
      const batch = hashes.slice(i, i + 100);
      const marks = batch.map(() => "?").join(",");
      for (const r of this.sql.exec<{ hash: string }>(`SELECT hash FROM files WHERE hash IN (${marks})`, ...batch)) found.add(r.hash);
    }
    return hashes.filter((h) => !found.has(h));
  }

  async put(docId: string, hash: string, body: ReadableStream<Uint8Array> | null, length: number): Promise<PutResult> {
    if (!this.initialized && !this.erased) await this.initialize(docId);
    if (this.erased || !this.initialized || this.file(hash)) {
      const result = this.erased || !this.initialized ? "changed" : "ok";
      await body?.cancel();
      return result;
    }
    const id = crypto.randomUUID();
    this.sql.exec("INSERT INTO files (id) VALUES (?)", id);
    const digest = new crypto.DigestStream("SHA-256");
    const writer = digest.getWriter();
    const done = digest.digest;
    void done.catch(() => {});
    const buf = new Uint8Array(CHUNK_BYTES);
    let fill = 0;
    let part = 0;
    let size = 0;
    let ready = false;
    const flush = () => {
      if (!fill) return;
      this.sql.exec("INSERT INTO chunks (id, part, data) VALUES (?, ?, ?)", id, part++, buf.subarray(0, fill));
      fill = 0;
    };
    try {
      if (body) for await (const chunk of body) {
        size += chunk.byteLength;
        if (size > length) return "mismatch";
        await writer.write(chunk);
        if (this.erased) return "changed";
        for (let at = 0; at < chunk.byteLength; ) {
          const take = Math.min(chunk.byteLength - at, CHUNK_BYTES - fill);
          buf.set(chunk.subarray(at, at + take), fill);
          fill += take;
          at += take;
          if (fill === CHUNK_BYTES) flush();
        }
      }
      await writer.close();
      const actual = hex(await done);
      if (this.erased) return "changed";
      if (size !== length || actual !== hash) return "mismatch";
      if (this.file(hash)) return "ok";
      flush();
      this.sql.exec("UPDATE files SET hash = ?, size = ? WHERE id = ?", hash, size, id);
      ready = true;
      return "ok";
    } finally {
      if (!ready) {
        if (!this.erased) this.ctx.storage.transactionSync(() => {
          this.sql.exec("DELETE FROM chunks WHERE id = ?", id);
          this.sql.exec("DELETE FROM files WHERE id = ?", id);
        });
        await writer.abort().catch(() => {});
      }
    }
  }

  get(hash: string, limit?: number) {
    const file = this.erased || !this.initialized ? null : this.file(hash);
    if (!file) return null;
    const size = Math.min(file.size, limit ?? file.size);
    let left = size;
    let part = 0;
    const body = new ReadableStream({
      type: "bytes",
      pull: (controller) => {
        if (!left) return controller.close();
        if (this.erased) return controller.error(new Error("blob was deleted while reading"));
        const expected = Math.min(CHUNK_BYTES, file.size - part * CHUNK_BYTES);
        const row = this.sql.exec<{ data: ArrayBuffer }>(
          "SELECT data FROM chunks WHERE id = ? AND part = ?", file.id, part++,
        ).toArray()[0];
        if (row?.data.byteLength !== expected) return controller.error(new Error("blob chunk is missing or incomplete"));
        const bytes = new Uint8Array(row.data, 0, Math.min(expected, left));
        left -= bytes.byteLength;
        controller.enqueue(bytes);
      },
    });
    return { body, size };
  }

  async erase() {
    this.erased = true;
    await this.ctx.storage.deleteAll();
  }

  private async initialize(docId: string) {
    // An empty shard can be either new or erased. Only the catalog can tell them apart.
    const catalog = this.env.STORE.getByName("catalog");
    if (!(await catalog.canWriteBlobs(docId)) || this.erased || this.initialized) return;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`CREATE TABLE files (
        id TEXT PRIMARY KEY,
        hash TEXT UNIQUE,
        size INTEGER
      )`);
      this.sql.exec(`CREATE TABLE chunks (
        id TEXT NOT NULL,
        part INTEGER NOT NULL,
        data BLOB NOT NULL,
        PRIMARY KEY (id, part)
      )`);
      this.ctx.storage.kv.put("initialized", true);
    });
    this.initialized = true;
  }

  private file(hash: string): BlobRow | undefined {
    return this.sql.exec<BlobRow>("SELECT id, size FROM files WHERE hash = ?", hash).toArray()[0];
  }
}
