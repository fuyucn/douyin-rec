import { describe, it, expect } from "vitest";
import { KuaishouQrLogin } from "./kuaishou-qr-login.js";

function jsonResponse(body: Record<string, unknown>, cookies: string[] = []): Response {
  const headers = new Headers({ "content-type": "application/json" });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(JSON.stringify(body), { status: 200, headers });
}

describe("KuaishouQrLogin", () => {
  it("start 直接复用接口返回的 base64 二维码", async () => {
    const login = new KuaishouQrLogin({
      fetch: async (url) => {
        if (!String(url).includes("qr/start")) throw new Error("unexpected");
        return jsonResponse(
          { result: 1, imageData: "iVBORw0KGgo=", qrLoginToken: "token", qrLoginSignature: "sig" },
          ["did=abc; Path=/"],
        );
      },
    });
    const r = await login.start();
    expect(r.qrPng).toBe("iVBORw0KGgo=");
    await login.cancel();
  });

  it("扫描确认后完成 accept/callback/verify 并返回 cookie", async () => {
    let step = 0;
    const login = new KuaishouQrLogin({
      fetch: async (url) => {
        const u = String(url);
        if (u.includes("qr/start")) {
          return jsonResponse({ result: 1, imageData: "im", qrLoginToken: "t1", qrLoginSignature: "s1" }, ["did=abc"]);
        }
        if (u.includes("scanResult")) return jsonResponse({ result: 1 });
        if (u.includes("acceptResult")) return jsonResponse({ qrToken: "t2" });
        if (u.includes("callback")) {
          step++;
          return jsonResponse({ "kuaishou.web.cp.api.at": "at" }, ["kuaishou.web.cp.api_st=st"]);
        }
        if (u.includes("verifyToken")) {
          step++;
          return jsonResponse({ result: 1 }, ["userId=123"]);
        }
        throw new Error("unexpected " + u);
      },
    });
    await login.start();
    const r = await login.poll();
    expect(r.state).toBe("confirmed");
    expect(r.cookie).toContain("did=abc");
    expect(r.cookie).toContain("kuaishou.web.cp.api_st=st");
    expect(r.cookie).toContain("userId=123");
    expect(step).toBe(2);
  });
});
