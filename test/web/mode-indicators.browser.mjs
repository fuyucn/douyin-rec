import assert from "node:assert/strict";
import { chromium } from "playwright";

const baseUrl = process.env.MODE_ICONS_BASE_URL ?? "http://localhost:18766";
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
});

async function mountIndicators(page) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.evaluate(async () => {
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
}

try {
  const desktop = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await mountIndicators(desktop);
  const buttons = desktop.locator("#indicators button");
  assert.equal(await buttons.count(), 3);
  assert.equal(await desktop.locator("#indicators").textContent(), "");
  const names = await buttons.evaluateAll(elements => elements.map(element => element.getAttribute("aria-label")));
  assert(names.every(name => name && !name.includes("room.")));
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

  const mobile = await browser.newPage({ viewport: { width: 320, height: 740 }, hasTouch: true, isMobile: true });
  await mountIndicators(mobile);
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
  console.log("PASS: accessible names; hover; Tab; Escape; drag-out keyboard recovery; touch toggle/dismissal; disappearing indicator reset; 320px layout");
} finally {
  await browser.close();
}
