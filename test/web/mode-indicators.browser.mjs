import assert from "node:assert/strict";
import { chromium } from "playwright";

const baseUrl = process.env.MODE_ICONS_BASE_URL ?? "http://localhost:18766";
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
});

async function isolateApi(page, responses = {}) {
  const unexpectedRequests = [];
  await page.route(/^https?:\/\/[^/]+\/api(?:\/|$)/, async (route) => {
    const request = route.request();
    const key = request.method() + " " + new URL(request.url()).pathname;
    if (!Object.hasOwn(responses, key)) {
      unexpectedRequests.push(key);
      await route.abort();
      return;
    }
    await route.fulfill({ json: responses[key] });
  });
  return unexpectedRequests;
}

async function mountIndicators(page) {
  const unexpectedRequests = await isolateApi(page);
  const fixtureUrl = new URL("/__mode_indicator_fixture__", baseUrl).href;

  await page.route(fixtureUrl, (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><html><head><meta name='viewport' content='width=device-width, initial-scale=1'></head><body></body></html>" }));
  await page.goto(fixtureUrl, { waitUntil: "domcontentloaded" });
  // 预热 optimizeDeps:CI 里只 curl 过 `/` 就开始导入 `/node_modules/.vite/deps/react.js`,
  // 预打包一旦还没落盘,vite 会先回 504 Outdated Optimize Dep,动态导入随机超时(本脚本 flake 的成因)。
  await page.evaluate(async () => {
    for (const dep of ["/node_modules/.vite/deps/react.js", "/node_modules/.vite/deps/react-dom_client.js"]) {
      for (let attempt = 0; attempt < 40; attempt++) {
        const res = await fetch(dep, { cache: "no-store" }).catch(() => null);
        if (res && res.ok) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  });
  await page.evaluate(async () => {
    const refresh = await import("/@react-refresh");
    refresh.default.injectIntoGlobalHook(window);
    window.$RefreshReg$ = () => {};
    window.$RefreshSig$ = () => (type) => type;
    window.__vite_plugin_react_preamble_installed__ = true;
    const reactModule = await import("/node_modules/.vite/deps/react.js");
    const React = reactModule.default ?? reactModule;
    const domModule = await import("/node_modules/.vite/deps/react-dom_client.js");
    const { createRoot } = domModule.default ?? domModule;
    const { ModeIndicators } = await import("/src/components/ModeIndicator.tsx");
    const host = document.createElement("main");
    host.style.cssText = "padding:24px;min-height:100vh";
    document.body.replaceChildren(host);
    const room = {
      recording: { danmu: 1, enabled: true, streamUpload: true, streamUploadSpool: false },
      processing: { enabled: true, pipeline: { upload: { mode: "rolling", private: false } } },
    };
    const root = createRoot(host);
    window.setIndicatorRoom = (nextRoom) => root.render(React.createElement("div", null,
      React.createElement("h1", { id: "outside", style: { marginBottom: 32 } }, "Room icon verification"),
      React.createElement("section", { id: "indicators" }, React.createElement(ModeIndicators, { room: nextRoom })),
    ));
    window.setIndicatorRoom(room);
  });
  await page.locator("#indicators button").last().waitFor();
  return unexpectedRequests;
}

async function assertAllMarkGeometry(page) {
  await page.evaluate(async () => {
    const kinds = ["archive", "bilibili", "zero-disk", "segment", "merge", "node", "split", "danmu"];
    const { ModeLogo } = await import("/src/components/ModeLogo.tsx");
    const reactModule = await import("/node_modules/.vite/deps/react.js");
    const React = reactModule.default ?? reactModule;
    const domModule = await import("/node_modules/.vite/deps/react-dom_client.js");
    const { createRoot } = domModule.default ?? domModule;
    const host = document.createElement("div");
    host.id = "mark-geometry";
    host.style.cssText = "position:fixed;left:0;top:0;width:200px;pointer-events:none";
    document.body.append(host);
    const root = createRoot(host);
    root.render(React.createElement(React.Fragment, null,
      kinds.map((kind) => React.createElement(ModeLogo, { key: kind, kind, className: "mode-chip-icon" }))));
  });
  await page.waitForFunction(() => {
    const uses = document.querySelectorAll("#mark-geometry svg use");
    if (uses.length !== 8) return false;
    for (const use of uses) {
      try {
        const bbox = use.getBBox();
        if (!(bbox.width > 0 && bbox.height > 0)) return false;
      } catch { return false; }
    }
    return true;
  }, undefined, { timeout: 5000 });
  const sizes = await page.locator("#mark-geometry svg use").evaluateAll((uses) =>
    uses.map((use) => {
      try {
        const { width, height } = use.getBBox();
        return { width, height };
      } catch { return { width: 0, height: 0 }; }
    }));
  assert.equal(sizes.length, 8);
  assert(sizes.every(({ width, height }) => width > 0 && height > 0),
    `every mark must render nonempty geometry: ${JSON.stringify(sizes)}`);
}

async function assertMobileRoomRow(page) {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") pageErrors.push(message.text());
  });
  page.on("requestfailed", (request) => {
    if (request.resourceType() === "script" || new URL(request.url()).pathname.startsWith("/src/")) {
      pageErrors.push(request.url() + ": " + request.failure()?.errorText);
    }
  });
  page.on("response", (response) => {
    if (response.request().resourceType() === "script" && response.status() >= 400) {
      pageErrors.push(response.url() + ": HTTP " + response.status());
    }
  });
  const room = {
    key: "douyin.fixture", platform: "douyin", roomSlug: "fixture", room: "https://example.test/fixture",
    recording: { taskId: null, name: "Fixture room", danmu: 1, enabled: true, streamUpload: false, scheduleStart: "20:00", scheduleEnd: "02:00" },
    processing: { enabled: true, workers: ["fixture-node"], pipeline: { upload: { mode: "upload" }, steps: { mergeSegments: false } } },
  };
  await page.addInitScript(() => {
    localStorage.setItem("drec.lang", "en");
    window.EventSource = undefined;
  });
  const responses = {
      // App 先探测会话再挂载 shell(#600)；声明成期望请求,否则会被隔离门判成未声明 API 调用。
      "GET /api/session": { authRequired: false, authenticated: true },
      "GET /api/rooms": [room],
      "GET /api/tasks": [],
      "GET /api/hub/latest-runs": { rooms: [] },
      "GET /api/hub/workers": [{ id: "fixture-node", name: "Studio node" }],
      "GET /api/hub/status": { enabled: true },
      "GET /api/cookies/douyin": { platform: "douyin", set: false, hasSession: false, length: 0, expiresAt: null, source: "none" },
      "GET /api/timezone": { timezone: "", default: "Asia/Shanghai", effective: "Asia/Shanghai" },
      "GET /api/events": { events: [], cursor: 0 },
  };
  const unexpectedRequests = await isolateApi(page, responses);
  const initialized = Promise.all(Object.keys(responses).map((key) => page.waitForResponse((response) =>
    response.request().method() + " " + new URL(response.url()).pathname === key && response.ok())));
  await page.goto(new URL("/rooms", baseUrl).href, { waitUntil: "domcontentloaded" });
  await initialized;
  await page.waitForLoadState("networkidle");
  const row = page.locator(".task-compact").filter({ hasText: "Fixture room" });
  await row.waitFor({ state: "visible", timeout: 10000 }).catch(async (error) => {
    throw new Error("RoomsPage did not render fixture: " + (await page.locator("body").innerText()) + "; browser errors: " + pageErrors.join("; "), { cause: error });
  });
  await row.getByText("Studio node", { exact: true }).waitFor({ state: "visible" });
  await row.getByText(/20:00.*02:00/).waitFor({ state: "visible" });
  // 契约有意变更(hy4 F⑨):交付方式那枚是「位置上的一个短词」,不再是图标;另外两枚仍是图标。
  const controls = row.locator(".mode-indicators button");
  assert.equal(await controls.count(), 3);
  assert.equal(await controls.filter({ has: page.locator("svg use") }).count(), 2);
  const geometry = await row.evaluate((element) => {
    const rowRect = element.getBoundingClientRect();
    const items = [...element.querySelectorAll(".mode-indicators button")];
    const scheduleElement = [...element.querySelectorAll("span")].find((span) => /20:00.*02:00/.test(span.textContent ?? ""));
    const nodeElement = [...element.querySelectorAll("span")].find((span) => span.textContent === "Studio node");
    return {
      viewport: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      row: { left: rowRect.left, right: rowRect.right },
      items: [...items, scheduleElement, nodeElement].map((item) => {
        if (!item) return null;
        const rect = item.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
      }),
    };
  });
  assert.equal(geometry.viewport, 320);
  assert.equal(geometry.scrollWidth, 320);
  assert(geometry.row.left >= 0 && geometry.row.right <= 320);
  assert.equal(geometry.items.length, 5);
  for (const item of geometry.items) {
    assert(item && item.width > 0 && item.height > 0 && item.left >= geometry.row.left && item.right <= geometry.row.right,
      "room row item is clipped: " + JSON.stringify(geometry));
  }
  for (let index = 0; index < geometry.items.length; index++) {
    for (let other = index + 1; other < geometry.items.length; other++) {
      const first = geometry.items[index];
      const second = geometry.items[other];
      assert(first.right <= second.left || second.right <= first.left || first.bottom <= second.top || second.bottom <= first.top,
        "room row items overlap: " + JSON.stringify(geometry));
    }
  }
  await page.close();
  assert.deepEqual(unexpectedRequests, [], "unexpected API requests");
  assert.deepEqual(pageErrors, [], "browser console, page or module errors");
}

try {
  const desktop = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const desktopRequests = await mountIndicators(desktop);
  await assertAllMarkGeometry(desktop);
  const buttons = desktop.locator("#indicators button");
  assert.equal(await buttons.count(), 3);
  const names = await buttons.evaluateAll(elements => elements.map(element => element.getAttribute("aria-label")));
  assert(names.every(name => name && !name.includes("room.")));
  // 契约有意变更(hy4 F⑨):交付方式那枚从纯图标改为「图标位置上的一个短词」,
  // 三个纯图标在 Upload 列里读不出意思。图标仍然占据同一位置,故按钮数仍是 3。
  const indicatorText = (await desktop.locator("#indicators").textContent())?.trim() ?? "";
  assert(indicatorText.length > 0, "delivery mark must show a readable word");
  assert(indicatorText.length <= 8, `delivery word must stay short, got "${indicatorText}"`);
  await buttons.first().hover();
  await desktop.getByRole("dialog").waitFor({ state: "visible" });
  await desktop.locator("#outside").hover();
  await desktop.getByRole("dialog").waitFor({ state: "hidden" });
  await desktop.keyboard.press("Tab");
  await desktop.getByRole("dialog").waitFor({ state: "visible" });
  await desktop.keyboard.press("Escape");
  await desktop.getByRole("dialog").waitFor({ state: "hidden" });
  await buttons.first().hover();
  await desktop.mouse.down();
  await desktop.mouse.move(300, 400);
  await desktop.mouse.up();
  await desktop.getByRole("dialog").waitFor({ state: "hidden" });
  await desktop.locator("#outside").evaluate(element => { element.tabIndex = 0; element.focus(); });
  await desktop.keyboard.press("Tab");
  await desktop.getByRole("dialog").waitFor({ state: "visible" });
  await desktop.keyboard.press("Escape");
  await desktop.getByRole("dialog").waitFor({ state: "hidden" });

  await desktop.close();
  assert.deepEqual(desktopRequests, [], "unexpected desktop API requests");

  const deliveryCases = [
    { steps: {}, zh: /整场各分段合成一片/, en: /Join the whole broadcast into one file/ },
    { steps: { mergeSegments: false }, zh: /每个分段一个分 P/, en: /One part per recorded segment/ },
    { steps: { nodeSideUpload: true, burnDanmu: false, burnLivechat: false }, zh: /不可用时回退主控.*已选合并:节点可将录像分段分组合并/, en: /fall back to master if unavailable.*Merge selected: the node may combine recorded segments into groups/ },
    { steps: { nodeSideUpload: true, mergeSegments: false, burnDanmu: false, burnLivechat: false }, zh: /不可用时回退主控.*符合条件的分段各为一个分 P,短碎片可能被过滤/, en: /fall back to master if unavailable.*eligible segments become separate parts; short fragments may be filtered/ },
  ];
  for (const language of ["zh", "en"]) {
    const localized = await browser.newPage();
    await localized.addInitScript((lang) => localStorage.setItem("drec.lang", lang), language);
    const localizedRequests = await mountIndicators(localized);
    const fallbackName = language === "zh" ? /始终保留本地回退文件/ : /Always keep a local fallback file/;
    const legacyDirect = localized.locator("#indicators").getByRole("button", { name: fallbackName });
    await legacyDirect.waitFor({ state: "visible" });
    assert.equal(await legacyDirect.count(), 1);
    for (const fixture of deliveryCases) {
      await localized.evaluate((steps) => window.setIndicatorRoom({
        recording: null,
        processing: { enabled: true, pipeline: { upload: { mode: "upload" }, steps } },
      }), fixture.steps);
      const button = localized.locator("#indicators").getByRole("button", { name: fixture[language] });
      await button.waitFor({ state: "visible" });
      assert.equal(await button.count(), 1);
    }
    await localized.close();
    assert.deepEqual(localizedRequests, [], "unexpected localized API requests");
  }

  const mobile = await browser.newPage({ viewport: { width: 320, height: 740 }, hasTouch: true, isMobile: true });
  const mobileRequests = await mountIndicators(mobile);
  const trigger = mobile.locator("#indicators button").first();
  await trigger.tap();
  await mobile.getByRole("dialog").waitFor({ state: "visible" });
  await mobile.locator("#outside").tap();
  await mobile.getByRole("dialog").waitFor({ state: "hidden" });
  await trigger.tap();
  await mobile.getByRole("dialog").waitFor({ state: "visible" });
  await trigger.tap();
  await mobile.getByRole("dialog").waitFor({ state: "hidden" });
  await mobile.locator("#indicators button").last().tap();
  await mobile.getByRole("dialog").waitFor({ state: "visible" });
  await mobile.evaluate(() => window.setIndicatorRoom({
    recording: { danmu: 1, enabled: true, streamUpload: true },
    processing: { enabled: false, pipeline: { upload: { mode: "rolling" } } },
  }));
  await mobile.getByRole("dialog").waitFor({ state: "hidden" });
  await mobile.evaluate(() => window.setIndicatorRoom({
    recording: { danmu: 1, enabled: true, streamUpload: true },
    processing: { enabled: true, pipeline: { upload: { mode: "rolling" } } },
  }));
  await mobile.locator("#indicators button").nth(2).waitFor();
  await mobile.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth), 320);
  await mobile.close();
  assert.deepEqual(mobileRequests, [], "unexpected mobile API requests");
  const mobileRooms = await browser.newPage({ viewport: { width: 320, height: 740 }, hasTouch: true, isMobile: true });
  await assertMobileRoomRow(mobileRooms);
  const isolationProbe = await browser.newPage();
  const blockedRequests = await mountIndicators(isolationProbe);
  await isolationProbe.evaluate(() => fetch("/api/isolation-probe").catch(() => null));
  await isolationProbe.close();
  assert.deepEqual(blockedRequests, ["GET /api/isolation-probe"], "undeclared API request must be blocked");
  assert.throws(() => assert.deepEqual(blockedRequests, []), "unexpected requests must fail the isolation gate");
  console.log("PASS: SVG geometry all 8 marks; accessible names; hover; Tab; Escape; drag-out keyboard recovery; touch toggle/dismissal; disappearing indicator reset; 320px layout");
} finally {
  await browser.close();
}
