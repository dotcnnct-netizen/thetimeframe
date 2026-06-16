# The Timeframe Engine — Live Terminal (Netlify edition)

A market-terminal dashboard for your engine: live candlestick backdrop, a scrolling signal
ticker, and the D1→H4→H1→M15→M5→ORDER cascade lighting up with energy pulses as each gate fires.

Everything runs on **Netlify** under your domain **thetimeframeengine.in** — the website *and*
the live data endpoint (a tiny Netlify Function + Netlify Blobs storage). Netlify can't run a
always-on Python server, so the backend was rebuilt as serverless functions; you don't have to
think about that, just deploy the folder.

```
[Your PC]                                  [Netlify — thetimeframeengine.in]
 run_live.py                                /                 -> the website
   │ prints                                 /api/ingest       -> stores each signal (Blobs)
   ▼                                        /api/state        -> dashboard polls this ~1/sec
 bridge.py ── POST /api/ingest (token) ──▶
```

## What goes where
- **`pc-engine-files/`**  → copy `bridge.py` + `parser.py` into your engine folder
  `C:\Users\psain\OneDrive\Desktop\THE TIMEFRAME ENGINE V2\`. You run `python bridge.py`.
- **`website-netlify/`**  → this whole folder is the website you deploy to Netlify.
- **`optional-python-server/`** → ignore unless you ever want the all-in-one server instead of Netlify.

---

## PART A — Put the website live on Netlify

The website uses a Netlify Function that needs one npm package installed, so use the
**Git import** method (Netlify installs it for you in the cloud). No coding tools needed locally.

### A1. Create a GitHub repo with the website files
1. Make a free account at github.com.
2. Click **New repository** → name it `tfe-dashboard` → **Create**.
3. On the new repo page click **uploading an existing file**, then drag in everything from the
   `website-netlify/` folder, keeping the folders:
   ```
   netlify.toml
   package.json
   public/index.html
   netlify/functions/ingest.mjs
   netlify/functions/state.mjs
   ```
   Commit the upload.

### A2. Deploy on Netlify
1. Make a free account at netlify.com (sign in with GitHub is easiest).
2. **Add new site → Import an existing project → GitHub →** pick `tfe-dashboard`.
3. Leave build settings as detected (publish dir `public`, functions `netlify/functions`). **Deploy.**
4. When it finishes you get a URL like `https://random-name-123.netlify.app`. Open it — the
   dashboard loads with a red **engine offline** dot. That's correct; nothing is feeding it yet.

### A3. Set the secret token (required)
1. In Netlify: **Site configuration → Environment variables → Add a variable.**
2. Key: `INGEST_TOKEN`  ·  Value: a long random string you invent (save it; you'll paste it into
   `bridge.py`). Example: `tfe_9f3K2pQ7xR1n`.
3. **Deploys → Trigger deploy → Deploy site** so the new variable takes effect.

---

## PART B — Connect your domain (thetimeframeengine.in)

1. In Netlify: **Domain management → Add a domain →** type `thetimeframeengine.in` → **Add**.
   Netlify will show you the exact DNS records to create. Use whatever Netlify shows; the typical
   values are below.
2. Log in to **Hostinger → Domains → thetimeframeengine.in → DNS / Nameservers** (DNS Zone editor).
3. Add/replace these records:
   - **A record** — Host/Name: `@`  → Points to: `75.2.60.5`  (Netlify's load balancer)
   - **CNAME** — Host/Name: `www` → Points to: `your-site-name.netlify.app`  (your Netlify subdomain)
   Remove any old parking A record on `@` that points somewhere else.
4. Back in Netlify, set `thetimeframeengine.in` as the **primary domain**, and let it provision
   **HTTPS** (Let's Encrypt — automatic, may take a few minutes to an hour).
5. When DNS propagates, `https://thetimeframeengine.in` shows your dashboard.

> Alternative if you prefer: in Hostinger set the **nameservers** to the ones Netlify lists under
> "Use Netlify DNS." That hands all DNS to Netlify and skips the manual records. Only do this if
> you don't rely on Hostinger for email on this domain.

---

## PART C — Feed it from your PC

1. Copy `bridge.py` and `parser.py` into your engine folder (next to `run_live.py`).
2. Edit the top of `bridge.py`:
   ```python
   SERVER_URL   = "https://thetimeframeengine.in"
   INGEST_TOKEN = "tfe_9f3K2pQ7xR1n"      # EXACTLY what you set in Netlify A3
   ENGINE_CMD   = "python run_live.py"
   ```
3. From the engine folder, run the bridge instead of the engine:
   ```
   python bridge.py
   ```
   You'll see your normal engine output, then `[bridge] connected — signals are going live`.

Open `https://thetimeframeengine.in` — the dot turns green and signals stream in.

From now on, start your engine with `python bridge.py`. That's the only change to your routine.

---

## Quick checks if something's off
- **Dot stays red / no signals:** is `bridge.py` running and printing `connected`? If it prints
  `site unreachable`, the URL is wrong or the domain isn't live yet — test with the raw
  `https://your-site-name.netlify.app` URL first.
- **`401` in the bridge:** `INGEST_TOKEN` in `bridge.py` doesn't match the Netlify env variable.
- **`404` in the bridge:** site not deployed yet, or you pointed at the wrong URL.
- **Domain not loading:** DNS can take time; check the raw `.netlify.app` URL works in the meantime.

## Heads-up from your logs (unrelated to the site)
Every `🚀 EXECUTING` is followed by `❌ ORDER FAILED: retcode=10030 (Unsupported filling mode)`,
meaning no orders actually reach your broker. It's a one-line MT5 fix: set the order request's
`type_filling` to a mode your broker accepts (often `mt5.ORDER_FILLING_IOC` or `FOK`), or read
`mt5.symbol_info(symbol).filling_mode` and use that. The dashboard will keep counting these as
**Failed** until it's fixed — handy to watch.
