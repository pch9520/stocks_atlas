"""上游连接异常与腾讯备用行情源的回归测试。

运行：python3 -m unittest discover -s tests -v
"""

from __future__ import annotations

import http.client
import json
import threading
import unittest
from unittest import mock

import server


class FetchTextTest(unittest.TestCase):
    def test_remote_disconnected_is_wrapped_as_api_error(self) -> None:
        """RemoteDisconnected 必须转成 ApiError，不能在 HTTP 层被静默吞掉。"""
        with mock.patch.object(
            server,
            "urlopen",
            side_effect=http.client.RemoteDisconnected("Remote end closed connection"),
        ), mock.patch.object(server.time, "sleep"):
            with self.assertRaises(server.ApiError) as context:
                server.fetch_text("https://example.invalid/api")

        self.assertEqual(context.exception.code, "UPSTREAM_UNAVAILABLE")
        self.assertEqual(context.exception.status, 502)

    def test_empty_response_is_retried_then_wrapped(self) -> None:
        response = mock.MagicMock()
        response.__enter__.return_value = response
        response.read.return_value = b""
        response.headers = {}
        with mock.patch.object(server, "urlopen", return_value=response) as urlopen, mock.patch.object(
            server.time, "sleep"
        ):
            with self.assertRaises(server.ApiError):
                server.fetch_text("https://example.invalid/api")

        self.assertEqual(urlopen.call_count, server.UPSTREAM_ATTEMPTS)


class FallbackTest(unittest.TestCase):
    def test_quote_uses_tencent_when_primary_fails(self) -> None:
        expected = {"stock": {"symbol": "1.600519"}, "price": 1.0}
        with mock.patch.object(
            server,
            "_get_quote_eastmoney",
            side_effect=server.ApiError("UPSTREAM_UNAVAILABLE", "primary down"),
        ), mock.patch.object(
            server, "get_quote_tencent", return_value=expected
        ) as fallback:
            self.assertIs(server.get_quote("1.600519"), expected)
        fallback.assert_called_once_with("1.600519")

    def test_commodity_does_not_fall_back_to_tencent(self) -> None:
        with mock.patch.object(
            server,
            "_get_quote_eastmoney",
            side_effect=server.ApiError("UPSTREAM_UNAVAILABLE", "primary down"),
        ), mock.patch.object(server, "get_quote_tencent") as fallback:
            with self.assertRaises(server.ApiError):
                server.get_quote("101.GC00Y")
        fallback.assert_not_called()

    def test_tencent_symbol_mapping(self) -> None:
        self.assertEqual(server.tencent_code("1.600519"), "sh600519")
        self.assertEqual(server.tencent_code("0.000001"), "sz000001")
        self.assertEqual(server.tencent_code("0.430047"), "bj430047")
        self.assertEqual(server.tencent_code("116.00700"), "hk00700")
        self.assertEqual(server.tencent_code("105.AAPL"), "usAAPL")
        self.assertEqual(server.tencent_code("105.AAPL", with_us_suffix=True), "usAAPL.OQ")
        self.assertEqual(server.tencent_code("106.IBM", with_us_suffix=True), "usIBM.N")


class ApiResponseTest(unittest.TestCase):
    def test_upstream_connection_reset_still_returns_json(self) -> None:
        """即使处理函数抛出连接重置，也必须给浏览器一个完整响应。"""
        original = server.API_ROUTES["/api/quote"]

        def broken(_params):
            raise http.client.RemoteDisconnected("Remote end closed connection")

        server.API_ROUTES["/api/quote"] = broken
        httpd = server.StockServer(("127.0.0.1", 0), quiet=True)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            connection = http.client.HTTPConnection(
                "127.0.0.1", httpd.server_address[1], timeout=5
            )
            connection.request("GET", "/api/quote?symbol=1.600519")
            response = connection.getresponse()
            payload = json.loads(response.read().decode("utf-8"))
            connection.close()
            self.assertEqual(response.status, 500)
            self.assertFalse(payload["ok"])
            self.assertEqual(payload["error"]["code"], "INTERNAL_ERROR")
        finally:
            server.API_ROUTES["/api/quote"] = original
            httpd.shutdown()
            httpd.server_close()


if __name__ == "__main__":
    unittest.main()
