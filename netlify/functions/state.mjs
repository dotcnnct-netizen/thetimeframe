import { getStore } from "@netlify/blobs";

const ONLINE_WINDOW = 45000;   // a viewer counts as online if seen in last 45s
const ENGINE_WINDOW = 1200000; // engine "live" if it pushed in last 20 min

const EMPTY = {
  last_seen: 0, engine_started: null,
  bias: {}, status: {}, pipeline: {}, open_trade: null,
  trades: [], stats: { total: 0, wins: 0, losses: 0 },
  activity: [], tradeSeq: 0, seq: 0,
};

export default async (req) => {
  const store = getStore("tfe");
  const url = new URL(req.url);
  const cid = url.searchParams.get("cid");

  let s = await store.get("state", { type: "json" });
  if (!s) s = { ...EMPTY };

  // presence folded into the same poll (no separate function = fewer calls)
  let online = 1;
  try {
    let p = (await store.get("presence", { type: "json" })) || {};
    const now = Date.now();
    if (cid) p[cid] = now;
    for (const k in p) if (now - p[k] > ONLINE_WINDOW) delete p[k];
    online = Object.keys(p).length || (cid ? 1 : 0);
    if (cid) await store.setJSON("presence", p);
  } catch (_) { /* presence is best-effort */ }

  const out = {
    ...EMPTY, ...s,
    online,
    engine_online: s.last_seen ? (Date.now() - s.last_seen) < ENGINE_WINDOW : false,
  };
  return new Response(JSON.stringify(out), {
    headers: { "content-type": "application/json", "cache-control": "no-store",
      "access-control-allow-origin": "*" },
  });
};

export const config = { path: "/api/state" };
