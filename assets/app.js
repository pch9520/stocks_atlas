/* ==========================================================================
   股票罗盘 STOCK ATLAS — 前端交互
   纯原生 JavaScript，无第三方依赖。
   ========================================================================== */

(() => {
  "use strict";

  const DEFAULT_STOCK = {
    symbol: "1.600519",
    code: "600519",
    name: "贵州茅台",
    market: "CN",
    marketLabel: "A股",
    board: "沪A",
    exchange: "上交所",
    currency: "CNY",
  };

  const MARKET_NAMES = { ALL: "全部", CN: "A股", HK: "港股", US: "美股" };
  const PULSE_STOCKS = [
    { symbol: "1.600519", market: "CN", label: "沪", name: "贵州茅台", code: "600519" },
    { symbol: "116.00700", market: "HK", label: "港", name: "腾讯控股", code: "00700" },
    { symbol: "105.AAPL", market: "US", label: "美", name: "苹果", code: "AAPL" },
  ];
  const COMMODITY_ITEMS = [
    {
      key: "gold", symbol: "101.GC00Y", code: "GC00Y", name: "黄金",
      contract: "COMEX 黄金", exchange: "COMEX", unit: "美元/盎司", mark: "金", decimals: 1,
      market: "COMMODITY", marketLabel: "大宗商品", board: "商品", currency: "USD",
    },
    {
      key: "silver", symbol: "101.SI00Y", code: "SI00Y", name: "白银",
      contract: "COMEX 白银", exchange: "COMEX", unit: "美元/盎司", mark: "银", decimals: 3,
      market: "COMMODITY", marketLabel: "大宗商品", board: "商品", currency: "USD",
    },
    {
      key: "oil", symbol: "102.CL00Y", code: "CL00Y", name: "原油",
      contract: "NYMEX 原油", exchange: "NYMEX", unit: "美元/桶", mark: "油", decimals: 2,
      market: "COMMODITY", marketLabel: "大宗商品", board: "商品", currency: "USD",
    },
    {
      key: "usdcnh", symbol: "133.USDCNH", code: "USDCNH", name: "美元/人民币",
      contract: "USD/CNH 离岸人民币", exchange: "离岸市场", unit: "CNY/USD", mark: "汇", decimals: 4,
      market: "COMMODITY", marketLabel: "外汇", board: "汇率", currency: "CNY",
    },
  ];
  const TROY_OUNCE_GRAMS = 31.1034768;

  function commodityMeta(symbol) {
    return COMMODITY_ITEMS.find((item) => item.symbol === symbol) || null;
  }

  function isCommoditySymbol(symbol) {
    return Boolean(commodityMeta(symbol));
  }

  function isCommodityMarket(stock) {
    return stock?.market === "COMMODITY";
  }

  function commodityKey(stock) {
    return stock?.key || commodityMeta(stock?.symbol)?.key || "";
  }

  function isConvertibleCommodity(stock) {
    const key = commodityKey(stock);
    return key === "gold" || key === "silver";
  }

  function isForexInstrument(stock) {
    return commodityKey(stock) === "usdcnh";
  }

  function cnyPerGram(usdPrice, rate) {
    const price = Number(usdPrice);
    const fx = Number(rate);
    if (!Number.isFinite(price) || !Number.isFinite(fx) || fx <= 0) return null;
    return (price * fx) / TROY_OUNCE_GRAMS;
  }

  const STORAGE = {
    favorites: "stockatlas:favorites:v1",
    range: "stockatlas:range:v1",
    view: "stockatlas:view:v1",
    theme: "stockatlas:theme:v1",
    heatmap: "stockatlas:heatmap:v1",
  };
  const MAX_FAVORITES = 30;
  const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || "");
  const HEATMAP_MARKETS = {
    shanghai: { label: "Shanghai", name: "沪市 A 股" },
    us500: { label: "US 500", name: "标普 500" },
    nasdaq100: { label: "Nasdaq 100", name: "纳斯达克 100" },
    us30: { label: "US30", name: "道琼斯 30" },
    hk: { label: "HK", name: "香港股市" },
  };
  const HEATMAP_AREA = ["marketCap", "amount", "volume", "equal"];
  const HEATMAP_COLOR = ["changePct", "amplitudePct", "turnoverPct", "amount", "marketCap"];
  const HEATMAP_LABEL = ["namePct", "name", "code", "codePct", "nameCap"];
  const HEATMAP_DEFAULTS = {
    market: "us500",
    area: "marketCap",
    color: "changePct",
    label: "namePct",
  };

  const state = {
    mode: "stock",
    selected: null,
    quote: null,
    intraday: null,
    history: null,
    historyDayMap: null,
    range: safeStorageGet(STORAGE.range) || "1m",
    view: safeStorageGet(STORAGE.view) || "calendar",
    favorites: readFavorites(),
    favoriteQuotes: {},
    loadToken: 0,
    historyToken: 0,
    isRefreshing: false,
    isAutoRefreshing: false,
    isPulseRefreshing: false,
    isCommodityRefreshing: false,
    lastLiveRefresh: 0,
    search: {
      query: "",
      items: [],
      visible: [],
      filter: "ALL",
      active: -1,
      seq: 0,
      timer: null,
      controller: null,
    },
    chartHover: null,
    chartGeometry: null,
    staleNotifiedAt: 0,
    brief: {
      seq: 0,
      data: null,
      error: "",
      loadedAt: 0,
    },
    prediction: {
      symbol: "",
      data: null,
      loading: false,
      error: "",
      busy: false,
      retryKind: "load",
      seq: 0,
      stats: {
        scope: "all",
        data: null,
        loading: false,
        error: "",
        seq: 0,
      },
    },
    heatmap: {
      ...readHeatmapPreferences(),
      data: null,
      itemMap: new Map(),
      token: 0,
      loading: false,
      loadedAt: 0,
      hoverSymbol: null,
      error: "",
    },
  };

  const dom = {};

  const THEME = {
    up: "#ef5d60",
    down: "#27b98d",
    gold: "#d8b36b",
    grid: "rgba(232,238,232,0.075)",
    gridSoft: "rgba(232,238,232,0.04)",
    text: "#89948f",
    faint: "#5c6762",
    baseline: "rgba(232,238,232,0.28)",
    bg: "#0f1516",
    volumeBg: "rgba(255,255,255,0.03)",
    crosshair: "rgba(232,238,232,0.25)",
  };

  document.addEventListener("DOMContentLoaded", init);

  /* ------------------------------------------------------------------------
     Boot
     ------------------------------------------------------------------------ */

  function init() {
    cacheDom();
    initTheme();
    updateDateAndClock();
    bindEvents();
    setRangeButtons();
    setView(state.view, { persist: false, rerender: false });
    initHeatmapControls();
    renderHeatmapMarketTabs();
    renderFavorites();
    renderPulseSkeleton();
    refreshMarketPulse();
    renderCommoditySkeleton();
    refreshCommodities();

    if (dom.searchKbd) dom.searchKbd.textContent = IS_MAC ? "⌘ K" : "Ctrl K";

    const route = readRoute();
    if (route.mode === "heatmap") {
      if (route.market && HEATMAP_MARKETS[route.market]) {
        state.heatmap.market = route.market;
      }
      setMode("heatmap", { syncHash: false, load: false });
      loadHeatmap(state.heatmap.market);
    } else {
      const hashSymbol = route.symbol;
      let initial = hashSymbol;
      if (initial && !isValidSymbol(initial)) {
        showToast("链接中的股票代码无效，已为你打开示例股票", "error");
        initial = null;
      }
      loadStock(initial ? { symbol: initial } : DEFAULT_STOCK, {
        historyMode: initial ? "none" : "replace",
      });
    }

    if (state.favorites.length) refreshFavoriteQuotes();

    window.setInterval(() => {
      updateDateAndClock();
      if (document.visibilityState !== "visible") return;
      refreshCommodities();
      if (state.mode === "heatmap") autoRefreshHeatmap();
      else quietRefresh();
    }, 60_000);

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        updateDateAndClock();
        refreshCommodities();
        if (state.mode === "heatmap") autoRefreshHeatmap();
        else if (Date.now() - state.lastLiveRefresh > 90_000) quietRefresh();
      }
    });

    window.addEventListener("popstate", handleRouteChange);
    window.addEventListener("hashchange", handleRouteChange);

    if (typeof ResizeObserver !== "undefined" && dom.chartStage) {
      new ResizeObserver(() => {
        window.requestAnimationFrame(drawIntradayChart);
      }).observe(dom.chartStage);
    }

    if (typeof ResizeObserver !== "undefined" && dom.heatmapStage) {
      let resizeFrame = 0;
      new ResizeObserver(() => {
        window.cancelAnimationFrame(resizeFrame);
        resizeFrame = window.requestAnimationFrame(() => {
          if (state.mode === "heatmap" && state.heatmap.data) renderHeatmap();
        });
      }).observe(dom.heatmapStage);
    }
  }

  function cacheDom() {
    const ids = [
      "searchField", "searchInput", "searchClear", "searchKbd", "searchIdle",
      "searchPanel", "searchSummary", "searchResults", "searchEmpty", "marketFilters",
      "closeSearch", "favoritesList", "favoritesHint", "favoriteCount", "sidebarStatus",
      "sidebarClock", "todayLabel", "connectionPill", "connectionText", "updateLabel",
      "refreshButton", "loadingView", "errorView", "errorMessage", "errorRetry",
      "stockView", "boardTag", "exchangeTag", "quoteTime", "stockName", "stockStar",
      "stockStarLabel", "stockCode", "stockCurrency", "stockMarketName", "priceMain",
      "priceCurrency", "priceCny", "changeLine", "changeValue", "changePct", "statStrip",
      "intradaySubtitle", "priceLegendSwatch", "chartStage", "intradayCanvas",
      "chartTooltip", "chartState", "chartFootStats", "rangeTabs", "historySummary",
      "viewToggle", "historyLoading", "historyError", "historyErrorText", "historyRetry",
      "calendarView", "tableView", "tableBody", "historyFootnote", "tileTooltip",
      "toastRegion", "marketPulseList", "commodityList", "themeToggle", "viewTabs", "heatmapView",
      "heatmapMarkets", "heatmapSummary", "heatmapUpdated", "heatmapArea", "heatmapColor",
      "heatmapLabel", "heatmapLegend", "heatmapStage", "heatmapBoard", "heatmapState",
      "heatmapStateText", "heatmapRetry", "heatmapFootnote", "heatmapTooltip",
      "aiPrediction", "aiEngine", "aiPredict", "aiStatsOpen", "aiBody", "aiStatsModal",
      "aiStatsClose", "aiScopeTabs", "aiStatsContent", "aiStatsFoot",
      "briefCard", "briefNewsState", "newsList", "newsUpdated", "earningsBadge",
      "earningsDate", "earningsWeekday", "earningsLabel", "earningsRecent", "earningsMeta",
    ];
    for (const id of ids) dom[id] = document.getElementById(id);
    dom.sidebarFooter = document.querySelector(".sidebar-footer");
    dom.canvasContext = dom.intradayCanvas ? dom.intradayCanvas.getContext("2d") : null;
  }

  function isLightTheme() {
    return document.documentElement.dataset.theme === "light";
  }

  function initTheme() {
    applyTheme(isLightTheme() ? "light" : "dark", { persist: false, rerender: false });
    const media = window.matchMedia ? window.matchMedia("(prefers-color-scheme: light)") : null;
    if (!media) return;
    const handleSystemTheme = (event) => {
      if (!safeStorageGet(STORAGE.theme)) {
        applyTheme(event.matches ? "light" : "dark", { persist: false });
      }
    };
    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", handleSystemTheme);
    } else if (typeof media.addListener === "function") {
      media.addListener(handleSystemTheme);
    }
  }

  function applyTheme(theme, options = {}) {
    const next = theme === "light" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    document.documentElement.style.colorScheme = next;
    const meta = document.getElementById("themeColor");
    if (meta) meta.content = next === "light" ? "#f3efe5" : "#0b0f10";
    if (options.persist !== false) safeStorageSet(STORAGE.theme, next);
    hydrateThemeColors();
    updateThemeToggle();

    hideTileTooltip();
    hideHeatmapTooltip();
    if (dom.chartTooltip) dom.chartTooltip.hidden = true;
    state.chartHover = null;
    if (options.rerender !== false && state.history) {
      renderCalendar(state.history.items, state.history.decimals);
    }
    if (options.rerender !== false && state.mode === "heatmap" && state.heatmap.data) {
      renderHeatmap();
    }
    window.requestAnimationFrame(drawIntradayChart);
  }

  function updateThemeToggle() {
    if (!dom.themeToggle) return;
    const light = isLightTheme();
    const label = light ? "切换到深色主题" : "切换到浅色主题";
    dom.themeToggle.setAttribute("aria-label", label);
    dom.themeToggle.title = label;
  }

  function hydrateThemeColors() {
    const css = getComputedStyle(document.documentElement);
    const pairs = [
      ["up", "--up"],
      ["down", "--down"],
      ["gold", "--gold"],
      ["faint", "--faint"],
      ["grid", "--chart-grid"],
      ["gridSoft", "--chart-grid-soft"],
      ["baseline", "--chart-baseline"],
      ["bg", "--chart-surface"],
      ["volumeBg", "--chart-volume-bg"],
      ["crosshair", "--chart-crosshair"],
    ];
    for (const [key, variable] of pairs) {
      const value = css.getPropertyValue(variable).trim();
      if (value) THEME[key] = value;
    }
    THEME.text = css.getPropertyValue("--muted").trim() || THEME.text;
  }

  function bindEvents() {
    dom.searchInput.addEventListener("input", handleSearchInput);
    dom.searchInput.addEventListener("focus", () => {
      if (dom.searchInput.value.trim()) openSearchPanel();
    });
    dom.searchInput.addEventListener("keydown", handleSearchKeydown);
    dom.searchClear.addEventListener("click", clearSearch);
    dom.closeSearch.addEventListener("click", () => {
      closeSearchPanel();
      dom.searchInput.focus();
    });
    dom.marketFilters.addEventListener("click", handleMarketFilterClick);
    dom.searchResults.addEventListener("click", handleSearchResultClick);
    dom.searchResults.addEventListener("pointermove", handleSearchResultHover);
    dom.searchIdle.addEventListener("click", handleQuickChipClick);

    dom.favoritesList.addEventListener("click", handleFavoriteClick);
    dom.marketPulseList.addEventListener("click", handlePulseClick);
    dom.commodityList.addEventListener("click", handleCommodityClick);
    dom.themeToggle.addEventListener("click", () => {
      applyTheme(isLightTheme() ? "dark" : "light");
    });
    dom.stockStar.addEventListener("click", () => {
      if (state.selected) toggleFavorite(state.selected);
    });

    dom.rangeTabs.addEventListener("click", handleRangeClick);
    dom.viewToggle.addEventListener("click", handleViewToggleClick);
    dom.historyRetry.addEventListener("click", () => {
      if (state.selected) {
        loadHistoryData(state.selected.symbol, state.range, state.loadToken).catch(() => {});
      }
    });

    dom.refreshButton.addEventListener("click", manualRefresh);
    dom.errorRetry.addEventListener("click", () => {
      if (state.selected) loadStock(state.selected, { historyMode: "none" });
    });

    dom.calendarView.addEventListener("pointerover", handleTilePointerOver);
    dom.calendarView.addEventListener("pointerout", handleTilePointerOut);
    dom.calendarView.addEventListener("focusin", handleTileFocusIn);
    dom.calendarView.addEventListener("focusout", handleTileFocusOut);
    window.addEventListener("scroll", hideTileTooltip, true);

    dom.aiPredict.addEventListener("click", () => requestPrediction(Boolean(state.prediction.data?.pending)));
    dom.aiBody.addEventListener("click", handleAiBodyClick);
    dom.aiStatsOpen.addEventListener("click", openAiStats);
    dom.aiStatsClose.addEventListener("click", closeAiStats);
    dom.aiStatsModal.addEventListener("click", (event) => {
      if (event.target === dom.aiStatsModal) closeAiStats();
    });
    dom.aiScopeTabs.addEventListener("click", handleAiScopeClick);

    dom.briefNewsState.addEventListener("click", (event) => {
      if (event.target.closest("[data-brief-retry]") && state.selected) {
        loadBrief(state.selected.symbol, state.selected.name);
      }
    });

    dom.viewTabs.addEventListener("click", handleViewTabClick);
    dom.heatmapMarkets.addEventListener("click", handleHeatmapMarketClick);
    dom.heatmapArea.addEventListener("change", handleHeatmapFilterChange);
    dom.heatmapColor.addEventListener("change", handleHeatmapFilterChange);
    dom.heatmapLabel.addEventListener("change", handleHeatmapFilterChange);
    dom.heatmapBoard.addEventListener("pointermove", handleHeatmapPointerMove);
    dom.heatmapBoard.addEventListener("pointerleave", hideHeatmapTooltip);
    dom.heatmapBoard.addEventListener("click", handleHeatmapClick);
    dom.heatmapBoard.addEventListener("focusin", handleHeatmapFocusIn);
    dom.heatmapBoard.addEventListener("focusout", handleHeatmapFocusOut);
    dom.heatmapRetry.addEventListener("click", () => {
      loadHeatmap(state.heatmap.market, { force: true });
    });
    window.addEventListener("scroll", hideHeatmapTooltip, true);

    dom.intradayCanvas.addEventListener("pointermove", handleChartPointerMove);
    dom.intradayCanvas.addEventListener("pointerleave", handleChartPointerLeave);
    dom.intradayCanvas.addEventListener("pointerdown", handleChartPointerMove);

    document.addEventListener("pointerdown", (event) => {
      if (
        !dom.searchPanel.hidden &&
        dom.searchField &&
        !dom.searchField.contains(event.target) &&
        !dom.searchPanel.contains(event.target)
      ) {
        closeSearchPanel();
      }
    });

    document.addEventListener("keydown", handleGlobalKeydown);
    window.addEventListener("resize", () => {
      hideTileTooltip();
      hideHeatmapTooltip();
    });
  }

  /* ------------------------------------------------------------------------
     Routing / loading
     ------------------------------------------------------------------------ */

  function handleRouteChange() {
    const route = readRoute();
    if (route.mode === "heatmap") {
      const market = HEATMAP_MARKETS[route.market] ? route.market : state.heatmap.market;
      const marketChanged = market !== state.heatmap.market;
      state.heatmap.market = market;
      setMode("heatmap", { syncHash: false, load: false });
      if (marketChanged || !state.heatmap.data) {
        loadHeatmap(market);
      } else {
        renderHeatmapMarketTabs();
      }
      return;
    }
    if (route.symbol && isValidSymbol(route.symbol)) {
      if (
        route.symbol !== state.selected?.symbol ||
        state.mode !== "stock" ||
        !state.quote
      ) {
        loadStock({ symbol: route.symbol }, { historyMode: "none" });
      }
      return;
    }
    if (state.mode === "heatmap") setMode("stock", { syncHash: false });
  }

  function readRoute() {
    const raw = window.location.hash.replace(/^#/, "");
    if (!raw) return { mode: "stock", symbol: null, market: null };
    const params = new URLSearchParams(raw);
    return {
      mode: params.get("view") === "heatmap" ? "heatmap" : "stock",
      symbol: params.get("symbol"),
      market: params.get("market"),
    };
  }

  function readSymbolFromHash() {
    return readRoute().symbol;
  }

  function updateHash(symbol, mode = "push") {
    writeHash({ mode: "stock", symbol }, mode);
  }

  function writeHash(route, mode = "push") {
    const params = new URLSearchParams();
    if (route.mode === "heatmap") {
      params.set("view", "heatmap");
      params.set("market", route.market || state.heatmap.market);
    } else if (route.symbol) {
      params.set("symbol", route.symbol);
    }
    const next = params.toString() ? `#${params.toString()}` : "";
    if (window.location.hash === next) return;
    const url = `${window.location.pathname}${window.location.search}${next}`;
    try {
      const method = mode === "replace" ? "replaceState" : "pushState";
      window.history[method]({ ...route }, "", url);
    } catch {
      /* 某些环境下 file:// 不允许改历史记录，不影响主流程。 */
    }
  }

  async function loadStock(input, options = {}) {
    const incoming = typeof input === "string" ? { symbol: input } : { ...input };
    if (!incoming.symbol || !isValidSymbol(incoming.symbol)) {
      showToast("代码格式不正确", "error");
      return;
    }
    const knownMeta = commodityMeta(incoming.symbol);

    if (state.mode !== "stock") {
      setMode("stock", { syncHash: false, ensureStock: false, load: false });
    }

    const symbol = incoming.symbol;
    const isNew = state.quote?.stock?.symbol !== symbol;
    const token = ++state.loadToken;
    state.isRefreshing = true;

    state.selected = isNew
      ? { symbol, ...(knownMeta || {}), ...incoming }
      : { ...state.selected, ...knownMeta, ...incoming, symbol };
    if (isNew) {
      state.intraday = null;
      state.history = null;
      state.historyDayMap = null;
      state.chartHover = null;
      resetForStock(state.selected);
      paintFavoriteQuotes();
      updatePulseActive();
      updateCommodityActive();
      if (!state.quote) showView("loading");
      else dom.stockView.classList.add("is-switching");
    }

    if (options.historyMode) updateHash(symbol, options.historyMode);
    setConnection("busy", "同步中");
    dom.refreshButton.classList.add("is-spinning");
    dom.refreshButton.disabled = true;

    const tasks = [
      loadQuoteData(symbol, token),
      loadIntradayData(symbol, token),
      loadHistoryData(symbol, state.range, token),
    ];
    loadPrediction(symbol).catch(() => {});
    loadBrief(symbol, state.selected?.name).catch(() => {});
    const results = await Promise.allSettled(tasks);
    if (token !== state.loadToken) return;

    state.isRefreshing = false;
    dom.stockView.classList.remove("is-switching");
    dom.refreshButton.classList.remove("is-spinning");
    dom.refreshButton.disabled = false;

    const quoteFailed = results[0].status === "rejected";
    const intradayFailed = results[1].status === "rejected";
    const historyFailed = results[2].status === "rejected";

    if (!quoteFailed) {
      showView("stock");
      dom.updateLabel.textContent = `更新于 ${clockNow()}`;
      state.lastLiveRefresh = Date.now();
    } else if (!state.quote || state.quote.stock?.symbol !== state.selected?.symbol) {
      state.quote = null;
      showError(results[0].reason?.message || "没有获取到该标的的行情");
    } else {
      showToast(results[0].reason?.message || "行情更新失败", "error");
    }

    if (intradayFailed && state.quote) {
      showChartMessage("分时数据暂时不可用");
    }
    if (historyFailed && state.selected) {
      // loadHistoryData 已经渲染了错误态。
    }

    const hasError = quoteFailed || intradayFailed || historyFailed;
    setConnection(hasError ? "error" : "idle", hasError ? "部分数据异常" : "行情已连接");
    if (!hasError) hideTileTooltip();
  }

  async function loadQuoteData(symbol, token) {
    const { data, meta } = await api(`/api/quote?symbol=${encodeURIComponent(symbol)}`);
    if (token !== state.loadToken) return;
    state.quote = data;
    if (data.stock) {
      state.selected = { ...state.selected, ...data.stock, symbol: data.stock.symbol };
    }
    renderQuote();
    showView("stock");
    dom.stockView.classList.remove("is-switching");
    if (state.favorites.some((item) => item.symbol === symbol)) {
      state.favoriteQuotes[symbol] = data;
      paintFavoriteQuotes();
    }
    maybeNotifyStale(meta);
  }

  async function loadIntradayData(symbol, token) {
    showChartMessage("正在读取分时轨迹…", "loading");
    const { data, meta } = await api(`/api/intraday?symbol=${encodeURIComponent(symbol)}`);
    if (token !== state.loadToken) return;
    state.intraday = data;
    renderIntraday();
    maybeNotifyStale(meta);
  }

  async function loadHistoryData(symbol, range, token) {
    if (!symbol) return;
    const requestId = ++state.historyToken;
    const currentSymbol = symbol;
    dom.historyLoading.hidden = false;
    dom.historyError.hidden = true;
    dom.calendarView.hidden = true;
    dom.tableView.hidden = true;
    dom.historySummary.innerHTML = "";
    dom.historyFootnote.textContent = "正在加载…";

    try {
      const { data, meta } = await api(
        `/api/history?symbol=${encodeURIComponent(currentSymbol)}&range=${encodeURIComponent(range)}`,
      );
      if (requestId !== state.historyToken || state.selected?.symbol !== currentSymbol) return;
      state.history = data;
      state.historyDayMap = new Map(data.items.map((item) => [item.date, item]));
      dom.historyLoading.hidden = true;
      dom.historyError.hidden = true;
      renderHistory(data);
      maybeNotifyStale(meta);
    } catch (error) {
      if (requestId !== state.historyToken || state.selected?.symbol !== currentSymbol) return;
      dom.historyLoading.hidden = true;
      dom.historyError.hidden = false;
      dom.historyErrorText.textContent = error.message || "历史数据加载失败，请稍后重试。";
      dom.historyFootnote.textContent = "历史行情暂不可用";
      throw error;
    }
  }

  async function manualRefresh() {
    if (state.mode === "heatmap") {
      if (state.heatmap.loading) return;
      await loadHeatmap(state.heatmap.market, { force: true });
      refreshCommodities();
      if (!state.heatmap.error) showToast(`热力图已刷新 · ${clockNow()}`, "success");
      return;
    }
    if (!state.selected || state.isRefreshing) return;
    await loadStock(state.selected, { historyMode: "none" });
    await refreshFavoriteQuotes();
    refreshMarketPulse();
    refreshCommodities();
    if (state.quote) showToast(`行情已刷新 · ${clockNow()}`, "success");
  }

  async function quietRefresh() {
    if (
      state.mode !== "stock" ||
      !state.selected ||
      state.isRefreshing ||
      state.isAutoRefreshing ||
      document.visibilityState !== "visible"
    ) {
      return;
    }
    const symbol = state.selected.symbol;
    state.isAutoRefreshing = true;
    try {
      const [quoteResult, intradayResult] = await Promise.allSettled([
        api(`/api/quote?symbol=${encodeURIComponent(symbol)}`),
        api(`/api/intraday?symbol=${encodeURIComponent(symbol)}`),
      ]);
      if (state.selected?.symbol !== symbol) return;
      if (quoteResult.status === "fulfilled") {
        state.quote = quoteResult.value.data;
        if (state.quote.stock) {
          state.selected = { ...state.selected, ...state.quote.stock };
        }
        renderQuote();
        state.lastLiveRefresh = Date.now();
        dom.updateLabel.textContent = `更新于 ${clockNow()}`;
      }
      if (intradayResult.status === "fulfilled") {
        state.intraday = intradayResult.value.data;
        renderIntraday();
      }
      if (quoteResult.status === "fulfilled" || intradayResult.status === "fulfilled") {
        setConnection("idle", "行情已连接");
      }
      if (Date.now() - state.brief.loadedAt > 300_000) {
        loadBrief(symbol, state.selected?.name);
      }
      refreshFavoriteQuotes();
      refreshMarketPulse();
      refreshCommodities();
    } catch {
      /* 静默刷新失败时保留上一帧，避免打扰阅读。 */
    } finally {
      state.isAutoRefreshing = false;
    }
  }

  /* ------------------------------------------------------------------------
     Rendering — identity & quote
     ------------------------------------------------------------------------ */

  function resetForStock(stock) {
    renderIdentity(stock);
    dom.priceMain.textContent = "--";
    dom.priceMain.className = "main-price";
    dom.priceCurrency.textContent = stock.currency || "";
    dom.changeLine.className = "change-line flat";
    dom.changeValue.textContent = "--";
    dom.changePct.textContent = "--";
    if (dom.priceCny) {
      dom.priceCny.hidden = true;
      dom.priceCny.textContent = "";
    }
    dom.quoteTime.textContent = "行情时间 --";
    dom.statStrip.innerHTML = placeholderStats(stock);
    updateStarState();
    showChartMessage("正在读取分时轨迹…", "loading");
    clearHistoryView();
    resetPrediction();
    resetBrief(stock);
    document.title = `${stock.name || stock.code || "标的"} · 股票罗盘`;
  }

  function renderIdentity(stock) {
    const marketClass = (stock.market || "").toLowerCase();
    dom.boardTag.textContent = stock.board || stock.marketLabel || "标的";
    dom.boardTag.className = `market-tag ${marketClass}`;
    dom.exchangeTag.textContent = stock.exchange || "";
    dom.stockName.textContent = stock.name || stock.code || stock.symbol;
    dom.stockCode.textContent = stock.code || "--";
    dom.stockCurrency.textContent = stock.currency || "--";
    dom.stockMarketName.textContent = `${stock.marketLabel || ""} · ${stock.exchange || ""}`.replace(/ · $/, "");
    dom.priceCurrency.textContent = stock.currency || "";
    updateStarState();
  }

  /* ------------------------------------------------------------------------
     Brief — latest market news & next earnings date
     ------------------------------------------------------------------------ */

  function resetBrief(stock) {
    if (!dom.briefCard) return;
    state.brief.seq += 1;
    state.brief.data = null;
    state.brief.error = "";
    state.brief.loadedAt = 0;
    const isStock = !isCommodityMarket(stock);
    dom.briefCard.hidden = !isStock;
    if (!isStock) return;
    dom.newsList.hidden = false;
    dom.newsList.innerHTML = briefSkeletonMarkup();
    dom.briefNewsState.hidden = true;
    dom.briefNewsState.innerHTML = "";
    dom.newsUpdated.textContent = "更新于 --";
    dom.earningsBadge.className = "earnings-badge is-muted";
    dom.earningsBadge.textContent = "--";
    dom.earningsDate.textContent = "--";
    dom.earningsWeekday.textContent = "正在读取财报日程…";
    dom.earningsLabel.textContent = "";
    dom.earningsRecent.innerHTML = "";
    dom.earningsMeta.textContent = "数据来自东方财富公开信息";
    dom.earningsMeta.removeAttribute("title");
  }

  function briefSkeletonMarkup() {
    return Array.from({ length: 4 }, () => (
      "<li class=\"news-item\"><div class=\"news-link\">" +
      "<span class=\"skeleton news-skeleton-line short\"></span>" +
      "<span class=\"skeleton news-skeleton-line wide\"></span>" +
      "</div></li>"
    )).join("");
  }

  async function loadBrief(symbol, name) {
    if (!dom.briefCard || !symbol || isCommodityMarket(state.selected)) return;
    const requestId = ++state.brief.seq;
    const params = new URLSearchParams({ symbol });
    if (name) params.set("name", name);
    try {
      const { data } = await api(`/api/brief?${params.toString()}`);
      if (requestId !== state.brief.seq || state.selected?.symbol !== symbol) return;
      state.brief.data = data;
      state.brief.loadedAt = Date.now();
      renderBrief(data);
    } catch (error) {
      if (requestId !== state.brief.seq || state.selected?.symbol !== symbol) return;
      state.brief.error = error.message || "资讯与财报日程加载失败";
      renderBriefError(state.brief.error);
    }
  }

  function renderBrief(data) {
    const news = data?.news || {};
    const items = Array.isArray(news.items) ? news.items : [];
    dom.newsUpdated.textContent = `更新于 ${clockNow()}`;
    if (items.length) {
      dom.briefNewsState.hidden = true;
      dom.newsList.hidden = false;
      dom.newsList.innerHTML = items.map((item, index) => newsItemMarkup(item, index)).join("");
    } else {
      dom.newsList.innerHTML = "";
      setBriefNewsState(news.error || "暂未找到与该标的相关的市场讯息");
    }
    renderEarnings(data?.earnings || {});
  }

  function newsItemMarkup(item, index) {
    const title = escapeHtml(item.title || "未命名资讯");
    const url = item.url ? escapeAttr(item.url) : "";
    const when = escapeHtml(newsTimeLabel(item.publishedAt));
    const source = escapeHtml(item.source || "东方财富");
    const isLead = index === 0;
    const summary = isLead ? String(item.summary || "").trim() : "";
    const body = (
      `<span class="news-when">${when}</span>` +
      `<span class="news-title">${title}</span>` +
      (summary ? `<span class="news-summary">${escapeHtml(summary)}</span>` : "") +
      `<span class="news-source">${source}</span>`
    );
    const className = `news-item${isLead ? " is-lead" : ""}`;
    return url
      ? `<li class="${className}"><a class="news-link" href="${url}" target="_blank" rel="noopener noreferrer">${body}</a></li>`
      : `<li class="${className}"><div class="news-link">${body}</div></li>`;
  }

  function newsTimeLabel(value) {
    const text = String(value || "").trim();
    if (!text) return "--";
    const [datePart, timePart] = text.split(" ");
    const [, month, day] = datePart.split("-");
    if (!month || !day) return text;
    return `${month}-${day}${timePart ? ` ${timePart.slice(0, 5)}` : ""}`;
  }

  function countdownLabel(dateString) {
    const [year, month, day] = String(dateString || "").split("-").map(Number);
    if (!year || !month || !day) return "";
    const target = Date.UTC(year, month - 1, day);
    const now = new Date();
    const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
    const days = Math.round((target - today) / 86_400_000);
    if (days === 0) return "今天";
    if (days === 1) return "明天";
    if (days === -1) return "昨天";
    return days > 0 ? `${days} 天后` : `${Math.abs(days)} 天前`;
  }

  function setBriefNewsState(message, mode = "empty") {
    dom.newsList.hidden = true;
    dom.briefNewsState.hidden = false;
    const icon = mode === "error" ? "icon-alert" : "icon-list";
    const retry = mode === "error"
      ? "<button type=\"button\" class=\"text-button\" data-brief-retry>重试</button>"
      : "";
    dom.briefNewsState.className = `brief-state ${mode}`;
    dom.briefNewsState.innerHTML = (
      `<svg class="icon" aria-hidden="true"><use href="#${icon}"></use></svg>` +
      `<span>${escapeHtml(message)}</span>${retry}`
    );
  }

  function renderEarnings(earnings) {
    const next = earnings?.next || null;
    const recent = Array.isArray(earnings.recent) ? earnings.recent.slice(0, 2) : [];
    if (!next || !next.date) {
      dom.earningsBadge.className = "earnings-badge is-muted";
      dom.earningsBadge.textContent = "待定";
      dom.earningsDate.textContent = "--";
      dom.earningsWeekday.textContent = earnings?.error || "暂未获取到下次财报日期";
      dom.earningsLabel.textContent = "";
      dom.earningsMeta.textContent = "数据来自东方财富公开信息";
      dom.earningsMeta.removeAttribute("title");
    } else {
      const estimated = Boolean(next.estimated);
      dom.earningsBadge.className = `earnings-badge${estimated ? " is-estimated" : ""}`;
      dom.earningsBadge.textContent = estimated ? "预计" : "已排期";
      dom.earningsDate.textContent = formatDateDot(next.date);
      dom.earningsWeekday.textContent = `${weekdayCN(next.date)} · ${countdownLabel(next.date)}`;
      dom.earningsLabel.textContent = next.label || "财报";
      const note = estimated
        ? "按历史披露规律估算，实际日期以公司公告为准"
        : `${next.source || "披露日程"} · 数据来自东方财富`;
      dom.earningsMeta.textContent = note;
      if (next.detail) dom.earningsMeta.title = next.detail;
      else dom.earningsMeta.removeAttribute("title");
    }
    dom.earningsRecent.innerHTML = recent.length
      ? (
          "<span class=\"earnings-recent-item\">最近披露</span>" +
          recent.map((item) => (
            `<span class="earnings-recent-item">${escapeHtml(item.label || "财报")}` +
            `<em>${escapeHtml(formatMonthDay(item.date))}</em></span>`
          )).join("")
        )
      : "";
  }

  function renderBriefError(message) {
    dom.newsUpdated.textContent = "更新于 --";
    setBriefNewsState(message || "资讯加载失败，请稍后重试", "error");
    dom.earningsBadge.className = "earnings-badge is-muted";
    dom.earningsBadge.textContent = "待定";
    dom.earningsDate.textContent = "--";
    dom.earningsWeekday.textContent = "财报日程暂不可用";
    dom.earningsLabel.textContent = "";
    dom.earningsRecent.innerHTML = "";
    dom.earningsMeta.textContent = "请稍后重试";
    dom.earningsMeta.removeAttribute("title");
  }

  function renderQuote() {
    const quote = state.quote;
    if (!quote || !quote.stock) return;
    const stock = quote.stock;
    const decimals = Number(quote.decimals) || 2;
    const tone = toneOf(quote.changePct);

    renderIdentity(stock);
    dom.quoteTime.textContent = quote.quoteTime
      ? `行情 ${formatTimeOnly(quote.quoteTime, true)}`
      : "行情时间 --";

    dom.priceMain.textContent = formatPrice(quote.price, decimals);
    dom.priceMain.className = `main-price ${tone}`;
    dom.priceCurrency.textContent = stock.currency || "";
    dom.changeLine.className = `change-line ${tone}`;
    dom.changeValue.textContent = formatSigned(quote.change, decimals);
    dom.changePct.textContent = formatPct(quote.changePct);
    if (dom.priceCny) {
      if (quote.cnyPrice !== null && quote.cnyPrice !== undefined) {
        const rateText = quote.cnyRate ? ` · USD/CNY ${formatPrice(quote.cnyRate, 4)}` : "";
        dom.priceCny.textContent = `≈ ${formatPrice(quote.cnyPrice, 2)} 元/g${rateText}`;
        dom.priceCny.hidden = false;
      } else {
        dom.priceCny.hidden = true;
        dom.priceCny.textContent = "";
      }
    }

    dom.stockName.textContent = stock.name || state.selected?.name || "--";
    dom.stockCode.textContent = stock.code || "--";
    dom.stockCurrency.textContent = stock.currency || "--";
    dom.stockMarketName.textContent = `${stock.marketLabel || ""} · ${stock.exchange || ""}`.replace(/ · $/, "");
    dom.stockStar.title = isFavorite(stock.symbol) ? "从自选中移除" : "加入自选";
    dom.statStrip.innerHTML = renderStatStrip(quote);

    const quotePrice = Number(quote.price);
    const prev = Number(quote.prevClose);
    if (Number.isFinite(quotePrice) && Number.isFinite(prev)) {
      dom.priceLegendSwatch.className = `legend-swatch ${quotePrice >= prev ? "line-red" : "line-green"}`;
    }

    document.title = `${stock.name} ${formatPrice(quote.price, decimals)} ${formatPct(quote.changePct)} · 股票罗盘`;
    updateStarState();
    if (state.favorites.some((item) => item.symbol === stock.symbol)) {
      state.favoriteQuotes[stock.symbol] = quote;
      paintFavoriteQuotes();
    }
  }

  function renderStatStrip(quote) {
    const d = Number(quote.decimals) || 2;
    const currency = quote.stock?.currency || "CNY";
    const prev = Number(quote.prevClose);
    const highTone = Number(quote.high) >= prev ? "up" : "down";
    const lowTone = Number(quote.low) <= prev ? "down" : "up";
    if (isConvertibleCommodity(quote.stock)) {
      return [
        statCell("今开", formatPrice(quote.open, d)),
        statCell("昨收", formatPrice(quote.prevClose, d)),
        statCell("最高", formatPrice(quote.high, d), highTone),
        statCell("最低", formatPrice(quote.low, d), lowTone),
        statCell("成交量", formatVolume(quote.volume, "手")),
        statCell("振幅", formatPct(quote.amplitudePct)),
        statCell("涨跌额", formatSigned(quote.change, d), toneOf(quote.changePct)),
        statCell("人民币/g", quote.cnyPrice !== null && quote.cnyPrice !== undefined ? `${formatPrice(quote.cnyPrice, 2)} 元` : "—"),
        statCell("计价单位", quote.stock?.unit || "—"),
        statCell("美元兑人民币", quote.cnyRate ? formatPrice(quote.cnyRate, 4) : "—"),
      ].join("");
    }
    if (isForexInstrument(quote.stock)) {
      return [
        statCell("今开", formatPrice(quote.open, d)),
        statCell("昨收", formatPrice(quote.prevClose, d)),
        statCell("最高", formatPrice(quote.high, d), highTone),
        statCell("最低", formatPrice(quote.low, d), lowTone),
        statCell("振幅", formatPct(quote.amplitudePct)),
        statCell("涨跌额", formatSigned(quote.change, d), toneOf(quote.changePct)),
        statCell("合约", quote.stock?.code || "—"),
        statCell("交易所", quote.stock?.exchange || "—"),
        statCell("计价单位", quote.stock?.unit || "—"),
        statCell("类型", quote.stock?.marketLabel || "外汇"),
      ].join("");
    }
    if (isCommodityMarket(quote.stock)) {
      return [
        statCell("今开", formatPrice(quote.open, d)),
        statCell("昨收", formatPrice(quote.prevClose, d)),
        statCell("最高", formatPrice(quote.high, d), highTone),
        statCell("最低", formatPrice(quote.low, d), lowTone),
        statCell("成交量", formatVolume(quote.volume, "手")),
        statCell("振幅", formatPct(quote.amplitudePct)),
        statCell("涨跌额", formatSigned(quote.change, d), toneOf(quote.changePct)),
        statCell("合约", quote.stock?.code || "—"),
        statCell("交易所", quote.stock?.exchange || "—"),
        statCell("计价单位", quote.stock?.unit || "—"),
      ].join("");
    }
    return [
      statCell("今开", formatPrice(quote.open, d)),
      statCell("昨收", formatPrice(quote.prevClose, d)),
      statCell("最高", formatPrice(quote.high, d), highTone),
      statCell("最低", formatPrice(quote.low, d), lowTone),
      statCell("成交量", formatVolume(quote.volume, volumeUnit(quote.stock))),
      statCell("成交额", formatMoney(quote.amount, currency)),
      statCell("换手率", formatPct(quote.turnoverPct)),
      statCell("振幅", formatPct(quote.amplitudePct)),
      statCell("市盈率（动）", quote.pe ? formatNumber(quote.pe, 2) : "—"),
      statCell("总市值", formatMoney(quote.marketCap, currency)),
    ].join("");
  }

  function placeholderStats(stock) {
    let labels;
    if (isConvertibleCommodity(stock)) {
      labels = ["今开", "昨收", "最高", "最低", "成交量", "振幅", "涨跌额", "人民币/g", "计价单位", "美元兑人民币"];
    } else if (isForexInstrument(stock)) {
      labels = ["今开", "昨收", "最高", "最低", "振幅", "涨跌额", "合约", "交易所", "计价单位", "类型"];
    } else if (isCommodityMarket(stock) || isCommoditySymbol(stock?.symbol)) {
      labels = ["今开", "昨收", "最高", "最低", "成交量", "振幅", "涨跌额", "合约", "交易所", "计价单位"];
    } else {
      labels = ["今开", "昨收", "最高", "最低", "成交量", "成交额", "换手率", "振幅", "市盈率（动）", "总市值"];
    }
    return labels.map((label) => statCell(label, "—")).join("");
  }

  function statCell(label, value, tone = "") {
    return `<div class="stat-cell"><span class="stat-label">${escapeHtml(label)}</span><span class="stat-value ${tone}">${escapeHtml(value)}</span></div>`;
  }

  /* ------------------------------------------------------------------------
     Intraday chart
     ------------------------------------------------------------------------ */

  function showChartMessage(message, mode = "error") {
    if (!dom.chartState) return;
    const content =
      mode === "loading"
        ? `<span class="spinner"></span><span>${escapeHtml(message)}</span>`
        : `<svg class="icon" aria-hidden="true"><use href="#icon-alert"></use></svg><span>${escapeHtml(message)}</span>`;
    dom.chartState.innerHTML = content;
    dom.chartState.hidden = false;
    dom.chartTooltip.hidden = true;
    dom.intradayCanvas.style.opacity = "0.16";
  }

  function hideChartMessage() {
    dom.chartState.hidden = true;
    dom.intradayCanvas.style.opacity = "1";
  }

  function renderIntraday() {
    const data = state.intraday;
    if (!data || !Array.isArray(data.points) || !data.points.length) {
      showChartMessage("今天还没有分时数据");
      dom.chartFootStats.innerHTML = "";
      return;
    }
    hideChartMessage();
    const date = data.tradingDate || data.points[0].datetime.slice(0, 10);
    const unitNote = data.stock?.unit ? ` · ${data.stock.unit}` : "";
    dom.intradaySubtitle.textContent = `${formatDateCN(date)} ${weekdayCN(date)} · 共 ${data.total} 个时点${unitNote}`;

    const points = data.points;
    const prices = points.map((point) => Number(point.price)).filter(Number.isFinite);
    const high = Math.max(...prices);
    const low = Math.min(...prices);
    const last = points[points.length - 1];
    const totalVolume = points.reduce((sum, point) => sum + (Number(point.volume) || 0), 0);
    const decimals = Number(data.decimals) || 2;

    const footStats = [
      chartFootStat("最新", formatPrice(last.price, decimals)),
      chartFootStat("区间高", formatPrice(high, decimals)),
      chartFootStat("区间低", formatPrice(low, decimals)),
    ];
    if (isForexInstrument(data.stock)) {
      const amplitude = Number(data.prevClose) ? ((high - low) / Number(data.prevClose)) * 100 : null;
      footStats.push(
        chartFootStat("昨收", formatPrice(data.prevClose, decimals)),
        chartFootStat("振幅", formatPct(amplitude)),
      );
    } else {
      footStats.push(
        chartFootStat("均价", formatPrice(last.avg, decimals)),
        chartFootStat("成交量", formatVolume(totalVolume, volumeUnit(data.stock))),
      );
    }
    if (Number(data.cnyRate) > 0) {
      const cny = cnyPerGram(last.price, data.cnyRate);
      if (cny !== null) footStats.push(chartFootStat("人民币", `${formatPrice(cny, 2)} 元/g`));
    }
    dom.chartFootStats.innerHTML = footStats.join("");
    dom.intradayCanvas.setAttribute(
      "aria-label",
      `${data.stock?.name || ""} ${date} 分时走势，最高 ${formatPrice(high, decimals)}，最低 ${formatPrice(low, decimals)}`,
    );

    const quotePrice = Number(state.quote?.price);
    const prev = Number(data.prevClose);
    if (Number.isFinite(quotePrice) && Number.isFinite(prev)) {
      dom.priceLegendSwatch.className = `legend-swatch ${quotePrice >= prev ? "line-red" : "line-green"}`;
    }
    window.requestAnimationFrame(drawIntradayChart);
  }

  function chartFootStat(label, value) {
    return `<span class="chart-foot-stat"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></span>`;
  }

  function drawIntradayChart() {
    const canvas = dom.intradayCanvas;
    const ctx = dom.canvasContext;
    const data = state.intraday;
    if (!canvas || !ctx || !data || !Array.isArray(data.points) || data.points.length === 0) return;

    const rect = canvas.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 40) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const pixelWidth = Math.round(rect.width * dpr);
    const pixelHeight = Math.round(rect.height * dpr);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);

    const width = rect.width;
    const height = rect.height;
    const left = 8;
    const right = 58;
    const top = 15;
    const bottom = 24;
    const volumeHeight = Math.max(35, Math.min(56, height * 0.135));
    const gap = 17;
    const priceBottom = height - bottom - volumeHeight - gap;
    const priceHeight = Math.max(60, priceBottom - top);
    const plotWidth = width - left - right;
    const points = data.points;
    const decimals = Number(data.decimals) || 2;
    const prevClose = Number(data.prevClose);
    const prices = points.map((point) => Number(point.price)).filter(Number.isFinite);
    if (!prices.length) return;

    let minPrice = Math.min(...prices);
    let maxPrice = Math.max(...prices);
    if (Number.isFinite(prevClose)) {
      minPrice = Math.min(minPrice, prevClose);
      maxPrice = Math.max(maxPrice, prevClose);
    }
    let priceRange = maxPrice - minPrice;
    if (priceRange <= 0) {
      priceRange = Math.max(Math.abs(maxPrice) * 0.01, 1);
    }
    const padding = priceRange * 0.09;
    minPrice -= padding;
    maxPrice += padding;
    priceRange = maxPrice - minPrice;

    const yPrice = (value) => top + ((maxPrice - value) / priceRange) * priceHeight;
    const xAt = (index) =>
      points.length === 1 ? left + plotWidth / 2 : left + (index / (points.length - 1)) * plotWidth;

    ctx.save();
    ctx.lineWidth = 1;

    // 价格网格与右侧刻度
    const gridLines = 4;
    ctx.font = '9px "SFMono-Regular", "SF Mono", Menlo, monospace';
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    for (let i = 0; i <= gridLines; i += 1) {
      const y = top + (i / gridLines) * priceHeight;
      ctx.beginPath();
      ctx.strokeStyle = i === 0 || i === gridLines ? THEME.grid : THEME.gridSoft;
      ctx.moveTo(left, y);
      ctx.lineTo(width - right, y);
      ctx.stroke();
      const value = maxPrice - (i / gridLines) * priceRange;
      ctx.fillStyle = THEME.faint;
      ctx.fillText(formatPrice(value, decimals), width - right + 7, y);
    }

    // 时间网格
    for (let i = 1; i < 4; i += 1) {
      const x = left + (i / 4) * plotWidth;
      ctx.beginPath();
      ctx.strokeStyle = THEME.gridSoft;
      ctx.moveTo(x, top);
      ctx.lineTo(x, priceBottom);
      ctx.stroke();
    }

    // 成交量
    const volumeTop = priceBottom + gap;
    const volumeBottom = height - bottom;
    const volumeMax = Math.max(...points.map((point) => Number(point.volume) || 0), 1);
    const barWidth = Math.max(1, (plotWidth / Math.max(points.length, 1)) * 0.62);
    ctx.fillStyle = THEME.volumeBg;
    ctx.fillRect(left, volumeTop, plotWidth, volumeBottom - volumeTop);
    for (let i = 0; i < points.length; i += 1) {
      const point = points[i];
      const previous = i > 0 ? points[i - 1] : point;
      const rising = Number(point.price) >= Number(previous.price);
      const barHeight = ((Number(point.volume) || 0) / volumeMax) * (volumeBottom - volumeTop - 5);
      ctx.fillStyle = withAlpha(rising ? THEME.up : THEME.down, 0.34);
      const x = xAt(i) - barWidth / 2;
      ctx.fillRect(x, volumeBottom - barHeight, barWidth, barHeight);
    }
    ctx.fillStyle = THEME.faint;
    ctx.font = '8px "SFMono-Regular", "SF Mono", Menlo, monospace';
    ctx.textAlign = "left";
    ctx.fillText("VOL", left + 1, volumeTop + 8);

    // 昨收线
    if (Number.isFinite(prevClose)) {
      const y = yPrice(prevClose);
      ctx.save();
      ctx.beginPath();
      ctx.strokeStyle = THEME.baseline;
      ctx.setLineDash([3, 4]);
      ctx.moveTo(left, y);
      ctx.lineTo(width - right, y);
      ctx.stroke();
      ctx.restore();
    }

    const last = points[points.length - 1];
    const lineColor = Number.isFinite(prevClose) && Number(last.price) < prevClose ? THEME.down : THEME.up;

    // 面积
    const gradient = ctx.createLinearGradient(0, top, 0, priceBottom);
    gradient.addColorStop(0, withAlpha(lineColor, 0.17));
    gradient.addColorStop(0.75, withAlpha(lineColor, 0.025));
    gradient.addColorStop(1, withAlpha(lineColor, 0));
    ctx.beginPath();
    ctx.moveTo(xAt(0), priceBottom);
    for (let i = 0; i < points.length; i += 1) {
      ctx.lineTo(xAt(i), yPrice(Number(points[i].price)));
    }
    ctx.lineTo(xAt(points.length - 1), priceBottom);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    // 价格线
    ctx.beginPath();
    for (let i = 0; i < points.length; i += 1) {
      const x = xAt(i);
      const y = yPrice(Number(points[i].price));
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 1.55;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.stroke();

    // 均价线
    const avgPoints = points.filter((point) => Number(point.avg) > 0);
    if (avgPoints.length) {
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < points.length; i += 1) {
        const avg = Number(points[i].avg);
        if (!Number.isFinite(avg) || avg <= 0) continue;
        const x = xAt(i);
        const y = yPrice(avg);
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.strokeStyle = withAlpha(THEME.gold, 0.72);
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // 时间刻度
    const labelIndexes = uniqueIndexes([0, 0.25, 0.5, 0.75, 1].map((ratio) =>
      Math.round(ratio * (points.length - 1)),
    ));
    ctx.font = '8px "SFMono-Regular", "SF Mono", Menlo, monospace';
    ctx.fillStyle = THEME.faint;
    ctx.textBaseline = "bottom";
    for (const index of labelIndexes) {
      const x = xAt(index);
      const label = points[index].time;
      ctx.textAlign = index === 0 ? "left" : index === points.length - 1 ? "right" : "center";
      ctx.fillText(label, x, height - 4);
    }

    // 最新点
    const lastX = xAt(points.length - 1);
    const lastY = yPrice(Number(last.price));
    ctx.beginPath();
    ctx.fillStyle = withAlpha(lineColor, 0.18);
    ctx.arc(lastX, lastY, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.fillStyle = THEME.bg;
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 2;
    ctx.arc(lastX, lastY, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // 悬浮十字线
    if (state.chartHover !== null && state.chartHover >= 0 && state.chartHover < points.length) {
      const hoverIndex = state.chartHover;
      const hoverPoint = points[hoverIndex];
      const x = xAt(hoverIndex);
      const y = yPrice(Number(hoverPoint.price));
      ctx.save();
      ctx.beginPath();
      ctx.strokeStyle = THEME.crosshair;
      ctx.setLineDash([3, 3]);
      ctx.moveTo(x, top);
      ctx.lineTo(x, volumeBottom);
      ctx.stroke();
      ctx.restore();
      ctx.beginPath();
      ctx.fillStyle = THEME.bg;
      ctx.strokeStyle = lineColor;
      ctx.lineWidth = 1.8;
      ctx.arc(x, y, 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      const volumeHeightHover =
        ((Number(hoverPoint.volume) || 0) / volumeMax) * (volumeBottom - volumeTop - 5);
      ctx.fillStyle = withAlpha(lineColor, 0.8);
      ctx.fillRect(x - barWidth / 2, volumeBottom - volumeHeightHover, barWidth, volumeHeightHover);
    }

    ctx.restore();

    state.chartGeometry = {
      width,
      height,
      left,
      right,
      top,
      bottom,
      priceBottom,
      volumeTop,
      volumeBottom,
      plotWidth,
      points,
      xAt,
      yPrice,
    };
  }

  function handleChartPointerMove(event) {
    const geometry = state.chartGeometry;
    if (!geometry || !state.intraday) return;
    const rect = dom.intradayCanvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    if (x < geometry.left - 5 || x > geometry.left + geometry.plotWidth + 5) {
      handleChartPointerLeave();
      return;
    }
    const ratio = Math.max(0, Math.min(1, (x - geometry.left) / geometry.plotWidth));
    const index = Math.round(ratio * (geometry.points.length - 1));
    if (state.chartHover !== index) {
      state.chartHover = index;
      drawIntradayChart();
    }
    showChartTooltip(index);
  }

  function handleChartPointerLeave() {
    if (state.chartHover === null) return;
    state.chartHover = null;
    dom.chartTooltip.hidden = true;
    drawIntradayChart();
  }

  function showChartTooltip(index) {
    const geometry = state.chartGeometry;
    const data = state.intraday;
    if (!geometry || !data) return;
    const point = geometry.points[index];
    if (!point) return;
    const decimals = Number(data.decimals) || 2;
    const prev = Number(data.prevClose);
    const price = Number(point.price);
    const pct = Number.isFinite(prev) && prev ? ((price / prev - 1) * 100) : null;
    const tone = toneOf(pct);
    const x = geometry.xAt(index);
    const y = geometry.yPrice(price);

    const cny = cnyPerGram(price, data.cnyRate);
    const cnyRow = cny !== null
      ? `<div class="chart-tooltip-row"><span>人民币</span><strong>${escapeHtml(formatPrice(cny, 2))} 元/g</strong></div>`
      : "";
    const avgRow = Number(point.avg) > 0
      ? `<div class="chart-tooltip-row"><span>均价</span><strong>${escapeHtml(formatPrice(point.avg, decimals))}</strong></div>`
      : "";
    const volumeRow = isForexInstrument(data.stock)
      ? ""
      : `<div class="chart-tooltip-row"><span>成交量</span><strong>${escapeHtml(formatVolume(point.volume, volumeUnit(data.stock)))}</strong></div>`;
    dom.chartTooltip.innerHTML = `
      <div class="chart-tooltip-time"><span>${escapeHtml(point.datetime.slice(0, 10))}</span><strong>${escapeHtml(point.time)}</strong></div>
      <div class="chart-tooltip-row"><span>价格</span><strong class="${tone}">${escapeHtml(formatPrice(price, decimals))}</strong></div>
      ${avgRow}
      <div class="chart-tooltip-row"><span>较昨收</span><strong class="${tone}">${escapeHtml(formatPct(pct))}</strong></div>
      ${cnyRow}
      ${volumeRow}
    `;

    const stageWidth = dom.chartStage.clientWidth;
    const left = clamp(x, 84, Math.max(84, stageWidth - 84));
    const below = y < 95;
    dom.chartTooltip.classList.toggle("is-below", below);
    dom.chartTooltip.style.left = `${left}px`;
    dom.chartTooltip.style.top = `${below ? y + 12 : y - 9}px`;
    dom.chartTooltip.hidden = false;
  }

  /* ------------------------------------------------------------------------
     History rendering
     ------------------------------------------------------------------------ */

  function clearHistoryView() {
    dom.historySummary.innerHTML = "";
    dom.calendarView.innerHTML = "";
    dom.tableBody.innerHTML = "";
    dom.historyFootnote.textContent = "等待历史数据…";
    dom.historyError.hidden = true;
    dom.historyLoading.hidden = false;
    dom.calendarView.hidden = true;
    dom.tableView.hidden = true;
  }

  function renderHistory(data) {
    renderHistorySummary(data.summary, data);
    renderCalendar(data.items, data.decimals);
    renderHistoryTable(data.items, data);
    setViewVisibility();
    const start = data.items[0]?.date;
    const end = data.items[data.items.length - 1]?.date;
    const today = shanghaiDateString();
    const todayNote = end === today ? " · 含今日盘中" : "";
    const basis = isForexInstrument(data.stock)
      ? "日线"
      : isCommodityMarket(data.stock) ? "连续合约日线" : "前复权日线";
    const unitNote = isCommodityMarket(data.stock) && data.stock?.unit
      ? ` · 价格单位 ${data.stock.unit}`
      : "";
    dom.historyFootnote.textContent =
      `${basis}${unitNote} · ${formatDateDot(start)} – ${formatDateDot(end)} · 共 ${data.items.length} 个交易日${todayNote}`;
  }

  function renderHistorySummary(summary, data) {
    if (!summary || !summary.total) {
      dom.historySummary.innerHTML = "";
      return;
    }
    const up = Number(summary.up) || 0;
    const down = Number(summary.down) || 0;
    const flat = Number(summary.flat) || 0;
    const upPct = Number(summary.upRatio) || 0;
    const downPct = Number(summary.downRatio) || 0;
    const flatPct = Math.max(0, 100 - upPct - downPct);
    const intervalTone = toneOf(summary.intervalPct);
    const avgTone = toneOf(summary.avgPct);
    const best = summary.best;
    const bestTone = best ? toneOf(best.pct) : "flat";
    const drawdownTone = Number(summary.maxDrawdown) < 0 ? "down" : "flat";

    dom.historySummary.innerHTML = `
      <div class="summary-ratio">
        <div class="ratio-headline"><span class="ratio-number">${upPct.toFixed(1)}<small>%</small></span></div>
        <p class="ratio-caption">上涨交易日占比 · 共 ${summary.total} 个交易日</p>
        <div class="ratio-counts">
          <span class="up"><i class="count-dot"></i>涨 ${up}</span>
          <span class="down"><i class="count-dot"></i>跌 ${down}</span>
          ${flat ? `<span class="flat"><i class="count-dot"></i>平 ${flat}</span>` : ""}
        </div>
        <div class="ratio-bar" aria-hidden="true">
          <span class="bar-up" style="width:${upPct}%"></span>
          <span class="bar-down" style="width:${downPct}%"></span>
          <span class="bar-flat" style="width:${flatPct}%"></span>
        </div>
      </div>
      <div class="summary-metrics">
        <div class="summary-metric">
          <span class="metric-label">区间涨跌</span>
          <strong class="metric-value ${intervalTone}">${formatPct(summary.intervalPct)}</strong>
          <span class="metric-sub">按每日涨跌复利</span>
        </div>
        <div class="summary-metric">
          <span class="metric-label">日均涨跌</span>
          <strong class="metric-value ${avgTone}">${formatPct(summary.avgPct)}</strong>
          <span class="metric-sub">${data.rangeLabel || ""}</span>
        </div>
        <div class="summary-metric">
          <span class="metric-label">最强单日</span>
          <strong class="metric-value ${bestTone}">${best ? formatPct(best.pct) : "—"}</strong>
          <span class="metric-sub">${best ? formatMonthDay(best.date) : "—"}</span>
        </div>
        <div class="summary-metric">
          <span class="metric-label">最大回撤</span>
          <strong class="metric-value ${drawdownTone}">${formatPct(summary.maxDrawdown)}</strong>
          <span class="metric-sub">区间收盘价峰值回落</span>
        </div>
      </div>
    `;
  }

  function renderCalendar(items, decimals = 2) {
    const light = isLightTheme();
    const groups = new Map();
    for (const item of items) {
      const key = item.date.slice(0, 7);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    const keys = [...groups.keys()].sort();
    const today = shanghaiDateString();
    const months = keys.map((key) => {
      const [yearText, monthText] = key.split("-");
      const year = Number(yearText);
      const month = Number(monthText);
      const monthItems = groups.get(key);
      const up = monthItems.filter((item) => item.pct > 0).length;
      const down = monthItems.filter((item) => item.pct < 0).length;
      const byDate = new Map(monthItems.map((item) => [item.date, item]));
      const firstWeekday = (new Date(year, month - 1, 1).getDay() + 6) % 7;
      const daysInMonth = new Date(year, month, 0).getDate();
      const cells = [];
      for (let i = 0; i < firstWeekday; i += 1) {
        cells.push('<span class="day-blank" aria-hidden="true"></span>');
      }
      for (let day = 1; day <= daysInMonth; day += 1) {
        const date = `${key}-${String(day).padStart(2, "0")}`;
        const item = byDate.get(date);
        if (!item) {
          cells.push('<span class="day-blank" aria-hidden="true"></span>');
          continue;
        }
        const pct = Number(item.pct) || 0;
        const tone = pct > 0 ? "up" : pct < 0 ? "down" : "flat";
        const intensity = Math.min(1, Math.abs(pct) / 6);
        const toneColor = tone === "up" ? THEME.up : THEME.down;
        const alpha = tone === "flat" ? 0 : light ? 0.09 + intensity * 0.4 : 0.15 + intensity * 0.66;
        const background =
          tone === "flat" ? "var(--day-flat-bg)" : withAlpha(toneColor, alpha);
        const border =
          tone === "flat"
            ? "var(--day-flat-border)"
            : withAlpha(toneColor, Math.min(0.92, light ? 0.2 + alpha * 0.45 : alpha + 0.1));
        const foreground =
          tone === "flat"
            ? "var(--muted)"
            : light
              ? tone === "up" ? "#5f1a1e" : "#03483a"
              : "rgba(255, 255, 255, 0.94)";
        const todayClass = date === today ? " is-today" : "";
        const aria = `${formatDateCN(date)} ${weekdayCN(date)}，${tone === "up" ? "上涨" : tone === "down" ? "下跌" : "平盘"} ${Math.abs(pct).toFixed(2)}%，收盘 ${formatPrice(item.close, decimals)}`;
        cells.push(
          `<button type="button" class="day-tile ${tone}${todayClass}" style="--tile-bg:${background};--tile-border:${border};--tile-fg:${foreground}" data-date="${date}" aria-label="${escapeAttr(aria)}">` +
            `<span class="day-number">${day}</span><span class="day-pct">${escapeHtml(formatPct(pct))}</span></button>`,
        );
      }
      const trailing = (7 - ((firstWeekday + daysInMonth) % 7)) % 7;
      for (let i = 0; i < trailing; i += 1) {
        cells.push('<span class="day-blank" aria-hidden="true"></span>');
      }
      return `
        <article class="month-card" aria-label="${year}年${month}月">
          <header class="month-head">
            <h3 class="month-title">${year}<span>${String(month).padStart(2, "0")} 月</span></h3>
            <span class="month-stats"><span class="up">涨 ${up}</span> · <span class="down">跌 ${down}</span></span>
          </header>
          <div class="weekday-row" aria-hidden="true"><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span><span>日</span></div>
          <div class="days-grid">${cells.join("")}</div>
        </article>`;
    });

    dom.calendarView.className = `calendar-grid months-${Math.min(keys.length, 3)}`;
    dom.calendarView.innerHTML = months.join("");
    paintPredictionMarkers();
  }

  function renderHistoryTable(items, data) {
    const decimals = Number(data.decimals) || 2;
    const currency = data.stock?.currency || "CNY";
    const rows = [...items].reverse().map((item) => {
      const tone = toneOf(item.pct);
      return `<tr>
        <td>${escapeHtml(item.date)}</td>
        <td>${escapeHtml(formatPrice(item.close, decimals))}</td>
        <td class="pct-cell ${tone}">${escapeHtml(formatPct(item.pct))}</td>
        <td>${escapeHtml(formatPrice(item.open, decimals))}</td>
        <td>${escapeHtml(formatPrice(item.high, decimals))}</td>
        <td>${escapeHtml(formatPrice(item.low, decimals))}</td>
        <td>${escapeHtml(formatVolume(item.volume, volumeUnit(data.stock)))}</td>
        <td>${escapeHtml(formatAmount(item.amount, currency, data.stock))}</td>
      </tr>`;
    });
    dom.tableBody.innerHTML = rows.join("");
  }

  function setViewVisibility() {
    const hasData = Boolean(state.history);
    dom.calendarView.hidden = !hasData || state.view !== "calendar";
    dom.tableView.hidden = !hasData || state.view !== "table";
  }

  function setView(view, options = {}) {
    if (!["calendar", "table"].includes(view)) view = "calendar";
    state.view = view;
    if (options.persist !== false) safeStorageSet(STORAGE.view, view);
    for (const button of dom.viewToggle.querySelectorAll("[data-view]")) {
      button.classList.toggle("active", button.dataset.view === view);
    }
    if (options.rerender !== false) setViewVisibility();
  }

  function setRangeButtons() {
    if (!["1m", "3m", "6m", "1y"].includes(state.range)) state.range = "1m";
    for (const button of dom.rangeTabs.querySelectorAll("[data-range]")) {
      const active = button.dataset.range === state.range;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
    }
  }

  function handleRangeClick(event) {
    const button = event.target.closest("[data-range]");
    if (!button) return;
    const range = button.dataset.range;
    if (!["1m", "3m", "6m", "1y"].includes(range) || range === state.range) return;
    state.range = range;
    safeStorageSet(STORAGE.range, range);
    setRangeButtons();
    if (state.selected) {
      loadHistoryData(state.selected.symbol, range, state.loadToken).catch(() => {});
    }
  }

  function handleViewToggleClick(event) {
    const button = event.target.closest("[data-view]");
    if (!button) return;
    setView(button.dataset.view);
  }

  /* ------------------------------------------------------------------------
     Calendar tooltip
     ------------------------------------------------------------------------ */

  function handleTilePointerOver(event) {
    const tile = event.target.closest(".day-tile");
    if (!tile || !dom.calendarView.contains(tile)) return;
    showTileTooltip(tile);
  }

  function handleTilePointerOut(event) {
    const tile = event.target.closest(".day-tile");
    if (!tile) return;
    const related = event.relatedTarget;
    if (related && tile.contains(related)) return;
    hideTileTooltip();
  }

  function handleTileFocusIn(event) {
    const tile = event.target.closest(".day-tile");
    if (tile) showTileTooltip(tile);
  }

  function handleTileFocusOut(event) {
    if (event.target.closest(".day-tile")) hideTileTooltip();
  }

  function showTileTooltip(tile) {
    const date = tile.dataset.date;
    const item = state.historyDayMap?.get(date);
    if (!item || !state.history) return;
    const decimals = Number(state.history.decimals) || 2;
    const currency = state.history.stock?.currency || "CNY";
    const tone = toneOf(item.pct);
    dom.tileTooltip.innerHTML = `
      <div class="tooltip-date">
        <span>${escapeHtml(formatDateCN(date))} · ${escapeHtml(weekdayCN(date))}</span>
        <span class="tooltip-pct ${tone}">${escapeHtml(formatPct(item.pct))}</span>
      </div>
      <div class="tooltip-grid">
        <div><span>收盘</span><strong>${escapeHtml(formatPrice(item.close, decimals))}</strong></div>
        <div><span>开盘</span><strong>${escapeHtml(formatPrice(item.open, decimals))}</strong></div>
        <div><span>最高</span><strong>${escapeHtml(formatPrice(item.high, decimals))}</strong></div>
        <div><span>最低</span><strong>${escapeHtml(formatPrice(item.low, decimals))}</strong></div>
        <div><span>成交量</span><strong>${escapeHtml(formatVolume(item.volume, volumeUnit(state.history?.stock)))}</strong></div>
        <div><span>成交额</span><strong>${escapeHtml(formatAmount(item.amount, currency, state.history?.stock))}</strong></div>
      </div>
    `;
    const rect = tile.getBoundingClientRect();
    const tooltipWidth = 226;
    const left = clamp(rect.left + rect.width / 2, tooltipWidth / 2 + 8, window.innerWidth - tooltipWidth / 2 - 8);
    const below = rect.top < 210;
    dom.tileTooltip.classList.toggle("is-below", below);
    dom.tileTooltip.style.left = `${left}px`;
    dom.tileTooltip.style.top = `${below ? rect.bottom + 8 : rect.top - 8}px`;
    dom.tileTooltip.hidden = false;
  }

  function hideTileTooltip() {
    if (dom.tileTooltip) dom.tileTooltip.hidden = true;
  }

  /* ------------------------------------------------------------------------
     AI prediction
     ------------------------------------------------------------------------ */

  function resetPrediction() {
    if (dom.aiStatsModal && !dom.aiStatsModal.hidden) closeAiStats({ restoreFocus: false });
    state.prediction.data = null;
    state.prediction.error = "";
    state.prediction.loading = true;
    state.prediction.busy = false;
    state.prediction.retryKind = "load";
    state.prediction.seq += 1;
    paintPredictionMarkers();
    renderPrediction();
  }

  async function loadPrediction(symbol) {
    if (!symbol) return;
    const seq = ++state.prediction.seq;
    state.prediction.symbol = symbol;
    state.prediction.loading = true;
    state.prediction.error = "";
    state.prediction.retryKind = "load";
    renderPrediction();
    try {
      const { data } = await api(`/api/prediction?symbol=${encodeURIComponent(symbol)}`);
      if (seq !== state.prediction.seq || state.selected?.symbol !== symbol) return;
      state.prediction.data = data;
      state.prediction.loading = false;
      renderPrediction();
      paintPredictionMarkers();
    } catch (error) {
      if (seq !== state.prediction.seq || state.selected?.symbol !== symbol) return;
      state.prediction.loading = false;
      state.prediction.error = error.message || "预测记录读取失败";
      renderPrediction();
    }
  }

  function renderPrediction() {
    if (!dom.aiBody) return;
    const prediction = state.prediction;
    const snapshot = prediction.data;
    const pending = snapshot?.pending || null;
    const latest = snapshot?.latest || null;
    const ai = snapshot?.ai || null;
    const busy = prediction.loading || prediction.busy;

    if (dom.aiEngine) {
      const configured = Boolean(ai?.configured);
      dom.aiEngine.textContent = configured
        ? ai.engineLabel || ai.model || "AI 模型"
        : "本地量化模型";
      dom.aiEngine.classList.toggle("is-ai", configured);
      dom.aiEngine.title = configured
        ? `${ai.provider || "AI"} · ${ai.model} · 在 data/ai_config.json 中可切换`
        : "未检测到 AI Key，正在使用本地量化模型；配置 data/ai_config.json 或 AI_API_KEY 后自动切换为大模型";
    }
    if (dom.aiPredict) {
      dom.aiPredict.disabled = busy || !state.selected || state.mode !== "stock";
      dom.aiPredict.textContent = pending ? "重新预测" : "AI 预测下一交易日";
    }

    if (prediction.loading && !snapshot) {
      dom.aiBody.innerHTML =
        '<div class="ai-loading"><span class="spinner"></span><span>正在读取预测记录…</span></div>';
      return;
    }

    if (!snapshot) {
      dom.aiBody.innerHTML = prediction.error
        ? aiAlertMarkup(prediction.error)
        : predictionEmptyMarkup(false);
      return;
    }

    const alert = prediction.error ? aiAlertMarkup(prediction.error) : "";
    if (pending) {
      dom.aiBody.innerHTML =
        alert +
        predictionPendingMarkup(pending) +
        predictionFootMarkup(
          `基于 ${escapeHtml(pending.baseDate)} 收盘 <strong>${escapeHtml(formatPredictionPrice(pending.baseClose))}</strong> · ${pending.baseIncomplete ? "盘中数据" : "已收盘"} · 第 ${pending.revision || 1} 次预测`,
          snapshot.stats,
        );
      return;
    }
    if (latest) {
      dom.aiBody.innerHTML =
        alert +
        predictionSettledMarkup(latest) +
        predictionFootMarkup(
          `实际 ${escapeHtml(latest.actualDate || latest.targetDate)} 收盘 · 基于 ${escapeHtml(latest.baseDate)} 收盘 <strong>${escapeHtml(formatPredictionPrice(latest.baseClose))}</strong>`,
          snapshot.stats,
        );
      return;
    }
    dom.aiBody.innerHTML = alert + predictionEmptyMarkup(Boolean(snapshot.ai?.configured));
  }

  function predictionEmptyMarkup(aiConfigured = false) {
    const hint = aiConfigured
      ? ""
      : `<div class="ai-config-hint">未配置 AI Key，当前使用本地量化模型；在 <code>data/ai_config.json</code> 填入 Key 后会自动切换为大模型。</div>`;
    return `<div class="ai-empty">
      <p>还没有该标的的预测记录。AI 对每个交易日<strong>只预测一次</strong>，结果会写入本地数据库；只有点击「重新预测」才会覆盖。</p>
      ${hint}
    </div>`;
  }

  function predictionPendingMarkup(prediction) {
    const up = prediction.direction > 0;
    const tone = up ? "up" : "down";
    const confidence = Math.round((Number(prediction.confidence) || 0.5) * 100);
    const vote = prediction.userChoice;
    const agreeActive = vote === true;
    const disagreeActive = vote === false;
    const voteNote =
      vote === null || vote === undefined
        ? "表态后会记入命中率统计，结算前都可以修改"
        : `你的看法：${vote ? "同意" : "不同意"} · 押${vote ? prediction.directionLabel : up ? "看跌" : "看涨"}，结算前可修改`;
    return `<div class="ai-main">
      <div class="ai-call">
        <div class="ai-call-head">
          <span class="ai-direction ${tone}">${escapeHtml(prediction.directionLabel)}</span>
          <span class="ai-confidence">置信度 <strong>${confidence}%</strong></span>
        </div>
        <p class="ai-headline">预测 <strong>${escapeHtml(formatMonthDay(prediction.targetDate))}</strong>（${escapeHtml(weekdayCN(prediction.targetDate))}）收盘相对 <strong>${escapeHtml(formatMonthDay(prediction.baseDate))}</strong>收盘${up ? "上涨" : "下跌"}</p>
        <div class="ai-meter" aria-hidden="true"><span style="width:${confidence}%"></span></div>
        <p class="ai-reason"><span>AI 理由</span>${escapeHtml(prediction.reason || "—")}</p>
      </div>
      <div class="ai-vote">
        <span class="ai-vote-label">你同意 AI 的判断吗？</span>
        <div class="ai-vote-actions">
          <button type="button" class="ai-vote-button${agreeActive ? " active" : ""}" data-vote="agree" aria-pressed="${agreeActive}">同意</button>
          <button type="button" class="ai-vote-button${disagreeActive ? " active" : ""}" data-vote="disagree" aria-pressed="${disagreeActive}">不同意</button>
        </div>
        <p class="ai-vote-note">${escapeHtml(voteNote)}</p>
      </div>
    </div>`;
  }

  function predictionSettledMarkup(prediction) {
    const actual = Number(prediction.actualDirection);
    const up = prediction.direction > 0;
    const verdictClass = actual === 0 ? "flat" : prediction.aiCorrect ? "correct" : "wrong";
    const verdictText = actual === 0 ? "平盘结算" : prediction.aiCorrect ? "预测正确" : "预测错误";
    const actualTone = actual > 0 ? "up" : actual < 0 ? "down" : "flat";
    const actualText = actual > 0 ? "上涨" : actual < 0 ? "下跌" : "平盘";
    const actualDay =
      prediction.actualDate && prediction.actualDate !== prediction.targetDate
        ? `${formatMonthDay(prediction.actualDate)}（原预测 ${formatMonthDay(prediction.targetDate)}）`
        : formatMonthDay(prediction.targetDate);
    const vote = prediction.userChoice;
    let voteText = "";
    let voteTone = "";
    if (vote === true || vote === false) {
      const label = vote ? "同意 AI" : "不同意 AI";
      if (actual === 0) {
        voteText = `你当时${label}，当天平盘，不计入命中率。`;
      } else if (prediction.userCorrect) {
        voteText = `你当时${label}，你也猜对了。`;
        voteTone = "is-correct";
      } else {
        voteText = `你当时${label}，你猜错了。`;
        voteTone = "is-wrong";
      }
    } else {
      voteText = "这次你没有表态。";
    }
    return `<div class="ai-main is-settled">
      <div class="ai-call">
        <div class="ai-call-head">
          <span class="ai-direction ${up ? "up" : "down"}">${escapeHtml(prediction.directionLabel)}</span>
          <span class="ai-verdict ${verdictClass}">${verdictText}</span>
        </div>
        <p class="ai-headline">实际 <strong>${escapeHtml(actualDay)}</strong> ${actualText} <strong class="${actualTone}">${escapeHtml(formatPct(prediction.actualPct))}</strong></p>
        <p class="ai-reason"><span>AI 理由</span>${escapeHtml(prediction.reason || "—")}</p>
        <p class="ai-user-verdict ${voteTone}">${escapeHtml(voteText)}</p>
      </div>
    </div>`;
  }

  function predictionFootMarkup(source, stats) {
    const ai = stats?.ai || {};
    const user = stats?.user || {};
    const aiText = ai.decided ? `${ai.rate}% (${ai.correct}/${ai.decided})` : "—";
    const userText = user.decided ? `${user.rate}% (${user.correct}/${user.decided})` : "—";
    const pending = stats?.samples?.pending || 0;
    return `<div class="ai-foot">
      <span>${source}</span>
      <span>AI 命中率 <strong>${aiText}</strong> · 你的命中率 <strong>${userText}</strong>${pending ? ` · 待结算 <strong>${pending}</strong>` : ""}</span>
    </div>`;
  }

  function aiAlertMarkup(message) {
    return `<div class="ai-alert">
      <svg class="icon" aria-hidden="true"><use href="#icon-alert"></use></svg>
      <span>${escapeHtml(message)}</span>
      <button type="button" data-ai-action="retry">重试</button>
    </div>`;
  }

  function formatPredictionPrice(value) {
    const decimals = Number(state.history?.decimals);
    const fallback = Number(state.quote?.decimals) ||
      commodityMeta(state.selected?.symbol)?.decimals ||
      (state.selected?.market === "US" || state.selected?.market === "HK" ? 3 : 2);
    return formatPrice(value, Number.isFinite(decimals) && decimals > 0 ? decimals : fallback);
  }

  function handleAiBodyClick(event) {
    const voteButton = event.target.closest("[data-vote]");
    if (voteButton) {
      submitPredictionVote(voteButton.dataset.vote === "agree");
      return;
    }
    const action = event.target.closest("[data-ai-action]");
    if (!action) return;
    if (action.dataset.aiAction === "predict") {
      requestPrediction(false);
    } else if (action.dataset.aiAction === "retry") {
      if (state.prediction.retryKind === "load") {
        loadPrediction(state.selected?.symbol).catch(() => {});
      } else if (state.prediction.retryKind === "vote") {
        showToast("请重新选择你的看法", "info");
      } else {
        requestPrediction(true);
      }
    }
  }

  async function requestPrediction(force) {
    const symbol = state.selected?.symbol;
    if (!symbol || state.prediction.busy) return;
    state.prediction.busy = true;
    state.prediction.error = "";
    state.prediction.retryKind = "predict";
    renderPrediction();
    try {
      const { data } = await api("/api/prediction", {
        method: "POST",
        body: { symbol, refresh: Boolean(force) },
        timeoutMs: 45_000,
      });
      if (state.selected?.symbol !== symbol) return;
      state.prediction.data = { ...data, symbol };
      state.prediction.error = "";
      showToast(
        data.cached ? "已读取缓存中的预测" : force ? "AI 已重新预测并写入数据库" : "AI 预测已写入数据库",
        "success",
      );
      paintPredictionMarkers();
    } catch (error) {
      state.prediction.error = error.message || "预测失败，请稍后重试";
      showToast(state.prediction.error, "error");
    } finally {
      state.prediction.busy = false;
      renderPrediction();
    }
  }

  async function submitPredictionVote(agree) {
    const symbol = state.selected?.symbol;
    if (!symbol || state.prediction.busy || !state.prediction.data?.pending) return;
    state.prediction.busy = true;
    state.prediction.error = "";
    state.prediction.retryKind = "vote";
    renderPrediction();
    try {
      const { data } = await api("/api/prediction/vote", {
        method: "POST",
        body: { symbol, agree },
      });
      if (state.selected?.symbol !== symbol) return;
      const current = state.prediction.data;
      const updated = data.pending || null;
      state.prediction.data = {
        ...current,
        pending: updated,
        latest:
          current?.latest && updated && current.latest.id === updated.id ? updated : current?.latest,
        stats: data.stats || current?.stats,
        ai: data.ai || current?.ai,
      };
      showToast(agree ? "已记录：你同意 AI 的判断" : "已记录：你不同意 AI 的判断", "success");
    } catch (error) {
      state.prediction.error = error.message || "记录态度失败";
      showToast(state.prediction.error, "error");
    } finally {
      state.prediction.busy = false;
      renderPrediction();
      paintPredictionMarkers();
    }
  }

  function paintPredictionMarkers() {
    if (!dom.calendarView) return;
    const snapshot = state.prediction.data;
    const pendingDate = snapshot?.pending?.targetDate || "";
    const latest = snapshot?.latest;
    const settledDate =
      latest && latest.status === "settled" ? latest.actualDate || latest.targetDate : "";
    for (const tile of dom.calendarView.querySelectorAll(".day-tile")) {
      const date = tile.dataset.date;
      const isPending = Boolean(pendingDate) && date === pendingDate;
      const isSettled = Boolean(settledDate) && date === settledDate;
      const marked = isPending || isSettled;
      tile.classList.toggle("is-forecast", marked);
      tile.classList.toggle("is-correct-forecast", isSettled && latest.aiCorrect === true);
      tile.classList.toggle("is-wrong-forecast", isSettled && latest.aiCorrect === false);
      if (marked) {
        tile.setAttribute(
          "data-ai",
          isPending ? "待验证" : latest.aiCorrect ? "AI 猜对" : "AI 猜错",
        );
      } else {
        tile.removeAttribute("data-ai");
      }
    }
  }

  /* ------------------------------------------------------------------------
     Prediction stats modal
     ------------------------------------------------------------------------ */

  function openAiStats() {
    if (!dom.aiStatsModal || !state.selected) return;
    dom.aiStatsModal.hidden = false;
    document.body.classList.add("has-modal");
    state.prediction.stats.scope = "all";
    updateAiScopeTabs();
    loadAiStats("all");
    window.setTimeout(() => dom.aiStatsClose.focus(), 0);
  }

  function closeAiStats(options = {}) {
    if (!dom.aiStatsModal || dom.aiStatsModal.hidden) return;
    dom.aiStatsModal.hidden = true;
    document.body.classList.remove("has-modal");
    state.prediction.stats.seq += 1;
    if (options.restoreFocus !== false) dom.aiStatsOpen.focus();
  }

  function updateAiScopeTabs() {
    if (!dom.aiScopeTabs) return;
    for (const button of dom.aiScopeTabs.querySelectorAll("[data-scope]")) {
      const active = button.dataset.scope === state.prediction.stats.scope;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
    }
  }

  function handleAiScopeClick(event) {
    const button = event.target.closest("[data-scope]");
    if (!button || button.dataset.scope === state.prediction.stats.scope) return;
    state.prediction.stats.scope = button.dataset.scope;
    updateAiScopeTabs();
    loadAiStats(state.prediction.stats.scope);
  }

  async function loadAiStats(scope) {
    const stats = state.prediction.stats;
    const symbol = state.selected?.symbol;
    if (scope === "stock" && !symbol) return;
    const seq = ++stats.seq;
    stats.loading = true;
    stats.error = "";
    renderAiStats();
    try {
      const query = scope === "stock" ? `?symbol=${encodeURIComponent(symbol)}` : "";
      const { data } = await api(`/api/predictions/stats${query}`);
      if (seq !== stats.seq || dom.aiStatsModal.hidden) return;
      stats.data = data;
      stats.loading = false;
      renderAiStats();
    } catch (error) {
      if (seq !== stats.seq) return;
      stats.loading = false;
      stats.error = error.message || "统计读取失败";
      renderAiStats();
    }
  }

  function renderAiStats() {
    const stats = state.prediction.stats;
    if (!dom.aiStatsContent) return;
    if (stats.loading) {
      dom.aiStatsContent.innerHTML =
        '<div class="ai-stats-loading"><span class="spinner"></span><span>正在复盘历史预测…</span></div>';
      dom.aiStatsFoot.textContent = "结算需要读取已收盘的日线数据，首次可能稍慢。";
      return;
    }
    if (stats.error) {
      dom.aiStatsContent.innerHTML = `<div class="ai-stats-empty">${escapeHtml(stats.error)}</div>`;
      dom.aiStatsFoot.textContent = "请确认本地服务仍运行后重试。";
      return;
    }
    const data = stats.data;
    if (!data) {
      dom.aiStatsContent.innerHTML = "";
      dom.aiStatsFoot.textContent = "AI 预测仅供参考，不构成投资建议。";
      return;
    }
    const scopeLabel = data.scope === "all" ? "全部标的" : state.selected?.name || "本标的";
    const overall = data.overall || {};
    const samples = overall.samples || {};
    const ai = overall.ai || {};
    const user = overall.user || {};
    if (!samples.settled && !samples.pending) {
      dom.aiStatsContent.innerHTML = `<div class="ai-stats-empty">${escapeHtml(scopeLabel)}还没有预测记录，先让 AI 预测一个交易日吧。</div>`;
      dom.aiStatsFoot.textContent = "AI 预测仅供参考，不构成投资建议。";
      return;
    }
    const aiRate = ai.rate === null || ai.rate === undefined ? "—" : `${ai.rate}<small>%</small>`;
    const userRate = user.rate === null || user.rate === undefined ? "—" : `${user.rate}<small>%</small>`;
    dom.aiStatsContent.innerHTML = `
      <div class="ai-stat-grid">
        <article class="ai-stat-card">
          <span class="ai-stat-label">AI 预测正确率</span>
          <div class="ai-stat-value">${aiRate}</div>
          <p class="ai-stat-sub">${ai.decided ? `猜对 ${ai.correct} 次 / 已结算 ${ai.decided} 次` : "还没有可结算的预测"}</p>
          <div class="ai-stat-bar" aria-hidden="true"><span style="width:${Number(ai.rate) || 0}%"></span></div>
        </article>
        <article class="ai-stat-card user">
          <span class="ai-stat-label">你的预测正确率</span>
          <div class="ai-stat-value">${userRate}</div>
          <p class="ai-stat-sub">${user.decided ? `猜对 ${user.correct} 次 / 已表态 ${user.decided} 次` : "还没有可结算的表态"}</p>
          <div class="ai-stat-bar" aria-hidden="true"><span style="width:${Number(user.rate) || 0}%"></span></div>
        </article>
      </div>
      <div class="ai-stat-legend">
        <span>已结算 <strong>${samples.settled || 0}</strong></span>
        <span>待结算 <strong>${samples.pending || 0}</strong></span>
        <span>平盘不计 <strong>${samples.flat || 0}</strong></span>
        <span>同意 AI <strong>${user.agree || 0}</strong> · 不同意 <strong>${user.disagree || 0}</strong></span>
        <span>AI 连续猜对 <strong>${ai.streak || 0}</strong></span>
      </div>
      ${data.scope === "all" ? predictionStocksTableMarkup(data.stocks) : ""}
      ${predictionRecentTableMarkup(data.recent, data.scope === "all")}
    `;
    const aiNote = data.ai?.configured ? "" : "当前使用本地量化模型（未配置 AI Key）。";
    dom.aiStatsFoot.textContent = `${aiNote}统计口径：方向按收盘价相对前一交易日收盘判断，平盘不计入正确率。更新于 ${formatTimeOnly(data.generatedAt, true)}。AI 预测仅供参考，不构成投资建议。`;
  }

  function predictionStocksTableMarkup(stocks) {
    if (!Array.isArray(stocks) || !stocks.length) return "";
    const rows = stocks
      .map((stock) => {
        const aiRate = stock.ai?.rate === null || stock.ai?.rate === undefined ? "—" : `${stock.ai.rate}%`;
        const userRate =
          stock.user?.rate === null || stock.user?.rate === undefined ? "—" : `${stock.user.rate}%`;
        const aiGood = Number(stock.ai?.rate) >= 50;
        const userGood = Number(stock.user?.rate) >= 50;
        return `<tr>
          <td class="stock-cell">${escapeHtml(stock.name)}<small>${escapeHtml(stock.code)}${stock.marketLabel ? ` · ${escapeHtml(stock.marketLabel)}` : ""}</small></td>
          <td>${stock.settled || 0} / <span class="${stock.pending ? "flat" : ""}">${stock.pending || 0}</span></td>
          <td class="rate-cell ${aiRate === "—" ? "is-empty" : aiGood ? "is-good" : ""}">${aiRate}</td>
          <td class="rate-cell ${userRate === "—" ? "is-empty" : userGood ? "is-good" : ""}">${userRate}</td>
          <td>${stock.ai?.decided ? `${stock.ai.correct}/${stock.ai.decided}` : "—"}</td>
        </tr>`;
      })
      .join("");
    return `<div class="ai-table-title"><span>分标的统计</span><span>${stocks.length} 个标的</span></div>
      <div class="ai-table-wrap">
        <table class="ai-table">
          <thead><tr><th>标的</th><th>已结 / 待结</th><th>AI 正确率</th><th>你的正确率</th><th>AI 命中</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  function predictionRecentTableMarkup(rows, showStock) {
    if (!Array.isArray(rows) || !rows.length) return "";
    const body = rows
      .map((row) => {
        const actual = Number(row.actualDirection);
        const actualTone = actual > 0 ? "up" : actual < 0 ? "down" : "flat";
        const actualText =
          actual === 0 ? "平盘" : `${actual > 0 ? "涨" : "跌"} ${formatPct(row.actualPct)}`;
        const aiText = actual === 0 ? "—" : row.aiCorrect ? "✓" : "✗";
        const aiTone = actual === 0 ? "" : row.aiCorrect ? "verdict-up" : "verdict-down";
        let userText = "未表态";
        let userTone = "";
        if (row.userChoice === true || row.userChoice === false) {
          if (actual === 0) {
            userText = "平盘";
          } else {
            userText = row.userCorrect ? "✓" : "✗";
            userTone = row.userCorrect ? "verdict-up" : "verdict-down";
          }
        }
        return `<tr>
          ${showStock ? `<td class="stock-cell">${escapeHtml(row.name)}<small>${escapeHtml(row.code)}</small></td>` : ""}
          <td>${escapeHtml(row.actualDate || row.targetDate)}</td>
          <td>${escapeHtml(row.directionLabel)}</td>
          <td>${row.userChoice === true ? "同意" : row.userChoice === false ? "不同意" : "未表态"}</td>
          <td class="${actualTone}">${escapeHtml(actualText)}</td>
          <td class="${aiTone}">${aiText}</td>
          <td class="${userTone}">${userText}</td>
        </tr>`;
      })
      .join("");
    return `<div class="ai-table-title"><span>最近结算记录</span><span>${rows.length} 条</span></div>
      <div class="ai-table-wrap">
        <table class="ai-table">
          <thead><tr>${showStock ? "<th>标的</th>" : ""}<th>实际日</th><th>AI 判断</th><th>你的态度</th><th>实际涨跌</th><th>AI</th><th>你</th></tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>`;
  }

  /* ------------------------------------------------------------------------
     Search
     ------------------------------------------------------------------------ */

  function handleSearchInput() {
    const query = dom.searchInput.value.trim();
    dom.searchClear.hidden = !query;
    state.search.query = query;
    state.search.active = -1;
    if (state.search.timer) window.clearTimeout(state.search.timer);

    if (!query) {
      abortSearch();
      closeSearchPanel();
      dom.searchIdle.hidden = false;
      return;
    }

    openSearchPanel();
    dom.searchIdle.hidden = true;
    dom.searchPanel.hidden = false;
    dom.searchResults.innerHTML = searchLoadingMarkup();
    dom.searchSummary.textContent = "正在连接三地市场…";
    dom.searchEmpty.hidden = true;
    updateFilterCounts([]);
    state.search.timer = window.setTimeout(() => runSearch(query), 260);
  }

  async function runSearch(query) {
    const seq = ++state.search.seq;
    abortSearch(false);
    const controller = new AbortController();
    state.search.controller = controller;
    try {
      const { data } = await api(`/api/search?q=${encodeURIComponent(query)}`, {
        signal: controller.signal,
      });
      if (seq !== state.search.seq || dom.searchInput.value.trim() !== query) return;
      state.search.items = Array.isArray(data.items) ? data.items : [];
      state.search.active = -1;
      renderSearchResults();
    } catch (error) {
      if (
        error.name === "AbortError" ||
        seq !== state.search.seq ||
        dom.searchInput.value.trim() !== query
      ) {
        return;
      }
      state.search.items = [];
      state.search.visible = [];
      dom.searchResults.innerHTML = "";
      dom.searchSummary.textContent = "搜索暂时失败";
      dom.searchEmpty.hidden = false;
      dom.searchEmpty.textContent = error.message || "行情源连接失败，请稍后再试。";
      updateFilterCounts([]);
    } finally {
      if (state.search.controller === controller) state.search.controller = null;
    }
  }

  function renderSearchResults() {
    const filter = state.search.filter;
    const counts = countMarkets(state.search.items);
    state.search.visible =
      filter === "ALL" ? state.search.items : state.search.items.filter((item) => item.market === filter);
    updateFilterCounts(counts);

    const marketText = filter === "ALL" ? "" : ` · ${MARKET_NAMES[filter]}`;
    dom.searchSummary.textContent = state.search.visible.length
      ? `找到 ${state.search.visible.length} 只股票${marketText}`
      : `没有找到${marketText ? marketText.replace(" · ", "") : ""}股票`;

    if (!state.search.visible.length) {
      dom.searchResults.innerHTML = "";
      dom.searchEmpty.hidden = false;
      dom.searchEmpty.textContent =
        state.search.items.length === 0
          ? `没有匹配“${state.search.query}”的股票，试试股票代码或拼音首字母。`
          : `当前筛选下没有结果，切换到“全部”看看。`;
      return;
    }

    dom.searchEmpty.hidden = true;
    dom.searchResults.innerHTML = state.search.visible
      .map((item, index) => {
        const marketClass = (item.market || "").toLowerCase();
        const favorite = isFavorite(item.symbol);
        return `<div class="search-result" id="search-option-${index}" role="option" aria-selected="false" data-index="${index}" data-symbol="${escapeAttr(item.symbol)}">
          <button type="button" class="result-open" data-open-symbol="${escapeAttr(item.symbol)}">
            <span class="result-name">${escapeHtml(item.name)}<span class="market-badge ${marketClass}">${escapeHtml(item.board || item.marketLabel)}</span></span>
            <span class="result-code">${escapeHtml(item.code)} · ${escapeHtml(item.exchange)}</span>
          </button>
          <span class="result-market">${escapeHtml(item.marketLabel)}</span>
          <button type="button" class="result-star ${favorite ? "is-favorite" : ""}" data-star-symbol="${escapeAttr(item.symbol)}" aria-label="${favorite ? "移出自选" : "加入自选"}" aria-pressed="${favorite}">
            <svg class="icon"><use href="#icon-star"></use></svg>
          </button>
        </div>`;
      })
      .join("");
  }

  function updateFilterCounts(counts) {
    const values = counts || { ALL: 0, CN: 0, HK: 0, US: 0 };
    for (const button of dom.marketFilters.querySelectorAll("[data-market-filter]")) {
      const key = button.dataset.marketFilter;
      const active = key === state.search.filter;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
      const count = button.querySelector(`[data-count="${key}"]`);
      if (count) count.textContent = String(values[key] || 0);
    }
  }

  function countMarkets(items) {
    const counts = { ALL: items.length, CN: 0, HK: 0, US: 0 };
    for (const item of items) {
      if (counts[item.market] !== undefined) counts[item.market] += 1;
    }
    return counts;
  }

  function handleSearchResultClick(event) {
    const star = event.target.closest(".result-star");
    if (star) {
      const symbol = star.dataset.starSymbol;
      const item = state.search.items.find((stock) => stock.symbol === symbol);
      if (item) {
        toggleFavorite(item);
        updateSearchStars();
      }
      return;
    }
    const row = event.target.closest(".search-result");
    if (!row) return;
    const item = state.search.items.find((stock) => stock.symbol === row.dataset.symbol);
    if (item) selectSearchItem(item);
  }

  function handleSearchResultHover(event) {
    const row = event.target.closest(".search-result");
    if (!row) return;
    const index = Number(row.dataset.index);
    if (Number.isFinite(index) && state.search.active !== index) {
      setActiveSearchIndex(index, false);
    }
  }

  function handleSearchKeydown(event) {
    if (event.key === "Escape") {
      closeSearchPanel();
      dom.searchInput.blur();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Enter"].includes(event.key)) return;
    if (dom.searchPanel.hidden) {
      if (dom.searchInput.value.trim()) openSearchPanel();
      return;
    }
    const length = state.search.visible.length;
    if (!length) return;
    event.preventDefault();
    if (event.key === "ArrowDown") {
      setActiveSearchIndex((state.search.active + 1 + length) % length);
    } else if (event.key === "ArrowUp") {
      setActiveSearchIndex((state.search.active - 1 + length) % length);
    } else if (event.key === "Enter") {
      const item = state.search.visible[state.search.active >= 0 ? state.search.active : 0];
      if (item) selectSearchItem(item);
    }
  }

  function setActiveSearchIndex(index, scroll = true) {
    if (!state.search.visible.length) return;
    state.search.active = index;
    const rows = dom.searchResults.querySelectorAll(".search-result");
    rows.forEach((row, rowIndex) => {
      const active = rowIndex === index;
      row.classList.toggle("is-active", active);
      row.setAttribute("aria-selected", String(active));
    });
    if (scroll) {
      const activeRow = rows[index];
      if (activeRow) activeRow.scrollIntoView({ block: "nearest" });
    }
    if (index >= 0) {
      dom.searchInput.setAttribute("aria-activedescendant", `search-option-${index}`);
    } else {
      dom.searchInput.removeAttribute("aria-activedescendant");
    }
  }

  function selectSearchItem(item) {
    closeSearchPanel(true);
    dom.searchInput.blur();
    loadStock(item, { historyMode: "push" });
  }

  function handleMarketFilterClick(event) {
    const button = event.target.closest("[data-market-filter]");
    if (!button) return;
    state.search.filter = button.dataset.marketFilter;
    state.search.active = -1;
    renderSearchResults();
  }

  function handleQuickChipClick(event) {
    const button = event.target.closest("[data-quick-symbol]");
    if (!button) return;
    loadStock(
      { symbol: button.dataset.quickSymbol, name: button.dataset.quickName },
      { historyMode: "push" },
    );
  }

  function openSearchPanel() {
    if (!dom.searchPanel) return;
    dom.searchPanel.hidden = false;
    dom.searchIdle.hidden = true;
    dom.searchInput.setAttribute("aria-expanded", "true");
  }

  function closeSearchPanel(clearInput = false) {
    dom.searchPanel.hidden = true;
    dom.searchInput.setAttribute("aria-expanded", "false");
    dom.searchInput.removeAttribute("aria-activedescendant");
    if (clearInput) {
      dom.searchInput.value = "";
      dom.searchClear.hidden = true;
      state.search.query = "";
      state.search.items = [];
      state.search.visible = [];
      state.search.active = -1;
      dom.searchIdle.hidden = false;
    } else {
      dom.searchIdle.hidden = Boolean(dom.searchInput.value.trim());
    }
  }

  function clearSearch() {
    dom.searchInput.value = "";
    dom.searchClear.hidden = true;
    state.search.query = "";
    state.search.items = [];
    state.search.visible = [];
    state.search.active = -1;
    abortSearch();
    closeSearchPanel(true);
    dom.searchInput.focus();
  }

  function abortSearch(increment = true) {
    if (state.search.timer) {
      window.clearTimeout(state.search.timer);
      state.search.timer = null;
    }
    if (state.search.controller) {
      state.search.controller.abort();
      state.search.controller = null;
    }
    if (increment) state.search.seq += 1;
  }

  function updateSearchStars() {
    for (const button of dom.searchResults.querySelectorAll("[data-star-symbol]")) {
      const favorite = isFavorite(button.dataset.starSymbol);
      button.classList.toggle("is-favorite", favorite);
      button.setAttribute("aria-pressed", String(favorite));
      button.setAttribute("aria-label", favorite ? "移出自选" : "加入自选");
    }
  }

  function searchLoadingMarkup() {
    return `<div class="search-loading">${Array.from({ length: 4 }, () => `
      <div class="search-loading-row">
        <span class="skeleton" style="width:28px;height:28px;border-radius:50%"></span>
        <span style="flex:1"><span class="skeleton" style="display:block;width:62%"></span><span class="skeleton" style="display:block;width:38%;margin-top:5px;height:6px"></span></span>
      </div>`).join("")}</div>`;
  }

  /* ------------------------------------------------------------------------
     Favorites
     ------------------------------------------------------------------------ */

  function readFavorites() {
    try {
      const parsed = JSON.parse(safeStorageGet(STORAGE.favorites) || "[]");
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((item) => item && typeof item.symbol === "string" && isValidSymbol(item.symbol))
        .slice(0, MAX_FAVORITES)
        .map((item) => ({
          symbol: item.symbol,
          code: String(item.code || item.symbol.split(".").slice(1).join(".")),
          name: String(item.name || item.code || item.symbol),
          market: String(item.market || ""),
          marketLabel: String(item.marketLabel || ""),
          board: String(item.board || ""),
          exchange: String(item.exchange || ""),
          currency: String(item.currency || ""),
        }));
    } catch {
      return [];
    }
  }

  function saveFavorites() {
    safeStorageSet(STORAGE.favorites, JSON.stringify(state.favorites));
  }

  function isFavorite(symbol) {
    return state.favorites.some((item) => item.symbol === symbol);
  }

  function toggleFavorite(stock) {
    if (!stock || !isValidSymbol(stock.symbol)) return;
    const index = state.favorites.findIndex((item) => item.symbol === stock.symbol);
    if (index >= 0) {
      state.favorites.splice(index, 1);
      delete state.favoriteQuotes[stock.symbol];
      saveFavorites();
      renderFavorites();
      updateStarState();
      updateSearchStars();
      showToast("已移出自选", "info");
      return;
    }
    if (state.favorites.length >= MAX_FAVORITES) {
      showToast(`自选最多收藏 ${MAX_FAVORITES} 个标的`, "error");
      return;
    }
    const normalized = {
      symbol: stock.symbol,
      code: String(stock.code || stock.symbol.split(".").slice(1).join(".")),
      name: String(stock.name || stock.code || stock.symbol),
      market: String(stock.market || ""),
      marketLabel: String(stock.marketLabel || ""),
      board: String(stock.board || ""),
      exchange: String(stock.exchange || ""),
      currency: String(stock.currency || ""),
    };
    state.favorites.unshift(normalized);
    if (state.quote?.stock?.symbol === normalized.symbol) {
      state.favoriteQuotes[normalized.symbol] = state.quote;
    }
    saveFavorites();
    renderFavorites();
    updateStarState();
    updateSearchStars();
    showToast(`已收藏 ${normalized.name}`, "success");
    refreshFavoriteQuotes();
  }

  function renderFavorites() {
    dom.favoriteCount.textContent = String(state.favorites.length);
    if (!state.favorites.length) {
      dom.favoritesList.innerHTML = "";
      dom.favoritesHint.hidden = false;
      dom.favoritesHint.innerHTML =
        '<span class="favorite-empty-mark"><svg class="icon" aria-hidden="true"><use href="#icon-star"></use></svg></span>在详情页点击星标，或从搜索结果中收藏。';
      return;
    }
    dom.favoritesHint.hidden = true;
    dom.favoritesList.innerHTML = state.favorites
      .map((item) => {
        const quote = state.favoriteQuotes[item.symbol];
        const price = quote ? formatPrice(quote.price, Number(quote.decimals) || 2) : "--";
        const pct = quote ? formatPct(quote.changePct) : "--";
        const tone = quote ? toneOf(quote.changePct) : "flat";
        const marketClass = (item.market || "").toLowerCase();
        const active = state.selected?.symbol === item.symbol ? " is-active" : "";
        return `<div class="favorite-item${active}" data-symbol="${escapeAttr(item.symbol)}">
          <button type="button" class="favorite-open" data-open-symbol="${escapeAttr(item.symbol)}">
            <span class="favorite-name">${escapeHtml(item.name)}<span class="market-badge ${marketClass}">${escapeHtml(item.board || item.marketLabel || "")}</span></span>
            <span class="favorite-code">${escapeHtml(item.code)}${item.exchange ? ` · ${escapeHtml(item.exchange)}` : ""}</span>
          </button>
          <span class="favorite-quote">
            <span class="favorite-price">${escapeHtml(price)}</span>
            <span class="favorite-pct ${tone}">${escapeHtml(pct)}</span>
          </span>
          <button type="button" class="favorite-remove" data-remove-symbol="${escapeAttr(item.symbol)}" aria-label="移出 ${escapeAttr(item.name)}" title="移出自选">
            <svg class="icon"><use href="#icon-x"></use></svg>
          </button>
        </div>`;
      })
      .join("");
    paintFavoriteQuotes();
  }

  function paintFavoriteQuotes() {
    for (const row of dom.favoritesList.querySelectorAll(".favorite-item")) {
      const symbol = row.dataset.symbol;
      const quote = state.favoriteQuotes[symbol];
      const priceNode = row.querySelector(".favorite-price");
      const pctNode = row.querySelector(".favorite-pct");
      if (!priceNode || !pctNode) continue;
      if (!quote) {
        priceNode.textContent = "--";
        pctNode.textContent = "--";
        pctNode.className = "favorite-pct flat";
        continue;
      }
      priceNode.textContent = formatPrice(quote.price, Number(quote.decimals) || 2);
      pctNode.textContent = formatPct(quote.changePct);
      pctNode.className = `favorite-pct ${toneOf(quote.changePct)}`;
    }
    for (const row of dom.favoritesList.querySelectorAll(".favorite-item")) {
      row.classList.toggle("is-active", row.dataset.symbol === state.selected?.symbol);
    }
  }

  function handleFavoriteClick(event) {
    const remove = event.target.closest("[data-remove-symbol]");
    if (remove) {
      const symbol = remove.dataset.removeSymbol;
      const item = state.favorites.find((favorite) => favorite.symbol === symbol);
      if (item) toggleFavorite(item);
      return;
    }
    const row = event.target.closest(".favorite-item");
    if (!row) return;
    const item = state.favorites.find((favorite) => favorite.symbol === row.dataset.symbol);
    if (item) loadStock(item, { historyMode: "push" });
  }

  async function refreshFavoriteQuotes() {
    if (!state.favorites.length) return;
    const symbols = state.favorites.map((item) => item.symbol);
    try {
      const { data } = await api(`/api/quotes?symbols=${encodeURIComponent(symbols.join(","))}`);
      if (!data?.items) return;
      Object.assign(state.favoriteQuotes, data.items);
      for (const item of state.favorites) {
        if (data.items[item.symbol]?.stock) {
          const stock = data.items[item.symbol].stock;
          item.name = stock.name || item.name;
          item.board = stock.board || item.board;
          item.exchange = stock.exchange || item.exchange;
        }
      }
      paintFavoriteQuotes();
    } catch {
      /* 自选报价失败不打断主行情。 */
    }
  }

  function updateStarState() {
    if (!state.selected) return;
    const favorite = isFavorite(state.selected.symbol);
    dom.stockStar.classList.toggle("is-active", favorite);
    dom.stockStar.setAttribute("aria-pressed", String(favorite));
    dom.stockStar.title = favorite ? "从自选中移除" : "加入自选";
    dom.stockStarLabel.textContent = favorite ? "已收藏" : "收藏";
  }

  /* ------------------------------------------------------------------------
     Market pulse
     ------------------------------------------------------------------------ */

  function renderPulseSkeleton() {
    dom.marketPulseList.innerHTML = PULSE_STOCKS.map(
      (item) => `<div class="pulse-loading"><span class="spinner"></span>${escapeHtml(item.name)}</div>`,
    ).join("");
  }

  async function refreshMarketPulse() {
    if (state.isPulseRefreshing || !dom.marketPulseList) return;
    state.isPulseRefreshing = true;
    try {
      const symbols = PULSE_STOCKS.map((item) => item.symbol).join(",");
      const { data } = await api(`/api/quotes?symbols=${encodeURIComponent(symbols)}`);
      const items = data?.items || {};
      dom.marketPulseList.innerHTML = PULSE_STOCKS.map((item) => {
        const quote = items[item.symbol];
        const name = quote?.stock?.name || item.name;
        const code = quote?.stock?.code || item.code;
        const decimals = Number(quote?.decimals) || 2;
        const tone = quote ? toneOf(quote.changePct) : "flat";
        return `<button type="button" class="pulse-item" data-pulse-symbol="${escapeAttr(item.symbol)}" data-pulse-market="${escapeAttr(item.market)}" aria-label="查看 ${escapeAttr(name)}">
          <span class="pulse-market">${escapeHtml(item.label)}</span>
          <span class="pulse-name">${escapeHtml(name)}<small>${escapeHtml(code)}</small></span>
          <span class="pulse-quote">
            <span class="pulse-price">${quote ? escapeHtml(formatPrice(quote.price, decimals)) : "--"}</span>
            <span class="pulse-pct ${tone}">${quote ? escapeHtml(formatPct(quote.changePct)) : "--"}</span>
          </span>
        </button>`;
      }).join("");
      updatePulseActive();
    } catch {
      if (!dom.marketPulseList.querySelector(".pulse-item")) {
        dom.marketPulseList.innerHTML = '<p class="pulse-loading">市场脉搏暂时不可用</p>';
      }
    } finally {
      state.isPulseRefreshing = false;
    }
  }

  function updatePulseActive() {
    for (const item of dom.marketPulseList.querySelectorAll(".pulse-item")) {
      item.classList.toggle("is-active", item.dataset.pulseSymbol === state.selected?.symbol);
    }
  }

  function handlePulseClick(event) {
    const button = event.target.closest("[data-pulse-symbol]");
    if (!button) return;
    loadStock({ symbol: button.dataset.pulseSymbol }, { historyMode: "push" });
  }

  /* ------------------------------------------------------------------------
     Commodities: gold, silver and crude oil
     ------------------------------------------------------------------------ */

  function renderCommoditySkeleton() {
    dom.commodityList.innerHTML = COMMODITY_ITEMS.map(
      (item) => `<div class="pulse-loading"><span class="spinner"></span>${escapeHtml(item.name)}</div>`,
    ).join("");
  }

  function commodityTitle(item, quote) {
    if (!quote) return `${item.contract} 行情暂时不可用`;
    const decimals = Number(quote.decimals) || 2;
    const parts = [
      `${quote.contract} ${formatPrice(quote.price, decimals)} ${quote.unit}`,
      `涨跌 ${formatSigned(quote.change, decimals)} (${formatPct(quote.changePct)})`,
    ];
    if (quote.cnyPrice !== null && quote.cnyPrice !== undefined) {
      parts.push(`约 ${formatPrice(quote.cnyPrice, 2)} 元/g`);
    }
    parts.push(
      `今开 ${formatPrice(quote.open, decimals)}`,
      `最高 ${formatPrice(quote.high, decimals)}`,
      `最低 ${formatPrice(quote.low, decimals)}`,
    );
    return parts.join(" · ");
  }

  async function refreshCommodities() {
    if (state.isCommodityRefreshing || !dom.commodityList) return;
    state.isCommodityRefreshing = true;
    try {
      const { data } = await api("/api/commodities");
      const quotes = new Map((data?.items || []).map((item) => [item.key, item]));
      dom.commodityList.innerHTML = COMMODITY_ITEMS.map((item) => {
        const quote = quotes.get(item.key);
        const decimals = Number(quote?.decimals) || 2;
        const tone = quote ? toneOf(quote.changePct) : "flat";
        const title = commodityTitle(item, quote);
        const cnyLine = quote && quote.cnyPrice !== null && quote.cnyPrice !== undefined
          ? `<small class="commodity-cny">≈ ${escapeHtml(formatPrice(quote.cnyPrice, 2))} 元/g</small>`
          : "";
        return `<button type="button" class="commodity-item" data-commodity-symbol="${escapeAttr(item.symbol)}" title="${escapeAttr(title)}" aria-label="${escapeAttr(title)}" aria-pressed="false">
          <span class="commodity-mark ${escapeAttr(item.key)}">${escapeHtml(item.mark)}</span>
          <span class="commodity-name">${escapeHtml(item.name)}<small>${escapeHtml(item.exchange)} · ${escapeHtml(item.unit)}</small>${cnyLine}</span>
          <span class="commodity-quote">
            <span class="commodity-price">${quote ? escapeHtml(formatPrice(quote.price, decimals)) : "--"}</span>
            <span class="commodity-pct ${tone}">${quote ? escapeHtml(formatPct(quote.changePct)) : "--"}</span>
          </span>
        </button>`;
      }).join("");
      updateCommodityActive();
    } catch {
      if (!dom.commodityList.querySelector(".commodity-item")) {
        dom.commodityList.innerHTML = '<p class="pulse-loading">大宗商品暂时不可用</p>';
      }
    } finally {
      state.isCommodityRefreshing = false;
    }
  }

  function updateCommodityActive() {
    if (!dom.commodityList) return;
    for (const item of dom.commodityList.querySelectorAll("[data-commodity-symbol]")) {
      const active = item.dataset.commoditySymbol === state.selected?.symbol;
      item.classList.toggle("is-active", active);
      item.setAttribute("aria-pressed", String(active));
    }
  }

  function handleCommodityClick(event) {
    const button = event.target.closest("[data-commodity-symbol]");
    if (!button) return;
    const meta = commodityMeta(button.dataset.commoditySymbol);
    if (!meta) return;
    loadStock(meta, { historyMode: "push" });
  }

  /* ------------------------------------------------------------------------
     Heatmap
     ------------------------------------------------------------------------ */

  function readHeatmapPreferences() {
    const fallback = { ...HEATMAP_DEFAULTS };
    try {
      const parsed = JSON.parse(safeStorageGet(STORAGE.heatmap) || "{}");
      if (!parsed || typeof parsed !== "object") return fallback;
      return {
        market: HEATMAP_MARKETS[parsed.market] ? parsed.market : fallback.market,
        area: HEATMAP_AREA.includes(parsed.area) ? parsed.area : fallback.area,
        color: HEATMAP_COLOR.includes(parsed.color) ? parsed.color : fallback.color,
        label: HEATMAP_LABEL.includes(parsed.label) ? parsed.label : fallback.label,
      };
    } catch {
      return fallback;
    }
  }

  function saveHeatmapPreferences() {
    safeStorageSet(
      STORAGE.heatmap,
      JSON.stringify({
        market: state.heatmap.market,
        area: state.heatmap.area,
        color: state.heatmap.color,
        label: state.heatmap.label,
      }),
    );
  }

  function initHeatmapControls() {
    if (!dom.heatmapArea) return;
    dom.heatmapArea.value = state.heatmap.area;
    dom.heatmapColor.value = state.heatmap.color;
    dom.heatmapLabel.value = state.heatmap.label;
    renderHeatmapMarketTabs();
  }

  function renderHeatmapMarketTabs() {
    if (!dom.heatmapMarkets) return;
    for (const button of dom.heatmapMarkets.querySelectorAll("[data-heatmap-market]")) {
      const active = button.dataset.heatmapMarket === state.heatmap.market;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
    }
  }

  function handleHeatmapMarketClick(event) {
    const button = event.target.closest("[data-heatmap-market]");
    if (!button) return;
    const market = button.dataset.heatmapMarket;
    if (!HEATMAP_MARKETS[market] || market === state.heatmap.market) return;
    state.heatmap.market = market;
    state.heatmap.data = null;
    state.heatmap.itemMap = new Map();
    state.heatmap.error = "";
    state.heatmap.loadedAt = 0;
    state.heatmap.hoverSymbol = null;
    saveHeatmapPreferences();
    renderHeatmapMarketTabs();
    dom.heatmapBoard.innerHTML = "";
    dom.heatmapSummary.innerHTML = "";
    dom.heatmapLegend.innerHTML = "";
    dom.heatmapFootnote.textContent = "正在加载…";
    writeHash({ mode: "heatmap", market }, "push");
    loadHeatmap(market);
  }

  function handleHeatmapFilterChange() {
    state.heatmap.area = HEATMAP_AREA.includes(dom.heatmapArea.value)
      ? dom.heatmapArea.value
      : HEATMAP_DEFAULTS.area;
    state.heatmap.color = HEATMAP_COLOR.includes(dom.heatmapColor.value)
      ? dom.heatmapColor.value
      : HEATMAP_DEFAULTS.color;
    state.heatmap.label = HEATMAP_LABEL.includes(dom.heatmapLabel.value)
      ? dom.heatmapLabel.value
      : HEATMAP_DEFAULTS.label;
    saveHeatmapPreferences();
    hideHeatmapTooltip();
    if (state.heatmap.data) renderHeatmap();
  }

  function updateHeatmapTitle() {
    const config = HEATMAP_MARKETS[state.heatmap.market] || HEATMAP_MARKETS.us500;
    if (state.mode === "heatmap") {
      document.title = `${config.label} 股票热力图 · 股票罗盘`;
    }
  }

  function shouldLoadHeatmap() {
    return (
      !state.heatmap.data ||
      state.heatmap.data.market !== state.heatmap.market ||
      Date.now() - state.heatmap.loadedAt > 110_000
    );
  }

  function paintHeatmapMeta(data) {
    const config = HEATMAP_MARKETS[state.heatmap.market] || HEATMAP_MARKETS.us500;
    dom.heatmapUpdated.textContent = `${config.label} · 快照 ${formatTimeOnly(data.updatedAt, true)}`;
    const missingNote = data.missing ? ` · ${data.missing} 只暂无行情` : "";
    dom.heatmapFootnote.textContent =
      `${data.scope} · ${data.count} 只 · 涨 ${data.summary.up} / 跌 ${data.summary.down} / 平 ${data.summary.flat}${missingNote}`;
  }

  function showHeatmapState(mode, message) {
    if (!dom.heatmapState) return;
    dom.heatmapState.hidden = false;
    dom.heatmapState.classList.toggle("is-error", mode === "error");
    const spinner = dom.heatmapState.querySelector(".spinner");
    if (spinner) spinner.hidden = mode === "error";
    dom.heatmapStateText.textContent = message || "";
    dom.heatmapRetry.hidden = mode !== "error";
  }

  function hideHeatmapState() {
    if (dom.heatmapState) dom.heatmapState.hidden = true;
  }

  async function loadHeatmap(market, options = {}) {
    const key = HEATMAP_MARKETS[market] ? market : "us500";
    state.heatmap.market = key;
    state.heatmap.loading = true;
    state.heatmap.error = "";
    const token = ++state.heatmap.token;
    hideHeatmapTooltip();
    renderHeatmapMarketTabs();
    showHeatmapState("loading", "正在读取市场热力图…");
    setConnection("busy", "同步中");
    dom.refreshButton.classList.add("is-spinning");
    dom.refreshButton.disabled = true;

    try {
      const suffix = options.force ? "&refresh=1" : "";
      const { data, meta } = await api(
        `/api/heatmap?market=${encodeURIComponent(key)}${suffix}`,
      );
      if (token !== state.heatmap.token) return;
      state.heatmap.data = data;
      state.heatmap.itemMap = new Map();
      for (const group of data.groups || []) {
        for (const item of group.items || []) {
          state.heatmap.itemMap.set(item.symbol, item);
        }
      }
      state.heatmap.loadedAt = Date.now();
      state.heatmap.loading = false;
      hideHeatmapState();
      if (state.mode !== "heatmap") return;
      renderHeatmapSummary(data);
      renderHeatmap();
      paintHeatmapMeta(data);
      updateHeatmapTitle();
      setConnection("idle", "热力图");
      dom.updateLabel.textContent = `更新于 ${clockNow()}`;
      maybeNotifyStale(meta);
    } catch (error) {
      if (token !== state.heatmap.token) return;
      state.heatmap.loading = false;
      state.heatmap.error = error.message || "热力图加载失败";
      if (state.mode !== "heatmap") return;
      if (state.heatmap.data) {
        hideHeatmapState();
        showToast(state.heatmap.error, "error");
      } else {
        showHeatmapState("error", state.heatmap.error);
        dom.heatmapUpdated.textContent = "加载失败";
      }
      setConnection("error", "热力图异常");
      dom.updateLabel.textContent = "加载失败";
    } finally {
      if (token === state.heatmap.token) {
        dom.refreshButton.classList.remove("is-spinning");
        dom.refreshButton.disabled = false;
      }
    }
  }

  function autoRefreshHeatmap() {
    if (state.mode !== "heatmap" || state.heatmap.loading) return;
    if (Date.now() - state.heatmap.loadedAt < 110_000) return;
    loadHeatmap(state.heatmap.market);
  }

  function renderHeatmapSummary(data) {
    if (!dom.heatmapSummary || !data?.summary) return;
    const summary = data.summary;
    const currency = data.currency || "USD";
    const weightedTone = toneOf(summary.weightedChangePct);
    const avgTone = toneOf(summary.avgChangePct);
    dom.heatmapSummary.innerHTML = `
      <div class="heatmap-stat">
        <span class="heatmap-stat-label">成分股</span>
        <strong>${escapeHtml(String(summary.count))}</strong>
        <small>${escapeHtml(data.scope)}</small>
      </div>
      <div class="heatmap-stat">
        <span class="heatmap-stat-label">上涨占比</span>
        <strong>${Number(summary.upRatio || 0).toFixed(1)}<em>%</em></strong>
        <small>涨 ${summary.up} · 跌 ${summary.down} · 平 ${summary.flat}</small>
      </div>
      <div class="heatmap-stat">
        <span class="heatmap-stat-label">市值加权涨跌</span>
        <strong class="${weightedTone}">${escapeHtml(formatPct(summary.weightedChangePct))}</strong>
        <small class="${avgTone}">平均 ${escapeHtml(formatPct(summary.avgChangePct))}</small>
      </div>
      <div class="heatmap-stat">
        <span class="heatmap-stat-label">总市值</span>
        <strong>${escapeHtml(formatMoney(summary.totalMarketCap, currency))}</strong>
        <small>成交 ${escapeHtml(formatMoney(summary.totalAmount, currency))}</small>
      </div>
    `;
  }

  function heatmapAreaValue(item, basis) {
    if (basis === "equal") return 1;
    const value = Number(item[basis]);
    return Number.isFinite(value) && value > 0 ? value : 0;
  }

  function heatmapColorValue(item, basis) {
    const value = Number(item[basis]);
    return Number.isFinite(value) ? value : 0;
  }

  function percentile(values, ratio) {
    const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
    if (!sorted.length) return 0;
    const position = clamp(ratio, 0, 1) * (sorted.length - 1);
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    if (lower === upper) return sorted[lower];
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
  }

  function buildHeatmapColorStats(items, basis) {
    if (basis === "changePct") {
      const maxAbs = percentile(
        items.map((item) => Math.abs(heatmapColorValue(item, basis))),
        0.9,
      );
      return { cap: clamp(maxAbs, 1.5, 15) };
    }
    const values = items
      .map((item) => heatmapColorValue(item, basis))
      .filter((value) => value > 0);
    const cap = percentile(values, 0.9);
    return { cap: cap > 0 ? cap : 1 };
  }

  function heatmapColorFor(item, basis, stats, light) {
    if (basis === "changePct") {
      const value = heatmapColorValue(item, basis);
      if (Math.abs(value) < 0.005) {
        return { background: "var(--heat-flat-bg)", foreground: "var(--muted)" };
      }
      const intensity = Math.min(1, Math.pow(Math.abs(value) / stats.cap, 0.7));
      const color = value > 0 ? THEME.up : THEME.down;
      const alpha = (light ? 0.14 : 0.18) + intensity * (light ? 0.78 : 0.76);
      return {
        background: withAlpha(color, alpha),
        foreground: light
          ? alpha >= 0.46
            ? "#fffdf8"
            : "var(--text)"
          : "rgba(250,252,250,0.97)",
      };
    }

    const value = heatmapColorValue(item, basis);
    if (!(value > 0)) {
      return { background: "var(--heat-flat-bg)", foreground: "var(--muted)" };
    }
    const intensity = Math.min(1, Math.pow(value / stats.cap, 0.62));
    const alpha = (light ? 0.1 : 0.14) + intensity * (light ? 0.82 : 0.76);
    return {
      background: withAlpha(THEME.gold, alpha),
      foreground: light
        ? alpha >= 0.52
          ? "#fffdf8"
          : "var(--text)"
        : "rgba(250,252,250,0.97)",
    };
  }

  function worstAspect(areas, totalArea, side) {
    const thickness = totalArea / side;
    if (!(thickness > 0)) return Number.POSITIVE_INFINITY;
    let worst = 0;
    for (const area of areas) {
      if (!(area > 0)) continue;
      worst = Math.max(worst, (thickness * thickness) / area, area / (thickness * thickness));
    }
    return worst;
  }

  function squarifyNodes(nodes, rect) {
    const result = [];
    const queue = nodes
      .filter((node) => node && Number.isFinite(node.weight) && node.weight > 0)
      .sort((a, b) => b.weight - a.weight);
    if (!queue.length || rect.w <= 0 || rect.h <= 0) return result;

    const total = queue.reduce((sum, node) => sum + node.weight, 0);
    const scale = (rect.w * rect.h) / total;
    let x = rect.x;
    let y = rect.y;
    let w = rect.w;
    let h = rect.h;

    while (queue.length && w > 0.4 && h > 0.4) {
      const shortSide = Math.min(w, h);
      const row = [];
      let rowArea = 0;
      let previousWorst = Number.POSITIVE_INFINITY;

      for (const node of queue) {
        const area = node.weight * scale;
        const areas = row.map((entry) => entry.area).concat(area);
        const candidate = worstAspect(areas, rowArea + area, shortSide);
        if (!row.length || candidate <= previousWorst * 1.0001) {
          row.push({ node, area });
          rowArea += area;
          previousWorst = candidate;
        } else {
          break;
        }
      }

      if (!row.length) break;

      if (w >= h) {
        const rowWidth = Math.min(w, rowArea / h);
        let offset = y;
        row.forEach((entry, index) => {
          const height =
            index === row.length - 1 ? y + h - offset : entry.area / rowWidth;
          result.push({
            node: entry.node,
            x,
            y: offset,
            w: rowWidth,
            h: Math.max(0, height),
          });
          offset += height;
        });
        x += rowWidth;
        w -= rowWidth;
      } else {
        const rowHeight = Math.min(h, rowArea / w);
        let offset = x;
        row.forEach((entry, index) => {
          const width =
            index === row.length - 1 ? x + w - offset : entry.area / rowHeight;
          result.push({
            node: entry.node,
            x: offset,
            y,
            w: Math.max(0, width),
            h: rowHeight,
          });
          offset += width;
        });
        y += rowHeight;
        h -= rowHeight;
      }

      queue.splice(0, row.length);
    }

    if (queue.length && w > 0 && h > 0) {
      const slot = Math.max(1, queue.length);
      const slotHeight = h / slot;
      queue.forEach((node, index) => {
        result.push({
          node,
          x,
          y: y + index * slotHeight,
          w,
          h: slotHeight,
        });
      });
    }
    return result;
  }

  function heatmapTileLabel(item, basis, currency) {
    switch (basis) {
      case "code":
        return [item.code];
      case "codePct":
        return [item.code, formatPct(item.changePct)];
      case "nameCap":
        return [item.name, formatMoney(item.marketCap, currency)];
      case "name":
        return [item.name];
      default:
        return [item.name, formatPct(item.changePct)];
    }
  }

  function renderHeatmap() {
    if (state.mode !== "heatmap" || !state.heatmap.data) return;
    const board = dom.heatmapBoard;
    if (!board) return;
    const width = board.clientWidth;
    const height = board.clientHeight;
    if (width < 80 || height < 80) return;

    const data = state.heatmap.data;
    const items = (data.groups || []).flatMap((group) => group.items || []);
    if (!items.length) return;

    const areaBasis = state.heatmap.area;
    const colorBasis = state.heatmap.color;
    const labelBasis = state.heatmap.label;
    const currency = data.currency || "USD";
    const light = isLightTheme();

    const maxArea = Math.max(
      1,
      ...items.map((item) => heatmapAreaValue(item, areaBasis)),
    );
    const floor = maxArea * 0.0007;
    const itemWeight = (item) =>
      areaBasis === "equal"
        ? 1
        : Math.max(heatmapAreaValue(item, areaBasis), floor);

    const groupNodes = (data.groups || [])
      .map((group) => {
        const groupItems = (group.items || []).map((item) => ({
          item,
          weight: itemWeight(item),
        }));
        return {
          item: group,
          weight: groupItems.reduce((sum, node) => sum + node.weight, 0),
          nodes: groupItems,
        };
      })
      .filter((node) => node.weight > 0 && node.nodes.length);

    const colorStats = buildHeatmapColorStats(items, colorBasis);
    renderHeatmapLegend(colorBasis, colorStats, currency);

    const groupRects = squarifyNodes(groupNodes, {
      x: 0,
      y: 0,
      w: width,
      h: height,
    });

    const groupMarkup = [];
    const tileMarkup = [];
    const label = dom.heatmapLabel?.value || labelBasis;

    for (const rect of groupRects) {
      const group = rect.node.item;
      const gx = rect.x + 1;
      const gy = rect.y + 1;
      const gw = Math.max(0, rect.w - 2);
      const gh = Math.max(0, rect.h - 2);
      if (gw < 3 || gh < 3) continue;

      const hasHeader = (group.items?.length || 0) >= 2 && gw >= 62 && gh >= 50;
      const headerHeight = hasHeader ? 18 : 0;
      const inner = {
        x: gx,
        y: gy + headerHeight,
        w: gw,
        h: gh - headerHeight,
      };
      if (inner.w < 3 || inner.h < 3) continue;

      groupMarkup.push(
        `<div class="heatmap-group${hasHeader ? "" : " is-compact"}" style="left:${gx}px;top:${gy}px;width:${gw}px;height:${gh}px">` +
          (hasHeader
            ? `<span class="heatmap-group-label"><span class="heatmap-group-name">${escapeHtml(group.name)}</span><small class="${toneOf(group.changePct)}">${escapeHtml(formatPct(group.changePct))}</small></span>`
            : "") +
          `</div>`,
      );

      const tileRects = squarifyNodes(rect.node.nodes, inner);
      for (const tileRect of tileRects) {
        const item = tileRect.node.item;
        const tx = tileRect.x + 1;
        const ty = tileRect.y + 1;
        const tw = Math.max(0, tileRect.w - 2);
        const th = Math.max(0, tileRect.h - 2);
        if (tw < 2 || th < 2) continue;

        const color = heatmapColorFor(item, colorBasis, colorStats, light);
        const lines = heatmapTileLabel(item, label, currency);
        const showPrimary = tw >= 26 && th >= 15;
        const showSecondary = showPrimary && tw >= 44 && th >= 32 && lines.length > 1;
        const fontSize = Math.min(
          label === "name" || label === "namePct" || label === "nameCap" ? 12 : 13,
          Math.max(7, Math.min(tw / 8.5, th / 4.4)),
        );
        const aria = `${item.name} ${item.code}，${formatPct(item.changePct)}，总市值 ${formatMoney(item.marketCap, currency)}`;
        tileMarkup.push(
          `<button type="button" class="heatmap-tile" data-heatmap-symbol="${escapeAttr(item.symbol)}" ` +
            `style="left:${tx}px;top:${ty}px;width:${tw}px;height:${th}px;--tile-bg:${color.background};--tile-fg:${color.foreground};font-size:${fontSize.toFixed(1)}px" ` +
            `aria-label="${escapeAttr(aria)}">` +
            (showPrimary
              ? `<span class="heatmap-tile-label">${escapeHtml(lines[0])}</span>`
              : "") +
            (showSecondary
              ? `<span class="heatmap-tile-sub">${escapeHtml(lines[1])}</span>`
              : "") +
            `</button>`,
        );
      }
    }

    board.innerHTML = groupMarkup.join("") + tileMarkup.join("");
    const config = HEATMAP_MARKETS[state.heatmap.market];
    dom.heatmapStage.setAttribute(
      "aria-label",
      `${config?.label || ""} 股票热力图，共 ${data.count} 只股票，${data.summary.up} 只上涨，${data.summary.down} 只下跌`,
    );
  }

  function renderHeatmapLegend(colorBasis, stats, currency) {
    if (!dom.heatmapLegend) return;
    if (colorBasis === "changePct") {
      dom.heatmapLegend.innerHTML = `
        <span class="heatmap-legend-title">颜色 · 涨跌幅</span>
        <span class="heatmap-legend-edge down">-${stats.cap.toFixed(1)}%</span>
        <span class="heatmap-gradient" style="background:linear-gradient(90deg,${withAlpha(THEME.down, 0.92)},${withAlpha(THEME.down, 0.16)} 42%,var(--heat-flat-bg) 50%,${withAlpha(THEME.up, 0.16)} 58%,${withAlpha(THEME.up, 0.92)})"></span>
        <span class="heatmap-legend-edge up">+${stats.cap.toFixed(1)}%</span>
      `;
      return;
    }
    const label = {
      amplitudePct: "振幅",
      turnoverPct: "换手率",
      amount: "成交额",
      marketCap: "总市值",
    }[colorBasis] || "数值";
    const maxLabel =
      colorBasis === "amount" || colorBasis === "marketCap"
        ? `${currency === "CNY" ? "¥" : currency === "HKD" ? "HK$" : "US$"}${compactNumber(stats.cap)}`
        : `${trimNumber(stats.cap)}%`;
    dom.heatmapLegend.innerHTML = `
      <span class="heatmap-legend-title">颜色 · ${escapeHtml(label)}</span>
      <span class="heatmap-legend-edge">0</span>
      <span class="heatmap-gradient" style="background:linear-gradient(90deg,var(--heat-flat-bg),${withAlpha(THEME.gold, 0.9)})"></span>
      <span class="heatmap-legend-edge">${escapeHtml(maxLabel)}</span>
    `;
  }

  function handleHeatmapPointerMove(event) {
    if (state.mode !== "heatmap") return;
    const tile = event.target.closest(".heatmap-tile");
    if (!tile) {
      hideHeatmapTooltip();
      return;
    }
    const item = state.heatmap.itemMap.get(tile.dataset.heatmapSymbol);
    if (!item) return;
    if (state.heatmap.hoverSymbol !== item.symbol) {
      state.heatmap.hoverSymbol = item.symbol;
      renderHeatmapTooltip(item);
    }
    positionHeatmapTooltip(event.clientX, event.clientY);
  }

  function renderHeatmapTooltip(item) {
    const data = state.heatmap.data;
    const currency = data?.currency || "USD";
    const decimals = Number(data?.decimals) || 2;
    const tone = toneOf(item.changePct);
    const marketLabel = { CN: "A股", HK: "港股", US: "美股" }[item.market] || "";
    dom.heatmapTooltip.innerHTML = `
      <div class="heatmap-tooltip-head">
        <span class="heatmap-tooltip-name">${escapeHtml(item.name)}</span>
        <span class="market-badge ${(item.market || "").toLowerCase()}">${escapeHtml(marketLabel)}</span>
      </div>
      <div class="heatmap-tooltip-code">${escapeHtml(item.code)} · ${escapeHtml(item.sector)}</div>
      <div class="heatmap-tooltip-price">
        <strong>${escapeHtml(formatPrice(item.price, decimals))}</strong>
        <span class="${tone}">${escapeHtml(formatPct(item.changePct))}</span>
      </div>
      <div class="tooltip-grid">
        <div><span>总市值</span><strong>${escapeHtml(formatMoney(item.marketCap, currency))}</strong></div>
        <div><span>成交额</span><strong>${escapeHtml(formatMoney(item.amount, currency))}</strong></div>
        <div><span>换手率</span><strong>${escapeHtml(formatPctPlain(item.turnoverPct))}</strong></div>
        <div><span>振幅</span><strong>${escapeHtml(formatPctPlain(item.amplitudePct))}</strong></div>
      </div>
      <div class="heatmap-tooltip-hint">点击查看个股行情</div>
    `;
    dom.heatmapTooltip.hidden = false;
  }

  function positionHeatmapTooltip(clientX, clientY) {
    if (!dom.heatmapTooltip) return;
    const width = 248;
    const left = clamp(
      clientX,
      width / 2 + 10,
      Math.max(width / 2 + 10, window.innerWidth - width / 2 - 10),
    );
    const below = clientY < 240;
    dom.heatmapTooltip.classList.toggle("is-below", below);
    dom.heatmapTooltip.style.left = `${left}px`;
    dom.heatmapTooltip.style.top = `${below ? clientY + 18 : clientY - 12}px`;
  }

  function hideHeatmapTooltip() {
    if (!dom.heatmapTooltip) return;
    dom.heatmapTooltip.hidden = true;
    state.heatmap.hoverSymbol = null;
  }

  function handleHeatmapFocusIn(event) {
    const tile = event.target.closest(".heatmap-tile");
    if (!tile) return;
    const item = state.heatmap.itemMap.get(tile.dataset.heatmapSymbol);
    if (!item) return;
    state.heatmap.hoverSymbol = item.symbol;
    renderHeatmapTooltip(item);
    const rect = tile.getBoundingClientRect();
    positionHeatmapTooltip(rect.left + rect.width / 2, rect.top + Math.min(rect.height / 2, 56));
  }

  function handleHeatmapFocusOut(event) {
    if (event.relatedTarget && dom.heatmapBoard.contains(event.relatedTarget)) return;
    hideHeatmapTooltip();
  }

  function handleHeatmapClick(event) {
    const tile = event.target.closest(".heatmap-tile");
    if (!tile) return;
    const item = state.heatmap.itemMap.get(tile.dataset.heatmapSymbol);
    if (!item) return;
    hideHeatmapTooltip();
    const meta = {
      CN: { marketLabel: "A股", board: "沪A", exchange: "上交所" },
      HK: { marketLabel: "港股", board: "港股", exchange: "港交所" },
      US: { marketLabel: "美股", board: "美股", exchange: "" },
    }[item.market] || {};
    loadStock(
      {
        symbol: item.symbol,
        code: item.code,
        name: item.name,
        market: item.market,
        currency: state.heatmap.data?.currency,
        ...meta,
      },
      { historyMode: "push" },
    );
  }

  /* ------------------------------------------------------------------------
     View / connection / error states
     ------------------------------------------------------------------------ */

  function showView(name) {
    if (state.mode !== "stock") return;
    dom.loadingView.hidden = name !== "loading";
    dom.stockView.hidden = name !== "stock";
    dom.errorView.hidden = name !== "error";
    if (name === "stock") {
      window.requestAnimationFrame(drawIntradayChart);
    }
  }

  function setMode(mode, options = {}) {
    const next = mode === "heatmap" ? "heatmap" : "stock";
    state.mode = next;
    updateModeTabs();
    if (dom.aiStatsModal && !dom.aiStatsModal.hidden) closeAiStats({ restoreFocus: false });

    if (next === "heatmap") {
      hideTileTooltip();
      hideHeatmapTooltip();
      dom.loadingView.hidden = true;
      dom.stockView.hidden = true;
      dom.errorView.hidden = true;
      dom.stockView.classList.remove("is-switching");
      dom.heatmapView.hidden = false;
      renderHeatmapMarketTabs();
      setConnection(state.heatmap.error ? "error" : "idle", state.heatmap.error ? "热力图异常" : "热力图");
      updateHeatmapTitle();
      if (options.syncHash !== false) {
        writeHash({ mode: "heatmap", market: state.heatmap.market }, options.hashMode || "push");
      }
      if (options.load !== false) {
        if (shouldLoadHeatmap()) {
          loadHeatmap(state.heatmap.market);
        } else if (state.heatmap.data) {
          hideHeatmapState();
          renderHeatmapSummary(state.heatmap.data);
          paintHeatmapMeta(state.heatmap.data);
          setConnection("idle", "热力图");
          dom.updateLabel.textContent = `更新于 ${clockNow()}`;
        }
      }
      window.requestAnimationFrame(() => {
        if (state.mode === "heatmap" && state.heatmap.data) renderHeatmap();
      });
      return;
    }

    dom.heatmapView.hidden = true;
    hideHeatmapTooltip();
    if (options.ensureStock !== false && !state.selected) {
      if (options.syncHash !== false) {
        writeHash(
          { mode: "stock", symbol: DEFAULT_STOCK.symbol },
          options.hashMode || "replace",
        );
      }
      loadStock(DEFAULT_STOCK, { historyMode: "none" });
      return;
    }
    showView(state.quote ? "stock" : "loading");
    if (state.quote?.stock) {
      document.title = `${state.quote.stock.name} ${formatPrice(state.quote.price, state.quote.decimals)} ${formatPct(state.quote.changePct)} · 股票罗盘`;
      setConnection("idle", "行情已连接");
    }
    if (options.syncHash !== false && state.selected?.symbol) {
      writeHash(
        { mode: "stock", symbol: state.selected.symbol },
        options.hashMode || "push",
      );
    }
  }

  function updateModeTabs() {
    if (!dom.viewTabs) return;
    for (const button of dom.viewTabs.querySelectorAll("[data-view-mode]")) {
      const active = button.dataset.viewMode === state.mode;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
    }
  }

  function handleViewTabClick(event) {
    const button = event.target.closest("[data-view-mode]");
    if (!button) return;
    const mode = button.dataset.viewMode;
    if (mode === state.mode) return;
    setMode(mode, { hashMode: "push" });
  }

  function showError(message) {
    if (state.mode !== "stock") return;
    dom.errorMessage.textContent = message || "请检查网络连接后重试。";
    showView("error");
    setConnection("error", "连接异常");
    dom.updateLabel.textContent = "未能获取行情";
    dom.refreshButton.classList.remove("is-spinning");
    dom.refreshButton.disabled = false;
  }

  function setConnection(kind, text) {
    dom.connectionPill.classList.toggle("is-busy", kind === "busy");
    dom.connectionPill.classList.toggle("is-error", kind === "error");
    dom.connectionText.textContent = text;
    if (dom.sidebarFooter) {
      dom.sidebarFooter.classList.toggle("is-busy", kind === "busy");
      dom.sidebarFooter.classList.toggle("is-error", kind === "error");
    }
    if (dom.sidebarStatus) {
      dom.sidebarStatus.textContent =
        kind === "busy" ? "正在同步行情" : kind === "error" ? "行情通道波动" : "行情通道就绪";
    }
  }

  function maybeNotifyStale(meta) {
    if (!meta?.stale) return;
    if (Date.now() - state.staleNotifiedAt < 60_000) return;
    state.staleNotifiedAt = Date.now();
    showToast("行情源暂时波动，正在展示最近一次缓存数据", "error");
  }

  /* ------------------------------------------------------------------------
     Global shortcuts
     ------------------------------------------------------------------------ */

  function handleGlobalKeydown(event) {
    const tag = document.activeElement?.tagName?.toLowerCase();
    const typing = tag === "input" || tag === "textarea" || document.activeElement?.isContentEditable;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      dom.searchInput.focus();
      dom.searchInput.select();
      return;
    }
    if (event.key === "/" && !typing && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      dom.searchInput.focus();
      return;
    }
    if (event.key === "Escape") {
      if (!dom.aiStatsModal?.hidden) {
        closeAiStats();
        return;
      }
      if (!dom.searchPanel.hidden) closeSearchPanel();
      hideTileTooltip();
      hideHeatmapTooltip();
      dom.chartTooltip.hidden = true;
      if (state.chartHover !== null) {
        state.chartHover = null;
        drawIntradayChart();
      }
    }
  }

  /* ------------------------------------------------------------------------
     Clock
     ------------------------------------------------------------------------ */

  function updateDateAndClock() {
    const parts = new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "long",
      day: "numeric",
      weekday: "short",
    }).formatToParts(new Date());
    const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    dom.todayLabel.textContent = `${map.year}年${map.month}月${map.day}日 ${map.weekday} · 北京时间`;
    dom.sidebarClock.textContent = clockNow(true);
  }

  function clockNow(withSeconds = false) {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      hour: "2-digit",
      minute: "2-digit",
      ...(withSeconds ? { second: "2-digit" } : {}),
      hour12: false,
    }).format(new Date());
  }

  function shanghaiDateString() {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());
    const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${map.year}-${map.month}-${map.day}`;
  }

  /* ------------------------------------------------------------------------
     Formatting helpers
     ------------------------------------------------------------------------ */

  function formatPrice(value, decimals = 2) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "--";
    return new Intl.NumberFormat("zh-CN", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(number);
  }

  function formatNumber(value, decimals = 2) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "—";
    return new Intl.NumberFormat("zh-CN", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(number);
  }

  function formatSigned(value, decimals = 2) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "--";
    return `${number > 0 ? "+" : ""}${formatPrice(number, decimals)}`;
  }

  function formatPct(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "--";
    return `${number > 0 ? "+" : ""}${number.toFixed(2)}%`;
  }

  function formatPctPlain(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "--";
    return `${number.toFixed(2)}%`;
  }

  function volumeUnit(stock) {
    if (isForexInstrument(stock)) return "";
    return isCommodityMarket(stock) ? "手" : "股";
  }

  function formatVolume(value, unit = "股") {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return "—";
    return `${compactNumber(number)}${unit}`;
  }

  function formatAmount(value, currency = "CNY", stock = null) {
    if (isCommodityMarket(stock)) return "—";
    return formatMoney(value, currency);
  }

  function formatMoney(value, currency = "CNY") {
    const number = Number(value);
    if (!Number.isFinite(number)) return "—";
    const symbol = { CNY: "¥", HKD: "HK$", USD: "US$" }[currency] || "";
    return `${symbol}${compactNumber(number)}`;
  }

  function compactNumber(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "—";
    const abs = Math.abs(number);
    if (abs >= 1e12) return `${trimNumber(number / 1e12)}万亿`;
    if (abs >= 1e8) return `${trimNumber(number / 1e8)}亿`;
    if (abs >= 1e4) return `${trimNumber(number / 1e4)}万`;
    return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(number);
  }

  function trimNumber(value) {
    return value.toFixed(2).replace(/\.?0+$/, "");
  }

  function toneOf(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || Math.abs(number) < 0.00001) return "flat";
    return number > 0 ? "up" : "down";
  }

  function formatDateCN(dateString) {
    if (!dateString) return "—";
    const [year, month, day] = dateString.split("-").map(Number);
    if (!year || !month || !day) return dateString;
    return `${year}年${month}月${day}日`;
  }

  function formatDateDot(dateString) {
    if (!dateString) return "—";
    return dateString.replaceAll("-", ".");
  }

  function formatMonthDay(dateString) {
    if (!dateString) return "—";
    const [, month, day] = dateString.split("-");
    return `${Number(month)}月${Number(day)}日`;
  }

  function weekdayCN(dateString) {
    if (!dateString) return "";
    const [year, month, day] = dateString.split("-").map(Number);
    return `周${"日一二三四五六"[new Date(year, month - 1, day).getDay()]}`;
  }

  function formatTimeOnly(iso, withSeconds = false) {
    if (!iso) return "--";
    try {
      return new Intl.DateTimeFormat("zh-CN", {
        timeZone: "Asia/Shanghai",
        hour: "2-digit",
        minute: "2-digit",
        ...(withSeconds ? { second: "2-digit" } : {}),
        hour12: false,
      }).format(new Date(iso));
    } catch {
      return "--";
    }
  }

  function withAlpha(hex, alpha) {
    const normalized = String(hex).replace("#", "");
    if (normalized.length !== 6) return `rgba(239,93,96,${alpha})`;
    const value = Number.parseInt(normalized, 16);
    const red = (value >> 16) & 255;
    const green = (value >> 8) & 255;
    const blue = value & 255;
    return `rgba(${red},${green},${blue},${alpha})`;
  }

  function uniqueIndexes(values) {
    return [...new Set(values)].filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function escapeAttr(value) {
    return escapeHtml(value).replaceAll("`", "&#96;");
  }

  function isValidSymbol(symbol) {
    return /^(101|102|133|0|1|105|106|107|116)\.[A-Za-z0-9._\-]{1,16}$/.test(String(symbol || ""));
  }

  /* ------------------------------------------------------------------------
     API / storage / toast
     ------------------------------------------------------------------------ */

  async function api(path, options = {}) {
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 30_000;
    const externalSignal = options.signal || null;
    const controller = new AbortController();
    let timedOut = false;
    const timer = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const forwardAbort = () => controller.abort();
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort();
      else externalSignal.addEventListener("abort", forwardAbort, { once: true });
    }

    let response;
    try {
      response = await fetch(path, {
        method: options.method || "GET",
        headers: {
          Accept: "application/json",
          ...(options.body ? { "Content-Type": "application/json" } : {}),
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
        cache: "no-store",
        signal: controller.signal,
      });
    } catch (error) {
      if (error.name === "AbortError") {
        if (externalSignal?.aborted) throw error;
        if (timedOut) throw new Error("行情服务响应超时，请稍后重试。");
      }
      throw new Error("网络连接失败，请确认本地服务仍在运行。");
    } finally {
      window.clearTimeout(timer);
      if (externalSignal) externalSignal.removeEventListener("abort", forwardAbort);
    }
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      throw new Error(`行情服务返回了异常响应（${response.status}）`);
    }
    if (!response.ok || !payload?.ok) {
      throw new Error(payload?.error?.message || `请求失败（${response.status}）`);
    }
    return { data: payload.data, meta: payload.meta };
  }

  function safeStorageGet(key) {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function safeStorageSet(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      /* 无痕模式等环境可能禁用 localStorage。 */
    }
  }

  function showToast(message, type = "info") {
    if (!dom.toastRegion) return;
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    toast.textContent = message;
    dom.toastRegion.appendChild(toast);
    window.setTimeout(() => {
      toast.classList.add("is-leaving");
      window.setTimeout(() => toast.remove(), 220);
    }, 2800);
  }
})();
