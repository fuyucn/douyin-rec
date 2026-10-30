import { describe, expect, it } from "vitest";
import { masterNotifiesLive, masterSendsTransition, roomIsLive, workerProbeUsable } from "../../packages/app/src/live-notify.js";

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

describe("masterSendsTransition", () => {
  const localFile = { local: true, streamUpload: false };
  it("gives a local file recording end back to the child (no duplicate)", () => {
    // The end tick already lost `local`: the recorder clears its flag before the process exits.
    expect(masterSendsTransition({ ...localFile, live: true }, { local: false, streamUpload: false, live: false })).toBe(false);
  });
  it("keeps live-direct and worker rooms on the master for both ends", () => {
    expect(masterSendsTransition({ live: true, local: true, streamUpload: true }, { live: false, local: true, streamUpload: true })).toBe(true);
    expect(masterSendsTransition({ live: true, local: false, streamUpload: false }, { live: false, local: false, streamUpload: false })).toBe(true);
  });
  it("decides the start from the new session, and the end from the session that ended", () => {
    const idle = { live: false, local: false, streamUpload: false };
    // Start: nothing was live before, the new local file session owns it.
    expect(masterSendsTransition(idle, { live: true, local: true, streamUpload: false })).toBe(false);
    // End of that same session: still the child's, even though `local` already dropped.
    expect(masterSendsTransition({ live: true, local: true, streamUpload: false }, idle)).toBe(false);
    // A live-direct session ending must be sent by the master in both directions.
    expect(masterSendsTransition(idle, { live: true, local: true, streamUpload: true })).toBe(true);
    expect(masterSendsTransition({ live: true, local: true, streamUpload: true }, idle)).toBe(true);
    // A worker session ending: the child is not here, so the master sends it.
    expect(masterSendsTransition({ live: true, local: false, streamUpload: false }, idle)).toBe(true);
  });
});

describe("workerProbeUsable", () => {
  it("rejects a snapshot where a worker could not answer", () => {
    expect(workerProbeUsable([{ state: "recording" }, { state: "unavailable" }])).toBe(false);
    expect(workerProbeUsable([{ state: "not_recording" }])).toBe(true);
    expect(workerProbeUsable([])).toBe(true);
  });
});
