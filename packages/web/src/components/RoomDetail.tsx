import { Pencil, Play, Square, Timer, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api, type HubJobDTO, type HubRuleDTO, type Task, type WorkerDTO } from "../api/client";
import { RunCard, JobLogDialog, runDate } from "./HubJobs";
import { Dialog } from "./Dialog";
import { Button, IconButton } from "./Button";
import { ConfirmDialog } from "./ConfirmDialog";
import { Switch } from "./Switch";
import { ExperimentalBadge } from "./ExperimentalBadge";
import { HubRuleDialog } from "../modals/HubRuleDialog";
import { errMessage, useToast, useHubStream, usePolling } from "../lib/hooks";
import { roomId } from "../lib/labels";
import { useT } from "../lib/i18n";
import type { FlowCfg } from "./flow-build";

const PAGE = 20;
const CUSTOM_DATE = "__custom__";
type TFunc = (key: string, vars?: Record<string, string | number>) => string;

function todayYmd(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 新建投稿序号:同 base key 已有 -N 则取最大 +1,否则从 -1 开始。 */
function nextSubmissionNo(baseKey: string, runs: HubJobDTO[]): number {
  const prefix = `${baseKey}-`;
  const max = runs.reduce((acc, j) => {
    const m = /-(\d+)$/.exec(j.streamKey);
    return m && j.streamKey.startsWith(prefix) ? Math.max(acc, Number(m[1])) : acc;
  }, 0);
  return max + 1;
}

/** 去掉新建投稿的 -N 后缀(不能用裸 /-\d+$/ :日期本身以 -DD 结尾)。 */
function submissionBaseKey(key: string): string {
  const m = /^(.+?:\d{4}-\d{2}-\d{2}(?:_\d{4})?)-(\d+)$/.exec(key);
  return m ? m[1] : key;
}

/** 产物 chips(plain 恒有;danmu/livechat 默认开,仅显式 false 才去掉)。 */
function outputChips(r: HubRuleDTO): string[] {
  const c = r.pipeline ?? {};
  const out = ["plain"];
  if (c.steps?.burnDanmu !== false) out.push("danmu");
  if (c.steps?.burnLivechat !== false) out.push("livechat");
  return out;
}
/** 上传模式 chip 文案。 */
function uploadChip(r: HubRuleDTO, t: TFunc): string {
  const c = r.pipeline ?? {};
  if (c.upload?.mode === "rolling") return t("hub.detail.chipUploadRolling");
  if (c.upload?.mode === "upload") return c.upload.private === false ? t("hub.detail.chipUploadPublic") : t("hub.detail.chipUploadPrivate");
  return t("hub.detail.chipStageOnly");
}

/** 右详情 pane:某直播间的房间头 + 配置/worker chips + 最近(或选中)run 完整 PipelineFlow + 运行记录列表。 */
export function RoomDetail({
  rule,
  onChanged,
  onDeleted,
}: {
  rule: HubRuleDTO;
  onChanged: () => void;
  onDeleted: () => void;
}): ReactNode {
  const t = useT();
  const toast = useToast();
  const [workers, setWorkers] = useState<WorkerDTO[]>([]);
  /**
   * 绑定的 master 录制任务(T18 动作要作用在它上面)。
   *
   * 为什么这里自己拉而不从 props 传:RoomDetail 是全页唯一的房间详情面板,
   * 上层 HubPage 并不需要任务列表;为一处动作把状态提升上去会让 HubPage 也绑上任务轮询。
   * 与 workers 同样走**慢速兜底**,不进推送热路径(listTasks 与台账无关,挂在热路径只会白打请求)。
   */
  const [tasks, setTasks] = useState<Task[]>([]);
  const [runs, setRuns] = useState<HubJobDTO[]>([]);
  const [total, setTotal] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [pages, setPages] = useState(1);
  const [logKey, setLogKey] = useState<string | null>(null);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [runOpen, setRunOpen] = useState(false);
  const [runKey, setRunKey] = useState(CUSTOM_DATE);
  const [runCustom, setRunCustom] = useState(todayYmd());
  const [runWorker, setRunWorker] = useState("");
  const [runBusy, setRunBusy] = useState(false);
  // 立即执行默认新建任务(id 自动 -1/-2),避免复用同一天旧任务导致“重试不像重试”。
  const [runNew, setRunNew] = useState(true);
  // T18 房间级**动作**。与配置(编辑弹窗)分离:动作会改运行时状态,危险的要二次确认。
  const [drainBusy, setDrainBusy] = useState(false);
  const [stopOpen, setStopOpen] = useState(false);

  const refresh = async (): Promise<void> => {
    // worker 列表与 run 列表**解耦**:run 刷新是推送驱动的热路径(每次 changed 都跑),
    // 若把 listWorkers 挂在同一个函数里,每次台账变化都会多打一个无用请求,
    // 而且它的 401 会把整次刷新变成失败 → 误报「数据可能已过期」。worker 单独慢速兜底。
    try {
      const r = await api.listHubJobs({ room: rule.key, limit: pages * PAGE, offset: 0 });
      setRuns(r.jobs);
      setTotal(r.total);
    } finally {
      setLoaded(true);
    }
  };
  // 推送驱动:run 状态变化由 /api/hub/stream 推;推送不可用自动退化为有界退避轮询。
  useHubStream(refresh);
  // 「加载更多」改 pages → 立即多拉一页(推送只在台账变化时来,不会因为本地翻页而触发)。
  const firstPageRun = useRef(true);
  useEffect(() => {
    if (firstPageRun.current) { firstPageRun.current = false; return; } // 首拉已由 useHubStream 发起
    void refresh().catch(() => {});
  }, [pages]); // eslint-disable-line react-hooks/exhaustive-deps

  /** worker 名单:独立慢速兜底(5 分钟)+ 首次加载;失败静默(workerName 本就会回落成 id)。 */
  const refreshWorkers = async (): Promise<void> => {
    try {
      setWorkers(await api.listWorkers());
    } catch {
      /* 忽略:workerName 回落展示 id */
    }
  };
  /** 任务列表:同上慢速兜底;失败静默(动作按钮会因拿不到任务而禁用,并给出说明)。 */
  const refreshTasks = async (): Promise<void> => {
    try {
      setTasks(await api.listTasks());
    } catch {
      /* 忽略:sourceTask 为 null → 动作禁用 */
    }
  };
  // usePolling 挂载即拉一次,不必再写首拉 effect(否则 mount 会双请求)。
  usePolling(() => void refreshWorkers(), 300_000);
  usePolling(() => void refreshTasks(), 300_000);

  // 稳定引用(仅 workers 变化时才换):PipelineFlow memo 用它比较,防每帧新引用击穿 memo。
  const workerName = useCallback((id: string): string => workers.find((w) => w.id === id)?.name ?? id, [workers]);
  // 展开的 run:默认最近一次(runs[0])展开;点击行展开/收起该行自己的 PipelineFlow。
  // expandedKey===null → 用默认(首条);===""(哨兵)→ 全收起;其它 → 展开那条。
  const defaultKey = runs[0]?.streamKey;
  const isExpanded = (k: string): boolean => (expandedKey === null ? k === defaultKey : k === expandedKey);
  const toggleRun = (k: string): void =>
    setExpandedKey((prev) => ((prev === null ? defaultKey : prev) === k ? "" : k));

  const toggle = async (): Promise<void> => {
    try {
      await api.updateHubRule(rule.key, { enabled: !rule.enabled });
      onChanged();
    } catch (e) {
      toast(errMessage(e), "error");
    }
  };

  /** 该房间绑定的 master 录制任务(动作都作用在它上面);未绑定 → 动作不可用。 */
  const sourceTaskId = rule.recording?.sourceTaskId ?? null;
  const sourceTask = sourceTaskId === null ? null : (tasks ?? []).find((x) => x.id === sourceTaskId) ?? null;
  const recRunning = sourceTask?.running === true;
  const recRecording = sourceTask?.recording === true;

  /**
   * 排空:停止接新场,当前这场录完自然收播(不腰斩)。
   * 与「立即停止」的区别对用户是可感知的:硬停会截断当前录像。
   */
  const doDrain = async (): Promise<void> => {
    if (sourceTaskId === null) return;
    setDrainBusy(true);
    try {
      await api.drainTask(sourceTaskId);
      toast(t("hub.detail.drained"), "info");
      await refresh();
      onChanged();
    } catch (e) {
      toast(errMessage(e), "error");
    } finally {
      setDrainBusy(false);
    }
  };

  /** 硬停:立即杀录制子进程(会截断当前分段)—— 必须二次确认。 */
  const doHardStop = async (): Promise<void> => {
    setStopOpen(false);
    if (sourceTaskId === null) return;
    try {
      await api.stopTask(sourceTaskId);
      toast(t("hub.detail.stopped"), "info");
      await refresh();
      onChanged();
    } catch (e) {
      toast(errMessage(e), "error");
    }
  };
  const doDelete = async (): Promise<void> => {
    setConfirmDelete(false);
    try {
      await api.deleteHubRule(rule.key);
      toast(t("hub.common.ruleDeleted"), "info");
      onDeleted();
    } catch (e) {
      toast(errMessage(e), "error");
    }
  };
  // 稳定引用(仅 t/toast 变化时才换):PipelineFlow memo 比较 onRetry 引用,防每帧新函数击穿 memo。
  const retryNode = useCallback(async (streamKey: string, node: string, force = false): Promise<void> => {
    try {
      await api.retryHubNode(streamKey, node, { force });
      toast(t("hub.jobs.retryNode"), "info");
    } catch (e) {
      toast(errMessage(e), "error");
    }
  }, [t, toast]);
  const stopJob = async (streamKey: string): Promise<void> => {
    try {
      await api.stopHubJob(streamKey);
      toast(t("hub.jobs.stopped"), "info");
      void refresh().catch(() => {}); // 交互后主动刷新;失败由 stale 提示呈现
    } catch (e) {
      toast(errMessage(e), "error");
    }
  };
  const runNow = async (streamKey: string, winnerWorker?: string): Promise<void> => {
    try {
      await api.runHubJob({ streamKey, winnerWorker });
      toast(t("hub.jobs.started"), "info");
      void refresh().catch(() => {}); // 交互后主动刷新;失败由 stale 提示呈现
    } catch (e) {
      toast(errMessage(e), "error");
    }
  };
  const openRun = (): void => {
    setRunKey(runs[0]?.streamKey ?? CUSTOM_DATE);
    setRunCustom(runs[0] ? runDate(runs[0].streamKey).slice(0, 10) : todayYmd());
    setRunWorker("");
    setRunNew(true);
    setRunOpen(true);
  };
  const submitRun = async (): Promise<void> => {
    const date = runCustom.trim();
    if (runKey === CUSTOM_DATE && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      toast(t("hub.jobs.runNowDateHint"), "error");
      return;
    }
    const selectedKey = runKey === CUSTOM_DATE ? `${rule.platform}:${rule.roomSlug}:${date}` : runKey;
    const baseKey = submissionBaseKey(selectedKey);
    const key = runNew ? `${baseKey}-${nextSubmissionNo(baseKey, runs)}` : selectedKey;
    setRunBusy(true);
    try {
      await runNow(key, runWorker || undefined);
      setRunOpen(false);
    } finally {
      setRunBusy(false);
    }
  };
  const nextSubmissionKey = ((): string => {
    const selectedKey = runKey === CUSTOM_DATE ? `${rule.platform}:${rule.roomSlug}:${runCustom.trim()}` : runKey;
    const baseKey = submissionBaseKey(selectedKey);
    return `${baseKey}-${nextSubmissionNo(baseKey, runs)}`;
  })();

  // 参与 worker:rule.workers 有值=选中的这些;缺省/空=全部节点。
  const participating = rule.workers && rule.workers.length > 0 ? rule.workers.map(workerName) : null;

  return (
    <>
      {/* 房间头 */}
      <div className="flex items-start justify-between gap-4 mb-6">
        <div className="min-w-0">
          <h2 className="headline text-[22px] sm:text-[24px] leading-tight truncate">
            {rule.taskName ?? rule.anchorName ?? roomId(rule.room)}
          </h2>
          <p className="text-muted-soft text-[13px] mt-1 font-mono break-all">
            {rule.taskName && rule.anchorName ? <>{rule.anchorName} · </> : null}
            {rule.platform} · {roomId(rule.room)}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button small variant="secondary" onClick={openRun}>
            <Play className="w-3.5 h-3.5" />
            {t("hub.jobs.runNow")}
          </Button>
          <Switch checked={rule.enabled} onCheckedChange={() => void toggle()} name={`hub-detail-${rule.key}`} />
          <IconButton title={t("hub.common.edit")} onClick={() => setEditOpen(true)}>
            <Pencil className="w-4 h-4" />
          </IconButton>
          <IconButton title={t("hub.common.delete")} style={{ color: "var(--error-fg)" }} onClick={() => setConfirmDelete(true)}>
            <Trash2 className="w-4 h-4" />
          </IconButton>
        </div>
      </div>

      {/* ── T18 房间动作条 ────────────────────────────────────────────────────
          动作作用在**绑定的录制任务**上(不是规则)。刻意与上面的 Switch(规则启用=是否做后处理)
          分开:两者是不同的事 —— 「停处理后」不该顺手把录制也停了,反之亦然。
          没有绑定任务时整条禁用并说明原因,而不是给一堆点了没反应的按钮。 */}
      <div className="flex flex-wrap items-center gap-2 mb-6">
        {sourceTaskId === null ? (
          <span className="text-xs text-muted">{t("hub.detail.actionsNoTask")}</span>
        ) : (
          <>
            <Button small variant="secondary" disabled={drainBusy || !recRunning} onClick={() => void doDrain()}>
              <Timer className="w-3.5 h-3.5" />
              {drainBusy ? t("hub.detail.draining") : t("hub.detail.drain")}
            </Button>
            <Button small variant="secondary" disabled={!recRunning} onClick={() => setStopOpen(true)}>
              <Square className="w-3.5 h-3.5" />
              {t("hub.detail.stopNow")}
            </Button>
            {/* 「立即处理本场」**不在这里重复**:房间头已有同名按钮(openRun,带日期/worker 选择)。
                同一个动作放两个入口只会让两处文案与确认逻辑各自漂移(自审发现,已删)。 */}
            {/* 状态提示:动作按钮的可用性依赖它,给出依据比灰按钮更好懂 */}
            <span className="text-xs text-muted ml-1">
              {recRecording
                ? t("hub.detail.stateRecording")
                : recRunning
                  ? t("hub.detail.stateWaiting")
                  : t("hub.detail.stateIdle")}
            </span>
          </>
        )}
      </div>

      {/* 硬停二次确认:会截断当前分段,必须讲清楚后果 */}
      <ConfirmDialog
        open={stopOpen}
        onCancel={() => setStopOpen(false)}
        onConfirm={() => void doHardStop()}
        title={t("hub.detail.stopConfirmTitle")}
        message={t("hub.detail.stopConfirmDesc")}
        confirmLabel={t("hub.detail.stopNow")}
        destructive
      />

      {/* 配置 + 参与 worker:并排 label+chips,无盒中盒 */}
      <div className="flex flex-wrap items-start gap-x-12 gap-y-4">
        <div>
          <div className="section-label mb-2">{t("hub.detail.pipelineConfig")}</div>
          <div className="flex flex-wrap items-center gap-1.5">
            {outputChips(rule).map((c) => (
              <span key={c} className="chip">{c}</span>
            ))}
            <span className="text-muted-soft text-xs">→</span>
            <span className="chip chip-accent">{uploadChip(rule, t)}</span>
            {/* 边录边传是实验功能:徽标挂在上传模式 chip 旁(issue #43) */}
            {rule.pipeline?.upload?.mode === "rolling" && <ExperimentalBadge id="rolling-upload" />}
            {/* 规则选了 rolling 却没生效(烧录开着 / 节点数不对):界面直接写明原因(issue #48) */}
            {rule.pipeline?.upload?.mode === "rolling" && rule.rollingPolicy && !rule.rollingPolicy.effective
              && (rule.rollingPolicy.reason === "needs-burn" || rule.rollingPolicy.reason === "multi-node") && (
              <span className="chip" title={rule.rollingPolicy.reason === "needs-burn" ? t("rooms.rollingNeedsBurn") : t("rooms.rollingMultiNodeHint")}>
                {rule.rollingPolicy.reason === "needs-burn" ? t("rooms.rollingReasonNeedsBurn") : t("rooms.rollingReasonMultiNode")}
              </span>
            )}
            {/* 在跑录制进程的启动参数落后于规则(进程常驻,启动参数不会自己变):标明「待重启生效」(issue #89) */}
            {sourceTask?.rollingPending === true && (
              <span className="chip" title={t("rooms.rollingPendingHint")}>{t("rooms.rollingPending")}</span>
            )}
          </div>
        </div>
        <div>
          <div className="section-label mb-2">{t("hub.detail.workersLabel")}</div>
          <div className="flex flex-wrap items-center gap-1.5">
            {participating === null ? (
              <span className="chip">{t("hub.detail.allWorkers")}</span>
            ) : (
              participating.map((n, i) => (
                <span key={i} className="chip">{n}</span>
              ))
            )}
          </div>
        </div>
      </div>

      {/* 运行记录列表:每条 run 可展开显示它自己的完整 PipelineFlow(默认展开最近一次) */}
      <div className="mt-6 pt-6 border-t border-hairline flex items-baseline justify-between mb-3">
        <h3 className="section-label">{t("hub.detail.runsHeading")}</h3>
        <span className="text-[12px] text-muted-soft">{t("hub.detail.totalRuns", { count: total })}</span>
      </div>
      {!loaded ? (
        <div className="py-10 text-center text-muted">{t("hub.common.loading")}</div>
      ) : runs.length === 0 ? (
        <div className="py-10 text-center text-muted-soft text-sm">{t("hub.detail.noRuns")}</div>
      ) : (
        <div className="run-list-shell divide-y divide-hairline">
          {runs.map((j) => (
            <RunCard
              key={j.streamKey}
              job={j}
              onOpenLog={setLogKey}
              workerName={workerName}
              cfg={rule.pipeline as FlowCfg}
              expanded={isExpanded(j.streamKey)}
              onToggle={toggleRun}
              onRetry={retryNode}
              onStop={stopJob}
              onRunNow={(key) => void runNow(key)}
            />
          ))}
          {runs.length < total && (
            <div className="text-center pt-2">
              <Button small variant="secondary" onClick={() => setPages((p) => p + 1)}>
                {t("hub.detail.loadMore", { count: total - runs.length })}
              </Button>
            </div>
          )}
        </div>
      )}

      <HubRuleDialog open={editOpen} onClose={() => setEditOpen(false)} rule={rule} onSaved={() => { onChanged(); void refresh().catch(() => {}); }} />
      <JobLogDialog logKey={logKey} onClose={() => setLogKey(null)} />
      <Dialog
        open={runOpen}
        onClose={() => !runBusy && setRunOpen(false)}
        title={t("hub.jobs.runNowTitle")}
        description={t("hub.jobs.runNowDesc")}
      >
        <div className="flex flex-col gap-4">
          <div>
            <label className="field-label">{t("hub.jobs.runNowDate")}</label>
            <select className="input" value={runKey} onChange={(e) => setRunKey(e.target.value)}>
              {runs.map((j) => (
                <option key={j.streamKey} value={j.streamKey}>{runDate(j.streamKey)}</option>
              ))}
              <option value={CUSTOM_DATE}>{t("hub.jobs.runNowCustom")}</option>
            </select>
          </div>
          {runKey === CUSTOM_DATE && (
            <div>
              <label className="field-label">{t("hub.jobs.runNowDateHint")}</label>
              <input className="input" value={runCustom} onChange={(e) => setRunCustom(e.target.value)} placeholder={todayYmd()} />
            </div>
          )}
          <div>
            <label className="field-label">{t("hub.jobs.runNowMode")}</label>
            <select className="input" value={runNew ? "new" : "resume"} onChange={(e) => setRunNew(e.target.value === "new")}>
              <option value="resume">{t("hub.jobs.runNowResume")}</option>
              <option value="new">{t("hub.jobs.runNowNew")}</option>
            </select>
          </div>
          {runNew && <p className="text-[12px] text-muted-soft">{t("hub.jobs.runNowNewHint", { key: nextSubmissionKey })}</p>}
          <div>
            <label className="field-label">{t("hub.jobs.runNowWorker")}</label>
            <select className="input" value={runWorker} onChange={(e) => setRunWorker(e.target.value)}>
              <option value="">{t("hub.jobs.runNowWorkerAuto")}</option>
              {(rule.workers && rule.workers.length > 0 ? workers.filter((w) => rule.workers!.includes(w.id)) : workers).map((w) => (
                <option key={w.id} value={w.id}>{w.name || w.id}</option>
              ))}
            </select>
          </div>
          <div className="flex justify-end gap-3">
            <Button type="button" variant="secondary" disabled={runBusy} onClick={() => setRunOpen(false)}>
              {t("hub.common.cancel")}
            </Button>
            <Button type="button" loading={runBusy} disabled={runBusy} onClick={() => void submitRun()}>
              {t("hub.jobs.runNow")}
            </Button>
          </div>
        </div>
      </Dialog>
      <ConfirmDialog
        open={confirmDelete}
        title={t("hub.common.deleteRuleConfirmTitle")}
        confirmLabel={t("hub.common.delete")}
        destructive
        onConfirm={() => void doDelete()}
        onCancel={() => setConfirmDelete(false)}
      />
    </>
  );
}
