"""资讯清洗与财报日程推断的后端单元测试。

运行：python3 -m unittest discover -s tests -v
"""

from __future__ import annotations

import unittest
from datetime import date

import server


def cn_row(
    report_type: str,
    name: str,
    report_date: str,
    publish_date: str,
    published: str = "1",
) -> dict:
    return {
        "REPORT_TYPE": report_type,
        "REPORT_TYPE_NAME": name,
        "REPORT_DATE": report_date,
        "APPOINT_PUBLISH_DATE": publish_date,
        "ACTUAL_PUBLISH_DATE": publish_date if published == "1" else None,
        "IS_PUBLISH": published,
    }


def f10_row(event: str, day: str, content: str) -> dict:
    return {
        "EVENT_TYPE": "报表披露",
        "SPECIFIC_EVENTTYPE": event,
        "NOTICE_DATE": day,
        "LEVEL1_CONTENT": content,
    }


CN_ROWS = [
    cn_row("3", "2026年 三季报", "2026-09-30", "2026-10-31"),
    cn_row("2", "2026年 半年报", "2026-06-30", "2026-08-15"),
    cn_row("1", "2026年 一季报", "2026-03-31", "2026-04-25"),
    cn_row("4", "2025年 年报", "2025-12-31", "2026-04-17"),
]


class NewsNormalizeTest(unittest.TestCase):
    def test_normalize_strips_markup_and_rejects_bad_url(self) -> None:
        item = server._normalize_news(
            {
                "title": "<em>贵州茅台</em>发布公告",
                "url": "javascript:alert(1)",
                "mediaName": "财联社",
                "date": "2026-11-05 10:00:00",
                "content": "<p>内容 &amp; 摘要</p>",
            }
        )
        self.assertIsNotNone(item)
        assert item is not None
        self.assertEqual(item["title"], "贵州茅台 发布公告")
        self.assertEqual(item["summary"], "内容 & 摘要")
        self.assertEqual(item["url"], "")
        self.assertEqual(item["source"], "财联社")

    def test_normalize_requires_title(self) -> None:
        self.assertIsNone(server._normalize_news({"title": "  "}))


class ReportHelpersTest(unittest.TestCase):
    def test_report_kind(self) -> None:
        self.assertEqual(server._report_kind("三季报预披露"), "三季报")
        self.assertEqual(server._report_kind("中报披露"), "中报")
        self.assertEqual(server._report_kind("年报披露"), "年报")

    def test_report_label(self) -> None:
        self.assertEqual(
            server._report_label("2026财年一季报归属股东应占溢利", "一季报"),
            "2026财年 一季报",
        )
        self.assertEqual(
            server._report_label("2026年 三季报", "三季报", 1),
            "2027年 三季报",
        )


class CnEarningsTest(unittest.TestCase):
    def test_estimates_next_report_when_not_scheduled(self) -> None:
        payload = server.build_cn_earnings(CN_ROWS, today=date(2026, 11, 5))
        assert payload["next"] is not None
        self.assertEqual(payload["next"]["date"], "2027-04-19")
        self.assertEqual(payload["next"]["label"], "2026年 年报")
        self.assertTrue(payload["next"]["estimated"])
        self.assertEqual(payload["recent"][0]["date"], "2026-10-31")
        self.assertEqual(payload["recent"][0]["label"], "2026年 三季报")

    def test_uses_scheduled_appointment(self) -> None:
        rows = CN_ROWS + [
            cn_row("4", "2026年 年报", "2026-12-31", "2027-03-20", published="0")
        ]
        payload = server.build_cn_earnings(rows, today=date(2026, 11, 5))
        assert payload["next"] is not None
        self.assertEqual(payload["next"]["date"], "2027-03-20")
        self.assertEqual(payload["next"]["label"], "2026年 年报")
        self.assertFalse(payload["next"]["estimated"])

    def test_empty_rows(self) -> None:
        payload = server.build_cn_earnings([], today=date(2026, 11, 5))
        self.assertIsNone(payload["next"])
        self.assertEqual(payload["recent"], [])


class F10EarningsTest(unittest.TestCase):
    def test_uses_future_disclosure(self) -> None:
        rows = [
            f10_row("三季报预披露", "2026-11-18", "披露2026财年三季报"),
            f10_row("中报披露", "2026-08-12", "2026财年中报归属股东应占溢利"),
        ]
        payload = server.build_f10_earnings(rows, market=116, today=date(2026, 11, 5))
        assert payload["next"] is not None
        self.assertEqual(payload["next"]["date"], "2026-11-18")
        self.assertEqual(payload["next"]["label"], "2026财年 三季报")
        self.assertFalse(payload["next"]["estimated"])
        self.assertEqual(payload["market"], "HK")

    def test_estimates_after_last_report(self) -> None:
        rows = [
            f10_row("三季报披露", "2026-10-13", "2026财年三季报归属股东应占溢利"),
            f10_row("中报披露", "2026-07-14", "2026财年中报归属股东应占溢利"),
            f10_row("一季报披露", "2026-04-14", "2026财年一季报归属股东应占溢利"),
            f10_row("年报披露", "2026-01-13", "2025财年年报归属股东应占溢利"),
        ]
        payload = server.build_f10_earnings(rows, market=106, today=date(2026, 11, 5))
        assert payload["next"] is not None
        self.assertEqual(payload["next"]["date"], "2027-01-13")
        self.assertEqual(payload["next"]["label"], "2026财年 年报（预计）")
        self.assertTrue(payload["next"]["estimated"])
        self.assertEqual(payload["market"], "US")
        self.assertEqual(payload["recent"][0]["date"], "2026-10-13")

    def test_sparse_history_advances_to_next_period(self) -> None:
        rows = [f10_row("一季报披露", "2026-04-22", "2026财年一季报归属股东应占溢利")]
        payload = server.build_f10_earnings(rows, market=105, today=date(2026, 11, 5))
        assert payload["next"] is not None
        self.assertEqual(payload["next"]["date"], "2027-01-20")
        self.assertEqual(payload["next"]["label"], "2026财年 年报（预计）")
        self.assertTrue(payload["next"]["estimated"])


if __name__ == "__main__":
    unittest.main()
