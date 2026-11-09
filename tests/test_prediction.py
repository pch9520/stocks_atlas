"""预测记录、结算与统计的后端单元测试。

运行：python3 -m unittest discover -s tests -v
"""

from __future__ import annotations

import json
import os
import tempfile
import unittest
from datetime import date, datetime
from io import BytesIO
from pathlib import Path
from unittest import mock
from urllib.error import HTTPError

import server


def make_bars(rows: list[tuple[str, float, float]]) -> dict:
    """rows: (date, close, pct) -> load_daily_bars() 形状。"""
    items = []
    for index, (day, close, pct) in enumerate(rows):
        items.append(
            {
                "date": day,
                "open": close,
                "close": close,
                "high": close,
                "low": close,
                "volume": 1_000_000 + index * 10_000,
                "amount": 1e9,
                "amplitudePct": 1.0,
                "pct": pct,
                "change": 0.0,
                "turnoverPct": 0.5,
            }
        )
    return {
        "stock": {
            "symbol": "1.600519",
            "code": "600519",
            "name": "贵州茅台",
            "market": "CN",
            "marketLabel": "A股",
            "board": "沪A",
            "exchange": "上交所",
            "currency": "CNY",
        },
        "decimals": 2,
        "items": items,
    }


BASE_BARS = make_bars(
    [
        ("2026-10-26", 1300.0, 0.4),
        ("2026-10-27", 1310.0, 0.77),
        ("2026-10-28", 1330.75, -1.85),
        ("2026-10-29", 1354.0, 1.75),
        ("2026-10-30", 1392.05, 2.81),
        ("2026-11-02", 1439.1, 3.38),
    ]
)


class PredictionTestBase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.old_db_path = server.PREDICTION_DB_PATH
        server.PREDICTION_DB_PATH = Path(self.tmp.name) / "predictions.db"
        server._prediction_db_ready = False
        server._cache.clear()
        self.bundle = make_bars(
            [(item["date"], item["close"], item["pct"]) for item in BASE_BARS["items"]]
        )
        self.loader = mock.patch.object(
            server, "load_daily_bars", side_effect=lambda symbol: self.bundle
        )
        self.loader.start()
        self.addCleanup(self.loader.stop)
        self.ai_config = mock.patch.object(
            server,
            "load_ai_config",
            return_value={
                "apiKey": "",
                "baseUrl": server.AI_DEFAULT_BASE_URL,
                "model": server.AI_DEFAULT_MODEL,
                "timeout": 30.0,
                "configured": False,
            },
        )
        self.ai_config.start()
        self.addCleanup(self.ai_config.stop)

    def tearDown(self) -> None:
        server.PREDICTION_DB_PATH = self.old_db_path
        server._prediction_db_ready = False
        server._cache.clear()


class HelpersTest(unittest.TestCase):
    def test_next_weekday(self) -> None:
        self.assertEqual(server.next_weekday(date(2026, 10, 30)), date(2026, 11, 2))
        self.assertEqual(server.next_weekday(date(2026, 10, 31)), date(2026, 11, 2))
        self.assertEqual(server.next_weekday(date(2026, 11, 2)), date(2026, 11, 3))
        self.assertEqual(server.next_weekday(date(2026, 11, 6)), date(2026, 11, 9))

    def test_bar_settleable_for_cn(self) -> None:
        morning = datetime(2026, 11, 3, 10, 0, tzinfo=server.SHANGHAI_TZ)
        after_close = datetime(2026, 11, 3, 15, 30, tzinfo=server.SHANGHAI_TZ)
        self.assertFalse(server.bar_settleable(1, "2026-11-03", morning))
        self.assertTrue(server.bar_settleable(1, "2026-11-03", after_close))
        self.assertTrue(server.bar_settleable(1, "2026-11-02", morning))

    def test_bar_settleable_for_hk_and_us(self) -> None:
        hk_before = datetime(2026, 11, 3, 16, 0, tzinfo=server.SHANGHAI_TZ)
        hk_after = datetime(2026, 11, 3, 16, 20, tzinfo=server.SHANGHAI_TZ)
        self.assertFalse(server.bar_settleable(116, "2026-11-03", hk_before))
        self.assertTrue(server.bar_settleable(116, "2026-11-03", hk_after))

        us_live = datetime(2026, 11, 3, 23, 0, tzinfo=server.SHANGHAI_TZ)
        us_closed = datetime(2026, 11, 4, 6, 0, tzinfo=server.SHANGHAI_TZ)
        us_early_morning = datetime(2026, 11, 4, 3, 0, tzinfo=server.SHANGHAI_TZ)
        us_midnight = datetime(2026, 11, 3, 0, 5, tzinfo=server.SHANGHAI_TZ)
        self.assertFalse(server.bar_settleable(105, "2026-11-03", us_live))
        self.assertTrue(server.bar_settleable(105, "2026-11-03", us_closed))
        self.assertFalse(server.bar_settleable(105, "2026-11-03", us_early_morning))
        self.assertFalse(server.bar_settleable(105, "2026-11-02", us_midnight))
        self.assertTrue(server.bar_settleable(105, "2026-10-30", us_midnight))

    def test_parse_ai_reply(self) -> None:
        result = server.parse_ai_reply(
            '```json\n{"direction":"up","confidence":0.72,"reason":"均线多头排列"}\n```'
        )
        self.assertEqual(result["direction"], 1)
        self.assertAlmostEqual(result["confidence"], 0.72)
        self.assertEqual(result["reason"], "均线多头排列")

        chinese = server.parse_ai_reply("看跌")
        self.assertEqual(chinese["direction"], -1)
        self.assertEqual(chinese["confidence"], 0.6)

        with self.assertRaises(server.ApiError):
            server.parse_ai_reply("今天天气不错")

    def test_local_prediction_directions(self) -> None:
        up_bars = [
            {"date": f"2026-10-{index + 1:02d}", "close": 100 + index * 2, "pct": 1.0, "volume": 1000}
            for index in range(20)
        ]
        up = server.local_prediction(up_bars)
        self.assertEqual(up["direction"], 1)
        self.assertGreaterEqual(up["confidence"], 0.5)
        self.assertTrue(up["reason"])

        down_bars = [
            {"date": f"2026-10-{index + 1:02d}", "close": 200 - index * 2, "pct": -1.0, "volume": 1000}
            for index in range(20)
        ]
        down = server.local_prediction(down_bars)
        self.assertEqual(down["direction"], -1)

    def test_ai_config_env_overrides(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(server, "AI_CONFIG_PATH", Path(tmp) / "missing.json"):
                with mock.patch.dict(
                    os.environ,
                    {
                        "AI_API_KEY": "sk-test",
                        "AI_BASE_URL": "https://example.com/v1/",
                        "AI_MODEL": "test-model",
                    },
                    clear=False,
                ):
                    config = server.load_ai_config()
        self.assertTrue(config["configured"])
        self.assertEqual(config["apiKey"], "sk-test")
        self.assertEqual(config["baseUrl"], "https://example.com/v1")
        self.assertEqual(config["model"], "test-model")

    def test_call_ai_prediction(self) -> None:
        context = {
            "stock": {
                "name": "贵州茅台",
                "code": "600519",
                "marketLabel": "A股",
                "exchange": "上交所",
            },
            "base": {"date": "2026-11-02", "close": 1439.1},
            "baseDate": "2026-11-02",
            "baseClose": 1439.1,
            "targetDate": "2026-11-03",
            "bars": [
                {
                    "date": f"2026-10-{index + 1:02d}",
                    "close": 1400 + index,
                    "pct": 0.5,
                    "volume": 1000,
                }
                for index in range(10)
            ],
        }
        config = {
            "apiKey": "sk-test",
            "baseUrl": "https://example.com/v1",
            "model": "test-model",
            "timeout": 10,
        }
        payload = {
            "choices": [
                {"message": {"content": '{"direction":"up","confidence":77,"reason":"均线多头"}'}}
            ]
        }
        with mock.patch.object(server, "urlopen") as urlopen:
            urlopen.return_value.__enter__.return_value.read.return_value = json.dumps(
                payload
            ).encode("utf-8")
            result = server.call_ai_prediction(context, config)

        self.assertEqual(result["direction"], 1)
        self.assertAlmostEqual(result["confidence"], 0.77)
        self.assertEqual(result["reason"], "均线多头")
        request = urlopen.call_args[0][0]
        self.assertEqual(request.full_url, "https://example.com/v1/chat/completions")
        self.assertEqual(request.get_header("Authorization"), "Bearer sk-test")

    def test_call_ai_prediction_auth_error(self) -> None:
        context = {
            "stock": {"name": "贵州茅台", "code": "600519", "marketLabel": "A股", "exchange": "上交所"},
            "base": {"date": "2026-11-02", "close": 1439.1},
            "baseDate": "2026-11-02",
            "baseClose": 1439.1,
            "targetDate": "2026-11-03",
            "bars": [
                {"date": "2026-11-02", "close": 1439.1, "pct": 1.0, "volume": 1000}
            ],
        }
        config = {
            "apiKey": "bad-key",
            "baseUrl": "https://example.com/v1",
            "model": "test-model",
            "timeout": 10,
        }
        with mock.patch.object(
            server,
            "urlopen",
            side_effect=HTTPError("https://example.com/v1/chat/completions", 401, "Unauthorized", {}, None),
        ):
            with self.assertRaises(server.ApiError) as context_manager:
                server.call_ai_prediction(context, config)
        self.assertEqual(context_manager.exception.code, "AI_AUTH_FAILED")

    def test_call_ai_prediction_deepseek_payload(self) -> None:
        context = {
            "stock": {"name": "贵州茅台", "code": "600519", "marketLabel": "A股", "exchange": "上交所"},
            "base": {"date": "2026-11-02", "close": 1439.1},
            "baseDate": "2026-11-02",
            "baseClose": 1439.1,
            "targetDate": "2026-11-03",
            "bars": [{"date": "2026-11-02", "close": 1439.1, "pct": 1.0, "volume": 1000}],
        }
        config = {
            "apiKey": "sk-test",
            "baseUrl": "https://api.deepseek.com",
            "model": "deepseek-flash",
            "timeout": 10,
        }
        payload = {
            "choices": [{"message": {"content": '{"direction":"down","confidence":0.6,"reason":"偏空"}'}}]
        }
        with mock.patch.object(server, "urlopen") as urlopen:
            urlopen.return_value.__enter__.return_value.read.return_value = json.dumps(
                payload
            ).encode("utf-8")
            server.call_ai_prediction(context, config)

        request = urlopen.call_args[0][0]
        self.assertEqual(request.full_url, "https://api.deepseek.com/chat/completions")
        self.assertEqual(request.get_header("Authorization"), "Bearer sk-test")
        self.assertEqual(request.get_header("Content-type"), "application/json")
        body = json.loads(request.data.decode("utf-8"))
        self.assertEqual(body["model"], "deepseek-flash")
        self.assertEqual(body["thinking"], {"type": "disabled"})
        self.assertEqual(body["response_format"], {"type": "json_object"})

    def test_call_ai_prediction_surfaces_upstream_message(self) -> None:
        context = {
            "stock": {"name": "贵州茅台", "code": "600519", "marketLabel": "A股", "exchange": "上交所"},
            "base": {"date": "2026-11-02", "close": 1439.1},
            "baseDate": "2026-11-02",
            "baseClose": 1439.1,
            "targetDate": "2026-11-03",
            "bars": [{"date": "2026-11-02", "close": 1439.1, "pct": 1.0, "volume": 1000}],
        }
        config = {
            "apiKey": "sk-test",
            "baseUrl": "https://api.deepseek.com",
            "model": "deepseek-flash",
            "timeout": 10,
        }
        error_body = BytesIO(b'{"error":{"message":"Model Not Exist"}}')
        with mock.patch.object(
            server,
            "urlopen",
            side_effect=HTTPError(
                "https://api.deepseek.com/chat/completions", 400, "Bad Request", {}, error_body
            ),
        ):
            with self.assertRaises(server.ApiError) as context_manager:
                server.call_ai_prediction(context, config)
        self.assertEqual(context_manager.exception.code, "AI_HTTP_ERROR")
        self.assertIn("Model Not Exist", context_manager.exception.message)


class PredictionFlowTest(PredictionTestBase):
    def test_prediction_is_cached_and_refreshed_in_place(self) -> None:
        first = server.predict_for_symbol("1.600519")
        self.assertFalse(first["cached"])
        self.assertTrue(first["created"])
        prediction = first["prediction"]
        self.assertEqual(prediction["status"], "pending")
        self.assertEqual(prediction["targetDate"], "2026-11-03")
        self.assertEqual(prediction["engine"], "local")

        second = server.predict_for_symbol("1.600519")
        self.assertTrue(second["cached"])
        self.assertEqual(second["prediction"]["id"], prediction["id"])
        self.assertEqual(second["prediction"]["revision"], 1)

        server.record_prediction_vote("1.600519", True)
        refreshed = server.predict_for_symbol("1.600519", force=True)
        self.assertFalse(refreshed["cached"])
        self.assertEqual(refreshed["prediction"]["id"], prediction["id"])
        self.assertEqual(refreshed["prediction"]["revision"], 2)
        # 同一目标日、同一方向时保留用户态度
        self.assertTrue(refreshed["prediction"]["userChoice"])
        self.assertEqual(refreshed["prediction"]["userDirection"], 1)

    def test_reverse_prediction_clears_user_vote(self) -> None:
        first = server.predict_for_symbol("1.600519")
        server.record_prediction_vote("1.600519", False)
        self.assertIsNotNone(server.get_pending_prediction("1.600519")["user_choice"])

        # 让模型转向：构造连续下跌的日线
        self.bundle = make_bars(
            [
                ("2026-10-26", 1500.0, -1.0),
                ("2026-10-27", 1460.0, -2.0),
                ("2026-10-28", 1420.0, -2.5),
                ("2026-10-29", 1400.0, -1.5),
                ("2026-10-30", 1370.0, -2.0),
                ("2026-11-02", 1330.0, -3.0),
            ]
        )
        server._cache.clear()
        server.load_daily_bars.side_effect = lambda symbol: self.bundle
        refreshed = server.predict_for_symbol("1.600519", force=True)
        self.assertEqual(refreshed["prediction"]["direction"], -1)
        self.assertNotEqual(refreshed["prediction"]["direction"], first["prediction"]["direction"])
        self.assertIsNone(refreshed["prediction"]["userChoice"])

    def test_settlement_waits_for_close(self) -> None:
        server.predict_for_symbol("1.600519")
        with_bar = make_bars(
            [(item["date"], item["close"], item["pct"]) for item in BASE_BARS["items"]]
            + [("2026-11-03", 1450.0, 0.76)]
        )
        self.bundle = with_bar
        server._cache.clear()
        server.load_daily_bars.side_effect = lambda symbol: self.bundle

        morning = datetime(2026, 11, 3, 10, 30, tzinfo=server.SHANGHAI_TZ)
        self.assertEqual(server.settle_predictions("1.600519", now=morning), 0)
        self.assertIsNone(server.get_pending_prediction("1.600519")["actual_direction"])

        after_close = datetime(2026, 11, 3, 15, 30, tzinfo=server.SHANGHAI_TZ)
        self.assertEqual(server.settle_predictions("1.600519", now=after_close), 1)
        row = server.get_latest_prediction("1.600519")
        self.assertEqual(row["actual_direction"], 1)
        self.assertEqual(row["actual_pct"], 0.76)
        self.assertEqual(row["actual_date"], "2026-11-03")
        self.assertIsNone(server.get_pending_prediction("1.600519"))
        self.assertTrue(server.serialize_prediction(row)["aiCorrect"])

    def test_vote_requires_pending_prediction(self) -> None:
        with self.assertRaises(server.ApiError) as context:
            server.record_prediction_vote("1.600519", True)
        self.assertEqual(context.exception.code, "NO_PENDING_PREDICTION")

    def test_stats_scope_and_accuracy(self) -> None:
        server.ensure_prediction_db()
        conn = server.prediction_db()
        try:
            rows = [
                # AI 对、用户同意 -> 都对
                ("1.600519", "600519", "贵州茅台", "2026-11-01", "2026-11-02", 1, 1, 1, 1, 1.2),
                # AI 错、用户不同意 -> 用户对
                ("1.600519", "600519", "贵州茅台", "2026-11-02", "2026-11-03", 1, -1, 0, -1, -0.8),
                # AI 对、用户未表态
                ("116.00700", "00700", "腾讯控股", "2026-11-02", "2026-11-03", -1, -1, None, None, -1.5),
                # 平盘 -> 不计入双方准确率
                ("116.00700", "00700", "腾讯控股", "2026-11-03", "2026-11-04", 1, 0, None, None, 0.0),
                # 待结算
                ("105.AAPL", "AAPL", "苹果", "2026-11-03", "2026-11-04", 1, None, None, None, None),
            ]
            for (
                symbol, code, name, base_date, target_date, direction,
                actual, user_choice, user_direction, pct,
            ) in rows:
                conn.execute(
                    "INSERT INTO predictions (symbol, code, name, market, market_label, currency, "
                    "base_date, target_date, direction, confidence, reason, model, engine, "
                    "user_choice, user_direction, actual_direction, actual_pct, actual_date, "
                    "created_at, updated_at) VALUES (?, ?, ?, 'CN', 'A股', 'CNY', ?, ?, ?, 0.6, '', "
                    "'local-quant-v1', 'local', ?, ?, ?, ?, ?, '2026-11-04T00:00:00+08:00', "
                    "'2026-11-04T00:00:00+08:00')",
                    (
                        symbol, code, name, base_date, target_date, direction,
                        user_choice, user_direction, actual, pct,
                        target_date if actual is not None else None,
                    ),
                )
            conn.commit()
        finally:
            conn.close()

        payload = server.build_prediction_stats()
        overall = payload["overall"]
        self.assertEqual(overall["samples"]["settled"], 4)
        self.assertEqual(overall["samples"]["decided"], 3)
        self.assertEqual(overall["samples"]["flat"], 1)
        self.assertEqual(overall["samples"]["pending"], 1)
        self.assertEqual(overall["ai"]["correct"], 2)
        self.assertAlmostEqual(overall["ai"]["rate"], 66.7)
        self.assertEqual(overall["user"]["decided"], 2)
        self.assertEqual(overall["user"]["correct"], 2)
        self.assertAlmostEqual(overall["user"]["rate"], 100.0)
        self.assertEqual(overall["user"]["agree"], 1)
        self.assertEqual(overall["user"]["disagree"], 1)
        self.assertEqual(len(payload["stocks"]), 3)

        single = server.build_prediction_stats("1.600519")
        self.assertEqual(single["overall"]["ai"]["correct"], 1)
        self.assertEqual(single["overall"]["user"]["correct"], 2)
        self.assertEqual(single["overall"]["user"]["decided"], 2)
        self.assertEqual(len(single["recent"]), 2)
        self.assertEqual(single["stocks"], [])


if __name__ == "__main__":
    unittest.main()
