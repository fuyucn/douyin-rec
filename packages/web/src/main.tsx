import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { applyTheme, getInitialTheme } from "./lib/theme";
import "./lib/i18n"; // 副作用:初始化 i18next(必须在 App 渲染前)
import "./index.css";

// Apply the persisted/OS theme before first paint to avoid a light→dark flash.
applyTheme(getInitialTheme());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
