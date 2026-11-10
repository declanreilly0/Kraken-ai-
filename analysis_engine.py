"""Transparent research rules, fee-adjusted scenarios. No ML or profit forecasts."""
from __future__ import annotations
import math
import time


def ema(values: list[float], period: int) -> list[float]:
    if not values:
        return []
    alpha = 2 / (period + 1)
    output = [values[0]]
    for v in values[1:]:
        output.append(v * alpha + output[-1] * (1 - alpha))
    return output


def rsi(values: list[float], period: int = 14) -> float | None:
    if len(values) < period + 2:
        return None
    changes = [values[i] - values[i - 1] for i in range(1, len(values))]
    gains = [max(v, 0) for v in changes]
    losses = [max(-v, 0) for v in changes]
    gain = sum(gains[:period]) / period
    loss = sum(losses[:period]) / period
    for g, l in zip(gains[period:], losses[period:]):
        gain = (gain * (period - 1) + g) / period
        loss = (loss * (period - 1) + l) / period
    if gain == 0 and loss == 0:
        return 50.0
    return 100.0 if loss == 0 else 100 - (100 / (1 + gain / loss))


def atr(bars: list[dict], period: int = 14) -> float | None:
    if len(bars) < period + 1:
        return None
    tr = []
    for prev, cur in zip(bars[:-1], bars[1:]):
        tr.append(max(cur["high"] - cur["low"], abs(cur["high"] - prev["close"]), abs(cur["low"] - prev["close"])))
    value = sum(tr[:period]) / period
    for x in tr[period:]:
        value = (value * (period - 1) + x) / period
    return value


def scenario(stake: float, entry: float, target: float, stop: float, fee_pct: float, slippage_pct: float) -> dict:
    """Buy at displayed ask, use quote-inclusive costs; sell at hypothetical bid targets.

    Fee is charged on notional both sides; slippage is assumed on both sides.
    Assumes no additional spread on the hypothetical future exit bid, with no guarantees.
    """
    if not (stake > 0 and entry > 0 and target > 0 and stop > 0 and target > entry > stop):
        raise ValueError("Need a positive stake and stop < entry < target.")
    if not (0 <= fee_pct < 20 and 0 <= slippage_pct < 20):
        raise ValueError("Fee and slippage percentages must each be between 0 and 20.")
    fee, slip = fee_pct / 100, slippage_pct / 100
    purchase_notional = stake / (1 + fee)
    quantity = purchase_notional / (entry * (1 + slip))
    proceeds_target = quantity * target * (1 - slip) * (1 - fee)
    proceeds_stop = quantity * stop * (1 - slip) * (1 - fee)
    profit = proceeds_target - stake
    loss = proceeds_stop - stake
    return {
        "stake_gbp": stake, "units": quantity,
        "entry_gbp": entry, "target_gbp": target, "stop_gbp": stop,
        "target_net_gbp": profit, "stop_net_gbp": loss,
        "target_return_pct": profit / stake * 100,
        "stop_return_pct": loss / stake * 100,
        "reward_risk": round(max(profit, 0) / abs(loss), 2) if loss < 0 else None,
        "fee_pct_each_side": fee_pct, "slippage_pct_each_side": slippage_pct,
    }


def analyze(data: dict, market: dict, *, stake: float = 50, fee_pct: float = 0.4,
            slippage_pct: float = 0.1, min_volume_gbp: float = 40000,
            max_spread_pct: float = 1.5) -> dict:
    pair = data["pair"]
    interval = data["interval"]
    bars = data["candles"][:-1] # Exclude forming candle unconditionally.
    output = {
        "pair": pair["symbol"], "id": pair["id"], "base": pair["base"],
        "interval": interval, "score": 0, "status": "NO DATA", "rules": [],
        "reasons": [], "quality": [], "scenario": None,
        "retrieved_at": data["retrieved_at"],
        "closed_candle_at": bars[-1]["time"] + interval * 60 if bars else None,
        "bars_used": len(bars), "quote": "GBP",
    }
    if len(bars) < 50:
        output["reasons"].append("Fewer than 50 closed candles available")
        return output
    values = [b["close"] for b in bars]
    if not all(math.isfinite(v) and v > 0 for v in values):
        output["reasons"].append("Incomplete or invalid price history")
        return output
    close, slow, fast = values[-1], ema(values, 21), ema(values, 9)
    r = rsi(values)
    vol_avg = sum(b["volume"] for b in bars[-21:-1]) / 20
    volatility = atr(bars)
    conditions = [
        ("EMA trend", fast[-1] > slow[-1], "9-period EMA above 21-period EMA"),
        ("Price strength", close > fast[-1], "Last completed close above 9-period EMA"),
        ("RSI momentum", r is not None and 48 <= r <= 70, "RSI (14) between 48 and 70"),
        ("Breakout", close > max(v["high"] for v in bars[-21:-1]), "Close above prior 20-candle high"),
        ("Volume confirmation", vol_avg > 0 and bars[-1]["volume"] >= vol_avg * 1.2,
         "Last closed candle volume at least 1.2× previous 20 average"),
    ]
    output["rules"] = [{"name": n, "passed": bool(ok), "detail": d} for n, ok, d in conditions]
    output["score"] = sum(bool(ok) for _, ok, _ in conditions)
    output["indicators"] = {"rsi": round(r, 2) if r is not None else None,
                            "ema9": fast[-1], "ema21": slow[-1], "atr14": volatility}
    now = time.time()
    candle_age = now - output["closed_candle_at"]
    max_candle_age = max(150, interval * 60 * 2.5)
    if candle_age < -60 or candle_age > max_candle_age:
        output["quality"].append("Closed candle is stale or timestamp is invalid")
    volume = market.get("volume_gbp24", 0) or 0
    if volume < min_volume_gbp:
        output["quality"].append("24h GBP market turnover below liquidity threshold")
    spread = market.get("spread_pct")
    if spread is None or spread < 0 or spread > max_spread_pct:
        output["quality"].append("Bid/ask spread unavailable or above limit")
    ask = market.get("ask", 0) or 0
    bid = market.get("bid", 0) or 0
    if ask <= 0 or bid <= 0 or not math.isfinite(ask) or not math.isfinite(bid):
        output["quality"].append("Executable bid/ask quote not available")
    elif abs(ask - close) / close > 0.06:
        output["quality"].append("Current ask has moved over 6% from last completed close")
    if not volatility or volatility <= 0 or not math.isfinite(volatility):
        output["quality"].append("ATR volatility unavailable")
    if ask > 0 and volatility and volatility > 0:
        risk = max(volatility * 1.6, ask * 0.012)
        if risk / ask > 0.12:
            output["quality"].append("Price volatility too high for the risk model")
        else:
            entry, stop, target = ask, ask - risk, ask + risk * 2.7
            if stop > 0:
                try:
                    estimate = scenario(stake, entry, target, stop, fee_pct, slippage_pct)
                    output["scenario"] = estimate
                    min_notional = max(pair.get("cost_min", 0), pair.get("order_min", 0) * ask)
                    if stake < min_notional * (1 + fee_pct / 100):
                        output["quality"].append("Stake below exchange minimum order notional")
                    if estimate["target_net_gbp"] <= 0 or estimate["reward_risk"] is None or estimate["reward_risk"] < 1.5:
                        output["quality"].append("Net risk/reward below 1.5:1 after assumed costs")
                except ValueError:
                    output["quality"].append("Scenario could not be calculated")
    if output["quality"]:
        output["status"] = "BLOCKED"
    elif output["score"] >= 4:
        output["status"] = "SETUP"
    elif output["score"] >= 3:
        output["status"] = "WATCH"
    else:
        output["status"] = "NO SETUP"
    output["reasons"] = [r["name"] + " did not pass" for r in output["rules"] if not r["passed"]]
    return output
