import { describe, it, expect } from "vitest";
import { writeFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "../../packages/app/src/store.js";
import { MergeJobStore } from "../../packages/app/src/merge-jobs.js";

describe("MergeJobStore(SQLite 持久化)", () => {
  it("create/finish/fail/view 往返", () => {
    const db = new TaskStore(":memory:").db;
    const s = new MergeJobStore(db);
    const j = s.create(7, ["a", "b"], "/out/x_merged.mp4", "/out/x_merged.xml");
    expect(j.state).toBe("running");
    expect(s.view(j.id)).toMatchObject({ taskId: 7, state: "running", sessions: ["a", "b"], mp4: "/out/x_merged.mp4" });
    s.finish(j.id, { mp4: "/out/x_merged.mp4", xml: "/out/x_merged.xml" });
    expect(s.view(j.id)).toMatchObject({ state: "done", mp4: "/out/x_merged.mp4", xml: "/out/x_merged.xml" });
    const j2 = s.create(7, ["c"], "/out/y.mp4");
    s.fail(j2.id, "boom");
    expect(s.view(j2.id)).toMatchObject({ state: "error", error: "boom" });
    expect(s.view("nope")).toBeNull();
  });

  it("recoverOrphans:重启后 running → error + 删半截 mp4(保留行)", () => {
    const dir = mkdtempSync(join(tmpdir(), "mj_"));
    const partial = join(dir, "z_merged.mp4");
    writeFileSync(partial, "half");
    const db = new TaskStore(":memory:").db;
    const s = new MergeJobStore(db);
    const j = s.create(3, ["z"], partial); // running,mp4 指向半截文件
    expect(existsSync(partial)).toBe(true);
    const n = s.recoverOrphans();
    expect(n).toBe(1);
    expect(existsSync(partial)).toBe(false); // 半截 mp4 已删
    expect(s.view(j.id)).toMatchObject({ state: "error" }); // 标记 error,行仍在(UI 不再 404)
    expect(s.recoverOrphans()).toBe(0); // 再次启动无遗留
  });
});
