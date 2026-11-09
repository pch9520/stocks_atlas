# 股票罗盘 · STOCK ATLAS

本地运行的跨市场行情观察台：原生 HTML / CSS / JavaScript 构建界面，Python 标准库实现轻量行情代理，把东方财富的公开行情整理成统一格式。

覆盖 **沪深京 A 股、港股、美股**，以及 **黄金、白银、原油** 与 **美元兑人民币汇率**；包含搜索、当天分时、每日涨跌日历、AI 次日涨跌预测与命中率复盘、五大市场热力图、自选股和深浅双主题。

![股票罗盘](docs/preview-dashboard.png)

## 快速开始

要求：**Python 3.9+**，无需第三方依赖。在项目根目录（`README.md`、`server.py` 所在目录）执行：

```bash
python3 server.py --open
```

浏览器会自动打开 <http://127.0.0.1:8765>。macOS 也可双击 `start.command`，终端可运行 `./start.sh`。

> 不要直接双击 `index.html`：页面依赖本地服务提供 `/api/*` 行情代理，用 `file://` 打开无法请求数据。

其他启动参数：

```bash
python3 server.py --port 9000        # 换一个端口
python3 server.py --host 0.0.0.0     # 允许局域网访问
python3 server.py --quiet            # 不输出访问日志
```

## 功能

| 模块 | 说明 |
| --- | --- |
| 跨市场搜索 | 按名称 / 代码 / 拼音首字母搜索 A 股、港股、美股 |
| 当天走势 | 价格线、均价线、昨收线、成交量，60 秒自动刷新 |
| 涨跌日历 | 1 个月 / 3 个月 / 6 个月 / 1 年，红涨绿跌，含月度统计与明细表 |
| AI 预测 | 预测下一交易日方向与置信度，写入本地 SQLite，只生成一次 |
| 命中率复盘 | AI 与用户表态的胜率统计，目标日收盘后自动结算 |
| 市场热力图 | Shanghai / US 500 / Nasdaq 100 / US30 / HK，两级矩形树图 |
| 大宗商品 | 黄金、白银、原油、USD/CNH，金银附人民币/克折算 |
| 自选股 | 保存在浏览器 `localStorage`，最多 30 只 |
| 主题 | 深色 / 浅色，默认跟随系统 |
| 资讯与财报 | 最近 5 条市场讯息 + 下次财报日期（未排期时标注“预计”） |

![市场热力图](docs/preview-heatmap.png)

## 项目结构

```text
stocks_atlas/
├── index.html          # 页面结构
├── assets/             # styles.css、app.js、favicon
├── data/               # 指数成分股清单、AI 配置示例；运行时生成 predictions.db
├── docs/               # 预览截图
├── tests/              # 单元测试
├── server.py           # 静态站点 + 行情代理 + 缓存 + 预测接口（仅标准库）
├── start.command       # macOS 双击启动
├── start.sh            # 终端启动
└── README.md
```

## API

所有接口返回 `{ ok, data, meta }`。`symbol` 使用东方财富的 `市场.代码` 格式，如 `1.600519`（沪）、`116.00700`（港）、`105.AAPL`（美）。

| 接口 | 说明 |
| --- | --- |
| `GET /api/search?q=腾讯` | 搜索三地股票 |
| `GET /api/quote?symbol=1.600519` | 实时快照；`/api/quotes?symbols=...` 为批量 |
| `GET /api/intraday?symbol=1.600519` | 当天分时 |
| `GET /api/history?symbol=1.600519&range=1m` | 日线 + 涨跌统计，`range` 取 `1m` / `3m` / `6m` / `1y` |
| `GET /api/brief?symbol=1.600519` | 市场资讯 + 下次财报 |
| `GET /api/heatmap?market=us500` | 热力图，`market` 取 `shanghai` / `us500` / `nasdaq100` / `us30` / `hk` |
| `GET /api/commodities` | 黄金 / 白银 / 原油 / USD-CNH 快照 |
| `GET /api/prediction?symbol=1.600519` | 读取预测并顺带结算已收盘记录 |
| `POST /api/prediction` | 生成预测，body `{"symbol":"1.600519","refresh":false}` |
| `POST /api/prediction/vote` | 记录是否同意 AI，body `{"symbol":"1.600519","agree":true}` |
| `GET /api/predictions/stats?symbol=1.600519` | 命中率统计；省略 `symbol` 返回全部标的 |

出错时返回 `{ "ok": false, "error": { "code": "...", "message": "..." } }`。

## AI 预测配置

默认走 OpenAI Chat Completions 兼容协议（`https://api.deepseek.com`，模型 `deepseek-flash`）；未配置 Key 时自动降级为本地量化模型，功能完整且不产生外部请求。

1. **配置文件**：复制 `data/ai_config.example.json` 为 `data/ai_config.json`，填入 `apiKey`。
2. **环境变量**（优先级更高，也兼容 `DEEPSEEK_API_KEY` / `OPENAI_API_KEY`）：

```bash
AI_API_KEY=sk-... AI_BASE_URL=https://api.deepseek.com AI_MODEL=deepseek-flash python3 server.py --open
```

`data/ai_config.json` 与 `data/predictions.db` 已加入 `.gitignore`。

## 测试

```bash
python3 -m unittest discover -s tests -v
```

## 说明

- 行情来自东方财富公开接口，可能存在延迟、限流或字段调整；本项目提供缓存与错误提示，但不保证实时性与长期可用性。
- 页面与数据仅供学习、研究使用，**不构成任何投资建议**。
- 自选股与主题偏好只保存在浏览器 `localStorage`，不收集用户数据，也不向第三方发送。
