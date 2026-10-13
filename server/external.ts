// Linear and HubSpot: read open items assigned to Jason, and write back "done" and due-date changes.
// Keys come from server-only secret variables: LINEAR_API_KEY and HUBSPOT_TOKEN.
// Nothing here touches the database; synced items are fetched live each time the board loads or syncs.

const LINEAR_URL = "https://api.linear.app/graphql";
const HUBSPOT_URL = "https://api.hubapi.com";
const DEFAULT_HUBSPOT_OWNER_ID = "1066649882"; // Jason Clarke
const DEFAULT_HUBSPOT_PORTAL_ID = "48441489"; // Newspack HubSpot account

type Env = Record<string, string | undefined>;

export type ExternalItem = {
  id: string; // "lin:<uuid>" or "hub:<id>"
  source: "linear" | "hubspot";
  extId: string;
  title: string;
  ctx: string; // Linear project, or HubSpot deal / company / contact
  body: string;
  url: string;
  due?: string | null; // Linear: YYYY-MM-DD
  ts?: string | null; // HubSpot: ISO timestamp; the browser turns it into a local date and time
  doneStateId?: string | null; // Linear: the team's first "completed" state
  key?: string; // Linear: NEWS-123
};

export class SourceError extends Error {
  status: number;
  constructor(message: string, status = 502) { super(message); this.status = status; }
}

function clip(s: unknown, n: number): string {
  const t = typeof s === "string" ? s : "";
  return t.length > n ? t.slice(0, n) + "…" : t;
}
function stripHtml(s: unknown): string {
  return String(s || "")
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li)>/gi, "\n").replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n").trim();
}

// ---------- Linear ----------
async function linear(env: Env, query: string, variables: Record<string, unknown> = {}) {
  const key = env.LINEAR_API_KEY;
  if (!key) throw new SourceError("LINEAR_API_KEY is not set.", 412);
  const res = await fetch(LINEAR_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: key },
    body: JSON.stringify({ query, variables }),
  });
  let out: any = null;
  try { out = await res.json(); } catch (e) { /* fall through */ }
  if (!res.ok || !out || out.errors) {
    const msg = out && out.errors && out.errors[0] && out.errors[0].message;
    throw new SourceError("Linear: " + (msg || "answered " + res.status), res.status === 401 ? 401 : 502);
  }
  return out.data;
}

const LINEAR_READ = `query {
  viewer {
    teams(first: 50) { nodes { id states(filter: { type: { eq: "completed" } }) { nodes { id position } } } }
    assignedIssues(first: 150, filter: { state: { type: { nin: ["completed", "canceled"] } } }) {
      nodes { id identifier title description url dueDate project { name } team { id } }
    }
  }
}`;

export async function readLinear(env: Env): Promise<ExternalItem[]> {
  const data = await linear(env, LINEAR_READ);
  const doneByTeam: Record<string, string> = {};
  for (const t of data.viewer.teams.nodes) {
    const states = (t.states.nodes || []).slice().sort((a: any, b: any) => a.position - b.position);
    if (states[0]) doneByTeam[t.id] = states[0].id;
  }
  return data.viewer.assignedIssues.nodes.map((i: any) => ({
    id: "lin:" + i.id,
    source: "linear",
    extId: i.id,
    key: i.identifier,
    title: i.title,
    ctx: (i.project && i.project.name) || "",
    body: clip(i.description, 4000),
    url: i.url,
    due: i.dueDate || null,
    doneStateId: (i.team && doneByTeam[i.team.id]) || null,
  }));
}

export async function writeLinear(env: Env, op: any) {
  const input: Record<string, unknown> = {};
  if (op.action === "done") {
    if (!op.doneStateId) throw new SourceError("No Done state for this issue's team.", 400);
    input.stateId = op.doneStateId;
  } else if (op.action === "due") {
    if (op.due !== null && !/^\d{4}-\d{2}-\d{2}$/.test(String(op.due))) throw new SourceError("Bad date.", 400);
    input.dueDate = op.due;
  } else throw new SourceError("Unknown action.", 400);
  const data = await linear(env,
    "mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
    { id: op.extId, input });
  if (!data.issueUpdate || !data.issueUpdate.success) throw new SourceError("Linear did not accept the change.");
}

// ---------- HubSpot ----------
async function hubspot(env: Env, path: string, init: { method?: string; body?: unknown } = {}) {
  const token = env.HUBSPOT_TOKEN;
  if (!token) throw new SourceError("HUBSPOT_TOKEN is not set.", 412);
  const res = await fetch(HUBSPOT_URL + path, {
    method: init.method || "GET",
    headers: { "content-type": "application/json", authorization: "Bearer " + token },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  let out: any = null;
  try { out = await res.json(); } catch (e) { /* empty body */ }
  if (!res.ok) {
    const msg = out && (out.message || (out.errors && out.errors[0] && out.errors[0].message));
    throw new SourceError("HubSpot: " + (msg || "answered " + res.status), res.status === 401 || res.status === 403 ? res.status : 502);
  }
  return out;
}

// Task id -> first associated record id, for one object type.
async function firstAssociation(env: Env, toType: string, ids: string[]): Promise<Record<string, string>> {
  if (!ids.length) return {};
  const out = await hubspot(env, `/crm/v4/associations/tasks/${toType}/batch/read`, {
    method: "POST", body: { inputs: ids.map((id) => ({ id })) },
  });
  const map: Record<string, string> = {};
  for (const r of out.results || []) {
    const to = r.to && r.to[0];
    if (to) map[String(r.from.id)] = String(to.toObjectId);
  }
  return map;
}
async function names(env: Env, type: string, ids: string[], props: string[]): Promise<Record<string, any>> {
  const uniq = Array.from(new Set(ids));
  if (!uniq.length) return {};
  const out = await hubspot(env, `/crm/v3/objects/${type}/batch/read`, {
    method: "POST", body: { properties: props, inputs: uniq.map((id) => ({ id })) },
  });
  const map: Record<string, any> = {};
  for (const r of out.results || []) map[String(r.id)] = r.properties || {};
  return map;
}

export async function readHubspot(env: Env): Promise<ExternalItem[]> {
  const owner = env.HUBSPOT_OWNER_ID || DEFAULT_HUBSPOT_OWNER_ID;
  const portal = env.HUBSPOT_PORTAL_ID || DEFAULT_HUBSPOT_PORTAL_ID;
  const search = await hubspot(env, "/crm/v3/objects/tasks/search", {
    method: "POST",
    body: {
      filterGroups: [{ filters: [
        { propertyName: "hubspot_owner_id", operator: "EQ", value: owner },
        { propertyName: "hs_task_status", operator: "NEQ", value: "COMPLETED" },
      ] }],
      properties: ["hs_task_subject", "hs_timestamp", "hs_task_status", "hs_task_body"],
      sorts: [{ propertyName: "hs_timestamp", direction: "ASCENDING" }],
      limit: 100,
    },
  });
  const tasks = search.results || [];
  const ids = tasks.map((t: any) => String(t.id));
  const [toDeal, toCompany, toContact] = await Promise.all([
    firstAssociation(env, "deals", ids),
    firstAssociation(env, "companies", ids),
    firstAssociation(env, "contacts", ids),
  ]);
  const [deals, companies, contacts] = await Promise.all([
    names(env, "deals", Object.values(toDeal), ["dealname"]),
    names(env, "companies", Object.values(toCompany), ["name"]),
    names(env, "contacts", Object.values(toContact), ["firstname", "lastname", "email"]),
  ]);
  return tasks.map((t: any) => {
    const id = String(t.id); const p = t.properties || {};
    let ctx = ""; let url = `https://app.hubspot.com/tasks/${portal}/view/all`;
    const d = toDeal[id], c = toCompany[id], k = toContact[id];
    if (d && deals[d]) { ctx = deals[d].dealname || ""; url = `https://app.hubspot.com/contacts/${portal}/record/0-3/${d}`; }
    else if (c && companies[c]) { ctx = companies[c].name || ""; url = `https://app.hubspot.com/contacts/${portal}/record/0-2/${c}`; }
    else if (k && contacts[k]) {
      const x = contacts[k]; ctx = [x.firstname, x.lastname].filter(Boolean).join(" ") || x.email || "";
      url = `https://app.hubspot.com/contacts/${portal}/record/0-1/${k}`;
    }
    return {
      id: "hub:" + id, source: "hubspot", extId: id,
      title: p.hs_task_subject || "(untitled task)",
      ctx, body: clip(stripHtml(p.hs_task_body), 4000), url,
      ts: p.hs_timestamp || null,
    } as ExternalItem;
  });
}

export async function writeHubspot(env: Env, op: any) {
  const properties: Record<string, string> = {};
  if (op.action === "done") properties.hs_task_status = "COMPLETED";
  else if (op.action === "due") {
    if (!op.ts || isNaN(Date.parse(op.ts))) throw new SourceError("Bad date.", 400);
    properties.hs_timestamp = new Date(op.ts).toISOString();
  } else throw new SourceError("Unknown action.", 400);
  if (!/^\d+$/.test(String(op.extId))) throw new SourceError("Bad task id.", 400);
  await hubspot(env, "/crm/v3/objects/tasks/" + op.extId, { method: "PATCH", body: { properties } });
}
