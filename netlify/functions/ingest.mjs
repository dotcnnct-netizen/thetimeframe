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
  lastClosedTid: 0,         // highest closed trade id — blocks self-heal from resurrecting it
  seq: 0,
});

function act(s, level, text, ts) {
  s.activity.push({ level, text, ts: ts || null, recv: Date.now() });
  if (s.activity.length > ACT_MAX) s.activity = s.activity.slice(-ACT_MAX);
}

function openFrom(s, f) {
  s.tradeSeq += 1;
  return {
    id: s.tradeSeq,
    tid: f.tid || 0,
    dir: f.dir, entry: f.entry, sl: f.sl, tp: f.tp,
    rr: f.rr, risk: f.risk, reward: f.reward,
    opened_ts: f.ts || null, opened_date: f.date || s.bias.date || null,
    price: f.entry, price_ts: f.ts || null, updated: Date.now(),
  };
}

function apply(s, ev) {
  const k = ev.kind;
  s.last_seen = Date.now();
  if (s.lastClosedTid == null) s.lastClosedTid = 0;

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
    // Safety net: any non-trading state means the engine isn't tracking a trade.
    // Clear a stale trade (e.g. left over after Ctrl+C / restart) and block resurrection.
    if (ev.stage && ev.stage !== "in_trade" && s.open_trade) {
      s.lastClosedTid = Math.max(s.lastClosedTid || 0, s.open_trade.tid || 0);
      act(s, "info", `Live trade cleared (engine ${ev.stage})`, ev.ts);
      s.open_trade = null;
    }
  }
  else if (k === "pipeline") {
    s.pipeline = { h4: ev.h4 ?? null, h1: ev.h1 ?? null, m15: ev.m15 ?? null };
  }
  else if (k === "open") {
    s.open_trade = openFrom(s, ev);
    if (s.status) s.status.stage = "in_trade";
    act(s, "open", `Trade opened — ${ev.dir} @ ${ev.entry}`, ev.ts);
  }
  else if (k === "price") {
    // self-heal: rebuild the trade if 'open' was lost — but never resurrect a trade
    // whose id has already been closed (prevents a late price re-creating a phantom).
    if (!s.open_trade && ev.trade && (ev.trade.tid || 0) > (s.lastClosedTid || 0)) {
      s.open_trade = openFrom(s, ev.trade);
      if (s.status) s.status.stage = "in_trade";
      act(s, "open", `Trade opened — ${ev.trade.dir} @ ${ev.trade.entry}`, ev.trade.ts);
    }
    if (s.open_trade) {
      s.open_trade.price = ev.price;
      s.open_trade.price_ts = ev.ts || null;
      s.open_trade.updated = Date.now();
    }
  }
  else if (k === "update") {
    if (s.open_trade) {
      if (ev.sl != null) s.open_trade.sl = ev.sl;
      if (ev.tp != null) s.open_trade.tp = ev.tp;
      s.open_trade.updated = Date.now();
      if (ev.sl != null) act(s, "info", `SL trailed to ${ev.sl}`, ev.ts);
    }
  }
  else if (k === "close") {
    if (s.open_trade) {
      const t = s.open_trade;
      const isSell = String(t.dir || "").toUpperCase().startsWith("S");
      const pnl = isSell ? (t.entry - ev.exit) : (ev.exit - t.entry);
      const pnlR = Math.round(pnl * 100) / 100;
      // win/loss reflects real P/L — a stop trailed into profit still counts as a win
      const result = pnlR > 0 ? "WIN" : (pnlR < 0 ? "LOSS" : "BE");
      const rec = {
        ...t,
        closed_ts: ev.ts || null,
        outcome: ev.outcome,           // "TP" | "SL" | "MANUAL"
        exit: ev.exit,
        pnl_points: pnlR,
        result,
      };
      s.trades.push(rec);
      if (s.trades.length > HIST_MAX) s.trades = s.trades.slice(-HIST_MAX);
      s.stats.total += 1;
      if (result === "WIN") s.stats.wins += 1;
      else if (result === "LOSS") s.stats.losses += 1;
      s.lastClosedTid = Math.max(s.lastClosedTid || 0, t.tid || ev.tid || 0);
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
