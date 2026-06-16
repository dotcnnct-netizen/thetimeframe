import { getStore } from "@netlify/blobs";

const EMPTY = {
  last_seen: 0, last_ts: null, session: null,
  bias: {}, gate: {}, h1: {}, m15: {}, m5: {}, last_trade: {},
  stats: { trades: 0, executed: 0, failed: 0 },
  feed: [], seq: 0,
};

export default async () => {
  const store = getStore("tfe");
  let s = await store.get("state", { type: "json" });
  if (!s) s = { ...EMPTY };
  s.engine_online = s.last_seen ? (Date.now() - s.last_seen) < 120000 : false;
  return new Response(JSON.stringify(s), {
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    },
  });
};

export const config = { path: "/api/state" };
