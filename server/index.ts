// Day Board server: one table of JSON records (tasks and repeat rules), keyed by the page's own ids.
// The page loads everything with GET /api/state and saves changes with POST /api/ops.
import { capsule, endpoint, json, string, table } from "@spacefast/zero/server";
import { readLinear, readHubspot, writeLinear, writeHubspot, SourceError } from "./external";

const KINDS = ["task", "series"];
const MAX_OPS = 25; // keeps each request well under the 64-statement transaction limit

export default capsule({
  name: "dayboard",
  schema: {
    items: table({ key: string(), kind: string(), data: string() })
      .index("by_key", ["key"])
      .index("by_kind", ["kind"]),
  },
  endpoints: {
    state: endpoint({ method: "GET", path: "/api/state", mode: "read" }, async (ctx) => {
      const rows = await ctx.db.items.withIndex("by_creation").collect();
      const out = { tasks: [], series: [] };
      for (const r of rows) {
        try {
          const d = JSON.parse(r.data);
          if (r.kind === "task") out.tasks.push(d);
          else if (r.kind === "series") out.series.push(d);
        } catch (e) {
          ctx.log.warn("skipped unreadable row", r.key);
        }
      }
      return json(out);
    }),

    ops: endpoint({ method: "POST", path: "/api/ops", mode: "write" }, async (ctx, req) => {
      let body;
      try { body = await req.json(); } catch (e) { return json({ ok: false, error: "Body must be JSON." }, { status: 400 }); }
      const ops = body && Array.isArray(body.ops) ? body.ops : null;
      if (!ops) return json({ ok: false, error: "Send { ops: [...] }." }, { status: 400 });
      if (ops.length > MAX_OPS) return json({ ok: false, error: "Send at most " + MAX_OPS + " changes per request." }, { status: 400 });
      let applied = 0;
      for (const op of ops) {
        const key = op && typeof op.key === "string" ? op.key : "";
        if (!key || key.length > 100) return json({ ok: false, error: "Each change needs a key." }, { status: 400 });
        const existing = await ctx.db.items.withIndex("by_key", (r) => r.eq("key", key)).first();
        if (op.op === "delete") {
          if (existing) await ctx.db.items.delete(existing.id);
        } else if (op.op === "upsert") {
          if (KINDS.indexOf(op.kind) < 0) return json({ ok: false, error: "Unknown kind." }, { status: 400 });
          const data = JSON.stringify(op.data);
          if (data.length > 60000) return json({ ok: false, error: "That item is too large." }, { status: 400 });
          if (existing) await ctx.db.items.update(existing.id, { kind: op.kind, data });
          else await ctx.db.items.insert({ key, kind: op.kind, data });
        } else {
          return json({ ok: false, error: "Unknown change type." }, { status: 400 });
        }
        applied++;
      }
      return json({ ok: true, applied });
    }),

    // Live Linear issues and HubSpot tasks assigned to Jason. Each source reports its own error,
    // so one broken key never hides the other source.
    external: endpoint({ method: "GET", path: "/api/external", mode: "read" }, async (ctx) => {
      const env = (ctx as any).env || {};
      const settle = async (fn: (e: any) => Promise<any[]>, configured: boolean) => {
        if (!configured) return { ok: false, configured: false, items: [] };
        try { return { ok: true, configured: true, items: await fn(env) }; }
        catch (e: any) {
          ctx.log.warn("external read failed", String(e && e.message));
          return { ok: false, configured: true, error: String((e && e.message) || e), items: [] };
        }
      };
      const [lin, hub] = await Promise.all([
        settle(readLinear, Boolean(env.LINEAR_API_KEY)),
        settle(readHubspot, Boolean(env.HUBSPOT_TOKEN)),
      ]);
      return json({ linear: lin, hubspot: hub, at: new Date().toISOString() });
    }),

    // Write back one change: { source: "linear"|"hubspot", extId, action: "done"|"due", due?, ts?, doneStateId? }
    externalWrite: endpoint({ method: "POST", path: "/api/external/write", mode: "write" }, async (ctx, req) => {
      const env = (ctx as any).env || {};
      let op: any;
      try { op = await req.json(); } catch (e) { return json({ ok: false, error: "Body must be JSON." }, { status: 400 }); }
      try {
        if (op && op.source === "linear") await writeLinear(env, op);
        else if (op && op.source === "hubspot") await writeHubspot(env, op);
        else return json({ ok: false, error: "Unknown source." }, { status: 400 });
        return json({ ok: true });
      } catch (e: any) {
        ctx.log.warn("external write failed", String(e && e.message));
        return json({ ok: false, error: String((e && e.message) || e) }, { status: e instanceof SourceError ? e.status : 502 });
      }
    }),

    health: endpoint({ method: "GET", path: "/api/health", mode: "read" }, async (ctx) => {
      const rows = await ctx.db.items.withIndex("by_creation").collect();
      let tasks = 0, series = 0;
      for (const r of rows) { if (r.kind === "task") tasks++; else if (r.kind === "series") series++; }
      return json({ ok: true, tasks, series });
    }),
  },
});
