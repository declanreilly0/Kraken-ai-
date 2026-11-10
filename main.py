"""Kraken Radar V4: unauthed read-only market intelligence, direct GBP markets only."""
from __future__ import annotations
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Annotated
import time
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
import kraken
from analysis_engine import analyze, scenario

ROOT = Path(__file__).resolve().parent
app = FastAPI(title="Kraken Radar V4", docs_url=None, redoc_url=None)
app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")

@app.get("/")
def home():
    return FileResponse(ROOT / "static" / "index.html")

@app.get("/health")
def health():
    return {"status": "ok", "read_only": True, "quote": "GBP", "time": time.time()}


def fail(exc):
    raise HTTPException(status_code=503 if "connection" in str(exc).lower() else 422, detail=str(exc)) from exc

@app.get("/api/markets")
def markets():
    try:
        return kraken.tickers()
    except kraken.MarketError as exc:
        fail(exc)

@app.get("/api/candles")
def candles(pair: str = Query(..., max_length=64), interval: int = 15):
    try:
        return kraken.candles(pair, interval)
    except kraken.MarketError as exc:
        fail(exc)

@app.get("/api/book")
def book(pair: str = Query(..., max_length=64)):
    try:
        return kraken.order_book(pair)
    except kraken.MarketError as exc:
        fail(exc)

class Settings(BaseModel):
    stake: float = Field(50, ge=1, le=100000)
    fee_pct: float = Field(0.4, ge=0, lt=20)
    slippage_pct: float = Field(0.1, ge=0, lt=20)
    min_volume_gbp: float = Field(40000, ge=0, le=1e12)
    max_spread_pct: float = Field(1.5, gt=0, le=20)

class ScanRequest(Settings):
    pairs: list[str] = Field(min_length=1, max_length=6)
    interval: int = Field(default=15)

class CalculateRequest(BaseModel):
    stake: float = Field(50, gt=0, le=1e8)
    entry: float = Field(gt=0)
    target: float = Field(gt=0)
    stop: float = Field(gt=0)
    fee_pct: float = Field(0.4, ge=0, lt=20)
    slippage_pct: float = Field(0.1, ge=0, lt=20)

@app.post("/api/calculate")
def calculate(req: CalculateRequest):
    try:
        return scenario(req.stake, req.entry, req.target, req.stop, req.fee_pct, req.slippage_pct)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

@app.post("/api/scan")
def scan(req: ScanRequest):
    if req.interval not in kraken.INTERVALS:
        raise HTTPException(422, "Unsupported interval")
    if len(set(req.pairs)) != len(req.pairs):
        raise HTTPException(422, "Duplicate markets in batch")
    try:
        valid = {p["id"] for p in kraken.gbp_pairs()[0]}
        if not all(p in valid for p in req.pairs):
            raise HTTPException(422, "Every scanned pair must be an active direct GBP spot market")
        tick = kraken.tickers()
        by_id = {m["id"]: m for m in tick["markets"]}
    except kraken.MarketError as exc:
        fail(exc)
    def scan_one(pair_id):
        try:
            data = kraken.candles(pair_id, req.interval)
            market = by_id.get(pair_id)
            if not market:
                raise kraken.MarketError("No GBP bid/ask quote available")
            return analyze(data, market, stake=req.stake, fee_pct=req.fee_pct,
                           slippage_pct=req.slippage_pct,
                           min_volume_gbp=req.min_volume_gbp,
                           max_spread_pct=req.max_spread_pct)
        except (kraken.MarketError, ValueError) as exc:
            return {"id": pair_id, "status": "ERROR", "reason": str(exc), "quote": "GBP"}
    # Bounded calls respect public API; frontend also pauses between batches.
    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = {executor.submit(scan_one, p): p for p in req.pairs}
        results = {futures[f]: f.result() for f in as_completed(futures)}
    return {"results": [results[p] for p in req.pairs], "retrieved_at": time.time(), "quote": "GBP", "read_only": True}
