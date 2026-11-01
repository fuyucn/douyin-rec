import { describe, expect, it, vi } from "vitest";
import { reportStreamUploadLedgerResult } from "./stream-upload-ledger-report.js";

function io() {
  return {
    log: vi.fn(),
    notify: vi.fn(async () => {}),
  };
}

describe("reportStreamUploadLedgerResult(issue #428)", () => {
  it("成功:只记日志,不告警", async () => {
    const io_ = io();
    await reportStreamUploadLedgerResult({ ok: true, bvid: "BV1", alreadyTerminal: false }, io_);
    expect(io_.log).toHaveBeenCalledTimes(1);
    expect(io_.log).toHaveBeenCalledWith("[直播直传] 台账已记录: BV1");
    expect(io_.notify).not.toHaveBeenCalled();
  });

  it("已终态未覆盖:日志带后缀,不告警", async () => {
    const io_ = io();
    await reportStreamUploadLedgerResult({ ok: true, bvid: "BV1", alreadyTerminal: true }, io_);
    expect(io_.log).toHaveBeenCalledWith("[直播直传] 台账已记录: BV1(已是终态,未覆盖)");
    expect(io_.notify).not.toHaveBeenCalled();
  });

  it("失败:保留日志,且走告警通道(文案与日志一致)", async () => {
    const io_ = io();
    await reportStreamUploadLedgerResult({ ok: false, error: "SQLITE_BUSY: database is locked" }, io_);
    expect(io_.log).toHaveBeenCalledWith("[直播直传] ⚠️ 台账记录失败(不影响已上传稿件): SQLITE_BUSY: database is locked");
    expect(io_.notify).toHaveBeenCalledTimes(1);
    expect(io_.notify).toHaveBeenCalledWith("[直播直传] ⚠️ 台账记录失败(不影响已上传稿件): SQLITE_BUSY: database is locked");
  });

  it("notify 抛错被吞(收尾不能因告警通道故障而失败)", async () => {
    const io_ = io();
    io_.notify.mockRejectedValueOnce(new Error("webhook down"));
    await expect(reportStreamUploadLedgerResult({ ok: false, error: "x" }, io_)).resolves.toBeUndefined();
    expect(io_.log).toHaveBeenCalledTimes(1);
  });
});
