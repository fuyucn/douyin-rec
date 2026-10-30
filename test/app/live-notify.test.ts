import { describe, expect, it } from "vitest";
import { masterNotifiesLive, roomIsLive } from "../../packages/app/src/live-notify.js";

describe("roomIsLive", () => {
  it("is live when any worker reports recording", () => {
    expect(roomIsLive(false, [{ state: "not_recording" }, { state: "recording" }])).toBe(true);
  });
  it("is not live when nobody records", () => {
    expect(roomIsLive(false, [{ state: "not_recording" }, { state: "unavailable" }])).toBe(false);
    expect(roomIsLive(false, [])).toBe(false);
  });
  it("prefers the local recorder", () => {
    expect(roomIsLive(true, [])).toBe(true);
  });
});

describe("masterNotifiesLive", () => {
  it("covers live-direct even when it runs locally", () => {
    expect(masterNotifiesLive(true, true)).toBe(true);
  });
  it("covers rooms recorded on a worker", () => {
    expect(masterNotifiesLive(false, false)).toBe(true);
    expect(masterNotifiesLive(false, true)).toBe(true);
  });
  it("leaves local file recording to the child, so it is not sent twice", () => {
    expect(masterNotifiesLive(true, false)).toBe(false);
  });
});
