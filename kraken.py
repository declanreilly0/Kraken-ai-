"""Public, read-only Kraken Spot market data. Every displayed pair is genuinely quoted in GBP."""
from __future__ import annotations
import os
import threading
import time
from typing import Any
import requests
from requests.adapters import HTTPAdapter

BASE = "https://api.kraken.com/0/public"
USER_AGENT = "KrakenRadarV4/1.0 (read-only-market-research)"

class MarketError(RuntimeError):
    pass

class TTLStore:
    def __init__(self):
        self.lock = threading.RLock()
        self.data: dict[str, tuple[float, Any]] = {}

    def get(self, key: str):
        with self.lock:
            item = self.data.get(key)
            if item and item[0] > time.monotonic():
                return item[1]
        return None

    def put(self, key: str, value: Any, seconds: int):
        with self.lock:
            self.data[key] = (time.monotonic() + seconds, value)
        return value

_cache = TTLStore()
_thread_local = threading.local()


def _session() -> requests.Session:
    if not hasattr(_thread_local, "session"):
        session = requests.Session()
        session.headers.update({"User-Agent": USER_AGENT, "Accept": "application/json"})
        session.mount("https://", HTTPAdapter(pool_connections=8, pool_maxsize=8))
        _thread_local.session = session
    return _thread_local.session


def query(endpoint: str, params: dict | None = None, ttl: int = 0) -> tuple[dict, float]:
    """Return Kraken result dict and the Unix time it was retrieved, not exchange tick time."""
    params = params or {}
    cachekey = f"{endpoint}:{sorted(params.items())}"
    if ttl:
        cached = _cache.get(cachekey)
        if cached is not None:
            return cached
    try:
        response = _session().get(f"{BASE}/{endpoint}", params=params, timeout=(4, 13))
        response.raise_for_status()
        body = response.json()
        if not isinstance(body, dict) or not isinstance(body.get("result"), dict):
            raise MarketError("Unexpected response from Kraken.")
        if body.get("error"):
            raise MarketError("; ".join(map(str, body["error"]))[:180])
        result = (body["result"], time.time())
        return _cache.put(cachekey, result, ttl) if ttl else result
    except (requests.RequestException, ValueError) as exc:
        raise MarketError(f"Kraken market-data connection unavailable: {type(exc).__name__}") from exc


def gbp_pairs() -> tuple[list[dict], float]:
    raw, fetched = query("AssetPairs", ttl=900)
    pairs = []
    for pair_id, meta in raw.items():
        if not isinstance(meta, dict):
            continue
        ws = meta.get("wsname", "")
        # Do not derive pair validity from conversion pages or quoted display prices.
        # GBP is the genuine quote currency in Kraken's Spot AssetPairs response.
        if not isinstance(ws, str) or not ws.endswith("/GBP"):
            continue
        if meta.get("status", "online") != "online":
            continue
        base, quote = ws.split("/", 1)
        if quote != "GBP" or "." in base or "." in pair_id or base == "GBP":
            continue
        pairs.append({
            "id": pair_id, "symbol": ws, "base": base,
            "quote": "GBP", "altname": meta.get("altname", ""),
            "order_min": _num(meta.get("ordermin")),
            "cost_min": _num(meta.get("costmin")),
            "pair_decimals": meta.get("pair_decimals", 8),
            "status": meta.get("status", "online"),
        })
    return sorted(pairs, key=lambda p: p["symbol"]), fetched


def _num(x: Any) -> float:
    try:
        n = float(x)
        return n if n == n and abs(n) < 1e30 else 0.0
    except (ValueError, TypeError):
        return 0.0


def require_pair(pair_id: str) -> dict:
    # No HTTP request can retrieve an arbitrary USD pair through our APIs.
    pairs, _ = gbp_pairs()
    for item in pairs:
        if item["id"] == pair_id or item["symbol"] == pair_id:
            return item
    raise MarketError("This is not an active, direct Kraken GBP spot market.")


def tickers() -> dict:
    pairs, pair_ts = gbp_pairs()
    raw, fetched = query("Ticker", ttl=25)
    output = []
    for pair in pairs:
        # Kraken public endpoint uses the same pair identifier across AssetPairs/Ticker.
        record = raw.get(pair["id"])
        if not isinstance(record, dict):
            continue
        ask = _num((record.get("a") or [None])[0])
        bid = _num((record.get("b") or [None])[0])
        last = _num((record.get("c") or [None])[0])
        opn = _num(record.get("o"))
        v24 = _num((record.get("v") or [None, None])[-1])
        vwap = _num((record.get("p") or [None, None])[-1])
        high = _num((record.get("h") or [None, None])[-1])
        low = _num((record.get("l") or [None, None])[-1])
        spread = (ask - bid) / ((ask + bid) / 2) * 100 if ask > 0 and bid > 0 and ask >= bid else None
        market = {
            **pair, "ask": ask, "bid": bid, "last": last,
            "change24": ((last / opn - 1) * 100) if opn > 0 and last > 0 else None,
            "volume_gbp24": v24 * vwap, "volume_base24": v24,
            "high24": high, "low24": low,
            "spread_pct": spread, "has_quote": ask > 0 and bid > 0 and last > 0,
        }
        output.append(market)
    output.sort(key=lambda x: x["volume_gbp24"], reverse=True)
    return {"markets": output, "retrieved_at": fetched, "catalogue_retrieved_at": pair_ts, "quote": "GBP"}


INTERVALS = {1, 5, 15, 30, 60, 240, 1440, 10080, 21600}


def candles(pair_id: str, interval: int = 15) -> dict:
    pair = require_pair(pair_id)
    if interval not in INTERVALS:
        raise MarketError("Unsupported Kraken candlestick interval.")
    result, fetched = query("OHLC", {"pair": pair["id"], "interval": interval}, ttl=35)
    bars = result.get(pair["id"])
    if bars is None:
        # Some Kraken result keys are canonicalized differently from the requested id.
        bars = next((v for k, v in result.items() if k != "last" and isinstance(v, list)), None)
    if not isinstance(bars, list):
        raise MarketError("No candle history provided for this GBP market.")
    parsed = []
    for row in bars:
        if not isinstance(row, list) or len(row) < 8:
            continue
        parsed.append({
            "time": int(row[0]), "open": _num(row[1]), "high": _num(row[2]),
            "low": _num(row[3]), "close": _num(row[4]),
            "volume": _num(row[6]), "trades": int(row[7]),
        })
    parsed.sort(key=lambda r: r["time"])
    # Kraken explicitly includes a live, uncommitted final candle.
    # Keep it for charting, NEVER pass it to the signal model.
    return {
        "pair": pair, "interval": interval, "candles": parsed,
        "complete_count": max(0, len(parsed) - 1),
        "retrieved_at": fetched, "latest_is_forming": len(parsed) > 0,
        "history_limit": 720, "quote": "GBP",
    }


def order_book(pair_id: str, count: int = 20) -> dict:
    pair = require_pair(pair_id)
    count = min(max(int(count), 5), 50)
    result, fetched = query("Depth", {"pair": pair["id"], "count": count}, ttl=12)
    raw = result.get(pair["id"]) or next(iter(result.values()), {})
    if not isinstance(raw, dict):
        raise MarketError("No order-book data available.")
    def levels(side):
        rows = []
        for level in raw.get(side, []):
            if len(level) >= 2:
                p, q = _num(level[0]), _num(level[1])
                rows.append({"price": p, "amount": q, "total_gbp": p * q})
        return rows
    return {"pair": pair["symbol"], "asks": levels("asks"), "bids": levels("bids"), "retrieved_at": fetched, "quote": "GBP"}
