import { getStore } from "@netlify/blobs";

const FEED_MAX = 200;

const EMPTY = () => ({
  last_seen: 0, last_ts: null, session: null,
  bias: {}, gate: {}, h1: {}, m15: {}, m5: {}, last_trade: {},
  stats: { trades: 0, executed: 0, failed: 0 },
  feed: [], seq: 0,
});

function apply(s, ev) {
  const t = ev.type, d = ev.data || {};
  s.last_seen = Date.now();
  if (ev.ts) s.last_ts = ev.ts;
  if (ev.session) s.session = ev.session;

  if (t === "bias" || t === "bias_detail") s.bias = { ...s.bias, ...d };
  else if (t === "gate") s.gate = d;
  else if (["h1_engage", "h1_latch", "h1_levels", "h1_risk"].includes(t)) {
    const c = { ...s.h1 };
    for (const k in d) if (d[k] !== null && d[k] !== undefined) c[k] = d[k];
    s.h1 = c;
  }
  else if (t === "m15") s.m15 = d;
  else if (t === "m5_exec") s.m5 = d;
  else if (t === "trade") { s.last_trade = d; s.stats.trades++; }
  else if (t === "order_ok") s.stats.executed++;
  else if (t === "order_fail") s.stats.failed++;

  s.seq++;
  ev.seq = s.seq;
  ev.recv = Date.now();
  s.feed.push(ev);
  if (s.feed.length > FEED_MAX) s.feed = s.feed.slice(-FEED_MAX);
}

export default async (req) => {
  if (req.method !== "POST")
    return new Response(JSON.stringify({ error: "method" }), { status: 405 });

  if (req.headers.get("x-token") !== process.env.INGEST_TOKEN)
    return new Response(JSON.stringify({ error: "bad token" }),
      { status: 401, headers: { "content-type": "application/json" } });

  let payload;
  try { payload = await req.json(); }
  catch { return new Response(JSON.stringify({ error: "bad json" }), { status: 400 }); }

  const events = Array.isArray(payload) ? payload : [payload];
  const store = getStore("tfe");
  let s = await store.get("state", { type: "json" });
  if (!s) s = EMPTY();

  for (const ev of events)
    if (ev && typeof ev === "object") apply(s, ev);

  await store.setJSON("state", s);
  return new Response(JSON.stringify({ ok: true, count: events.length, seq: s.seq }),
    { headers: { "content-type": "application/json" } });
};

export const config = { path: "/api/ingest" };
