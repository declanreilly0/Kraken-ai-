# Radar V4 — Kraken GBP Market Terminal

A dark, responsive, iPhone-friendly read-only market analysis dashboard for **verified, directly quoted GBP Kraken Spot pairs**. Not affiliated with Kraken.

**Important:** This is an actual Python/FastAPI web app with a self-contained browser frontend, **not** a Streamlit app. Do not overwrite your existing working Streamlit repository unless you mean to migrate it. The cleanest migration is **a new GitHub repository** for V4, keeping V3 untouched as a fallback.

## Features

- **GBP-only, enforced server-side.** Downloads Kraken `/0/public/AssetPairs` and accepts only active Kraken spot instruments with `wsname` ending in `/GBP`. `/api/candles`, `/api/book`, and `/api/scan` reject arbitrary non-GBP markets. A token appearing in Kraken's app priced in GBP does not establish a GBP *spot pair*; it needs an AssetPairs listing.
- Discover the entire verified direct-GBP Kraken catalogue on every new server cache refresh, including newly added GBP pairs. Mark coins as "new here" if your browser last saw a smaller catalogue; this is **not** official Kraken listing-age data.
- Search/sort all supported GBP markets, star favourites (stored only in your browser), view movers and turnover estimates.
- Plotly **interactive candlestick and line charts** with 1m, 5m, 15m, 30m, 1h, 4h, 1d, 1w timeframes; drag, pan, scroll/pinch to zoom, volume bars, responsive layout.
- Order-book snapshots for GBP bids and asks (not a perpetual real-time WebSocket stream).
- Transparent 5-rule indicator scanner (9/21 EMA trend, price above EMA9, RSI 48–70, prior-20-candle breakout, volume >=1.2x the previous 20 bars). Progressive batches of up to six pairs, max two concurrent OHLC calls. `SETUP` is **not** a predicted winning trade; 4/5 indicators and quality gates are necessary but don't imply any success rate.
- **Data and quality gates:** use the `bid`/`ask` quote and reject stale closed candles, spreads over your limit, low GBP turnover, excessive volatility, >6% quote-vs-last-closed-candle changes, or insufficient net risk/reward after costs.
- **£ risk calculator** including assumed fee and slippage on both entry and exit. The expected profit/loss values are *hypothetical*, not guaranteed: stop orders may fill at a different price or not fill.
- Installable home-screen support (PWA manifest and service worker; service worker never caches market data).
- Fully **read-only**: no account, no keys, no order placement, no automatic trading.

## Recommended deployment: Render + a new GitHub repository

1. Download and unzip `Kraken_Radar_V4_GBP.zip`.
2. On GitHub create a **new repository**, e.g. `kraken-radar-v4`. Upload the **contents** of the extracted `kraken_radar_v4` folder to the repository root. The root should contain `main.py`, `kraken.py`, `analysis_engine.py`, `requirements.txt`, `render.yaml`, and the `static` folder. **Don't** upload the zip as the only file; Render needs the files unpacked. Keeping V3 in its current repository avoids breaking that app.
3. Go to <https://dashboard.render.com/> → **New** → **Web Service** → link your new GitHub repository.
4. Choose **Python 3**, **Free** plan if available, with:
   - Build command: `pip install -r requirements.txt`
   - Start command: `uvicorn main:app --host 0.0.0.0 --port $PORT`
   - Health check path: `/health`
   - Root directory: leave blank if code is at repo root.
5. Click **Deploy**. Visit your `https://<service>.onrender.com` URL after deployment succeeds. The first market request may take a few seconds; Kraken must be reachable from your host.
6. On iPhone: Safari → open the app URL → Share → **Add to Home Screen**. This gives it an app-like icon and full-screen experience.

Render's **Free** web services can sleep after 15 minutes of no traffic and take around a minute to start. They also have usage limits, and high volumes of outbound Kraken API calls can be an issue. A paid always-on host gives a snappier experience. See <https://render.com/docs/free> for the latest terms.

### Alternative local run

Requires Python 3.10+ (3.12+ recommended).

```bash
pip install -r requirements.txt
uvicorn main:app --host 127.0.0.1 --port 8000 --reload
```

Open `http://127.0.0.1:8000` in a browser. On an iPhone outside your local network, you must deploy the server somewhere accessible.

### Testing

```bash
python -m pip install pytest httpx
python -m pytest -q
node --check static/app.js   # if Node is installed
```

## How market discovery works

1. Query Kraken Spot `AssetPairs` (cache 15 minutes).
2. Filter for genuine active direct-GBP spot markets by canonical market name `BASE/GBP` and status `online`.
3. Fetch Kraken `/Ticker` (cache 25 seconds). Show retrieved timestamps to distinguish **snapshot recency** from actual trade recency.
4. For a chart, call `/OHLC?pair=<verified id>&interval=<Kraken supported interval>`; Kraken supplies **up to 720 bars**, and **the final bar is still forming**. We display the forming bar in the chart but **exclude it from signal evaluation**.
5. Market scans request OHLC per eligible verified pair, incrementally, within the app session. They don't run in a background service after closing the webpage.
6. The built-in meme filter is a **curated list of known tickers**, not an exhaustive or official meme classification. To catch all *newly listed* GBP pairs, select **All GBP markets**. Kraken listings without a directly tradable GBP spot pair will never appear, by design.

## Why an app price might differ from the chart

Kraken's consumer app may show a **GBP conversion** even when no direct GBP order book exists. Kraken Spot chart quotes represent **actual trades in that GBP pair**. Other reasons include a live/incomplete last bar, no trades during some intervals (no artificial candles added), or refreshed quotes versus older chart bars. Thus, prices needn't match exactly second-by-second.

## Scenario maths and assumptions

- The buy price is the *best ask* from the latest retrieved GBP ticker, not a promised executable order price.
- A stake includes purchase fee; illustrative units = `stake / (1 + fee_fraction) / [ask * (1 + slippage_fraction)]`.
- Hypothetical sale proceeds = `units * exit_level * (1 − slippage_fraction) * (1 − fee_fraction)`.
- Net result = proceeds − original stake. A stop can fail to fill at the illustrated stop level.
- The target is based on an ATR-derived illustrative 2.7× gross stop distance, adjusted by fee assumptions in net risk/reward. It is **not a price prediction**.
- Fee default **0.40% each side** and slippage **0.10% each side** are user-editable assumptions, *not* a quote of your actual Kraken plan's fees. Instant Buy, exchange market, or order-type charges can differ substantially. Configure the actual fee schedule for your account, and don't use the scenarios as trade instructions.

## What V4 intentionally doesn't do

- **No guaranteed profits**, no predictive AI model, no auto trades, no API credentials.
- **No broader-than-720-bar history** from Kraken's standard REST endpoint. 1M and multi-year charting require a separate history backend and historical data source; this app provides Kraken-supported intervals instead.
- **No claim of 100% meme identification**. New GBP-listed coins are auto-discovered in "All GBP markets", but classification is not automatic.
- **No live WebSocket feed**. It uses snapshot polling, and the dashboard tells you when data was retrieved. Quotes and candle snapshots will not be synchronized perfectly with Kraken's consumer app.
- **No cloud-based 24/7 scanning**: a full-universe scan works in batches while you leave the browser open. For 24/7 monitoring, you would need a persistent worker with rate limits and a database.

## Notes for developers

- API: `GET /health`, `GET /api/markets`, `GET /api/candles?pair=BEAMGBP&interval=15`, `GET /api/book?pair=BEAMGBP`, `POST /api/scan`, `POST /api/calculate`.
- No request path allows buy/sell placement; servers do not store account secrets.
- The app ships a local copy of `plotly.min.js` so charting does not depend on an external chart CDN.
- HTTPS is supplied by your deployment platform. Never input exchange credentials into this interface.
- Public API rate limits or unavailable markets can cause scans to return errors; these are shown rather than masked with fake prices.

Official sources: <https://docs.kraken.com/api-reference/market-data/get-tradable-asset-pairs>, <https://docs.kraken.com/api-reference/market-data/get-ohlc-data>, <https://support.kraken.com/articles/360000920306-api-symbols-and-tickers>, <https://render.com/docs/deploy-fastapi>.
