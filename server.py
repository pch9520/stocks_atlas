#!/usr/bin/env python3
"""股票罗盘 — 本地行情代理与静态站点服务。

只依赖 Python 标准库。浏览器端不直接访问第三方接口，所有请求都由本机
服务转发，从而绕开跨域限制，并统一做缓存、字段清洗和错误处理。
"""

from __future__ import annotations

import argparse
import gzip
import html
import json
import math
import os
import re
import sqlite3
import sys
import threading
import time
import webbrowser
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta
from http.client import HTTPException
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, unquote, urlencode, urlparse
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent
SHANGHAI_TZ = ZoneInfo("Asia/Shanghai")

SEARCH_URL = "https://searchapi.eastmoney.com/api/suggest/get"
QUOTE_URL = "https://push2.eastmoney.com/api/qt/stock/get"
TRENDS_URL = "https://push2his.eastmoney.com/api/qt/stock/trends2/get"
KLINE_URL = "https://push2his.eastmoney.com/api/qt/stock/kline/get"
LIST_URL = "https://push2.eastmoney.com/api/qt/clist/get"
BATCH_URL = "https://push2.eastmoney.com/api/qt/ulist.np/get"
NEWS_SEARCH_URL = "https://search-api-web.eastmoney.com/search/jsonp"
EARNINGS_APPOINT_URL = "https://datacenter-web.eastmoney.com/api/data/v1/get"
F10_EVENT_URL = "https://datacenter.eastmoney.com/securities/api/data/get"
# 东方财富 push2 接口偶尔会整段不可用（连接被重置/限流），此时用腾讯行情兜底，
# 保证主界面仍能展示快照、分时与日线。
TENCENT_QUOTE_URL = "https://qt.gtimg.cn/q="
TENCENT_MINUTE_URL = "https://web.ifzq.gtimg.cn/appstock/app/minute/query"
TENCENT_KLINE_URL = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get"
TENCENT_HEADERS = {"Referer": "https://gu.qq.com/"}
TENCENT_US_SUFFIX = {105: "OQ", 106: "N", 107: "AM"}
SEARCH_TOKEN = "D43BF722C8E33BDC906FB84D85E326E8"
HEATMAP_MEMBERS_PATH = ROOT / "data" / "heatmap_members.json"
PREDICTION_DB_PATH = ROOT / "data" / "predictions.db"
AI_CONFIG_PATH = ROOT / "data" / "ai_config.json"
AI_DEFAULT_BASE_URL = "https://api.deepseek.com"
AI_DEFAULT_MODEL = "deepseek-flash"
MAX_SETTLE_SYMBOLS = 30
UPSTREAM_TIMEOUT = 6
UPSTREAM_ATTEMPTS = 2

ALLOWED_MARKETS = {0, 1, 101, 102, 105, 106, 107, 116, 133}
SYMBOL_RE = re.compile(r"^(101|102|133|0|1|105|106|107|116)\.([A-Za-z0-9._\-]{1,16})$")
TROY_OUNCE_GRAMS = 31.1034768
CONVERTIBLE_COMMODITIES = {"101.GC00Y", "101.SI00Y"}
HK_STOCK_RE = re.compile(r"^0\d{4}$")
RANGE_DAYS = {"1m": 31, "3m": 92, "6m": 183, "1y": 366}
RANGE_LABELS = {"1m": "近 1 个月", "3m": "近 3 个月", "6m": "近 6 个月", "1y": "近 1 年"}
NEWS_LIMIT = 5
REPORT_LABELS = {1: "一季报", 2: "半年报", 3: "三季报", 4: "年报"}
REPORT_NEXT_TYPE = {1: 2, 2: 3, 3: 4, 4: 1}
REPORT_DEADLINES = {1: (4, 30), 2: (8, 31), 3: (10, 31), 4: (4, 30)}
REPORT_CYCLE = {"一季报": "中报", "中报": "三季报", "三季报": "年报", "年报": "一季报"}
US_F10_SUFFIX = {105: "O", 106: "N", 107: "A"}
US_F10_FALLBACK_SUFFIXES = ("O", "N", "A")
HEATMAP_FIELDS = "f2,f3,f5,f6,f8,f12,f13,f14,f15,f16,f17,f18,f20,f100"
COMMODITY_FIELDS = "f43,f44,f45,f46,f57,f58,f59,f60,f86,f169,f170"
COMMODITY_ITEMS = (
    {
        "key": "gold",
        "symbol": "101.GC00Y",
        "name": "黄金",
        "contract": "COMEX 黄金",
        "exchange": "COMEX",
        "unit": "美元/盎司",
    },
    {
        "key": "silver",
        "symbol": "101.SI00Y",
        "name": "白银",
        "contract": "COMEX 白银",
        "exchange": "COMEX",
        "unit": "美元/盎司",
    },
    {
        "key": "oil",
        "symbol": "102.CL00Y",
        "name": "原油",
        "contract": "NYMEX 原油",
        "exchange": "NYMEX",
        "unit": "美元/桶",
    },
    {
        "key": "usdcnh",
        "symbol": "133.USDCNH",
        "name": "美元/人民币",
        "contract": "USD/CNH 离岸人民币",
        "exchange": "离岸市场",
        "unit": "CNY/USD",
        "currency": "CNY",
        "board": "汇率",
        "marketLabel": "外汇",
    },
)
COMMODITY_MARKETS = {101, 102, 133}
COMMODITY_BY_SYMBOL = {item["symbol"]: item for item in COMMODITY_ITEMS}
HEATMAP_MARKETS = {
    "shanghai": {
        "label": "Shanghai",
        "name": "沪市 A 股",
        "currency": "CNY",
        "scope": "按总市值排序的前 500 只沪市 A 股",
        "limit": 500,
    },
    "us500": {
        "label": "US 500",
        "name": "标普 500",
        "currency": "USD",
        "scope": "S&P 500 全部成分股",
        "limit": 503,
    },
    "nasdaq100": {
        "label": "Nasdaq 100",
        "name": "纳斯达克 100",
        "currency": "USD",
        "scope": "Nasdaq-100 全部成分股",
        "limit": 101,
    },
    "us30": {
        "label": "US30",
        "name": "道琼斯 30",
        "currency": "USD",
        "scope": "道琼斯工业平均指数 30 只成分股",
        "limit": 30,
    },
    "hk": {
        "label": "HK",
        "name": "香港股市",
        "currency": "HKD",
        "scope": "按总市值排序的前 300 只港股",
        "limit": 300,
    },
}
HK_EXCLUDE_WORDS = (
    "ETF", "基金", "信托", "债券", "国债", "货币", "REIT", "牛熊",
    "认购", "认沽", "权证", "期货", "杠杆", "反向",
)
SH_EXCLUDE_WORDS = ("ETF", "基金", "债券", "国债", "转债", "退市")
STATIC_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".webmanifest": "application/manifest+json",
    ".json": "application/json; charset=utf-8",
}
REQUEST_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.7",
    "Referer": "https://quote.eastmoney.com/",
    "Connection": "close",
}


class ApiError(Exception):
    def __init__(self, code: str, message: str, status: int = 502):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


# ---------------------------------------------------------------------------
# 通用工具
# ---------------------------------------------------------------------------


def now_shanghai() -> datetime:
    return datetime.now(SHANGHAI_TZ)


def iso_time(value: datetime | None = None) -> str:
    return (value or now_shanghai()).isoformat(timespec="seconds")


def number(value: object) -> float | None:
    """把东方财富可能返回的 '-'、空串或异常数字统一成 float / None。"""
    if value is None or value == "" or value == "-":
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(result):
        return None
    return result


def scaled(value: object, decimals: int) -> float | None:
    numeric = number(value)
    return None if numeric is None else numeric / (10**decimals)


def rounded(value: float | None, digits: int = 4) -> float | None:
    return None if value is None else round(value, digits)


def fetch_text(
    url: str,
    params: dict[str, object] | None = None,
    headers: dict[str, str] | None = None,
    encoding: str = "utf-8",
) -> str:
    """请求并返回文本；短暂网络抖动时自动重试一次，兼容 gzip 响应。"""
    request_url = f"{url}?{urlencode(params)}" if params else url
    merged_headers = dict(REQUEST_HEADERS)
    if headers:
        merged_headers.update(headers)
    last_error: Exception | None = None
    for attempt in range(UPSTREAM_ATTEMPTS):
        try:
            request = Request(request_url, headers=merged_headers)
            with urlopen(request, timeout=UPSTREAM_TIMEOUT) as response:
                raw = response.read()
                content_encoding = (response.headers.get("Content-Encoding") or "").lower()
            if "gzip" in content_encoding:
                try:
                    raw = gzip.decompress(raw)
                except OSError:
                    pass
            text = raw.decode(encoding, errors="replace").strip()
            if not text:
                raise ValueError("empty response")
            return text
        except (OSError, HTTPException, ValueError) as exc:
            # RemoteDisconnected / BadStatusLine / 超时 / TLS 重置等都归入
            # 上游不可用。特别是 RemoteDisconnected 继承自 ConnectionResetError，
            # 若不在这里转换，会被 HTTP 层误当作“浏览器断开连接”而静默丢弃响应。
            last_error = exc
            if attempt < UPSTREAM_ATTEMPTS - 1:
                time.sleep(0.35)
    raise ApiError(
        "UPSTREAM_UNAVAILABLE",
        "行情源暂时不可用，请稍后重试",
        502,
    ) from last_error


def fetch_json(
    url: str,
    params: dict[str, object],
    headers: dict[str, str] | None = None,
    encoding: str = "utf-8",
) -> dict:
    """请求并解析 JSON；短暂网络抖动时自动重试一次。"""
    text = fetch_text(url, params, headers, encoding=encoding)
    try:
        payload = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ApiError(
            "UPSTREAM_UNAVAILABLE",
            "行情源暂时不可用，请稍后重试",
            502,
        ) from exc
    if not isinstance(payload, dict):
        raise ApiError(
            "UPSTREAM_UNAVAILABLE",
            "行情源暂时不可用，请稍后重试",
            502,
        )
    return payload


# ---------------------------------------------------------------------------
# 进程内 TTL 缓存（带过期旧数据兜底）
# ---------------------------------------------------------------------------

_cache: dict[str, tuple[float, object]] = {}
_cache_lock = threading.Lock()


def cache_get(key: str) -> object | None:
    with _cache_lock:
        entry = _cache.get(key)
        if entry and entry[0] > time.time():
            return entry[1]
    return None


def cache_get_stale(key: str, max_age: float = 6 * 3600) -> object | None:
    with _cache_lock:
        entry = _cache.get(key)
        if entry and entry[0] > time.time() - max_age:
            return entry[1]
    return None


def cache_set(key: str, value: object, ttl: float) -> None:
    with _cache_lock:
        _cache[key] = (time.time() + ttl, value)
        if len(_cache) > 600:
            cutoff = time.time() - 6 * 3600
            for stale_key in [k for k, v in _cache.items() if v[0] < cutoff][:200]:
                _cache.pop(stale_key, None)


def cache_delete(key: str) -> None:
    with _cache_lock:
        _cache.pop(key, None)


def cached_json(key: str, ttl: float, loader) -> tuple[object, str]:
    """返回 (数据, 状态)。状态为 fresh / hit / stale。"""
    hit = cache_get(key)
    if hit is not None:
        return hit, "hit"
    try:
        value = loader()
    except ApiError:
        stale = cache_get_stale(key)
        if stale is not None:
            return stale, "stale"
        raise
    cache_set(key, value, ttl)
    return value, "fresh"


# ---------------------------------------------------------------------------
# 股票元数据与搜索
# ---------------------------------------------------------------------------


def market_meta(market: int, code: str, name: str, board: str | None = None) -> dict:
    unit = ""
    contract = ""
    commodity_key = ""
    if market in (0, 1):
        if board == "京A" or code.startswith(("4", "8", "9")):
            exchange, board_label, currency = "北交所", "京A", "CNY"
        elif board == "沪A" or code.startswith(("6", "5")):
            exchange, board_label, currency = "上交所", "沪A", "CNY"
        else:
            exchange, board_label, currency = "深交所", "深A", "CNY"
        market_group, market_label = "CN", "A股"
    elif market == 116:
        exchange, board_label, currency = "港交所", "港股", "HKD"
        market_group, market_label = "HK", "港股"
    elif market in COMMODITY_MARKETS:
        config = COMMODITY_BY_SYMBOL.get(f"{market}.{code.upper()}")
        exchange = (
            str(config.get("exchange"))
            if config
            else {101: "COMEX", 102: "NYMEX", 133: "离岸市场"}.get(market, "商品")
        )
        board_label, currency = "商品", "USD"
        market_group, market_label = "COMMODITY", "大宗商品"
        if config:
            name = str(config["name"])
            unit = str(config["unit"])
            contract = str(config["contract"])
            commodity_key = str(config["key"])
            board_label = str(config.get("board") or board_label)
            market_label = str(config.get("marketLabel") or market_label)
            currency = str(config.get("currency") or currency)
    elif market in (105, 106, 107):
        exchange = {105: "纳斯达克", 106: "纽交所", 107: "美交所"}.get(market, "美股")
        board_label, currency = "美股", "USD"
        market_group, market_label = "US", "美股"
    else:
        raise ApiError("UNSUPPORTED_MARKET", "暂不支持该市场", 400)

    block = {
        "symbol": f"{market}.{code}",
        "code": code.upper() if market_group in ("US", "COMMODITY") else code,
        "name": name,
        "market": market_group,
        "marketLabel": market_label,
        "board": board_label,
        "exchange": exchange,
        "currency": currency,
    }
    if commodity_key:
        block["key"] = commodity_key
        block["unit"] = unit
        block["contract"] = contract
    return block


def parse_symbol(symbol: str) -> tuple[int, str]:
    if not symbol or not SYMBOL_RE.match(symbol):
        raise ApiError("INVALID_SYMBOL", "代码格式不正确", 400)
    market_text, code = symbol.split(".", 1)
    market = int(market_text)
    if market not in ALLOWED_MARKETS:
        raise ApiError("UNSUPPORTED_MARKET", "暂不支持该市场", 400)
    return market, code


def stock_from_search(item: dict) -> dict | None:
    quote_id = str(item.get("QuoteID") or "")
    code = str(item.get("Code") or "").strip()
    name = str(item.get("Name") or "").strip()
    classify = item.get("Classify")
    security_name = item.get("SecurityTypeName")
    if not quote_id or not code or not name:
        return None
    try:
        market = int(quote_id.split(".", 1)[0])
    except (ValueError, IndexError):
        return None

    if market in (0, 1):
        if not (classify == "AStock" or (classify == "NEEQ" and security_name == "京A")):
            return None
        if security_name not in ("沪A", "深A", "京A"):
            return None
        board = security_name
    elif market == 116:
        if (
            classify != "HK"
            or security_name != "港股"
            or str(item.get("TypeUS")) != "3"
            or not HK_STOCK_RE.match(code)
        ):
            return None
        board = "港股"
    elif market in (105, 106, 107):
        if (
            classify != "UsStock"
            or security_name != "美股"
            or str(item.get("TypeUS")) not in ("1", "3")
        ):
            return None
        board = "美股"
    else:
        return None

    try:
        return market_meta(market, code, name, board)
    except ApiError:
        return None


def search_score(stock: dict, query: str, api_index: int) -> tuple[float, int]:
    q = query.upper().strip()
    code = stock["code"].upper()
    name = stock["name"].upper()
    q_digits = q.lstrip("0") or "0"
    code_digits = code.lstrip("0") or "0"
    if code == q:
        rank = 0
    elif q.isdigit() and code.isdigit() and code_digits == q_digits:
        # 港股代码常省略前导零：输入 700 / 0700 也能命中 00700，
        # 并在与 A 股数字相同的情况下优先展示 5 位港股代码。
        rank = 0.4 if stock["market"] == "HK" and len(q) <= 4 else 0.5
    elif name == q:
        rank = 1
    elif code.startswith(q):
        rank = 2
    elif name.startswith(q):
        rank = 3
    elif q in code:
        rank = 4
    elif q in name:
        rank = 5
    else:
        rank = 6
    return rank, api_index


def search_stocks(query: str) -> list[dict]:
    queries = [query]
    # 用户可能只输入 700 / 0700，而港股代码实际是 00700。补一次前导零查询。
    if re.fullmatch(r"\d{1,4}", query):
        padded = query.zfill(5)
        if padded != query:
            queries.append(padded)

    seen: set[str] = set()
    stocks: list[dict] = []
    api_index = 0
    for search_query in queries:
        payload = fetch_json(
            SEARCH_URL,
            {
                "input": search_query,
                "type": 14,
                "token": SEARCH_TOKEN,
                "count": 40,
            },
        )
        table = payload.get("QuotationCodeTable") or {}
        raw_items = table.get("Data") or []
        for item in raw_items:
            stock = stock_from_search(item)
            if not stock or stock["symbol"] in seen:
                continue
            seen.add(stock["symbol"])
            stock["_rank"] = search_score(stock, query, api_index)
            stocks.append(stock)
            api_index += 1
    stocks.sort(key=lambda item: item["_rank"])
    for stock in stocks:
        stock.pop("_rank", None)
    return stocks[:24]


# ---------------------------------------------------------------------------
# 行情快照 / 分时 / 历史 K 线
# ---------------------------------------------------------------------------


def _get_quote_eastmoney(symbol: str) -> dict:
    market, code = parse_symbol(symbol)
    fields = (
        "f43,f44,f45,f46,f47,f48,f57,f58,f59,f60,f86,f107,f116,f117,"
        "f162,f167,f168,f169,f170,f171"
    )
    payload = fetch_json(QUOTE_URL, {"secid": symbol, "fields": fields})
    data = payload.get("data")
    if not isinstance(data, dict):
        raise ApiError("NO_QUOTE", "没有找到该标的的实时行情", 404)

    decimals = int(number(data.get("f59")) or (2 if market in (0, 1) else 3))
    price = scaled(data.get("f43"), decimals)
    prev_close = scaled(data.get("f60"), decimals)
    change = scaled(data.get("f169"), decimals)
    change_pct = number(data.get("f170"))
    change_pct = None if change_pct is None else change_pct / 100
    if change is None and price is not None and prev_close:
        change = price - prev_close
    if change_pct is None and change is not None and prev_close:
        change_pct = change / prev_close * 100

    quote_time = None
    timestamp = number(data.get("f86"))
    if timestamp:
        quote_time = datetime.fromtimestamp(timestamp, SHANGHAI_TZ).isoformat(timespec="seconds")

    market = int(data.get("f107") or market)
    name = str(data.get("f58") or code)
    block = market_meta(market, str(data.get("f57") or code), name)
    pe = scaled(data.get("f162"), 2)
    pb = scaled(data.get("f167"), 2)

    result = {
        "stock": block,
        "price": rounded(price),
        "open": rounded(scaled(data.get("f46"), decimals)),
        "high": rounded(scaled(data.get("f44"), decimals)),
        "low": rounded(scaled(data.get("f45"), decimals)),
        "prevClose": rounded(prev_close),
        "change": rounded(change),
        "changePct": rounded(change_pct),
        "volume": rounded((number(data.get("f47")) or 0) * (100 if market in (0, 1) else 1), 0),
        "amount": rounded(number(data.get("f48")), 2),
        "turnoverPct": rounded(scaled(data.get("f168"), 2)),
        "amplitudePct": rounded(scaled(data.get("f171"), 2)),
        "pe": rounded(pe) if pe and pe > 0 else None,
        "pb": rounded(pb) if pb and pb > 0 else None,
        "marketCap": rounded(number(data.get("f116")), 2),
        "floatCap": rounded(number(data.get("f117")), 2),
        "decimals": decimals,
        "quoteTime": quote_time,
        "updatedAt": iso_time(),
    }
    if symbol in CONVERTIBLE_COMMODITIES and price is not None:
        rate = usd_cny_rate()
        if rate:
            result["cnyPrice"] = round(price * rate / TROY_OUNCE_GRAMS, 2)
            result["cnyUnit"] = "元/g"
            result["cnyRate"] = round(rate, 4)
    return result


def _get_intraday_eastmoney(symbol: str) -> dict:
    market, code = parse_symbol(symbol)
    fields1 = "f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13"
    fields2 = "f51,f52,f53,f54,f55,f56,f57,f58"
    payload = fetch_json(
        TRENDS_URL,
        {
            "secid": symbol,
            "ndays": 1,
            "iscr": 0,
            "fields1": fields1,
            "fields2": fields2,
        },
    )
    data = payload.get("data")
    if not isinstance(data, dict):
        raise ApiError("NO_INTRADAY", "当前没有分时数据", 404)

    prev_close = number(data.get("preClose")) or number(data.get("prePrice"))
    decimals = int(number(data.get("decimal")) or (2 if market in (0, 1) else 3))
    points: list[dict] = []
    seen: set[str] = set()
    for row in data.get("trends") or []:
        parts = str(row).split(",")
        if len(parts) < 8:
            continue
        stamp = parts[0].strip()
        if not stamp or stamp in seen:
            continue
        seen.add(stamp)
        price = number(parts[2])
        if price is None:
            continue
        volume = (number(parts[5]) or 0) * (100 if market in (0, 1) else 1)
        points.append(
            {
                "datetime": stamp,
                "time": stamp[11:16] if len(stamp) >= 16 else stamp,
                "price": rounded(price),
                "avg": rounded(number(parts[7])),
                "volume": rounded(volume, 0),
                "amount": rounded(number(parts[6]), 2),
            }
        )

    if not points:
        raise ApiError("NO_INTRADAY", "该标的当前没有分时数据", 404)
    if not prev_close:
        prev_close = number(points[0].get("price"))

    source_time = number(data.get("time"))
    updated = (
        datetime.fromtimestamp(source_time, SHANGHAI_TZ).isoformat(timespec="seconds")
        if source_time
        else iso_time()
    )
    trading_date = points[0]["datetime"][:10]
    result = {
        "stock": market_meta(market, code, str(data.get("name") or code)),
        "prevClose": rounded(prev_close),
        "decimals": decimals,
        "tradingDate": trading_date,
        "points": points,
        "total": len(points),
        "updatedAt": updated,
    }
    if symbol in CONVERTIBLE_COMMODITIES:
        rate = usd_cny_rate()
        if rate:
            result["cnyRate"] = round(rate, 4)
            result["cnyUnit"] = "元/g"
    return result


def build_history_summary(items: list[dict]) -> dict:
    if not items:
        return {
            "total": 0,
            "up": 0,
            "down": 0,
            "flat": 0,
            "upRatio": 0,
            "downRatio": 0,
            "intervalPct": 0,
            "avgPct": 0,
            "best": None,
            "worst": None,
            "maxDrawdown": 0,
        }

    up = sum(1 for item in items if (item.get("pct") or 0) > 0.00001)
    down = sum(1 for item in items if (item.get("pct") or 0) < -0.00001)
    flat = len(items) - up - down
    total = len(items)

    compounded = 1.0
    for item in items:
        compounded *= 1 + (item.get("pct") or 0) / 100

    peak = None
    max_drawdown = 0.0
    for item in items:
        close = item.get("close")
        if close is None:
            continue
        peak = close if peak is None else max(peak, close)
        if peak:
            max_drawdown = min(max_drawdown, (close / peak - 1) * 100)

    valid = [item for item in items if item.get("pct") is not None]
    best = max(valid, key=lambda item: item["pct"]) if valid else None
    worst = min(valid, key=lambda item: item["pct"]) if valid else None
    avg_pct = sum(item["pct"] for item in valid) / len(valid) if valid else 0

    def brief(item: dict | None) -> dict | None:
        if not item:
            return None
        return {"date": item["date"], "pct": item["pct"], "close": item["close"]}

    return {
        "total": total,
        "up": up,
        "down": down,
        "flat": flat,
        "upRatio": round(up / total * 100, 2),
        "downRatio": round(down / total * 100, 2),
        "intervalPct": round((compounded - 1) * 100, 4),
        "avgPct": round(avg_pct, 4),
        "best": brief(best),
        "worst": brief(worst),
        "maxDrawdown": round(max_drawdown, 4),
    }


def _load_daily_bars_eastmoney(symbol: str) -> dict:
    """读取最近 520 个交易日的日线，供历史区间、AI 预测和结算共用。"""
    market, code = parse_symbol(symbol)
    payload = fetch_json(
        KLINE_URL,
        {
            "secid": symbol,
            "klt": 101,
            "fqt": 1,
            "lmt": 520,
            "end": 20500101,
            "fields1": "f1,f2,f3,f4,f5,f6",
            "fields2": "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
        },
    )
    data = payload.get("data")
    if not isinstance(data, dict):
        raise ApiError("NO_HISTORY", "没有找到该标的的历史行情", 404)

    decimals = int(number(data.get("decimal")) or (2 if market in (0, 1) else 3))
    items: list[dict] = []
    for row in data.get("klines") or []:
        parts = str(row).split(",")
        if len(parts) < 11:
            continue
        try:
            close = float(parts[2])
        except (TypeError, ValueError):
            continue
        item = {
            "date": parts[0],
            "open": rounded(number(parts[1])),
            "close": rounded(close),
            "high": rounded(number(parts[3])),
            "low": rounded(number(parts[4])),
            "volume": rounded((number(parts[5]) or 0) * (100 if market in (0, 1) else 1), 0),
            "amount": rounded(number(parts[6]), 2),
            "amplitudePct": rounded(number(parts[7])),
            "pct": rounded(number(parts[8])),
            "change": rounded(number(parts[9])),
            "turnoverPct": rounded(number(parts[10])),
        }
        if item["pct"] is None:
            item["pct"] = 0.0
        items.append(item)

    if not items:
        raise ApiError("NO_HISTORY", "没有找到该标的的历史行情", 404)
    return {
        "stock": market_meta(market, code, str(data.get("name") or code)),
        "decimals": decimals,
        "items": items,
    }


# ---------------------------------------------------------------------------
# 腾讯行情兜底（东方财富 push2 连接被重置时使用）
# ---------------------------------------------------------------------------


def tencent_code(symbol: str, with_us_suffix: bool = False) -> str:
    market, code = parse_symbol(symbol)
    if market in (0, 1):
        prefix = "sh" if market == 1 else "sz"
        if code.startswith(("4", "8", "9")):
            prefix = "bj"
        return f"{prefix}{code}"
    if market == 116:
        return f"hk{code}"
    if market in (105, 106, 107):
        suffix = TENCENT_US_SUFFIX.get(market) if with_us_suffix else None
        return f"us{code}.{suffix}" if suffix else f"us{code}"
    raise ApiError("NO_FALLBACK", "该标的暂不支持备用行情源", 404)


def tencent_quote_fields(symbol: str) -> list[str]:
    text = fetch_text(
        TENCENT_QUOTE_URL + tencent_code(symbol),
        headers=TENCENT_HEADERS,
        encoding="gbk",
    )
    match = re.search(r'="(.*)"', text, re.S)
    if not match:
        raise ApiError("NO_QUOTE", "备用行情源没有返回报价", 502)
    fields = match.group(1).split("~")
    if len(fields) < 50 or not fields[3]:
        raise ApiError("NO_QUOTE", "备用行情源没有返回完整报价", 502)
    return fields


def _tencent_quote_time(fields: list[str], market: int) -> str | None:
    if len(fields) <= 30:
        return None
    raw = fields[30].strip()
    zone = SHANGHAI_TZ if market in (0, 1, 116) else ZoneInfo("America/New_York")
    for fmt in ("%Y%m%d%H%M%S", "%Y/%m/%d %H:%M:%S", "%Y-%m-%d %H:%M:%S"):
        try:
            stamp = datetime.strptime(raw, fmt).replace(tzinfo=zone)
        except ValueError:
            continue
        return stamp.astimezone(SHANGHAI_TZ).isoformat(timespec="seconds")
    return None


def get_quote_tencent(symbol: str) -> dict:
    market, code = parse_symbol(symbol)
    fields = tencent_quote_fields(symbol)
    price = number(fields[3])
    if price is None:
        raise ApiError("NO_QUOTE", "备用行情源没有返回有效价格", 502)

    decimals = 3 if market == 116 else 2
    prev_close = number(fields[4])
    change = number(fields[31])
    change_pct = number(fields[32])
    raw_volume = number(fields[36]) if len(fields) > 36 else number(fields[6])
    raw_amount = number(fields[37]) if len(fields) > 37 else None
    volume = (raw_volume or 0) * (100 if market in (0, 1) else 1)
    amount = (raw_amount or 0) * (10000 if market in (0, 1) else 1)
    float_cap = number(fields[44]) if len(fields) > 44 else None
    total_cap = number(fields[45]) if len(fields) > 45 else None
    pe = number(fields[39]) if len(fields) > 39 else None
    pb = number(fields[46]) if len(fields) > 46 else None
    if pb is None and market not in (0, 1) and len(fields) > 47:
        # 港股/美股在市值后多一个公司英文名字段，市净率后移一位。
        pb = number(fields[47])
    name = str(fields[1] or code)

    return {
        "stock": market_meta(market, code, name),
        "price": rounded(price),
        "open": rounded(number(fields[5])),
        "high": rounded(number(fields[33]) if len(fields) > 33 else None),
        "low": rounded(number(fields[34]) if len(fields) > 34 else None),
        "prevClose": rounded(prev_close),
        "change": rounded(change),
        "changePct": rounded(change_pct),
        "volume": rounded(volume, 0),
        "amount": rounded(amount, 2),
        "turnoverPct": rounded(number(fields[38]) if len(fields) > 38 else None),
        "amplitudePct": rounded(number(fields[43]) if len(fields) > 43 else None),
        "pe": rounded(pe) if pe and pe > 0 else None,
        "pb": rounded(pb) if pb and pb > 0 else None,
        "marketCap": rounded((total_cap or 0) * 1e8, 2) if total_cap else None,
        "floatCap": rounded((float_cap or 0) * 1e8, 2) if float_cap else None,
        "decimals": decimals,
        "quoteTime": _tencent_quote_time(fields, market),
        "updatedAt": iso_time(),
        "_source": "腾讯行情（备用）",
    }


def get_intraday_tencent(symbol: str) -> dict:
    market, code = parse_symbol(symbol)
    if market in (105, 106, 107):
        # 腾讯美股分时只返回当前一个点，无法绘制走势图。
        raise ApiError("NO_INTRADAY", "备用行情源暂不提供美股分时", 404)

    tcode = tencent_code(symbol)
    payload = fetch_json(TENCENT_MINUTE_URL, {"code": tcode}, TENCENT_HEADERS)
    data = payload.get("data")
    bundle = data.get(tcode) if isinstance(data, dict) else None
    if not isinstance(bundle, dict):
        raise ApiError("NO_INTRADAY", "备用行情源没有返回分时数据", 404)
    block = bundle.get("data")
    rows = block.get("data") if isinstance(block, dict) else None
    if not isinstance(rows, list) or not rows:
        raise ApiError("NO_INTRADAY", "备用行情源没有返回分时数据", 404)

    date_raw = str(block.get("date") or "").strip() if isinstance(block, dict) else ""
    if len(date_raw) == 8 and date_raw.isdigit():
        trading_date = f"{date_raw[:4]}-{date_raw[4:6]}-{date_raw[6:8]}"
    else:
        trading_date = now_shanghai().date().isoformat()

    qt = bundle.get("qt")
    qt_fields: list = []
    if isinstance(qt, dict):
        candidate = qt.get(tcode)
        if isinstance(candidate, list):
            qt_fields = candidate
        else:
            qt_fields = next((value for value in qt.values() if isinstance(value, list)), [])
    prev_close = number(qt_fields[4]) if len(qt_fields) > 4 else None
    name = str(qt_fields[1]) if len(qt_fields) > 1 else code
    decimals = 3 if market == 116 else 2
    lot = 100 if market in (0, 1) else 1

    points: list[dict] = []
    previous_volume = 0.0
    previous_amount = 0.0
    for row in rows:
        parts = str(row).split()
        if len(parts) < 2:
            continue
        raw_time = parts[0]
        if len(raw_time) != 4 or not raw_time.isdigit():
            continue
        minute = int(raw_time)
        if market in (0, 1) and (
            minute < 930 or minute > 1500 or 1130 < minute < 1300
        ):
            # A 股只保留连续竞价时段，腾讯数据在 15:00 之后还有零星成交。
            continue
        price = number(parts[1])
        if price is None:
            continue
        cumulative_volume = number(parts[2]) if len(parts) > 2 else None
        cumulative_amount = number(parts[3]) if len(parts) > 3 else None
        delta_volume = (
            max(0.0, cumulative_volume - previous_volume)
            if cumulative_volume is not None
            else 0.0
        )
        if cumulative_volume is not None:
            previous_volume = cumulative_volume
        delta_amount = (
            max(0.0, cumulative_amount - previous_amount)
            if cumulative_amount is not None
            else None
        )
        if cumulative_amount is not None:
            previous_amount = cumulative_amount
        average = None
        if cumulative_amount and cumulative_volume:
            average = cumulative_amount / (cumulative_volume * lot)
        points.append(
            {
                "datetime": f"{trading_date} {raw_time[:2]}:{raw_time[2:]}",
                "time": f"{raw_time[:2]}:{raw_time[2:]}",
                "price": rounded(price),
                "avg": rounded(average),
                "volume": rounded(delta_volume * lot, 0),
                "amount": rounded(delta_amount, 2) if delta_amount is not None else None,
            }
        )

    if not points:
        raise ApiError("NO_INTRADAY", "备用行情源没有返回分时数据", 404)
    if not prev_close:
        prev_close = number(points[0].get("price"))
    return {
        "stock": market_meta(market, code, name),
        "prevClose": rounded(prev_close),
        "decimals": decimals,
        "tradingDate": trading_date,
        "points": points,
        "total": len(points),
        "updatedAt": _tencent_quote_time(qt_fields, market) or iso_time(),
        "_source": "腾讯行情（备用）",
    }


def load_daily_bars_tencent(symbol: str) -> dict:
    market, code = parse_symbol(symbol)
    tcode = tencent_code(symbol, with_us_suffix=True)
    payload = fetch_json(
        TENCENT_KLINE_URL,
        {"param": f"{tcode},day,,,520,qfq"},
        TENCENT_HEADERS,
    )
    data = payload.get("data")
    bundle = data.get(tcode) if isinstance(data, dict) else None
    if not isinstance(bundle, dict):
        raise ApiError("NO_HISTORY", "备用行情源没有返回历史行情", 404)
    rows = bundle.get("qfqday") or bundle.get("day") or []
    if not isinstance(rows, list) or not rows:
        raise ApiError("NO_HISTORY", "备用行情源没有返回历史行情", 404)

    name = code
    qt = bundle.get("qt")
    if isinstance(qt, dict):
        candidate = qt.get(tcode)
        if isinstance(candidate, list) and len(candidate) > 1:
            name = str(candidate[1])
        else:
            first = next((value for value in qt.values() if isinstance(value, list)), None)
            if first and len(first) > 1:
                name = str(first[1])

    decimals = 3 if market == 116 else 2
    items: list[dict] = []
    prev_close: float | None = None
    for row in rows:
        if not isinstance(row, (list, tuple)) or len(row) < 6:
            continue
        close = number(row[2])
        if close is None:
            continue
        open_price = number(row[1])
        high = number(row[3])
        low = number(row[4])
        volume = number(row[5])
        change = None
        pct = None
        amplitude = None
        if prev_close:
            change = close - prev_close
            pct = (close / prev_close - 1) * 100
            if high is not None and low is not None:
                amplitude = (high - low) / prev_close * 100
        items.append(
            {
                "date": str(row[0]),
                "open": rounded(open_price),
                "close": rounded(close),
                "high": rounded(high),
                "low": rounded(low),
                "volume": rounded(
                    (volume or 0) * (100 if market in (0, 1) else 1), 0
                ),
                "amount": None,
                "amplitudePct": rounded(amplitude),
                "pct": rounded(pct) if pct is not None else 0.0,
                "change": rounded(change),
                "turnoverPct": None,
            }
        )
        prev_close = close

    if not items:
        raise ApiError("NO_HISTORY", "备用行情源没有返回历史行情", 404)
    return {
        "stock": market_meta(market, code, name),
        "decimals": decimals,
        "items": items,
        "_source": "腾讯行情（备用）",
    }


def _tencent_fallback_supported(symbol: str) -> bool:
    try:
        market, _code = parse_symbol(symbol)
    except ApiError:
        return False
    return market in (0, 1, 105, 106, 107, 116)


def get_quote(symbol: str) -> dict:
    try:
        return _get_quote_eastmoney(symbol)
    except ApiError as primary_error:
        if not _tencent_fallback_supported(symbol):
            raise
        try:
            return get_quote_tencent(symbol)
        except ApiError:
            raise primary_error


def get_intraday(symbol: str) -> dict:
    try:
        return _get_intraday_eastmoney(symbol)
    except ApiError as primary_error:
        if not _tencent_fallback_supported(symbol):
            raise
        try:
            return get_intraday_tencent(symbol)
        except ApiError:
            raise primary_error


def load_daily_bars(symbol: str) -> dict:
    try:
        return _load_daily_bars_eastmoney(symbol)
    except ApiError as primary_error:
        if not _tencent_fallback_supported(symbol):
            raise
        try:
            return load_daily_bars_tencent(symbol)
        except ApiError:
            raise primary_error


def get_history(symbol: str, range_key: str) -> dict:
    if range_key not in RANGE_DAYS:
        raise ApiError("INVALID_RANGE", "时间范围不正确", 400)
    bundle, _state = cached_json(f"daily:{symbol}", 300, lambda: load_daily_bars(symbol))
    cutoff = (now_shanghai().date() - timedelta(days=RANGE_DAYS[range_key])).isoformat()
    items = [item for item in bundle["items"] if item["date"] >= cutoff]
    if not items:
        raise ApiError("NO_HISTORY", "这个时间范围内没有交易数据", 404)

    summary = build_history_summary(items)
    result = {
        "stock": bundle["stock"],
        "range": range_key,
        "rangeLabel": RANGE_LABELS[range_key],
        "decimals": bundle["decimals"],
        "items": items,
        "summary": summary,
        "updatedAt": iso_time(),
    }
    if bundle.get("_source"):
        result["_source"] = bundle["_source"]
    return result


# ---------------------------------------------------------------------------
# 最新资讯与财报日程
# ---------------------------------------------------------------------------


def _clean_text(value: object, limit: int = 160) -> str:
    text = re.sub(r"<[^>]+>", " ", str(value or ""))
    text = html.unescape(text)
    text = re.sub(r"\s+", " ", text).strip()
    if limit and len(text) > limit:
        return text[:limit].rstrip() + "…"
    return text


def _parse_day(value: object) -> date | None:
    text = str(value or "").strip()[:10]
    if not text:
        return None
    try:
        return date.fromisoformat(text)
    except ValueError:
        return None


def _add_year(day: date) -> date:
    try:
        return day.replace(year=day.year + 1)
    except ValueError:
        return day.replace(year=day.year + 1, day=28)


def _next_business_day(day: date) -> date:
    result = day
    while result.weekday() >= 5:
        result += timedelta(days=1)
    return result


def _request_news(keyword: str, sort: str) -> list[dict]:
    param = {
        "uid": "",
        "keyword": keyword,
        "type": ["cmsArticleWebOld"],
        "client": "web",
        "clientType": "web",
        "clientVersion": "curr",
        "param": {
            "cmsArticleWebOld": {
                "searchScope": "default",
                "sort": sort,
                "pageIndex": 1,
                "pageSize": 12,
                "preTag": "",
                "postTag": "",
            }
        },
    }
    text = fetch_text(
        NEWS_SEARCH_URL,
        {"cb": "cb", "param": json.dumps(param, ensure_ascii=False)},
        headers={"Referer": "https://so.eastmoney.com/"},
    )
    open_index = text.find("(")
    close_index = text.rfind(")")
    if (
        open_index > 0
        and close_index > open_index
        and re.fullmatch(r"[A-Za-z_$][\w$]*", text[:open_index].strip())
    ):
        text = text[open_index + 1 : close_index]
    try:
        payload = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ApiError("UPSTREAM_UNAVAILABLE", "资讯源返回了无法解析的数据", 502) from exc
    result = payload.get("result") if isinstance(payload, dict) else None
    rows = result.get("cmsArticleWebOld") if isinstance(result, dict) else None
    return [row for row in rows if isinstance(row, dict)] if isinstance(rows, list) else []


def _normalize_news(row: dict) -> dict | None:
    title = _clean_text(row.get("title"), 120)
    if not title:
        return None
    url = str(row.get("url") or "").strip()
    if not url.lower().startswith(("http://", "https://")):
        url = ""
    return {
        "title": title,
        "url": url,
        "source": _clean_text(row.get("mediaName"), 40),
        "publishedAt": _clean_text(row.get("date"), 30),
        "summary": _clean_text(row.get("content"), 110),
    }


def load_news(symbol: str, name: str = "") -> dict:
    _market, code = parse_symbol(symbol)
    if not name:
        try:
            quote, _state = cached_json(f"quote:{symbol}", 20, lambda: get_quote(symbol))
            name = str((quote.get("stock") or {}).get("name") or "")  # type: ignore[union-attr]
        except ApiError:
            name = ""
    tokens = [code.lower()]
    if name:
        tokens.append(name.lower())
    keyword = name or code

    def collect(search_keyword: str) -> list[dict]:
        rows: list[dict] = []
        for sort in ("default", "time"):
            try:
                rows.extend(_request_news(search_keyword, sort))
            except ApiError:
                if sort == "default":
                    raise
        return rows

    queries = [keyword]
    if keyword != code:
        queries.append(code)
    selected: list[dict] = []
    for query in queries:
        scored: list[tuple[bool, dict]] = []
        seen: set[str] = set()
        for row in collect(query):
            item = _normalize_news(row)
            if not item:
                continue
            haystack = f"{row.get('title') or ''} {row.get('content') or ''}".lower()
            if not any(token and token in haystack for token in tokens):
                continue
            key = item["url"] or item["title"]
            if key in seen:
                continue
            seen.add(key)
            title_hit = any(token and token in item["title"].lower() for token in tokens)
            scored.append((title_hit, item))
        scored.sort(key=lambda pair: (pair[0], pair[1]["publishedAt"]), reverse=True)
        selected = [item for _title_hit, item in scored]
        if selected:
            break
    return {"items": selected[:NEWS_LIMIT], "keyword": keyword, "total": len(selected)}


def _flatten_f10(payload: dict) -> list[dict]:
    data = payload.get("data")
    rows: list[dict] = []
    if not isinstance(data, list):
        return rows
    for group in data:
        if isinstance(group, list):
            rows.extend(item for item in group if isinstance(item, dict))
        elif isinstance(group, dict):
            rows.append(group)
    return rows


def _fetch_cn_appointments(code: str) -> list[dict]:
    payload = fetch_json(
        EARNINGS_APPOINT_URL,
        {
            "reportName": "RPT_PUBLIC_BS_APPOIN",
            "columns": (
                "SECURITY_CODE,REPORT_TYPE,REPORT_YEAR,REPORT_TYPE_NAME,REPORT_DATE,"
                "APPOINT_PUBLISH_DATE,ACTUAL_PUBLISH_DATE,IS_PUBLISH,QUARTER"
            ),
            "filter": f'(SECURITY_CODE="{code}")',
            "pageNumber": 1,
            "pageSize": 50,
            "sortColumns": "REPORT_DATE",
            "sortTypes": "-1",
            "source": "WEB",
            "client": "WEB",
        },
    )
    result = payload.get("result")
    rows = result.get("data") if isinstance(result, dict) else None
    return [row for row in rows if isinstance(row, dict)] if isinstance(rows, list) else []


def _fetch_f10_events(market: int, code: str) -> list[dict]:
    if market == 116:
        report = "RPT_F10_HK_DETAIL"
        candidates = [f"{code}.HK"]
    else:
        report = "RPT_F10_US_DETAIL"
        preferred = US_F10_SUFFIX.get(market)
        suffixes: list[str] = [preferred] if preferred else []
        suffixes.extend(item for item in US_F10_FALLBACK_SUFFIXES if item not in suffixes)
        candidates = [f"{code}.{suffix}" for suffix in suffixes]

    for params in candidates:
        payload = fetch_json(
            F10_EVENT_URL,
            {
                "type": report,
                "params": params,
                "p": 1,
                "source": "SECURITIES",
                "client": "SW",
            },
            headers={"Referer": "https://emweb.eastmoney.com/"},
        )
        rows = _flatten_f10(payload)
        if rows:
            return rows
    return []


def build_cn_earnings(rows: list[dict], today: date | None = None) -> dict:
    current = today or now_shanghai().date()
    prepared: list[tuple[date, dict]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        report_day = _parse_day(row.get("REPORT_DATE"))
        if report_day:
            prepared.append((report_day, row))
    if not prepared:
        return {"market": "CN", "next": None, "recent": [], "source": "东方财富预约披露"}
    prepared.sort(key=lambda item: item[0])

    future: list[tuple[date, date, dict]] = []
    for report_day, row in prepared:
        publish_day = _parse_day(
            row.get("APPOINT_PUBLISH_DATE") or row.get("FIRST_APPOINT_DATE")
        )
        if (
            publish_day
            and publish_day >= current
            and str(row.get("IS_PUBLISH") or "") != "1"
        ):
            future.append((publish_day, report_day, row))

    next_info: dict | None = None
    if future:
        publish_day, _report_day, row = min(future, key=lambda item: item[0])
        next_info = {
            "date": publish_day.isoformat(),
            "label": _clean_text(row.get("REPORT_TYPE_NAME"), 40) or "财报",
            "estimated": False,
            "source": "交易所预约披露",
        }
    else:
        report_day, latest = prepared[-1]
        try:
            latest_type = int(latest.get("REPORT_TYPE"))
        except (TypeError, ValueError):
            latest_type = 4
        next_type = REPORT_NEXT_TYPE.get(latest_type, 1)
        if latest_type == 1:
            period = date(report_day.year, 6, 30)
        elif latest_type == 2:
            period = date(report_day.year, 9, 30)
        elif latest_type == 3:
            period = date(report_day.year, 12, 31)
        else:
            period = date(report_day.year + 1, 3, 31)

        same_type = [
            (day, row)
            for day, row in prepared
            if str(row.get("REPORT_TYPE")) == str(next_type)
        ]
        if same_type:
            _base_day, base_row = same_type[-1]
            base_publish = _parse_day(
                base_row.get("ACTUAL_PUBLISH_DATE")
                or base_row.get("APPOINT_PUBLISH_DATE")
            )
            estimate = _add_year(base_publish or _base_day)
        else:
            estimate = period + timedelta(days=30)
        estimate = _next_business_day(estimate)
        deadline_year = period.year + (1 if next_type == 4 else 0)
        deadline = date(deadline_year, *REPORT_DEADLINES[next_type])
        if estimate > deadline:
            estimate = deadline
        if estimate < period:
            estimate = _next_business_day(period + timedelta(days=15))
        if estimate < current:
            estimate = _next_business_day(max(current, period))
        next_info = {
            "date": estimate.isoformat(),
            "label": f"{period.year}年 {REPORT_LABELS[next_type]}",
            "estimated": True,
            "source": "按历史披露规律估算",
        }

    recent: list[dict] = []
    for report_day, row in reversed(prepared):
        if str(row.get("IS_PUBLISH") or "") != "1":
            continue
        publish_day = _parse_day(
            row.get("ACTUAL_PUBLISH_DATE") or row.get("APPOINT_PUBLISH_DATE")
        )
        if not publish_day or publish_day > current:
            continue
        try:
            report_type = int(row.get("REPORT_TYPE") or 0)
        except (TypeError, ValueError):
            report_type = 0
        recent.append(
            {
                "date": publish_day.isoformat(),
                "label": _clean_text(row.get("REPORT_TYPE_NAME"), 40)
                or f"{report_day.year}年 {REPORT_LABELS.get(report_type, '财报')}",
            }
        )
        if len(recent) >= 2:
            break
    return {"market": "CN", "next": next_info, "recent": recent, "source": "东方财富预约披露"}


def _report_kind(value: object) -> str:
    text = str(value or "").replace("预披露", "").replace("披露", "").strip()
    text = re.sub(r"[（(].*?[）)]", " ", text).strip()
    if "一季" in text:
        return "一季报"
    if "中报" in text or "半年" in text:
        return "中报"
    if "三季" in text:
        return "三季报"
    if "年报" in text or "年度" in text:
        return "年报"
    return text or "财报"


def _report_label(content: str, kind: str, year_offset: int = 0) -> str:
    match = re.search(r"(\d{4})\s*财年", content)
    if match:
        return f"{int(match.group(1)) + year_offset}财年 {kind}"
    match = re.search(r"(\d{4})\s*年", content)
    if match:
        return f"{int(match.group(1)) + year_offset}年 {kind}"
    return kind


def _label_year(content: str) -> int | None:
    match = re.search(r"(\d{4})\s*财年", content) or re.search(r"(\d{4})\s*年", content)
    return int(match.group(1)) if match else None


def _estimated_report_label(content: str, kind: str, year_offset: int) -> str:
    year = _label_year(content)
    if year is None:
        return f"{kind}（预计）"
    marker = "财年" if "财年" in content else "年"
    return f"{year + year_offset}{marker} {kind}（预计）"


def build_f10_earnings(rows: list[dict], market: int, today: date | None = None) -> dict:
    current = today or now_shanghai().date()
    market_group = "HK" if market == 116 else "US"
    source = "港交所披露日程" if market == 116 else "交易所披露日程"
    events: list[dict] = []
    for row in rows:
        if str(row.get("EVENT_TYPE")) != "报表披露":
            continue
        day = _parse_day(row.get("NOTICE_DATE"))
        if not day:
            continue
        events.append(
            {
                "day": day,
                "kind": _report_kind(row.get("SPECIFIC_EVENTTYPE")),
                "content": _clean_text(row.get("LEVEL1_CONTENT"), 160),
            }
        )
    events.sort(key=lambda item: item["day"])
    if not events:
        return {"market": market_group, "next": None, "recent": [], "source": source}

    future = [event for event in events if event["day"] >= current]
    next_info: dict
    if future:
        event = future[0]
        next_info = {
            "date": event["day"].isoformat(),
            "label": _report_label(event["content"], event["kind"]),
            "estimated": False,
            "source": source,
            "detail": event["content"],
        }
    else:
        latest = events[-1]
        observed = {event["kind"] for event in events}
        cycle = REPORT_CYCLE
        if market == 116 and not ({"一季报", "三季报"} & observed) and {"中报", "年报"} <= observed:
            cycle = {"中报": "年报", "年报": "中报"}
        next_kind = cycle.get(latest["kind"], "一季报")
        same_kind = [
            event for event in events if event["kind"] == next_kind and event["day"] < current
        ]
        if same_kind:
            base = same_kind[-1]
            estimate = _add_year(base["day"])
            year_offset = 1
        else:
            base = latest
            estimate = latest["day"] + timedelta(days=91)
            year_offset = 1 if latest["kind"] == "年报" else 0
        kind = next_kind
        guard = 0
        while estimate < current and guard < 12:
            estimate += timedelta(days=91)
            kind = cycle.get(kind, "一季报")
            if kind == "一季报":
                year_offset += 1
            guard += 1
        estimate = _next_business_day(estimate)
        next_info = {
            "date": estimate.isoformat(),
            "label": _estimated_report_label(base["content"], kind, year_offset),
            "estimated": True,
            "source": "按历史披露规律估算",
            "detail": "",
        }

    recent: list[dict] = []
    for event in reversed(events):
        if event["day"] > current:
            continue
        recent.append(
            {
                "date": event["day"].isoformat(),
                "label": _report_label(event["content"], event["kind"]),
            }
        )
        if len(recent) >= 2:
            break
    return {"market": market_group, "next": next_info, "recent": recent, "source": source}


def load_earnings(symbol: str) -> dict:
    market, code = parse_symbol(symbol)
    if market in (0, 1):
        return build_cn_earnings(_fetch_cn_appointments(code))
    if market == 116 or market in (105, 106, 107):
        return build_f10_earnings(_fetch_f10_events(market, code), market)
    raise ApiError("NO_EARNINGS", "该标的没有财报日程", 404)


# ---------------------------------------------------------------------------
# AI 预测：本地 SQLite 记录 + 大模型 / 本地量化模型
# ---------------------------------------------------------------------------

PREDICTION_SCHEMA = """
CREATE TABLE IF NOT EXISTS predictions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    code TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL DEFAULT '',
    market TEXT NOT NULL DEFAULT '',
    market_label TEXT NOT NULL DEFAULT '',
    currency TEXT NOT NULL DEFAULT 'CNY',
    base_date TEXT NOT NULL,
    base_close REAL,
    target_date TEXT NOT NULL,
    direction INTEGER NOT NULL,
    confidence REAL,
    reason TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    engine TEXT NOT NULL DEFAULT 'local',
    revision INTEGER NOT NULL DEFAULT 1,
    user_choice INTEGER,
    user_direction INTEGER,
    user_updated_at TEXT,
    actual_direction INTEGER,
    actual_pct REAL,
    actual_date TEXT,
    settled_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_predictions_symbol ON predictions (symbol, target_date DESC);
CREATE INDEX IF NOT EXISTS idx_predictions_pending ON predictions (actual_direction);
"""

_prediction_db_ready = False
_prediction_db_lock = threading.Lock()
_prediction_write_lock = threading.Lock()


def prediction_db() -> sqlite3.Connection:
    PREDICTION_DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(PREDICTION_DB_PATH), timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn


def ensure_prediction_db() -> None:
    global _prediction_db_ready
    if _prediction_db_ready:
        return
    with _prediction_db_lock:
        if _prediction_db_ready:
            return
        conn = prediction_db()
        try:
            conn.executescript(PREDICTION_SCHEMA)
            conn.commit()
        finally:
            conn.close()
        _prediction_db_ready = True


def next_weekday(day: date) -> date:
    """下一交易日（按工作日估算；遇到休市时以实际出现的下一根日 K 结算）。"""
    following = day + timedelta(days=1)
    while following.weekday() >= 5:
        following += timedelta(days=1)
    return following


def bar_settleable(market: int, bar_date: str, now: datetime | None = None) -> bool:
    """判断某根日 K 是否已经收盘，避免把盘中未完成的一天当成实际涨跌。"""
    try:
        day = date.fromisoformat(bar_date)
    except (TypeError, ValueError):
        return False
    current = now or now_shanghai()
    if day > current.date():
        return False
    minutes = current.hour * 60 + current.minute
    if market in (0, 1):
        if day < current.date():
            return True
        return minutes >= 15 * 60 + 5
    if market == 116:
        if day < current.date():
            return True
        return minutes >= 16 * 60 + 10
    if market in COMMODITY_MARKETS:
        # COMEX / NYMEX 日 K 以美东交易日命名，北京时间次日 06:00 收盘。
        if day == current.date():
            return False
        if day == current.date() - timedelta(days=1) and minutes < 6 * 60 + 5:
            return False
        return True
    # 美股日 K 的日期是美东交易日：北京时间 21:30 开盘、次日 05:00 收盘，
    # 因此“昨天”的美股日 K 在凌晨 05:00 之前仍然没有走完。
    if day == current.date():
        return False
    if day == current.date() - timedelta(days=1) and minutes < 5 * 60:
        return False
    return True


def prediction_bars(symbol: str) -> dict | None:
    try:
        bundle, _state = cached_json(
            f"daily:{symbol}", 300, lambda: load_daily_bars(symbol)
        )
        return bundle
    except ApiError:
        return None


def prediction_rows(symbol: str | None = None) -> list[dict]:
    ensure_prediction_db()
    conn = prediction_db()
    try:
        if symbol:
            rows = conn.execute(
                "SELECT * FROM predictions WHERE symbol = ? ORDER BY target_date DESC, id DESC",
                (symbol,),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM predictions ORDER BY target_date DESC, id DESC"
            ).fetchall()
    finally:
        conn.close()
    return [dict(row) for row in rows]


def get_pending_prediction(symbol: str) -> dict | None:
    ensure_prediction_db()
    conn = prediction_db()
    try:
        row = conn.execute(
            "SELECT * FROM predictions WHERE symbol = ? AND actual_direction IS NULL "
            "ORDER BY target_date DESC, id DESC LIMIT 1",
            (symbol,),
        ).fetchone()
    finally:
        conn.close()
    return dict(row) if row else None


def get_latest_prediction(symbol: str) -> dict | None:
    ensure_prediction_db()
    conn = prediction_db()
    try:
        row = conn.execute(
            "SELECT * FROM predictions WHERE symbol = ? ORDER BY target_date DESC, id DESC LIMIT 1",
            (symbol,),
        ).fetchone()
    finally:
        conn.close()
    return dict(row) if row else None


def settle_predictions(symbol: str | None = None, now: datetime | None = None) -> int:
    """把已经收盘的预测补上实际涨跌；返回本次结算条数。"""
    ensure_prediction_db()
    current = now or now_shanghai()
    conn = prediction_db()
    try:
        if symbol:
            rows = conn.execute(
                "SELECT * FROM predictions WHERE actual_direction IS NULL AND symbol = ?",
                (symbol,),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM predictions WHERE actual_direction IS NULL "
                "ORDER BY target_date DESC LIMIT 200"
            ).fetchall()
    finally:
        conn.close()
    if not rows:
        return 0

    grouped: dict[str, list[dict]] = {}
    for row in rows:
        grouped.setdefault(row["symbol"], []).append(dict(row))
    symbols = list(grouped)[:MAX_SETTLE_SYMBOLS]

    bundles: dict[str, dict | None] = {}
    with ThreadPoolExecutor(max_workers=min(6, len(symbols))) as pool:
        futures = {pool.submit(prediction_bars, item): item for item in symbols}
        for future in as_completed(futures):
            item = futures[future]
            bundles[item] = future.result()

    settled = 0
    with _prediction_write_lock:
        conn = prediction_db()
        try:
            for item in symbols:
                bundle = bundles.get(item)
                if not bundle:
                    continue
                try:
                    market = parse_symbol(item)[0]
                except ApiError:
                    continue
                bars = bundle.get("items") or []
                for row in grouped[item]:
                    following = next(
                        (bar for bar in bars if bar["date"] > row["base_date"]), None
                    )
                    if following is None:
                        continue
                    if not bar_settleable(market, following["date"], current):
                        continue
                    pct = float(following.get("pct") or 0.0)
                    actual = 1 if pct > 0 else (-1 if pct < 0 else 0)
                    stamp = iso_time(current)
                    cursor = conn.execute(
                        "UPDATE predictions SET actual_direction = ?, actual_pct = ?, "
                        "actual_date = ?, settled_at = ?, updated_at = ? "
                        "WHERE id = ? AND actual_direction IS NULL",
                        (actual, rounded(pct), following["date"], stamp, stamp, row["id"]),
                    )
                    settled += max(cursor.rowcount, 0)
            conn.commit()
        finally:
            conn.close()
    return settled


def serialize_prediction(row: dict) -> dict:
    actual = row.get("actual_direction")
    user_direction = row.get("user_direction")
    ai_correct = None
    if actual is not None and actual != 0:
        ai_correct = int(row.get("direction") or 0) == actual
    user_correct = None
    if actual is not None and actual != 0 and user_direction is not None:
        user_correct = user_direction == actual
    engine = row.get("engine") or "local"
    base_incomplete = False
    try:
        market_number = int(str(row.get("symbol") or "").split(".")[0])
        base_incomplete = not bar_settleable(market_number, str(row.get("base_date") or ""))
    except (TypeError, ValueError):
        base_incomplete = False
    return {
        "id": row.get("id"),
        "symbol": row.get("symbol"),
        "code": row.get("code"),
        "name": row.get("name"),
        "market": row.get("market"),
        "marketLabel": row.get("market_label"),
        "currency": row.get("currency"),
        "baseDate": row.get("base_date"),
        "baseClose": row.get("base_close"),
        "baseIncomplete": base_incomplete,
        "targetDate": row.get("target_date"),
        "direction": row.get("direction"),
        "directionLabel": "看涨" if row.get("direction") == 1 else "看跌",
        "confidence": row.get("confidence"),
        "reason": row.get("reason") or "",
        "model": row.get("model") or "",
        "engine": engine,
        "engineLabel": "本地量化模型" if engine == "local" else (row.get("model") or "AI 模型"),
        "revision": row.get("revision") or 1,
        "userChoice": None if row.get("user_choice") is None else bool(row.get("user_choice")),
        "userDirection": user_direction,
        "userUpdatedAt": row.get("user_updated_at"),
        "status": "pending" if actual is None else "settled",
        "actualDirection": actual,
        "actualPct": row.get("actual_pct"),
        "actualDate": row.get("actual_date"),
        "settledAt": row.get("settled_at"),
        "aiCorrect": ai_correct,
        "userCorrect": user_correct,
        "createdAt": row.get("created_at"),
        "updatedAt": row.get("updated_at"),
    }


def _rate(correct: int, total: int) -> float | None:
    return round(correct / total * 100, 1) if total else None


def compute_stats(rows: list[dict]) -> dict:
    settled = [row for row in rows if row.get("actual_direction") is not None]
    decided = [row for row in settled if row.get("actual_direction") != 0]
    pending = len(rows) - len(settled)
    ai_correct = sum(
        1 for row in decided if row.get("direction") == row.get("actual_direction")
    )
    voted = [row for row in decided if row.get("user_direction") is not None]
    user_correct = sum(
        1 for row in voted if row.get("user_direction") == row.get("actual_direction")
    )
    agree = sum(1 for row in rows if row.get("user_choice") == 1)
    disagree = sum(1 for row in rows if row.get("user_choice") == 0)
    votes = agree + disagree

    ordered = sorted(
        decided, key=lambda row: (row.get("actual_date") or "", row.get("id") or 0), reverse=True
    )
    streak = 0
    for row in ordered:
        if row.get("direction") == row.get("actual_direction"):
            streak += 1
        else:
            break

    return {
        "samples": {
            "settled": len(settled),
            "decided": len(decided),
            "flat": len(settled) - len(decided),
            "pending": pending,
            "votes": votes,
        },
        "ai": {
            "correct": ai_correct,
            "decided": len(decided),
            "rate": _rate(ai_correct, len(decided)),
            "streak": streak,
        },
        "user": {
            "correct": user_correct,
            "decided": len(voted),
            "rate": _rate(user_correct, len(voted)),
            "agree": agree,
            "disagree": disagree,
            "agreeRate": _rate(agree, votes),
        },
    }


def build_prediction_stats(symbol: str | None = None) -> dict:
    rows = prediction_rows(symbol)
    grouped: dict[str, list[dict]] = {}
    for row in rows:
        grouped.setdefault(row["symbol"], []).append(row)

    stocks = []
    if not symbol:
        for item, stock_rows in grouped.items():
            stats = compute_stats(stock_rows)
            last = next(
                (row for row in stock_rows if row.get("actual_direction") is not None), None
            )
            last_result = None
            if last is not None and last.get("actual_direction") != 0:
                last_result = last.get("direction") == last.get("actual_direction")
            stocks.append(
                {
                    "symbol": item,
                    "code": stock_rows[0].get("code") or "",
                    "name": stock_rows[0].get("name") or item,
                    "marketLabel": stock_rows[0].get("market_label") or "",
                    "settled": stats["samples"]["settled"],
                    "pending": stats["samples"]["pending"],
                    "ai": stats["ai"],
                    "user": stats["user"],
                    "lastResult": last_result,
                    "lastDate": (last or {}).get("actual_date"),
                }
            )
        stocks.sort(
            key=lambda stock: (
                -(stock["settled"] + stock["pending"]),
                stock["code"] or stock["symbol"],
            )
        )

    recent = [row for row in rows if row.get("actual_direction") is not None][:20]
    return {
        "scope": symbol or "all",
        "overall": compute_stats(rows),
        "stocks": stocks,
        "recent": [serialize_prediction(row) for row in recent],
        "generatedAt": iso_time(),
    }


def load_ai_config() -> dict:
    config: dict[str, object] = {
        "apiKey": "",
        "baseUrl": AI_DEFAULT_BASE_URL,
        "model": AI_DEFAULT_MODEL,
        "timeout": 30.0,
    }
    try:
        raw = AI_CONFIG_PATH.read_text(encoding="utf-8")
    except OSError:
        raw = ""
    if raw.strip():
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            payload = None
        if isinstance(payload, dict):
            for key in ("apiKey", "baseUrl", "model"):
                value = payload.get(key)
                if isinstance(value, str) and value.strip():
                    config[key] = value.strip()
            timeout = number(payload.get("timeout"))
            if timeout is not None and 3 <= timeout <= 120:
                config["timeout"] = float(timeout)

    env_key = (
        os.environ.get("AI_API_KEY")
        or os.environ.get("DEEPSEEK_API_KEY")
        or os.environ.get("OPENAI_API_KEY")
        or ""
    ).strip()
    if env_key:
        config["apiKey"] = env_key
    env_base = (os.environ.get("AI_BASE_URL") or "").strip()
    if env_base:
        config["baseUrl"] = env_base
    env_model = (os.environ.get("AI_MODEL") or "").strip()
    if env_model:
        config["model"] = env_model

    config["baseUrl"] = str(config["baseUrl"]).rstrip("/")
    config["configured"] = bool(config["apiKey"])
    return config


def ai_public_config() -> dict:
    config = load_ai_config()
    host = urlparse(str(config["baseUrl"])).hostname or ""
    if "deepseek" in host:
        provider = "DeepSeek"
    elif "openai" in host:
        provider = "OpenAI"
    elif "moonshot" in host:
        provider = "Moonshot"
    else:
        provider = host or "自定义接口"
    return {
        "configured": bool(config["configured"]),
        "model": config["model"],
        "provider": provider,
        "engine": "ai" if config["configured"] else "local",
        "engineLabel": config["model"] if config["configured"] else "本地量化模型",
    }


def build_prediction_context(symbol: str) -> dict:
    bundle, _state = cached_json(f"daily:{symbol}", 300, lambda: load_daily_bars(symbol))
    items = bundle.get("items") or []
    if not items:
        raise ApiError("NO_HISTORY", "没有可用于预测的历史行情", 404)
    base = items[-1]
    base_day = date.fromisoformat(base["date"])
    market = parse_symbol(symbol)[0]
    now = now_shanghai()
    return {
        "symbol": symbol,
        "stock": bundle["stock"],
        "bars": items,
        "base": base,
        "baseDate": base["date"],
        "baseClose": base.get("close"),
        "baseIncomplete": not bar_settleable(market, base["date"], now),
        "targetDate": next_weekday(base_day).isoformat(),
    }


def _direction_from_text(text: str) -> int:
    value = str(text or "").strip().lower()
    if value in ("up", "rise", "bull", "bullish", "long", "1", "+1", "涨", "上涨", "看涨"):
        return 1
    if value in ("down", "fall", "bear", "bearish", "short", "-1", "跌", "下跌", "看跌"):
        return -1
    if re.search(r"\b(up|rise|bull|bullish|long)\b", value):
        return 1
    if re.search(r"\b(down|fall|bear|bearish|short)\b", value):
        return -1
    if "下跌" in value or "看跌" in value or "跌" in value:
        return -1
    if "上涨" in value or "看涨" in value or "涨" in value:
        return 1
    return 0


def parse_ai_reply(text: str) -> dict:
    cleaned = (text or "").strip()
    if not cleaned:
        raise ApiError("AI_BAD_RESPONSE", "AI 没有返回预测内容，请重新预测")
    match = re.search(r"\{.*\}", cleaned, re.S)
    payload = None
    if match:
        try:
            payload = json.loads(match.group(0))
        except json.JSONDecodeError:
            payload = None

    direction = 0
    confidence = None
    reason = ""
    if isinstance(payload, dict):
        direction = _direction_from_text(
            str(payload.get("direction") or payload.get("trend") or payload.get("prediction") or "")
        )
        confidence = number(payload.get("confidence"))
        reason = str(payload.get("reason") or payload.get("rationale") or "").strip()
    if not direction:
        direction = _direction_from_text(cleaned)
    if not direction:
        raise ApiError("AI_BAD_RESPONSE", "AI 返回的涨跌方向无法解析，请重新预测")

    if confidence is None:
        confidence = 0.6
    if confidence > 1:
        confidence = confidence / 100
    confidence = max(0.5, min(0.99, confidence))
    reason = re.sub(r"\s+", " ", reason)[:80] or "模型没有给出具体理由"
    return {"direction": direction, "confidence": round(confidence, 3), "reason": reason}


def _http_error_detail(exc: HTTPError) -> str:
    """提取上游错误信息用于提示，截断并做换行清洗。"""
    try:
        raw = exc.read().decode("utf-8", errors="replace")
    except (OSError, ValueError):
        return ""
    text = raw.strip()
    if not text:
        return ""
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        payload = None
    if isinstance(payload, dict):
        error = payload.get("error")
        message = error.get("message") if isinstance(error, dict) else None
        if not message:
            message = payload.get("message")
        if message:
            text = str(message)
    return re.sub(r"\s+", " ", text).strip()[:160]


def call_ai_prediction(context: dict, config: dict) -> dict:
    stock = context["stock"]
    base = context["base"]
    bars = context["bars"][-30:]
    lines = [
        f"{bar['date']},{bar['close']},{float(bar.get('pct') or 0):+.2f}%,{int(bar.get('volume') or 0)}"
        for bar in bars
    ]
    is_commodity = stock.get("market") == "COMMODITY"
    noun = "这个品种" if is_commodity else "这只股票"
    label = "品种" if is_commodity else "股票"
    prompt = (
        f"请只根据下面{noun}最近 30 个交易日的日线数据，判断其在下一交易日"
        f"（{context['targetDate']}）的收盘价相对基准收盘（{context['baseDate']} 收 {context['baseClose']}）"
        "是上涨还是下跌。\n\n"
        f"{label}：{stock.get('name')}（{stock.get('code')}，{stock.get('marketLabel')} · {stock.get('exchange')}）\n"
        f"基准日：{context['baseDate']}，收盘 {context['baseClose']}\n"
        f"预测目标日：{context['targetDate']}\n\n"
        "最近日线（日期,收盘,涨跌幅,成交量）：\n" + "\n".join(lines) + "\n\n"
        "要求：\n"
        '1. 只输出一个 JSON 对象，不要输出 Markdown 或任何解释文字。\n'
        '2. 格式：{"direction":"up" 或 "down","confidence":0.5 到 1 之间的小数,"reason":"不超过 40 个字的中文理由"}\n'
        '3. direction 只能是 "up"（上涨）或 "down"（下跌）。\n'
    )
    payload = {
        "model": config["model"],
        "messages": [
            {"role": "system", "content": "你是一位严谨的量化分析师，回答必须是合法 JSON。"},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.2,
        "max_tokens": 300,
        "stream": False,
    }
    host = (urlparse(str(config["baseUrl"])).hostname or "").lower()
    if "deepseek" in host:
        # DeepSeek 默认开启思考模式，会消耗 max_tokens 并拖慢一次简单的方向判断；
        # 同时用 JSON 模式保证返回可解析。
        payload["thinking"] = {"type": "disabled"}
        payload["response_format"] = {"type": "json_object"}
    elif "openai" in host:
        payload["response_format"] = {"type": "json_object"}

    request = Request(
        f"{str(config['baseUrl']).rstrip('/')}/chat/completions",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Authorization": f"Bearer {config['apiKey']}",
        },
        method="POST",
    )
    try:
        with urlopen(request, timeout=float(config.get("timeout") or 30)) as response:
            body = response.read().decode("utf-8", errors="replace")
    except HTTPError as exc:
        detail = _http_error_detail(exc)
        api_key = str(config.get("apiKey") or "")
        if detail and api_key:
            detail = detail.replace(api_key, "***")
        note = f"（{detail}）" if detail else ""
        if exc.code in (401, 403):
            raise ApiError(
                "AI_AUTH_FAILED",
                f"AI 接口鉴权失败{note}，请检查 data/ai_config.json 或 AI_API_KEY",
                502,
            ) from exc
        if exc.code == 429:
            raise ApiError("AI_RATE_LIMITED", "AI 接口请求过于频繁，请稍后再试", 429) from exc
        raise ApiError(
            "AI_HTTP_ERROR", f"AI 接口返回 {exc.code}{note}，请稍后重试", 502
        ) from exc
    except (URLError, TimeoutError, OSError) as exc:
        raise ApiError(
            "AI_UNAVAILABLE", "无法连接 AI 接口，请检查网络与 Base URL 配置", 502
        ) from exc

    try:
        result = json.loads(body)
    except json.JSONDecodeError as exc:
        raise ApiError("AI_BAD_RESPONSE", "AI 接口返回了无法解析的内容", 502) from exc
    choices = result.get("choices") if isinstance(result, dict) else None
    content = ""
    if choices:
        message = (choices[0] or {}).get("message") or {}
        raw_content = message.get("content")
        if isinstance(raw_content, str):
            content = raw_content
        elif isinstance(raw_content, list):
            content = "".join(
                str(part.get("text") or "")
                for part in raw_content
                if isinstance(part, dict)
            )
    if not content.strip():
        raise ApiError("AI_BAD_RESPONSE", "AI 没有返回预测内容，请重新预测", 502)
    return parse_ai_reply(content)


def local_prediction(bars: list[dict], include_volume: bool = True) -> dict:
    """无 API Key 时的本地量化模型：动量 + 均线偏离 + 涨跌宽度 + 量能 + 短线反转。"""
    usable = [bar for bar in bars if bar.get("close") is not None]
    if len(usable) < 2:
        raise ApiError("LOCAL_MODEL_NO_DATA", "历史数据太少，暂时无法生成预测", 422)
    closes = [float(bar["close"]) for bar in usable]
    last = closes[-1]

    def change(period: int) -> float:
        if len(closes) <= period:
            return 0.0
        origin = closes[-1 - period]
        return (last / origin - 1) * 100 if origin else 0.0

    mom5 = change(5)
    mom10 = change(10)
    mom20 = change(20)
    ma20_window = closes[-20:]
    ma20 = sum(ma20_window) / len(ma20_window)
    bias20 = (last / ma20 - 1) * 100 if ma20 else 0.0
    recent = usable[-20:]
    pcts = [float(bar.get("pct") or 0) for bar in recent]
    up_days = sum(1 for value in pcts if value > 0)
    down_days = sum(1 for value in pcts if value < 0)
    volumes = [float(bar.get("volume") or 0) for bar in recent]
    avg_volume20 = sum(volumes) / len(volumes)
    avg_volume5 = sum(volumes[-5:]) / len(volumes[-5:])
    volume_ratio = avg_volume5 / avg_volume20 if avg_volume20 else 1.0
    last_pct = pcts[-1] if pcts else 0.0

    score = (
        0.55 * math.tanh(mom5 / 2.5)
        + 0.30 * math.tanh(mom10 / 4.5)
        + 0.20 * math.tanh(mom20 / 8.0)
        + 0.20 * ((up_days - down_days) / max(1, len(pcts)))
        + 0.12 * math.tanh(bias20 / 3.0)
        - 0.18 * math.tanh(last_pct / 3.0)
    )
    prob_up = 1 / (1 + math.exp(-score))
    direction = 1 if prob_up >= 0.5 else -1
    confidence = max(0.5, min(0.95, 0.5 + abs(prob_up - 0.5) * 1.6))

    parts = [
        f"5日动量 {mom5:+.1f}%",
        f"20日动量 {mom20:+.1f}%",
        f"收盘{'高于' if bias20 >= 0 else '低于'}20日均线 {abs(bias20):.1f}%",
        f"近20日 {up_days} 涨 {down_days} 跌",
    ]
    if include_volume:
        parts.append("量能放大" if volume_ratio >= 1.15 else ("量能萎缩" if volume_ratio <= 0.85 else "量能平稳"))
    if last_pct >= 3:
        parts.append("短线偏热，注意回撤")
    elif last_pct <= -3:
        parts.append("短线超跌，存在反抽")
    parts.append("综合偏多" if direction > 0 else "综合偏空")
    return {
        "direction": direction,
        "confidence": round(confidence, 3),
        "reason": "，".join(parts)[:80],
    }


def predict_for_symbol(symbol: str, force: bool = False) -> dict:
    """生成（或按用户要求重新生成）下一交易日预测，并写入 SQLite。"""
    ensure_prediction_db()
    settle_predictions(symbol)
    with _prediction_write_lock:
        pending = get_pending_prediction(symbol)
        if pending and not force:
            return {
                "prediction": serialize_prediction(pending),
                "cached": True,
                "created": False,
            }

        context = build_prediction_context(symbol)
        config = load_ai_config()
        if config["configured"]:
            result = call_ai_prediction(context, config)
            engine = "ai"
            model = str(config["model"])
        else:
            result = local_prediction(
                context["bars"],
                include_volume=context["stock"].get("key") != "usdcnh",
            )
            engine = "local"
            model = "local-quant-v1"

        stock = context["stock"]
        stamp = iso_time()
        conn = prediction_db()
        try:
            if pending:
                direction_changed = (
                    int(pending.get("direction") or 0) != result["direction"]
                    or pending.get("target_date") != context["targetDate"]
                )
                if direction_changed:
                    user_choice = None
                    user_direction = None
                    user_updated_at = None
                else:
                    user_choice = pending.get("user_choice")
                    user_direction = pending.get("user_direction")
                    user_updated_at = pending.get("user_updated_at")
                conn.execute(
                    "UPDATE predictions SET code = ?, name = ?, market = ?, market_label = ?, "
                    "currency = ?, base_date = ?, base_close = ?, target_date = ?, direction = ?, "
                    "confidence = ?, reason = ?, model = ?, engine = ?, revision = revision + 1, "
                    "user_choice = ?, user_direction = ?, user_updated_at = ?, updated_at = ? "
                    "WHERE id = ?",
                    (
                        stock.get("code") or "",
                        stock.get("name") or "",
                        stock.get("market") or "",
                        stock.get("marketLabel") or "",
                        stock.get("currency") or "CNY",
                        context["baseDate"],
                        context["baseClose"],
                        context["targetDate"],
                        result["direction"],
                        result["confidence"],
                        result["reason"],
                        model,
                        engine,
                        user_choice,
                        user_direction,
                        user_updated_at,
                        stamp,
                        pending["id"],
                    ),
                )
                conn.commit()
                row = conn.execute(
                    "SELECT * FROM predictions WHERE id = ?", (pending["id"],)
                ).fetchone()
                created = False
            else:
                cursor = conn.execute(
                    "INSERT INTO predictions (symbol, code, name, market, market_label, currency, "
                    "base_date, base_close, target_date, direction, confidence, reason, model, engine, "
                    "revision, created_at, updated_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)",
                    (
                        symbol,
                        stock.get("code") or "",
                        stock.get("name") or "",
                        stock.get("market") or "",
                        stock.get("marketLabel") or "",
                        stock.get("currency") or "CNY",
                        context["baseDate"],
                        context["baseClose"],
                        context["targetDate"],
                        result["direction"],
                        result["confidence"],
                        result["reason"],
                        model,
                        engine,
                        stamp,
                        stamp,
                    ),
                )
                conn.commit()
                row = conn.execute(
                    "SELECT * FROM predictions WHERE id = ?", (cursor.lastrowid,)
                ).fetchone()
                created = True
        finally:
            conn.close()

    return {
        "prediction": serialize_prediction(dict(row)),
        "cached": False,
        "created": created,
    }


def record_prediction_vote(symbol: str, agree: bool) -> dict:
    settle_predictions(symbol)
    with _prediction_write_lock:
        pending = get_pending_prediction(symbol)
        if not pending:
            raise ApiError(
                "NO_PENDING_PREDICTION", "当前没有待结算的预测，无法记录你的看法", 409
            )
        user_direction = int(pending["direction"]) if agree else -int(pending["direction"])
        stamp = iso_time()
        conn = prediction_db()
        try:
            conn.execute(
                "UPDATE predictions SET user_choice = ?, user_direction = ?, "
                "user_updated_at = ?, updated_at = ? WHERE id = ?",
                (1 if agree else 0, user_direction, stamp, stamp, pending["id"]),
            )
            conn.commit()
            row = conn.execute(
                "SELECT * FROM predictions WHERE id = ?", (pending["id"],)
            ).fetchone()
        finally:
            conn.close()
    return serialize_prediction(dict(row))


# ---------------------------------------------------------------------------
# 市场热力图
# ---------------------------------------------------------------------------


_heatmap_members: dict | None = None
_heatmap_members_lock = threading.Lock()


def load_heatmap_members() -> dict:
    """读取随项目附带的标普 500 / 纳指 100 / 道指 30 成分股清单。"""
    global _heatmap_members
    if _heatmap_members is not None:
        return _heatmap_members
    with _heatmap_members_lock:
        if _heatmap_members is not None:
            return _heatmap_members
        try:
            payload = json.loads(HEATMAP_MEMBERS_PATH.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise ApiError(
                "HEATMAP_DATA_MISSING",
                "热力图成分股清单缺失，请重新生成 data/heatmap_members.json",
                500,
            ) from exc
        if not isinstance(payload, dict) or not isinstance(payload.get("markets"), dict):
            raise ApiError("HEATMAP_DATA_INVALID", "热力图成分股清单格式不正确", 500)
        _heatmap_members = payload["markets"]
        return _heatmap_members


def fetch_list_page(fs: str, page: int) -> list[dict]:
    payload = fetch_json(
        LIST_URL,
        {
            "pn": page,
            "pz": 100,
            "po": 1,
            "np": 1,
            "fltt": 2,
            "invt": 2,
            "fid": "f20",
            "fs": fs,
            "fields": HEATMAP_FIELDS,
        },
    )
    data = payload.get("data")
    if not isinstance(data, dict):
        return []
    return list(data.get("diff") or [])


def fetch_list_pages(fs: str, pages: int) -> list[dict]:
    """并行抓取东方财富列表分页，单页失败时保留其余页面。"""
    results: dict[int, list[dict]] = {}

    def load(page: int) -> tuple[int, list[dict]]:
        try:
            return page, fetch_list_page(fs, page)
        except ApiError:
            return page, []

    with ThreadPoolExecutor(max_workers=min(5, pages)) as pool:
        futures = [pool.submit(load, page) for page in range(1, pages + 1)]
        for future in as_completed(futures):
            page, rows = future.result()
            results[page] = rows

    combined: list[dict] = []
    for page in range(1, pages + 1):
        combined.extend(results.get(page, []))
    return combined


def fetch_batch_quotes(secids: list[str]) -> list[dict]:
    if not secids:
        return []
    payload = fetch_json(
        BATCH_URL,
        {
            "fltt": 2,
            "invt": 2,
            "secids": ",".join(secids),
            "fields": HEATMAP_FIELDS,
        },
    )
    data = payload.get("data")
    if not isinstance(data, dict):
        return []
    return list(data.get("diff") or [])


def detect_market_group(market: int) -> str:
    if market in (0, 1):
        return "CN"
    if market == 116:
        return "HK"
    return "US"


def normalize_sector(value: object) -> str:
    text = str(value or "").strip()
    if not text or text == "-":
        return "其他"
    text = re.sub(r"[ⅠⅡⅢⅣⅤ]+$", "", text).strip()
    return text or "其他"


def build_heatmap_item(
    raw: dict,
    market: int,
    display_code: str | None = None,
) -> dict | None:
    code = str(raw.get("f12") or "").strip()
    if not code:
        return None
    name = str(raw.get("f14") or code).strip()
    price = number(raw.get("f2"))
    change_pct = number(raw.get("f3"))
    market_cap = number(raw.get("f20"))
    volume = number(raw.get("f5"))
    if volume is not None and market in (0, 1):
        volume *= 100  # A 股接口的成交量单位是“手”

    high = number(raw.get("f15"))
    low = number(raw.get("f16"))
    prev_close = number(raw.get("f18"))
    amplitude = None
    if high is not None and low is not None and prev_close:
        amplitude = (high - low) / prev_close * 100

    return {
        "symbol": f"{market}.{code}",
        "code": display_code or code,
        "quoteCode": code,
        "name": name,
        "market": detect_market_group(market),
        "price": rounded(price),
        "changePct": rounded(change_pct),
        "marketCap": rounded(market_cap, 2),
        "amount": rounded(number(raw.get("f6")), 2),
        "volume": rounded(volume, 0),
        "turnoverPct": rounded(number(raw.get("f8"))),
        "amplitudePct": rounded(amplitude),
        "sector": normalize_sector(raw.get("f100")),
    }


def shanghai_rows() -> list[dict]:
    # t:2 是沪市主板，t:23 是科创板；合并后按总市值取前 500 只。
    rows = fetch_list_pages("m:1+t:2,m:1+t:23", 5)
    items: list[dict] = []
    seen: set[str] = set()
    for raw in rows:
        code = str(raw.get("f12") or "")
        name = str(raw.get("f14") or "")
        if not re.fullmatch(r"6\d{5}", code) or code in seen:
            continue
        if any(word in name for word in SH_EXCLUDE_WORDS):
            continue
        item = build_heatmap_item(raw, 1)
        if not item or not item.get("marketCap"):
            continue
        seen.add(code)
        items.append(item)
        if len(items) >= HEATMAP_MARKETS["shanghai"]["limit"]:
            break
    return items


def hk_rows() -> list[dict]:
    rows = fetch_list_pages("m:116+t:3", 5)
    items: list[dict] = []
    seen: set[str] = set()
    for raw in rows:
        code = str(raw.get("f12") or "")
        name = str(raw.get("f14") or "")
        if not HK_STOCK_RE.match(code) or code in seen or code.startswith("8"):
            continue
        if any(word in name for word in HK_EXCLUDE_WORDS):
            continue
        item = build_heatmap_item(raw, 116)
        if not item or not item.get("marketCap"):
            continue
        seen.add(code)
        items.append(item)
        if len(items) >= HEATMAP_MARKETS["hk"]["limit"]:
            break
    return items


def us_index_rows(market_key: str) -> tuple[list[dict], int]:
    config = load_heatmap_members().get(market_key)
    if not isinstance(config, dict):
        raise ApiError("HEATMAP_DATA_MISSING", "该指数暂时没有成分股清单", 500)
    members = [item for item in config.get("members") or [] if isinstance(item, dict)]
    member_map = {str(item.get("symbol")): item for item in members}
    secids = [str(item.get("symbol")) for item in members]
    chunks = [secids[index : index + 100] for index in range(0, len(secids), 100)]

    raw_items: list[dict] = []
    with ThreadPoolExecutor(max_workers=min(6, max(1, len(chunks)))) as pool:
        futures = [pool.submit(fetch_batch_quotes, chunk) for chunk in chunks]
        for future in as_completed(futures):
            raw_items.extend(future.result())

    items: list[dict] = []
    for raw in raw_items:
        try:
            market = int(raw.get("f13"))
        except (TypeError, ValueError):
            market = 105
        symbol = f"{market}.{raw.get('f12')}"
        member = member_map.get(symbol) or member_map.get(str(raw.get("f12")))
        display_code = str(member.get("code")) if member else None
        item = build_heatmap_item(raw, market, display_code)
        if item:
            items.append(item)
    return items, max(0, len(members) - len(items))


def build_heatmap_payload(market_key: str) -> dict:
    config = HEATMAP_MARKETS[market_key]
    if market_key == "shanghai":
        items = shanghai_rows()
        missing = 0
    elif market_key == "hk":
        items = hk_rows()
        missing = 0
    else:
        items, missing = us_index_rows(market_key)

    if not items:
        raise ApiError("NO_HEATMAP", "暂时没有获取到该市场的热力图数据", 502)

    for item in items:
        if item.get("marketCap") is None:
            item["marketCap"] = 0.0

    groups: dict[str, list[dict]] = {}
    for item in items:
        groups.setdefault(item["sector"], []).append(item)

    group_payload: list[dict] = []
    for sector, members in groups.items():
        members.sort(key=lambda item: item.get("marketCap") or 0, reverse=True)
        cap_total = sum(item.get("marketCap") or 0 for item in members)
        weighted_base = sum(
            (item.get("marketCap") or 0)
            for item in members
            if item.get("changePct") is not None
        )
        weighted_change = (
            sum(
                (item.get("marketCap") or 0) * item["changePct"]
                for item in members
                if item.get("changePct") is not None
            )
            / weighted_base
            if weighted_base
            else None
        )
        group_payload.append(
            {
                "name": sector,
                "count": len(members),
                "marketCap": rounded(cap_total, 2),
                "amount": rounded(sum(item.get("amount") or 0 for item in members), 2),
                "changePct": rounded(weighted_change),
                "items": members,
            }
        )
    group_payload.sort(key=lambda group: (-group["marketCap"], group["name"]))

    valid_changes = [item["changePct"] for item in items if item.get("changePct") is not None]
    up = sum(1 for value in valid_changes if value > 0.00001)
    down = sum(1 for value in valid_changes if value < -0.00001)
    flat = len(items) - up - down
    cap_values = [(item.get("marketCap") or 0) for item in items]
    cap_total = sum(cap_values)
    weighted_base = sum(
        (item.get("marketCap") or 0) for item in items if item.get("changePct") is not None
    )
    weighted_change = (
        sum(
            (item.get("marketCap") or 0) * item["changePct"]
            for item in items
            if item.get("changePct") is not None
        )
        / weighted_base
        if weighted_base
        else None
    )
    avg_change = sum(valid_changes) / len(valid_changes) if valid_changes else None

    return {
        "market": market_key,
        "label": config["label"],
        "name": config["name"],
        "currency": config["currency"],
        "scope": config["scope"],
        "decimals": 2 if config["currency"] in ("CNY", "USD") else 3,
        "count": len(items),
        "missing": missing,
        "groups": group_payload,
        "summary": {
            "count": len(items),
            "up": up,
            "down": down,
            "flat": flat,
            "upRatio": round(up / len(items) * 100, 2) if items else 0,
            "avgChangePct": rounded(avg_change),
            "weightedChangePct": rounded(weighted_change),
            "totalMarketCap": rounded(cap_total, 2),
            "totalAmount": rounded(sum(item.get("amount") or 0 for item in items), 2),
        },
        "updatedAt": iso_time(),
    }


def api_heatmap(params: dict[str, list[str]]) -> dict:
    market_key = single_param(params, "market", "us500")
    if market_key not in HEATMAP_MARKETS:
        raise ApiError("INVALID_MARKET", "热力图市场不正确", 400)
    force = single_param(params, "refresh") in ("1", "true", "yes")
    cache_key = f"heatmap:{market_key}"
    if force:
        cache_delete(cache_key)
    data, state = cached_json(cache_key, 90, lambda: build_heatmap_payload(market_key))
    data = dict(data)  # type: ignore[arg-type]
    data["_cache"] = state
    return data


# ---------------------------------------------------------------------------
# 大宗商品：黄金 / 白银 / 原油
# ---------------------------------------------------------------------------


def build_commodity_quote(config: dict) -> dict:
    """读取单一商品的实时快照，价格按接口给出的精度缩放。"""
    payload = fetch_json(
        QUOTE_URL,
        {"secid": config["symbol"], "fields": COMMODITY_FIELDS},
    )
    data = payload.get("data")
    if not isinstance(data, dict):
        raise ApiError("NO_COMMODITY_QUOTE", f"没有找到{config['name']}的实时行情", 404)

    decimals = int(number(data.get("f59")) or 2)
    price = scaled(data.get("f43"), decimals)
    prev_close = scaled(data.get("f60"), decimals)
    change = scaled(data.get("f169"), decimals)
    change_pct = number(data.get("f170"))
    change_pct = None if change_pct is None else change_pct / 100
    if change is None and price is not None and prev_close:
        change = price - prev_close
    if change_pct is None and change is not None and prev_close:
        change_pct = change / prev_close * 100

    quote_time = None
    timestamp = number(data.get("f86"))
    if timestamp:
        quote_time = datetime.fromtimestamp(timestamp, SHANGHAI_TZ).isoformat(timespec="seconds")

    code = str(data.get("f57") or config["symbol"].split(".", 1)[-1])
    return {
        "key": config["key"],
        "symbol": config["symbol"],
        "code": code,
        "name": config["name"],
        "contract": config["contract"],
        "exchange": config["exchange"],
        "unit": config["unit"],
        "board": str(config.get("board") or "商品"),
        "marketLabel": str(config.get("marketLabel") or "大宗商品"),
        "currency": str(config.get("currency") or "USD"),
        "price": rounded(price),
        "change": rounded(change),
        "changePct": rounded(change_pct),
        "open": rounded(scaled(data.get("f46"), decimals)),
        "high": rounded(scaled(data.get("f44"), decimals)),
        "low": rounded(scaled(data.get("f45"), decimals)),
        "prevClose": rounded(prev_close),
        "decimals": decimals,
        "quoteTime": quote_time,
        "updatedAt": iso_time(),
    }


def usd_cny_rate() -> float | None:
    """读取离岸美元兑人民币汇率，供金银的人民币/克换算。"""
    config = COMMODITY_BY_SYMBOL.get("133.USDCNH")
    if not config:
        return None
    try:
        quote, _state = cached_json(
            "commodity-rate:usdcnh", 20, lambda: build_commodity_quote(config)
        )
        rate = number(quote.get("price"))
        return rate if rate and rate > 0 else None
    except ApiError:
        return None


def load_commodities() -> dict:
    """并发读取商品与汇率，单个失败时保留其余结果。"""
    quotes: dict[str, dict] = {}
    errors: dict[str, str] = {}

    def load(config: dict) -> tuple[str, dict | None, str | None]:
        try:
            return config["key"], build_commodity_quote(config), None
        except ApiError as exc:
            return config["key"], None, exc.message

    with ThreadPoolExecutor(max_workers=len(COMMODITY_ITEMS)) as pool:
        futures = [pool.submit(load, config) for config in COMMODITY_ITEMS]
        for future in as_completed(futures):
            key, quote, error = future.result()
            if quote:
                quotes[key] = quote
            elif error:
                errors[key] = error

    rate = number((quotes.get("usdcnh") or {}).get("price"))
    if rate and rate > 0:
        for key in ("gold", "silver"):
            quote = quotes.get(key)
            if not quote or quote.get("price") is None:
                continue
            quote["cnyPrice"] = round(quote["price"] * rate / TROY_OUNCE_GRAMS, 2)
            quote["cnyUnit"] = "元/g"
            quote["cnyRate"] = round(rate, 4)

    items = [quotes[config["key"]] for config in COMMODITY_ITEMS if config["key"] in quotes]
    if not items:
        raise ApiError("COMMODITIES_UNAVAILABLE", "大宗商品行情暂时不可用", 502)
    return {"items": items, "errors": errors, "updatedAt": iso_time()}


def api_commodities(params: dict[str, list[str]]) -> dict:
    data, state = cached_json("commodities", 20, load_commodities)
    data = dict(data)  # type: ignore[arg-type]
    data["_cache"] = state
    return data


# ---------------------------------------------------------------------------
# API 分发
# ---------------------------------------------------------------------------


def single_param(params: dict[str, list[str]], key: str, default: str = "") -> str:
    return (params.get(key) or [default])[0].strip()


def api_search(params: dict[str, list[str]]) -> dict:
    query = single_param(params, "q")
    if not query:
        return {"query": "", "items": []}
    if len(query) > 40:
        raise ApiError("QUERY_TOO_LONG", "搜索关键词过长", 400)
    cache_key = f"search:{query.lower()}"
    items, state = cached_json(cache_key, 600, lambda: search_stocks(query))
    return {"query": query, "items": items, "_cache": state}


def api_quote(params: dict[str, list[str]]) -> dict:
    symbol = single_param(params, "symbol")
    parse_symbol(symbol)
    data, state = cached_json(f"quote:{symbol}", 20, lambda: get_quote(symbol))
    data = dict(data)  # type: ignore[arg-type]
    data["_cache"] = state
    return data


def api_quotes(params: dict[str, list[str]]) -> dict:
    raw = single_param(params, "symbols")
    symbols = list(dict.fromkeys(item.strip() for item in raw.split(",") if item.strip()))
    if not symbols:
        return {"items": {}, "errors": {}}
    if len(symbols) > 30:
        raise ApiError("TOO_MANY_SYMBOLS", "一次最多查询 30 只股票", 400)
    for symbol in symbols:
        parse_symbol(symbol)

    items: dict[str, dict] = {}
    errors: dict[str, str] = {}

    def load(symbol: str) -> tuple[str, dict | None, str | None]:
        try:
            data, _state = cached_json(f"quote:{symbol}", 20, lambda: get_quote(symbol))
            payload = dict(data)  # type: ignore[arg-type]
            payload.pop("_cache", None)
            payload.pop("_source", None)
            return symbol, payload, None
        except ApiError as exc:
            return symbol, None, exc.message

    workers = min(8, len(symbols))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(load, symbol) for symbol in symbols]
        for future in as_completed(futures):
            symbol, payload, error = future.result()
            if payload:
                items[symbol] = payload
            elif error:
                errors[symbol] = error
    return {"items": items, "errors": errors}


def api_intraday(params: dict[str, list[str]]) -> dict:
    symbol = single_param(params, "symbol")
    parse_symbol(symbol)
    data, state = cached_json(f"intraday:{symbol}", 20, lambda: get_intraday(symbol))
    data = dict(data)  # type: ignore[arg-type]
    data["_cache"] = state
    return data


def api_history(params: dict[str, list[str]]) -> dict:
    symbol = single_param(params, "symbol")
    range_key = single_param(params, "range", "1m")
    parse_symbol(symbol)
    if range_key not in RANGE_DAYS:
        raise ApiError("INVALID_RANGE", "时间范围不正确", 400)
    data, state = cached_json(
        f"history:{symbol}:{range_key}",
        300,
        lambda: get_history(symbol, range_key),
    )
    data = dict(data)  # type: ignore[arg-type]
    data["_cache"] = state
    return data


def api_prediction(params: dict[str, list[str]]) -> dict:
    symbol = single_param(params, "symbol")
    parse_symbol(symbol)
    settle_predictions(symbol)
    rows = prediction_rows(symbol)
    pending = next((row for row in rows if row.get("actual_direction") is None), None)
    latest = rows[0] if rows else None
    return {
        "symbol": symbol,
        "pending": serialize_prediction(pending) if pending else None,
        "latest": serialize_prediction(latest) if latest else None,
        "stats": compute_stats(rows),
        "ai": ai_public_config(),
    }


def api_predict(params: dict[str, list[str]], body: dict) -> dict:
    symbol = str(body.get("symbol") or single_param(params, "symbol") or "").strip()
    parse_symbol(symbol)
    refresh = bool(body.get("refresh"))
    result = predict_for_symbol(symbol, force=refresh)
    rows = prediction_rows(symbol)
    pending = next((row for row in rows if row.get("actual_direction") is None), None)
    return {
        "prediction": result["prediction"],
        "pending": serialize_prediction(pending) if pending else None,
        "latest": serialize_prediction(rows[0]) if rows else None,
        "stats": compute_stats(rows),
        "ai": ai_public_config(),
        "cached": result["cached"],
        "created": result["created"],
        "_cache": "hit" if result["cached"] else "fresh",
    }


def api_prediction_vote(params: dict[str, list[str]], body: dict) -> dict:
    symbol = str(body.get("symbol") or single_param(params, "symbol") or "").strip()
    parse_symbol(symbol)
    agree = body.get("agree")
    if not isinstance(agree, bool):
        raise ApiError("INVALID_VOTE", "agree 必须是布尔值", 400)
    prediction = record_prediction_vote(symbol, agree)
    return {
        "prediction": prediction,
        "pending": prediction if prediction.get("status") == "pending" else None,
        "stats": compute_stats(prediction_rows(symbol)),
        "ai": ai_public_config(),
    }


def api_prediction_stats(params: dict[str, list[str]]) -> dict:
    symbol = single_param(params, "symbol")
    if symbol:
        parse_symbol(symbol)
        settle_predictions(symbol)
    else:
        settle_predictions(None)
    payload = build_prediction_stats(symbol or None)
    payload["ai"] = ai_public_config()
    return payload


def api_brief(params: dict[str, list[str]]) -> dict:
    symbol = single_param(params, "symbol")
    market, _code = parse_symbol(symbol)
    if market in COMMODITY_MARKETS:
        raise ApiError("NO_EARNINGS", "该标的没有财报日程", 400)
    name = _clean_text(single_param(params, "name"), 40)

    cache_state = "fresh"
    news: dict
    earnings: dict
    try:
        news, news_state = cached_json(
            f"news:{symbol}", 300, lambda: load_news(symbol, name)
        )
        if news_state in ("hit", "stale"):
            cache_state = "hit"
    except ApiError as exc:
        news = {"items": [], "keyword": "", "error": exc.message}
    try:
        earnings, earnings_state = cached_json(
            f"earnings:{symbol}", 3600, lambda: load_earnings(symbol)
        )
        if earnings_state in ("hit", "stale"):
            cache_state = "hit"
    except ApiError as exc:
        earnings = {
            "market": {0: "CN", 1: "CN", 116: "HK"}.get(market, "US"),
            "next": None,
            "recent": [],
            "error": exc.message,
        }
    return {
        "symbol": symbol,
        "news": news,
        "earnings": earnings,
        "updatedAt": iso_time(),
        "_cache": cache_state,
    }


API_ROUTES = {
    "/api/search": api_search,
    "/api/quote": api_quote,
    "/api/quotes": api_quotes,
    "/api/intraday": api_intraday,
    "/api/history": api_history,
    "/api/brief": api_brief,
    "/api/heatmap": api_heatmap,
    "/api/commodities": api_commodities,
    "/api/prediction": api_prediction,
    "/api/predictions/stats": api_prediction_stats,
}

POST_ROUTES = {
    "/api/prediction": api_predict,
    "/api/prediction/vote": api_prediction_vote,
}


# ---------------------------------------------------------------------------
# HTTP 服务
# ---------------------------------------------------------------------------


class StockHandler(BaseHTTPRequestHandler):
    server_version = "StockAtlas/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args) -> None:
        if getattr(self.server, "quiet", False):
            return
        stamp = now_shanghai().strftime("%H:%M:%S")
        sys.stderr.write(f"[{stamp}] {self.address_string()} {fmt % args}\n")

    def _send_bytes(
        self,
        status: int,
        body: bytes,
        content_type: str,
        extra_headers: dict[str, str] | None = None,
        head_only: bool = False,
    ) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cache-Control", "no-store")
        for key, value in (extra_headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if not head_only:
            self.wfile.write(body)

    def _send_json(self, status: int, payload: dict, head_only: bool = False) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self._send_bytes(
            status,
            body,
            "application/json; charset=utf-8",
            {"Cache-Control": "no-store, max-age=0"},
            head_only=head_only,
        )

    def _send_error_json(self, error: ApiError, head_only: bool = False) -> None:
        self._send_json(
            error.status,
            {"ok": False, "error": {"code": error.code, "message": error.message}},
            head_only=head_only,
        )

    def _read_json_body(self) -> dict:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except (TypeError, ValueError):
            length = 0
        if length <= 0:
            return {}
        if length > 64 * 1024:
            raise ApiError("PAYLOAD_TOO_LARGE", "请求内容过大", 413)
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ApiError("INVALID_JSON", "请求内容不是合法的 JSON", 400) from exc
        if not isinstance(payload, dict):
            raise ApiError("INVALID_JSON", "请求内容必须是 JSON 对象", 400)
        return payload

    def _send_json_safely(self, status: int, payload: dict, head_only: bool = False) -> None:
        """只在写回浏览器时容忍断连，不要吞掉上游请求的异常。"""
        try:
            self._send_json(status, payload, head_only)
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True

    def _send_error_json_safely(self, error: ApiError, head_only: bool = False) -> None:
        try:
            self._send_error_json(error, head_only)
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True

    def _serve_api(
        self,
        route: str,
        params: dict[str, list[str]],
        body: dict | None = None,
        head_only: bool = False,
    ) -> None:
        is_post = body is not None
        handler = POST_ROUTES.get(route) if is_post else API_ROUTES.get(route)
        if handler is None:
            if route in API_ROUTES or route in POST_ROUTES:
                self._send_error_json_safely(
                    ApiError(
                        "METHOD_NOT_ALLOWED",
                        "该接口只支持 " + ("POST" if route in POST_ROUTES else "GET") + " 请求",
                        405,
                    ),
                    head_only,
                )
            else:
                self._send_error_json_safely(
                    ApiError("NOT_FOUND", "接口不存在", 404), head_only
                )
            return
        started = time.time()
        try:
            data = handler(params, body) if is_post else handler(params)
            cache_state = data.pop("_cache", None)
            source = data.pop("_source", None)
            is_prediction = route.startswith("/api/prediction")
            meta = {
                "source": source or ("本地预测记录" if is_prediction else "东方财富"),
                "fetchedAt": iso_time(),
                "elapsedMs": int((time.time() - started) * 1000),
                "cached": cache_state in ("hit", "stale"),
            }
            if cache_state == "stale":
                meta["stale"] = True
                meta["notice"] = "行情源暂不可用，正在展示最近一次缓存数据"
        except ApiError as exc:
            self._send_error_json_safely(exc, head_only)
            return
        except Exception as exc:  # 避免单次请求异常拖垮服务
            self.log_message("Unhandled API error: %r", exc)
            self._send_error_json_safely(
                ApiError("INTERNAL_ERROR", "服务处理请求时出现异常", 500), head_only
            )
            return
        self._send_json_safely(200, {"ok": True, "data": data, "meta": meta}, head_only)

    def _serve_static(self, raw_path: str, head_only: bool = False) -> None:
        path = unquote(raw_path)
        if path in ("", "/"):
            path = "/index.html"
        candidate = (ROOT / path.lstrip("/")).resolve()
        try:
            candidate.relative_to(ROOT)
        except ValueError:
            self._send_error_json(ApiError("NOT_FOUND", "页面不存在", 404), head_only)
            return
        # data/ 下是服务端数据（AI Key、预测数据库等），不通过静态站点暴露。
        try:
            candidate.relative_to((ROOT / "data").resolve())
            self._send_error_json(ApiError("NOT_FOUND", "页面不存在", 404), head_only)
            return
        except ValueError:
            pass

        suffix = candidate.suffix.lower()
        if not candidate.is_file() or suffix not in STATIC_TYPES:
            self._send_error_json(ApiError("NOT_FOUND", "页面不存在", 404), head_only)
            return
        try:
            body = candidate.read_bytes()
        except OSError:
            self._send_error_json(ApiError("NOT_FOUND", "页面不存在", 404), head_only)
            return
        self._send_bytes(200, body, STATIC_TYPES[suffix], {"Cache-Control": "no-cache"}, head_only)

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query, keep_blank_values=True)
        if parsed.path.startswith("/api/"):
            self._serve_api(parsed.path, params)
        else:
            self._serve_static(parsed.path)

    def do_HEAD(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query, keep_blank_values=True)
        if parsed.path.startswith("/api/"):
            self._serve_api(parsed.path, params, head_only=True)
        else:
            self._serve_static(parsed.path, head_only=True)

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query, keep_blank_values=True)
        if not parsed.path.startswith("/api/"):
            self._send_error_json(ApiError("NOT_FOUND", "页面不存在", 404))
            return
        try:
            body = self._read_json_body()
        except ApiError as exc:
            self._send_error_json(exc)
            return
        self._serve_api(parsed.path, params, body=body)


class StockServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], quiet: bool = False):
        super().__init__(address, StockHandler)
        self.quiet = quiet


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="股票罗盘本地服务")
    parser.add_argument("--host", default="127.0.0.1", help="监听地址，默认 127.0.0.1")
    parser.add_argument("--port", type=int, default=8765, help="监听端口，默认 8765")
    parser.add_argument("--open", action="store_true", help="启动后自动打开浏览器")
    parser.add_argument("--quiet", action="store_true", help="不打印访问日志")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    try:
        ensure_prediction_db()
    except (OSError, sqlite3.Error) as exc:
        print(f"无法初始化预测数据库：{exc}", file=sys.stderr)
    try:
        server = StockServer((args.host, args.port), quiet=args.quiet)
    except OSError as exc:
        print(f"无法启动服务：{exc}", file=sys.stderr)
        print(f"请确认端口 {args.port} 未被占用，或用 --port 指定其他端口。", file=sys.stderr)
        raise SystemExit(1) from exc

    url = f"http://{args.host}:{args.port}"
    if args.host in ("0.0.0.0", "::"):
        url = f"http://127.0.0.1:{args.port}"
    print("\n  股票罗盘 STOCK ATLAS")
    print(f"  ➜  {url}")
    print("  ➜  数据源：东方财富公开行情接口（腾讯行情备用）")
    print("  ➜  按 Ctrl+C 停止服务\n")
    if args.open:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n服务已停止。")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
