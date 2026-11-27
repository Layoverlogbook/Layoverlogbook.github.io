// Layover Logbook: MCP server (Pro + AI).
// Lets an AI assistant (Claude, ChatGPT, Cursor, ...) read a crew member's layovers and spending,
// and add expenses or wishlist items, using a personal key made in the app
// (Notebook > Connect your AI). Speaks the Model Context Protocol over plain HTTP (JSON-RPC).
//
// Deployed as the Edge Function `mcp` with JWT verification off: it checks the personal key itself.
// The key can be sent as   Authorization: Bearer llb_...   or in the address as   ?key=llb_...
// Uses SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, which Supabase provides to every function.

const SB = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER = { name: "layover-logbook", title: "Layover Logbook", version: "1.0.0" };
const CATS = ["Food", "Transport", "Shopping", "Activities", "Beauty & health", "Other"];

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, mcp-protocol-version, mcp-session-id",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};
const send = (o: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(o === null ? null : JSON.stringify(o), {
    status, headers: { ...cors, ...(o === null ? {} : { "Content-Type": "application/json" }), ...extra },
  });

// ---------- database helpers (service role) ----------
async function rest(path: string, init: RequestInit = {}) {
  return await fetch(`${SB}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}
async function rpc(fn: string, args: unknown) {
  const r = await rest(`rpc/${fn}`, { method: "POST", body: JSON.stringify(args) });
  if (!r.ok) throw new Error(`${fn} ${r.status}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}
async function sha256(s: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
async function loadData(uid: string): Promise<any> {
  const r = await rest(`user_data?select=data&user_id=eq.${uid}`);
  if (!r.ok) throw new Error("load " + r.status);
  const rows = await r.json();
  return rows[0]?.data ?? {};
}

// ---------- time and money helpers (same rules as the app) ----------
const HOME_DEFAULT = { code: "DOH", name: "Doha", cc: "QA", tz: "Asia/Qatar", cur: "QAR" };
const home = (d: any) => ({ ...HOME_DEFAULT, ...(d.home ?? {}) });
function offH(tz: string, at: Date) {
  try {
    const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
      .formatToParts(at).reduce((a: any, x) => (a[x.type] = x.value, a), {});
    return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - Math.floor(at.getTime() / 6e4) * 6e4) / 36e5;
  } catch { return 0; }
}
function local(ms: number, tz: string) {
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms));
  } catch { return new Date(ms).toISOString(); }
}
const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;
function toHome(d: any, cur: string, amt: number): number | null {
  const H = home(d).cur;
  if (cur === H) return amt;
  const R = d.rates?.rates;
  const rate = (c: string) => c === "QAR" ? 1 : R && R[c] ? R[c] : c === "USD" ? 1 / 3.64 : null;
  const a = rate(cur), b = rate(H);
  return a && b ? amt / a * b : null;
}
const homeAmt = (d: any, t: any) => t.qar != null ? t.qar : toHome(d, t.cur, t.amt);
const realTrips = (d: any) => (Array.isArray(d.trips) ? d.trips : []).filter((t: any) => !t.ex && t.arrUTC && t.pickUTC);
const realTx = (d: any) => (Array.isArray(d.tx) ? d.tx : []).filter((t: any) => !t.ex);
const txKey = (t: any) => t.code || `${t.dest}-${t.cc}`;

function planFor(d: any, tr: any) {
  const H = home(d), plan = d.plan ?? {};
  const xfer = Number(plan.xfer ?? 1), ready = Number(plan.ready ?? 1.5), rest = Number(tr.rest ?? plan.rest ?? 10);
  const ground = (tr.pickUTC - tr.arrUTC) / 36e5;
  const free = Math.max(0, ground - xfer - rest - ready);
  const freeStart = tr.arrUTC + (xfer + rest) * 36e5, freeEnd = freeStart + free * 36e5;
  const now = Date.now();
  const a = new Date(tr.arrUTC).toISOString().slice(0, 10), b = new Date(tr.pickUTC).toISOString().slice(0, 10);
  const spent = realTx(d).filter((t: any) => t.type === "spend" && txKey(t) === tr.key && t.date >= a && t.date <= b)
    .reduce((s: number, t: any) => s + (homeAmt(d, t) || 0), 0);
  return {
    id: tr.id, city: tr.dest, code: tr.code || null, country: tr.cc || null, timezone: tr.tz,
    status: now < tr.arrUTC ? "upcoming" : now <= tr.pickUTC ? "on layover now" : "past",
    arrival_local: local(tr.arrUTC, tr.tz), pickup_local: local(tr.pickUTC, tr.tz),
    arrival_home_time: local(tr.arrUTC, H.tz),
    hours_on_ground: r1(ground),
    time_vs_home_hours: r1(offH(tr.tz, new Date(tr.arrUTC)) - offH(H.tz, new Date(tr.arrUTC))),
    settings_hours: { hotel_transfer: xfer, minimum_rest: rest, getting_ready: ready },
    free_time_hours: r1(free),
    free_window_local: free > 0 ? `${local(freeStart, tr.tz)} to ${local(freeEnd, tr.tz)}` : "no free time after rest",
    local_time_now: local(now, tr.tz),
    duty_hours_before: tr.duty || 0,
    allowance: tr.allow ? `${tr.allow} ${tr.allowCur}` : null,
    spent_on_this_layover: `${r2(spent)} ${H.cur}`,
  };
}

function inPeriod(period: string) {
  const n = new Date(), y = n.getUTCFullYear(), m = n.getUTCMonth();
  const iso = (dt: Date) => dt.toISOString().slice(0, 10);
  switch (period) {
    case "last_month": return [iso(new Date(Date.UTC(y, m - 1, 1))), iso(new Date(Date.UTC(y, m, 0)))];
    case "last_30_days": return [iso(new Date(Date.now() - 30 * 864e5)), iso(n)];
    case "this_year": return [`${y}-01-01`, iso(n)];
    case "all": return ["0000-01-01", "9999-12-31"];
    default: return [iso(new Date(Date.UTC(y, m, 1))), iso(n)];
  }
}

// ---------- tools ----------
const TOOLS = [
  {
    name: "get_overview",
    title: "Overview",
    description: "Start here. The crew member's home base and currency, the city they have open in the app, their next or current layover, and what they spent this month.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "list_layovers",
    title: "List layovers",
    description: "Saved layovers with city, arrival and pickup in local time, hours on the ground and free time.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        when: { type: "string", enum: ["upcoming", "past", "all"], default: "upcoming" },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "get_layover_plan",
    title: "Layover plan",
    description: "Full plan for one layover: arrival, pickup, rest, the free-time window in local time, the time difference from home, allowance and spending. Leave layover_id empty for the current or next layover.",
    inputSchema: { type: "object", additionalProperties: false, properties: { layover_id: { type: "string" } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: "spending_summary",
    title: "Spending summary",
    description: "Spending totals in the home currency, grouped by category or by city, with allowance added in the same period.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        period: { type: "string", enum: ["this_month", "last_month", "last_30_days", "this_year", "all"], default: "this_month" },
        group_by: { type: "string", enum: ["category", "city"], default: "category" },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "list_expenses",
    title: "List expenses",
    description: "The most recent expenses and money added, newest first. Optionally only one city (airport code).",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        city_code: { type: "string", description: "3-letter airport code, e.g. LHR" },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "add_expense",
    title: "Add an expense",
    description: "Log something the crew member spent. It appears in the Money tab on every phone signed in to the account. Uses the city open in the app unless city_code names a saved layover city. Paying cash here does not change the cash wallet balance in the app.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["amount", "currency", "category"],
      properties: {
        amount: { type: "number", exclusiveMinimum: 0, maximum: 1000000 },
        currency: { type: "string", description: "3-letter currency code, e.g. GBP", pattern: "^[A-Za-z]{3}$" },
        category: { type: "string", enum: CATS },
        note: { type: "string", maxLength: 80 },
        date: { type: "string", description: "YYYY-MM-DD, default today", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
        city_code: { type: "string" },
        paid_by: { type: "string", enum: ["card", "cash"], default: "card" },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "get_city_notes",
    title: "City notes",
    description: "The crew member's own tips and wishlist (things to buy or do) for a city.",
    inputSchema: { type: "object", additionalProperties: false, required: ["city_code"], properties: { city_code: { type: "string" } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: "add_wishlist_item",
    title: "Add to wishlist",
    description: "Add something to buy or do on a future layover in a city, e.g. 'Macarons for home' in CDG.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["city_code", "item"],
      properties: { city_code: { type: "string" }, item: { type: "string", minLength: 1, maxLength: 80 } },
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
];

const code3 = (s: unknown) => String(s ?? "").trim().toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 12);
const text = (o: unknown) => ({ content: [{ type: "text", text: typeof o === "string" ? o : JSON.stringify(o, null, 1) }], structuredContent: typeof o === "string" ? undefined : o });
const fail = (msg: string) => ({ content: [{ type: "text", text: msg }], isError: true });

async function callTool(uid: string, name: string, a: any) {
  a = a ?? {};
  const d = await loadData(uid);
  const H = home(d), now = Date.now();
  const trips = realTrips(d).sort((x: any, y: any) => x.arrUTC - y.arrUTC);
  const nextTrip = trips.find((t: any) => t.pickUTC >= now);

  switch (name) {
    case "get_overview": {
      const [f, t] = inPeriod("this_month");
      const spent = realTx(d).filter((x: any) => x.type === "spend" && x.date >= f && x.date <= t).reduce((s: number, x: any) => s + (homeAmt(d, x) || 0), 0);
      return text({
        home_base: `${H.name} (${H.code})`, home_currency: H.cur, home_time_now: local(now, H.tz),
        city_open_in_app: d.dest ? `${d.dest.name}${d.dest.code ? " (" + d.dest.code + ")" : ""}` : null,
        next_or_current_layover: nextTrip ? planFor(d, nextTrip) : null,
        saved_layovers: trips.length, spent_this_month: `${r2(spent)} ${H.cur}`,
      });
    }
    case "list_layovers": {
      const when = a.when ?? "upcoming", lim = Math.min(50, Math.max(1, a.limit ?? 10));
      let list = when === "past" ? trips.filter((t: any) => t.pickUTC < now).reverse() : when === "all" ? trips.slice().reverse() : trips.filter((t: any) => t.pickUTC >= now);
      list = list.slice(0, lim);
      if (!list.length) return text(`No ${when === "all" ? "" : when + " "}layovers saved. They are added in the app on the Today tab with Save a layover.`);
      return text({ layovers: list.map((t: any) => { const p = planFor(d, t); return { id: p.id, city: p.city, code: p.code, status: p.status, arrival_local: p.arrival_local, pickup_local: p.pickup_local, hours_on_ground: p.hours_on_ground, free_time_hours: p.free_time_hours }; }) });
    }
    case "get_layover_plan": {
      const tr = a.layover_id ? trips.find((t: any) => t.id === a.layover_id) : nextTrip;
      if (!tr) return fail(a.layover_id ? "No layover with that id. Use list_layovers to see the ids." : "No current or upcoming layover saved.");
      return text(planFor(d, tr));
    }
    case "spending_summary": {
      const [f, t] = inPeriod(a.period ?? "this_month"), by = a.group_by === "city" ? "city" : "category";
      const tx = realTx(d).filter((x: any) => x.date >= f && x.date <= t);
      const groups: Record<string, number> = {}; let total = 0, added = 0, unconverted = 0;
      for (const x of tx) {
        const v = homeAmt(d, x);
        if (v == null) { unconverted++; continue; }
        if (x.type === "add") { added += v; continue; }
        if (x.type !== "spend") continue;
        const k = by === "city" ? (x.dest || "Unknown") : (x.cat || "Other");
        groups[k] = (groups[k] || 0) + v; total += v;
      }
      const allowance = realTrips(d).filter((x: any) => { const s = new Date(x.arrUTC).toISOString().slice(0, 10); return s >= f && s <= t; })
        .reduce((s: number, x: any) => s + (x.allowQAR ?? 0), 0);
      return text({
        period: a.period ?? "this_month", from: f, to: t > new Date().toISOString().slice(0, 10) ? "today" : t, currency: H.cur,
        total_spent: r2(total), by: Object.fromEntries(Object.entries(groups).sort((p, q) => q[1] - p[1]).map(([k, v]) => [k, r2(v)])),
        allowance_from_layovers: r2(allowance), money_added_to_wallet: r2(added),
        kept: r2(allowance - total),
        ...(unconverted ? { note: `${unconverted} entries have no exchange rate yet and are left out. Opening the app fixes this.` } : {}),
      });
    }
    case "list_expenses": {
      const c = a.city_code ? code3(a.city_code) : "", lim = Math.min(100, Math.max(1, a.limit ?? 20));
      const list = realTx(d).filter((x: any) => !c || x.code === c).sort((x: any, y: any) => String(y.date).localeCompare(String(x.date))).slice(0, lim);
      return text({ currency_home: H.cur, entries: list.map((x: any) => ({ date: x.date, type: x.type === "add" ? "money added" : "spent", amount: `${x.amt} ${x.cur}`, in_home_currency: homeAmt(d, x) == null ? null : r2(homeAmt(d, x)!), category: x.cat || null, city: x.dest || null, paid_by: x.pay, note: x.note || null })) });
    }
    case "add_expense": {
      const amt = Number(a.amount), cur = String(a.currency ?? "").toUpperCase();
      if (!(amt > 0 && amt <= 1e6)) return fail("The amount must be more than 0.");
      if (!/^[A-Z]{3}$/.test(cur)) return fail("Use a 3-letter currency code, e.g. GBP.");
      if (!CATS.includes(a.category)) return fail("Category must be one of: " + CATS.join(", "));
      const today = new Date(now + offH(H.tz, new Date()) * 36e5).toISOString().slice(0, 10);
      const date = a.date ?? today;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > new Date(now + 864e5).toISOString().slice(0, 10)) return fail("The date must be YYYY-MM-DD and not in the future.");
      let city: any = d.dest ?? null;
      if (a.city_code) {
        const c = code3(a.city_code);
        const t = trips.slice().reverse().find((x: any) => x.code === c);
        city = t ? { name: t.dest, code: t.code, cc: t.cc } : d.dest?.code === c ? d.dest : null;
        if (!city) return fail(`${c} isn't a saved layover city. Save the layover in the app first, or leave city_code empty to use the city open in the app.`);
      }
      const q = toHome(d, cur, amt);
      const item = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7), date, type: "spend", cur, amt: r2(amt),
        cat: a.category, pay: a.paid_by === "cash" ? "cash" : "card", note: String(a.note ?? "").trim().slice(0, 80),
        dest: city?.name ?? "", code: city?.code ?? "", cc: city?.cc ?? "", qar: q == null ? null : r2(q), via: "ai", at: Date.now(),
      };
      await rpc("ai_tx_add", { p_uid: uid, p_item: item });
      return text(`Saved: ${item.amt} ${cur} on ${item.cat.toLowerCase()}${item.dest ? " in " + item.dest : ""} (${date})${q != null ? `, about ${r2(q)} ${H.cur}` : ""}. It shows in the Money tab next time the app opens.`);
    }
    case "get_city_notes": {
      const c = code3(a.city_code);
      const tips = (d.tips?.[c] ?? []).filter((x: any) => !x.ex).map((x: any) => ({ tip: x.t, category: x.c }));
      const wish = (d.wish?.[c] ?? []).filter((x: any) => !x.ex).map((x: any) => ({ item: x.t, done: !!x.d }));
      if (!tips.length && !wish.length) return text(`No notes or wishlist saved for ${c} yet.`);
      return text({ city: c, tips, wishlist: wish });
    }
    case "add_wishlist_item": {
      const c = code3(a.city_code), item = String(a.item ?? "").trim().slice(0, 80);
      if (!/^[A-Z]{3}$/.test(c)) return fail("Use the city's 3-letter airport code, e.g. CDG.");
      if (!item) return fail("Say what to add.");
      await rpc("ai_wish_add", { p_uid: uid, p_code: c, p_item: { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7), t: item, d: false, via: "ai", at: Date.now() } });
      return text(`Added "${item}" to your ${c} wishlist.`);
    }
  }
  return fail("Unknown tool: " + name);
}

// ---------- MCP over HTTP ----------
const err = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

async function handle(msg: any, uid: string) {
  const { id, method, params } = msg ?? {};
  if (id === undefined || id === null) return null; // notifications need no answer
  switch (method) {
    case "initialize": {
      const v = VERSIONS.includes(params?.protocolVersion) ? params.protocolVersion : VERSIONS[1];
      return {
        jsonrpc: "2.0", id, result: {
          protocolVersion: v, serverInfo: SERVER, capabilities: { tools: { listChanged: false } },
          instructions: "Layover Logbook is a planning app for airline cabin crew. Use get_overview first. Times are given in the layover city's local time unless marked as home time. Fatigue and rest figures are a planning guide only; the crew member's airline rules come first.",
        },
      };
    }
    case "ping": return { jsonrpc: "2.0", id, result: {} };
    case "tools/list": return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
    case "tools/call": {
      if (!TOOLS.some((t) => t.name === params?.name)) return err(id, -32602, "Unknown tool");
      try { return { jsonrpc: "2.0", id, result: await callTool(uid, params.name, params.arguments) }; }
      catch (e) { console.warn("tool", params?.name, String(e)); return { jsonrpc: "2.0", id, result: fail("Layover Logbook couldn't do that right now. Try again in a minute.") }; }
    }
    case "resources/list": return { jsonrpc: "2.0", id, result: { resources: [] } };
    case "prompts/list": return { jsonrpc: "2.0", id, result: { prompts: [] } };
    default: return err(id, -32601, "Method not found");
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method === "GET") return send({ error: "This MCP server answers POST requests only." }, 405, { Allow: "POST" });
  if (req.method === "DELETE") return send(null, 405);
  if (req.method !== "POST") return send(err(null, -32600, "POST only"), 405);

  const url = new URL(req.url);
  const auth = req.headers.get("authorization") ?? "";
  const token = (auth.match(/^Bearer\s+(llb_[A-Za-z0-9_-]{20,80})$/)?.[1]) ?? (url.searchParams.get("key") ?? "");
  if (!/^llb_[A-Za-z0-9_-]{20,80}$/.test(token)) {
    return send(err(null, -32001, "Add your Layover Logbook AI key. Make one in the app: Notebook > Connect your AI."), 401);
  }
  let who: any;
  try { who = await rpc("ai_resolve", { p_hash: await sha256(token) }); }
  catch (e) { console.warn("resolve", String(e)); return send(err(null, -32603, "Server busy, try again."), 503); }
  if (!who) return send(err(null, -32001, "This AI key isn't valid. It may have been removed in the app."), 401);
  if (!who.pro) return send(err(null, -32002, "Connecting an AI assistant is part of Layover Logbook Pro."), 402);
  if (who.limited) return send(err(null, -32003, "Too many requests. Wait a minute."), 429, { "Retry-After": "60" });

  let body: any;
  try { body = await req.json(); } catch { return send(err(null, -32700, "Parse error"), 400); }
  if (Array.isArray(body)) {
    if (body.length > 20) return send(err(null, -32600, "Batch too large"), 400);
    const out = (await Promise.all(body.map((m) => handle(m, who.uid)))).filter(Boolean);
    return out.length ? send(out) : send(null, 202);
  }
  const out = await handle(body, who.uid);
  return out ? send(out) : send(null, 202);
});
