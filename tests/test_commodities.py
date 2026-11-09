"""黄金 / 白银 / 原油行情字段清洗与缓存测试。

运行：python3 -m unittest discover -s tests -v
"""

from __future__ import annotations

import unittest
from datetime import datetime
from unittest import mock

import server


def make_payload(price: int, decimals: int, prev_close: int, change: int, change_pct: int) -> dict:
    return {
        "data": {
            "f43": price,
            "f44": price + 500,
            "f45": price - 500,
            "f46": prev_close,
            "f57": "GC00Y",
            "f58": "COMEX黄金",
            "f59": decimals,
            "f60": prev_close,
            "f86": 1793718157,
            "f169": change,
            "f170": change_pct,
        }
    }


PAYLOADS = {
    "101.GC00Y": make_payload(39491, 1, 39696, -205, -52),
    "101.SI00Y": make_payload(49960, 3, 50888, -928, -182),
    "102.CL00Y": make_payload(9589, 2, 9646, -57, -59),
    "133.USDCNH": make_payload(66701, 4, 66473, 228, 34),
}


def fake_fetch(url: str, params: dict) -> dict:
    return PAYLOADS[params["secid"]]


class CommodityQuoteTest(unittest.TestCase):
    def setUp(self) -> None:
        server._cache.clear()

    def test_scales_each_commodity_by_its_own_decimals(self) -> None:
        with mock.patch.object(server, "fetch_json", side_effect=fake_fetch):
            data = server.load_commodities()

        self.assertEqual(
            [item["key"] for item in data["items"]],
            ["gold", "silver", "oil", "usdcnh"],
        )
        self.assertEqual(data["errors"], {})

        gold, silver, oil, fx = data["items"]
        self.assertEqual(gold["price"], 3949.1)
        self.assertEqual(gold["changePct"], -0.52)
        self.assertEqual(gold["decimals"], 1)
        self.assertAlmostEqual(gold["cnyPrice"], 846.88, places=2)
        self.assertEqual(gold["cnyUnit"], "元/g")
        self.assertEqual(gold["cnyRate"], 6.6701)

        self.assertEqual(silver["price"], 49.96)
        self.assertEqual(silver["change"], -0.928)
        self.assertEqual(silver["unit"], "美元/盎司")

        self.assertEqual(oil["price"], 95.89)
        self.assertEqual(oil["contract"], "NYMEX 原油")
        self.assertEqual(oil["unit"], "美元/桶")
        self.assertIsNone(oil.get("cnyPrice"))

        self.assertEqual(fx["price"], 6.6701)
        self.assertEqual(fx["name"], "美元/人民币")
        self.assertEqual(fx["board"], "汇率")
        self.assertEqual(fx["marketLabel"], "外汇")
        self.assertEqual(fx["currency"], "CNY")

    def test_partial_failure_keeps_the_other_commodities(self) -> None:
        def partial_fetch(url: str, params: dict) -> dict:
            if params["secid"] == "101.SI00Y":
                return {"data": None}
            return PAYLOADS[params["secid"]]

        with mock.patch.object(server, "fetch_json", side_effect=partial_fetch):
            data = server.load_commodities()

        self.assertEqual([item["key"] for item in data["items"]], ["gold", "oil", "usdcnh"])
        self.assertIn("silver", data["errors"])

    def test_api_response_is_cached(self) -> None:
        with mock.patch.object(server, "fetch_json", side_effect=fake_fetch) as fetch:
            first = server.api_commodities({})
            second = server.api_commodities({})

        self.assertEqual(first["_cache"], "fresh")
        self.assertEqual(second["_cache"], "hit")
        self.assertEqual(fetch.call_count, 4)
        self.assertEqual(
            [item["key"] for item in second["items"]],
            ["gold", "silver", "oil", "usdcnh"],
        )


if __name__ == "__main__":
    unittest.main()


class CommodityInstrumentTest(unittest.TestCase):
    def setUp(self) -> None:
        server._cache.clear()

    def test_symbol_parsing_and_market_meta(self) -> None:
        self.assertEqual(server.parse_symbol("101.GC00Y"), (101, "GC00Y"))
        meta = server.market_meta(101, "GC00Y", "COMEX黄金")
        self.assertEqual(meta["name"], "黄金")
        self.assertEqual(meta["market"], "COMMODITY")
        self.assertEqual(meta["marketLabel"], "大宗商品")
        self.assertEqual(meta["board"], "商品")
        self.assertEqual(meta["exchange"], "COMEX")
        self.assertEqual(meta["currency"], "USD")
        self.assertEqual(meta["unit"], "美元/盎司")
        self.assertEqual(meta["contract"], "COMEX 黄金")

    def test_commodity_daily_bar_is_settled_after_six_am(self) -> None:
        tz = server.SHANGHAI_TZ
        self.assertFalse(
            server.bar_settleable(101, "2026-11-03", datetime(2026, 11, 3, 23, 0, tzinfo=tz))
        )
        self.assertFalse(
            server.bar_settleable(101, "2026-11-03", datetime(2026, 11, 4, 5, 30, tzinfo=tz))
        )
        self.assertTrue(
            server.bar_settleable(101, "2026-11-03", datetime(2026, 11, 4, 6, 10, tzinfo=tz))
        )
        self.assertTrue(
            server.bar_settleable(101, "2026-10-30", datetime(2026, 11, 3, 12, 0, tzinfo=tz))
        )

    def test_forex_symbol_meta_and_quote_conversion(self) -> None:
        self.assertEqual(server.parse_symbol("133.USDCNH"), (133, "USDCNH"))
        meta = server.market_meta(133, "USDCNH", "美元兑离岸人民币")
        self.assertEqual(meta["name"], "美元/人民币")
        self.assertEqual(meta["market"], "COMMODITY")
        self.assertEqual(meta["marketLabel"], "外汇")
        self.assertEqual(meta["board"], "汇率")
        self.assertEqual(meta["currency"], "CNY")
        self.assertEqual(meta["unit"], "CNY/USD")

        def quote_fetch(url: str, params: dict) -> dict:
            secid = params["secid"]
            if secid == "101.GC00Y":
                return {
                    "data": {
                        "f43": 39491, "f44": 39817, "f45": 39041, "f46": 39605,
                        "f47": 116476, "f48": 0, "f57": "GC00Y", "f58": "COMEX黄金",
                        "f59": 1, "f60": 39696, "f86": 1793718157, "f107": 101,
                        "f169": -205, "f170": -52,
                    }
                }
            return {
                "data": {
                    "f43": 66701, "f44": 66755, "f45": 66452, "f46": 66476,
                    "f47": 0, "f48": 0, "f57": "USDCNH", "f58": "美元兑离岸人民币",
                    "f59": 4, "f60": 66473, "f86": 1793720084, "f107": 133,
                    "f169": 228, "f170": 34,
                }
            }

        with mock.patch.object(server, "fetch_json", side_effect=quote_fetch):
            quote = server.get_quote("101.GC00Y")

        self.assertEqual(quote["stock"]["name"], "黄金")
        self.assertEqual(quote["stock"]["unit"], "美元/盎司")
        self.assertEqual(quote["cnyRate"], 6.6701)
        self.assertEqual(quote["cnyUnit"], "元/g")
        self.assertAlmostEqual(quote["cnyPrice"], 846.88, places=2)

    def test_daily_bars_keep_contract_volume(self) -> None:
        payload = {
            "data": {
                "name": "COMEX黄金",
                "decimal": 1,
                "klines": [
                    "2026-11-02,3890.0,3956.6,3980.8,3889.0,166666,0.0,2.35,1.48,57.7,0.00",
                    "2026-11-03,3960.5,3948.3,3981.7,3904.1,116488,0.0,1.95,-0.54,-21.3,0.00",
                ],
            }
        }
        with mock.patch.object(server, "fetch_json", return_value=payload):
            bundle = server.load_daily_bars("101.GC00Y")

        self.assertEqual(bundle["stock"]["name"], "黄金")
        self.assertEqual(bundle["stock"]["unit"], "美元/盎司")
        self.assertEqual(bundle["decimals"], 1)
        self.assertEqual(bundle["items"][0]["volume"], 166666)
        self.assertEqual(bundle["items"][-1]["pct"], -0.54)
