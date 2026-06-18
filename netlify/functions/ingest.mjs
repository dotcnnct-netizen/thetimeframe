import { getStore } from "@netlify/blobs";

const HIST_MAX = 300;
const ACT_MAX = 40;

const EMPTY = () => ({
  last_seen: 0,
  engine_started: null,
  bias: {},                 // {label, date}
  status: {},               // {stage, session, trades_today, max_trades, ts}
  pipeline: {},             // {h4, h1:{state,score,rr}, m15}
  open_trade: null,         // live trade being tracked
  trades: [],               // closed trade history
  stats: { total: 0, wins: 0, losses: 0 },
  activity: [],             // human-readable client-facing events
  tradeSeq: 0,
  seq: 0,
});

function act(s, level, text, ts) {
  s.activity.push({ level, text, ts: ts || null, recv: Date.now() });
  if (s.activity.length > ACT_MAX) s.activity = s.activity.slice(-ACT_MAX);
}

function apply(s, ev) {
  const k = ev.kind;
  s.last_seen = Date.now();

  if (k === "bias") {
    s.bias = { label: ev.label, date: ev.date || s.bias.date || null };
    if (ev.label && ev.label !== "NO_TRADE_DAY")
      act(s, "info", `Daily bias: ${String(ev.label).replace(/_/g, " ")}`, ev.ts);
  }
  else if (k === "status") {
    s.status = {
      stage: ev.stage,
      session: ev.session ?? s.status.session ?? null,
      trades_today: ev.trades_today ?? s.status.trades_today ?? 0,
      max_trades: ev.max_trades ?? s.status.max_trades ?? null,
      ts: ev.ts || null,
    };
    if (ev.stage === "starting") s.engine_started = Date.now();
  }
  else if (k === "pipeline") {
    s.pipeline = { h4: ev.h4 ?? null, h1: ev.h1 ?? null, m15: ev.m15 ?? null };
  }
  else if (k === "open") {
    s.tradeSeq += 1;
    s.open_trade = {
      id: s.tradeSeq,
      dir: ev.dir, entry: ev.entry, sl: ev.sl, tp: ev.tp,
      rr: ev.rr, risk: ev.risk, reward: ev.reward,
      opened_ts: ev.ts || null, opened_date: ev.date || s.bias.date || null,
      price: ev.entry, price_ts: ev.ts || null, updated: Date.now(),
    };
    if (s.status) s.status.stage = "in_trade";
    act(s, "open", `Trade opened — ${ev.dir} @ ${ev.entry}`, ev.ts);
  }
  else if (k === "price") {
    if (s.open_trade) {
      s.open_trade.price = ev.price;
      s.open_trade.price_ts = ev.ts || null;
      s.open_trade.updated = Date.now();
    }
  }
  else if (k === "close") {
    if (s.open_trade) {
      const t = s.open_trade;
      const isSell = String(t.dir || "").toUpperCase().startsWith("S");
      const pnl = isSell ? (t.entry - ev.exit) : (ev.exit - t.entry);
      const result = ev.outcome === "TP" ? "WIN" : (ev.outcome === "SL" ? "LOSS" : (pnl >= 0 ? "WIN" : "LOSS"));
      const rec = {
        ...t,
        closed_ts: ev.ts || null,
        outcome: ev.outcome,           // "TP" | "SL" | "MANUAL"
        exit: ev.exit,
        pnl_points: Math.round(pnl * 100) / 100,
        result,
      };
      s.trades.push(rec);
      if (s.trades.length > HIST_MAX) s.trades = s.trades.slice(-HIST_MAX);
      s.stats.total += 1;
      if (result === "WIN") s.stats.wins += 1; else s.stats.losses += 1;
      s.open_trade = null;
      if (s.status) s.status.stage = "scanning";
      const sign = rec.pnl_points >= 0 ? "+" : "";
      act(s, result === "WIN" ? "win" : "loss",
        `${ev.outcome} hit — ${t.dir} closed @ ${ev.exit} (${sign}${rec.pnl_points} pts)`, ev.ts);
    }
  }
  s.seq += 1;
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
  // make sure older stored states gain new fields
  s = { ...EMPTY(), ...s, stats: { ...EMPTY().stats, ...(s.stats || {}) } };

  for (const ev of events) if (ev && typeof ev === "object" && ev.kind) apply(s, ev);

  await store.setJSON("state", s);
  return new Response(JSON.stringify({ ok: true, count: events.length, seq: s.seq }),
    { headers: { "content-type": "application/json" } });
};

export const config = { path: "/api/ingest" };
