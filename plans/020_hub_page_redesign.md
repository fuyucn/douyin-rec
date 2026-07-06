# Hub 页面重构(master-detail + Workers 浮层) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hub 页从两张堆叠表格重构为 master-detail(左房间列表+右详情)+ Workers 浮层,建立清晰层次;保留 /hub/:key deep-link;右详情复用完整 PipelineFlow 图。

**Architecture:** HubPage 改左列表+右 RoomDetail;RoomDetail 并入 HubDetailPage 内容(配置卡+PipelineFlow 完整图+RunCard 列表)、/hub/:key 与 /hub 共用;WorkersCard → 顶栏 pill 开关的滑入浮层。纯前端,复用现有组件/轮询/i18n,不新增配色。

**Tech Stack:** Vite + React19 + jotai + @base-ui/react + Tailwind v4 + lucide + react-i18next + react-router + @xyflow/react。

## Global Constraints

- **纯前端零后端改动**:不碰 `packages/app`/`packages/core`/REST/DTO;只改 `packages/web/src`。
- **保留 `/hub/:key` deep-link**:选左侧房间 → `navigate('/hub/{key}')` 更新 URL;直达 `/hub/:key` → 该房间选中;`/hub`(无 key)→ 默认选中第一个房间(无房间则空态)。用现有 react-router。
- **右详情复用现有 `PipelineFlow`**(不重写 React Flow):`HubJobs.tsx` 里 `PipelineFlow` 改为 `export`,RoomDetail 直接渲染最近一次(或选中)run 的完整 fork/join 图。
- **复用不重写**:`RunCard`/`JobLogDialog`/`LatestRunBadge`(HubJobs.tsx)、`HubRuleDialog`、`WorkerDialog`、`Switch`、`ConfirmDialog`、`Button`/`IconButton`、worker 实时 status 轮询、i18n `hub` 词典组。对 `RunCard` 仅做**加性**改动(新增可选 props,默认行为不变),不改其内部实现。
- **i18n**:新增文案 `zh`+`en` 两边对称加(`packages/web/src/lib/i18n.tsx` 的 `DICT.zh.hub.*` 与 `DICT.en.hub.*`)。值里用单花括号 `{var}` 占位。
- **视觉**:沿用现有暗色 Cal.com token(`--canvas/--surface/--surface-soft/--hairline/--ink/--muted/--muted-soft/--success/--error/--warning`),**不新增配色**。层次靠布局 + 卡片 accent 竖条 + 分区标签。运行中状态沿用现有 pulse/marching-ants。
- **窄屏堆叠**(< ~820px:master-detail 上下堆叠);**宽内容**(graph)自身 `overflow-x:auto`,页面不横向滚。
- **hubEnabled/slave 分支照旧**:`hubEnabled === false` 时仍渲染现有 child-node 提示(不显示 master 版 Hub 页)。
- **无 vitest** → 验证 = `cd packages/web && rtk proxy pnpm build` 绿 + 根 `rtk proxy pnpm typecheck` 0 + 每任务手动清单。
- **commit** 约定式:`<type>(<scope>): 中文描述`,scope 用 `web`;正文 bullet points;**不加** AI 署名 trailer、不加 `Claude-Session`。

## 关键既有事实(实现者须知,已核对源码)

- 路由在 `packages/web/src/App.tsx`:`<Route path="/hub" element={<HubPage />} />` + `<Route path="/hub/:key" element={<HubDetailPage />} />`。改后两条都指向 `HubPage`。
- `usePolling(fn: () => void, ms: number, enabled = true): void`(`packages/web/src/lib/hooks.ts`)—— 立即跑一次再每 `ms` 跑,`enabled=false` 完全不跑。
- `api.listHubRules(): Promise<HubRuleDTO[]>`、`api.listHubJobs({room?, limit?, offset?}): Promise<{jobs: HubJobDTO[]; total: number}>`、`api.listWorkers(): Promise<WorkerDTO[]>`、`api.getWorkersStatus(): Promise<WorkerStatus[]>`、`api.updateHubRule(key, {enabled})`、`api.deleteHubRule(key)`、`api.deleteWorker(id)`(`packages/web/src/api/client.ts`)。
- DTO 字段(`packages/core/src/api-types.ts`):
  - `HubRuleDTO { key; roomSlug; room; platform; enabled; pipeline: HubPipelineConfig; workers?: string[]; anchorName?: string | null }`。
  - `HubJobDTO { streamKey; state; winnerWorker; bv; error; fails; ...; events; steps; currentStepSec; etaSec; videoDurationSec; hasLog }`。
  - `WorkerDTO { id; name; kind; host?; dataRoot?; apiUrl? }`;`WorkerStatus { id; ok; error? }`。
- `roomId(room: string): string`(`packages/web/src/lib/labels.ts`)—— web_rid 纯数字。
- 组件签名:`Switch({checked,onCheckedChange,name?,disabled?,id?})`、`HubRuleDialog({open,onClose,rule:HubRuleDTO|null,onSaved})`、`WorkerDialog({open,onClose,worker:WorkerDTO|null,onSaved})`、`ConfirmDialog({open,title,message?,confirmLabel?,cancelLabel?,destructive?,onConfirm,onCancel})`、`RunCard({job,onOpenLog,workerName?})`、`JobLogDialog({logKey,onClose})`、`LatestRunBadge({run})`。
- CSS 可复用:`.card`(圆角+hairline 边)、`.dot`(7px 圆点)、`.tasks`(表格)、`.modal-backdrop`(`position:fixed;inset:0;z-index:100;background:rgba(17,17,17,.45);blur`)、`.modal-positioner`(z-101)、`.flow-node-active`(脉冲)。
- 现有 `summarize(r, t)`(HubDetailPage 版,`upload.mode !== "upload"` → `stageOnlySuffix`)——RoomDetail 用这个语义。

---

## Task 1 — master-detail 外壳 + 路由 + 右详情(RoomDetail)

把 `HubPage` 重构成「左房间列表 + 右详情 pane」的 master-detail 外壳;新建 `RoomDetail` 组件承接原 `HubDetailPage` 的全部内容(房间头 + 配置/参与-worker chips + 完整 PipelineFlow + RunCard 运行记录列表);`/hub/:key` 与 `/hub` 共用 `HubPage`(按 URL param 选中);删除独立的 `HubDetailPage`。本任务**保留 `<WorkersCard />` 原样渲染在外壳内**(Task 2 才移入浮层),确保每步 build 后仍功能完整。

### Files
- **Modify** `packages/web/src/components/HubJobs.tsx`(`PipelineFlow` 加 `export`;`RunCard` 加可选 props `hideGraph`/`selected`/`onSelect`,默认行为不变)。
- **Create** `packages/web/src/components/RoomDetail.tsx`(右详情 pane 组件)。
- **Modify** `packages/web/src/pages/HubPage.tsx`(重构为 master-detail 外壳)。
- **Modify** `packages/web/src/App.tsx`(`/hub/:key` 路由改指 `HubPage`;删 `HubDetailPage` import)。
- **Delete** `packages/web/src/pages/HubDetailPage.tsx`(内容已并入 `RoomDetail`)。
- **Modify** `packages/web/src/lib/i18n.tsx`(`DICT.zh.hub` + `DICT.en.hub` 新增 detail/page 文案)。

### Interfaces
- Produces `PipelineFlow`(newly exported):`function PipelineFlow({ job }: { job: HubJobDTO }): ReactNode`。
- Produces `RunCard`(扩展签名,加性):
  ```ts
  export function RunCard({
    job,
    onOpenLog,
    workerName,
    hideGraph,          // 新:true = 不渲染内嵌 PipelineFlow(列表精简版,图在上方单独渲染)
    selected,           // 新:true = 选中态高亮边
    onSelect,           // 新:给定则整卡可点,点击回传 job.streamKey(切换上方图)
  }: {
    job: HubJobDTO;
    onOpenLog: (key: string) => void;
    workerName?: (id: string) => string;
    hideGraph?: boolean;
    selected?: boolean;
    onSelect?: (streamKey: string) => void;
  }): ReactNode
  ```
- Produces `RoomDetail`:
  ```ts
  export function RoomDetail({
    rule,          // 选中房间的规则(父层已从 listHubRules 拿到)
    onChanged,     // 规则被 toggle/编辑保存后 → 父层重拉 rules/jobs
    onDeleted,     // 规则被删除后 → 父层 navigate('/hub')
  }: {
    rule: HubRuleDTO;
    onChanged: () => void;
    onDeleted: () => void;
  }): ReactNode
  ```
- Consumes:`api.listHubJobs`/`api.listWorkers`/`api.updateHubRule`/`api.deleteHubRule`、`usePolling`、`PipelineFlow`/`RunCard`/`JobLogDialog`、`HubRuleDialog`、`ConfirmDialog`、`Switch`、`roomId`、`useT`。

### Steps

- [ ] **1.1 — `HubJobs.tsx`:导出 `PipelineFlow`。** 把第 135 行 `function PipelineFlow(` 改为 `export function PipelineFlow(`。其余不动。
- [ ] **1.2 — `HubJobs.tsx`:`RunCard` 加性扩展。** 用真实代码替换 `RunCard` 的签名与外层容器(内部时间线/元信息/PipelineFlow 逻辑保持,仅按 `hideGraph` 条件渲染图、外层加可点/选中态):
  ```tsx
  export function RunCard({
    job,
    onOpenLog,
    workerName,
    hideGraph,
    selected,
    onSelect,
  }: {
    job: HubJobDTO;
    onOpenLog: (key: string) => void;
    workerName?: (id: string) => string;
    hideGraph?: boolean;
    selected?: boolean;
    onSelect?: (streamKey: string) => void;
  }): ReactNode {
    const t = useT();
    const labels = stepLabelMap(t);
    return (
      <div
        className={`rounded-lg border p-3${onSelect ? " cursor-pointer transition-colors" : ""}`}
        style={{
          borderColor: selected ? "var(--ink)" : "var(--hairline)",
          background: selected ? "var(--surface-soft)" : undefined,
        }}
        onClick={onSelect ? () => onSelect(job.streamKey) : undefined}
      >
        <div className="flex items-center justify-between gap-2 mb-2">
          {/* … 保持现有:runDate + 状态行 + spinner + currentStepSec + etaSec … */}
          {job.hasLog && (
            <IconButton
              title={t("hub.jobs.viewLog")}
              onClick={(e) => {
                e.stopPropagation();       // 点日志按钮不触发选中
                onOpenLog(job.streamKey);
              }}
            >
              <FileText className="w-4 h-4" />
            </IconButton>
          )}
        </div>
        {!hideGraph && <PipelineFlow job={job} />}
        {/* … 保持现有:winner/duration/retries/bv 元信息行 + error 行 … */}
      </div>
    );
  }
  ```
  注意:① 现有 `onOpenLog` 的 `onClick={() => onOpenLog(job.streamKey)}` 必须换成 `(e) => { e.stopPropagation(); onOpenLog(job.streamKey); }`(否则点日志会连带选中);② 状态行/元信息区块原样保留(照抄现有 JSX),只是外层容器与 graph 渲染变了。默认 `hideGraph`/`onSelect` 皆 undefined → 老调用点(其它页面若有)行为不变。
- [ ] **1.3 — i18n:新增 detail chip + page 文案(zh)。** 在 `DICT.zh.hub.detail` 里追加(与现有 `pipelineConfig/runsHeading/totalRuns/noRuns/loadMore` 并列):
  ```ts
  workersLabel: "参与 Worker", allWorkers: "全部节点",
  chipUploadPrivate: "上传(私)", chipUploadPublic: "上传(公开)", chipStageOnly: "仅合成",
  noRunGraph: "尚无运行(录制并收播后自动产生流程图)。",
  ```
  在 `DICT.zh.hub.page` 里追加:
  ```ts
  roomsHeading: "直播间", selectRoomHint: "从左侧选择一个直播间查看运行记录。",
  ```
- [ ] **1.4 — i18n:对称补 en。** 在 `DICT.en.hub.detail` 追加:
  ```ts
  workersLabel: "Participating workers", allWorkers: "All nodes",
  chipUploadPrivate: "Upload (private)", chipUploadPublic: "Upload (public)", chipStageOnly: "Stage only",
  noRunGraph: "No runs yet (a pipeline graph appears automatically after recording ends).",
  ```
  在 `DICT.en.hub.page` 追加:
  ```ts
  roomsHeading: "Rooms", selectRoomHint: "Select a room on the left to view its run history.",
  ```
- [ ] **1.5 — 新建 `RoomDetail.tsx`(承接 HubDetailPage 内容,右 pane 版)。** 写整个文件(真实代码):
  ```tsx
  import { Pencil, Trash2 } from "lucide-react";
  import { useState, type ReactNode } from "react";
  import { api, type HubJobDTO, type HubRuleDTO, type WorkerDTO } from "../api/client";
  import { PipelineFlow, RunCard, JobLogDialog } from "./HubJobs";
  import { Button, IconButton } from "./Button";
  import { ConfirmDialog } from "./ConfirmDialog";
  import { Switch } from "./Switch";
  import { HubRuleDialog } from "../modals/HubRuleDialog";
  import { errMessage, useToast, usePolling } from "../lib/hooks";
  import { roomId } from "../lib/labels";
  import { useT } from "../lib/i18n";

  const PAGE = 20;
  type TFunc = (key: string, vars?: Record<string, string | number>) => string;

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
    if (c.upload?.mode === "upload") return c.upload.private === false ? t("hub.detail.chipUploadPublic") : t("hub.detail.chipUploadPrivate");
    return t("hub.detail.chipStageOnly");
  }

  const chipCls = "inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-mono";
  const chipStyle = { background: "var(--surface-soft)", color: "var(--body)", border: "1px solid var(--hairline)" } as const;

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
    const [runs, setRuns] = useState<HubJobDTO[]>([]);
    const [total, setTotal] = useState(0);
    const [loaded, setLoaded] = useState(false);
    const [pages, setPages] = useState(1);
    const [logKey, setLogKey] = useState<string | null>(null);
    const [selectedRunKey, setSelectedRunKey] = useState<string | null>(null);
    const [editOpen, setEditOpen] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(false);

    const refresh = async (): Promise<void> => {
      try {
        setWorkers(await api.listWorkers());
      } catch {
        /* 忽略:workerName 回落展示 id */
      }
      try {
        const r = await api.listHubJobs({ room: rule.key, limit: pages * PAGE, offset: 0 });
        setRuns(r.jobs);
        setTotal(r.total);
      } catch {
        /* 轮询重试 */
      } finally {
        setLoaded(true);
      }
    };
    const anyActive = runs.some((j) => !["done", "failed", "needs_manual"].includes(j.state));
    // 有进行中 run → 3s;空闲 5s(与原 HubDetailPage 一致,避免像「没实时更新」)。
    usePolling(() => void refresh(), anyActive ? 3000 : 5000);

    const workerName = (id: string): string => workers.find((w) => w.id === id)?.name ?? id;
    // 选中的 run(点列表切换);默认最近一次(runs[0])。
    const selectedRun = runs.find((j) => j.streamKey === selectedRunKey) ?? runs[0];

    const toggle = async (): Promise<void> => {
      try {
        await api.updateHubRule(rule.key, { enabled: !rule.enabled });
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

    // 参与 worker:rule.workers 有值=选中的这些;缺省/空=全部节点。
    const participating = rule.workers && rule.workers.length > 0 ? rule.workers.map(workerName) : null;

    return (
      <>
        {/* 房间头 */}
        <div className="flex items-start justify-between gap-4 mb-5">
          <div className="min-w-0">
            <h2 className="headline text-[22px] sm:text-[24px] leading-tight truncate">
              {rule.anchorName ?? roomId(rule.room)}
            </h2>
            <p className="text-muted text-sm mt-1 font-mono break-all">{rule.platform} · {roomId(rule.room)}</p>
          </div>
          <div className="flex items-center gap-2.5 shrink-0">
            <Switch checked={rule.enabled} onCheckedChange={() => void toggle()} name={`hub-detail-${rule.key}`} />
            <IconButton title={t("hub.common.edit")} onClick={() => setEditOpen(true)}>
              <Pencil className="w-4 h-4" />
            </IconButton>
            <IconButton title={t("hub.common.delete")} style={{ color: "var(--error)" }} onClick={() => setConfirmDelete(true)}>
              <Trash2 className="w-4 h-4" />
            </IconButton>
          </div>
        </div>

        {/* 配置 + 参与 worker chips */}
        <div className="card p-4 mb-6 space-y-3">
          <div>
            <div className="text-xs font-semibold text-ink mb-2">{t("hub.detail.pipelineConfig")}</div>
            <div className="flex flex-wrap items-center gap-1.5">
              {outputChips(rule).map((c) => (
                <span key={c} className={chipCls} style={chipStyle}>{c}</span>
              ))}
              <span className="text-muted-soft text-xs">→</span>
              <span className={chipCls} style={chipStyle}>{uploadChip(rule, t)}</span>
            </div>
          </div>
          <div>
            <div className="text-xs font-semibold text-ink mb-2">{t("hub.detail.workersLabel")}</div>
            <div className="flex flex-wrap items-center gap-1.5">
              {participating === null ? (
                <span className={chipCls} style={chipStyle}>{t("hub.detail.allWorkers")}</span>
              ) : (
                participating.map((n, i) => (
                  <span key={i} className={chipCls} style={chipStyle}>{n}</span>
                ))
              )}
            </div>
          </div>
        </div>

        {/* 最近(或选中)run 的完整 PipelineFlow */}
        {selectedRun ? (
          <div className="card p-3 mb-6 overflow-x-auto">
            <PipelineFlow job={selectedRun} />
          </div>
        ) : (
          loaded && (
            <div className="card p-8 mb-6 text-center text-muted text-sm">{t("hub.detail.noRunGraph")}</div>
          )
        )}

        {/* 运行记录列表(精简:不重复画图,点某条切上方图) */}
        <div className="flex items-baseline justify-between mb-3">
          <h3 className="text-sm font-semibold text-ink">{t("hub.detail.runsHeading")}</h3>
          <span className="text-[12px] text-muted-soft">{t("hub.detail.totalRuns", { count: total })}</span>
        </div>
        {!loaded ? (
          <div className="card p-10 text-center text-muted">{t("hub.common.loading")}</div>
        ) : runs.length === 0 ? (
          <div className="card p-10 text-center text-muted text-sm">{t("hub.detail.noRuns")}</div>
        ) : (
          <div className="space-y-3">
            {runs.map((j) => (
              <RunCard
                key={j.streamKey}
                job={j}
                onOpenLog={setLogKey}
                workerName={workerName}
                hideGraph
                selected={j.streamKey === (selectedRun?.streamKey ?? "")}
                onSelect={setSelectedRunKey}
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

        <HubRuleDialog open={editOpen} onClose={() => setEditOpen(false)} rule={rule} onSaved={() => { onChanged(); void refresh(); }} />
        <JobLogDialog logKey={logKey} onClose={() => setLogKey(null)} />
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
  ```
  说明:pagination `pages` 变化后 `usePolling` 会用新 `limit` 重拉(refresh 闭包读最新 `pages`,`usePolling` 用 ref 持最新 fn)。`selectedRunKey` 换房间时不自动清空——但父层给每个房间不同 `key` 的 `RoomDetail`(见 1.6,用 `key={rule.key}` 强制重挂载),故切房间即重置所有本地 state。
- [ ] **1.6 — 重构 `HubPage.tsx`(master-detail 外壳)。** 全量替换文件为(真实代码,保留 `hubEnabled===false` 分支、rules+jobs 轮询、`runsOf`、新建规则、删除确认):
  ```tsx
  import { Plus, Radio } from "lucide-react";
  import { useState, type ReactNode } from "react";
  import { useNavigate, useParams } from "react-router-dom";
  import { useAtomValue } from "jotai";
  import { api, type HubRuleDTO, type HubJobDTO } from "../api/client";
  import { hubEnabledAtom } from "../atoms";
  import { Button } from "../components/Button";
  import { LatestRunBadge } from "../components/HubJobs";
  import { RoomDetail } from "../components/RoomDetail";
  import { WorkersCard } from "../components/WorkersCard";
  import { HubRuleDialog } from "../modals/HubRuleDialog";
  import { usePolling } from "../lib/hooks";
  import { roomId } from "../lib/labels";
  import { useT } from "../lib/i18n";
  import { Network } from "lucide-react";

  /** Hub 管理页(/hub 与 /hub/:key 共用):左房间列表 + 右详情(RoomDetail)。 */
  export function HubPage(): ReactNode {
    const t = useT();
    const hubEnabled = useAtomValue(hubEnabledAtom);
    const { key } = useParams<{ key?: string }>();
    const navigate = useNavigate();
    const [rules, setRules] = useState<HubRuleDTO[]>([]);
    const [jobs, setJobs] = useState<HubJobDTO[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [dialogOpen, setDialogOpen] = useState(false);

    const refresh = async (): Promise<void> => {
      try {
        setRules(await api.listHubRules());
      } catch {
        /* 静默:轮询会重试 */
      } finally {
        setLoaded(true);
      }
      try {
        setJobs((await api.listHubJobs()).jobs);
      } catch {
        /* 忽略 */
      }
    };
    usePolling(() => void refresh(), 3000);

    /** 某规则(房间)的历次 run,新→旧:streamKey 前缀 `{platform}:{roomSlug}:` 匹配。 */
    const runsOf = (r: HubRuleDTO): HubJobDTO[] => {
      const prefix = `${r.platform}:${r.roomSlug}:`;
      return jobs.filter((j) => j.streamKey.startsWith(prefix));
    };

    // 本节点不是 master(未启用 hub)→ child-node 提示(原样保留)。
    if (hubEnabled === false) {
      return (
        <div className="card p-10 flex flex-col items-center gap-4 text-center">
          <Network className="w-10 h-10" style={{ color: "var(--muted-soft)" }} />
          <h1 className="headline text-[22px]">{t("hub.page.childTitle")}</h1>
          <p className="text-muted text-sm max-w-md">
            {t("hub.page.childDesc1")}<code>task serve</code>{t("hub.page.childDesc2")}<code>--hub</code>
            {t("hub.page.childDesc3")}<b>{t("hub.page.childMaster")}</b>{t("hub.page.childDesc4")}
          </p>
        </div>
      );
    }

    // 选中房间:URL param 命中则用之,否则默认第一个。
    const selectedKey = key && rules.some((r) => r.key === key) ? key : rules[0]?.key;
    const selectedRule = rules.find((r) => r.key === selectedKey) ?? null;
    const selectRoom = (r: HubRuleDTO): void => navigate(`/hub/${encodeURIComponent(r.key)}`);

    return (
      <>
        <div className="flex items-end justify-between gap-3 mb-6">
          <div>
            <h1 className="headline text-[28px] sm:text-[32px] leading-tight">{t("hub.page.title")}</h1>
            <p className="text-muted text-sm mt-1.5">{t("hub.page.subtitle")}</p>
          </div>
          <Button onClick={() => setDialogOpen(true)}>
            <Plus className="w-4 h-4" />
            {t("hub.page.newRule")}
          </Button>
        </div>

        {/* Task 2 会把 WorkersCard 移入浮层;本任务先原样保留,保功能不断。 */}
        <WorkersCard />

        {loaded && rules.length === 0 ? (
          <section className="card p-16">
            <div className="flex flex-col items-center gap-4 text-muted">
              <Radio className="w-10 h-10" style={{ color: "var(--muted-soft)" }} />
              <div className="text-sm font-medium text-ink">{t("hub.page.noRules")}</div>
              <Button small onClick={() => setDialogOpen(true)}>{t("hub.page.newRule")}</Button>
            </div>
          </section>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-[288px_1fr] gap-6 items-start">
            {/* 左:房间列表 */}
            <aside className="card p-2 space-y-1">
              <div className="px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-soft">
                {t("hub.page.roomsHeading")}
              </div>
              {!loaded && <div className="px-2 py-3 text-sm text-muted">{t("hub.common.loading")}</div>}
              {rules.map((r) => {
                const active = r.key === selectedKey;
                return (
                  <button
                    key={r.key}
                    onClick={() => selectRoom(r)}
                    className="w-full text-left rounded-lg px-3 py-2.5 flex flex-col gap-1 transition-colors"
                    style={{
                      borderLeft: `3px solid ${active ? "var(--ink)" : "transparent"}`,
                      background: active ? "var(--surface-soft)" : "transparent",
                      opacity: r.enabled ? 1 : 0.55,
                    }}
                  >
                    <div className="min-w-0">
                      {r.anchorName ? (
                        <>
                          <div className="font-medium text-ink truncate">{r.anchorName}</div>
                          <div className="font-mono text-[11px] text-muted-soft mt-0.5 truncate">{roomId(r.room)}</div>
                        </>
                      ) : (
                        <div className="font-mono text-[13px] font-medium text-ink truncate">{roomId(r.room)}</div>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="dot" style={{ background: r.enabled ? "var(--success)" : "var(--muted-soft)" }} />
                      <LatestRunBadge run={runsOf(r)[0]} />
                    </div>
                  </button>
                );
              })}
            </aside>

            {/* 右:选中房间详情 */}
            <section className="min-w-0">
              {selectedRule ? (
                <RoomDetail
                  key={selectedRule.key}
                  rule={selectedRule}
                  onChanged={() => void refresh()}
                  onDeleted={() => navigate("/hub")}
                />
              ) : (
                <div className="card p-16 text-center text-muted text-sm">{t("hub.page.selectRoomHint")}</div>
              )}
            </section>
          </div>
        )}

        <HubRuleDialog open={dialogOpen} onClose={() => setDialogOpen(false)} rule={null} onSaved={() => void refresh()} />
      </>
    );
  }
  ```
  说明:① `key={selectedRule.key}` 让切房间时 `RoomDetail` 重挂载 → 本地 state(selectedRunKey/pages/runs)自动重置;② `onDeleted={() => navigate("/hub")}` → URL 回到 `/hub` → selectedKey 落回 rules[0](删掉的那条已从下一次 refresh 移除);③ 左列表 button 用 `<button>`(可点、a11y),active 用 accent 竖条 + surface 高亮,disabled(暂停)整卡降透明度 —— 完全对齐 spec。
- [ ] **1.7 — `App.tsx`:路由改指 + 删 HubDetailPage import。** 删掉 `import { HubDetailPage } from "./pages/HubDetailPage";`,把 `<Route path="/hub/:key" element={<HubDetailPage />} />` 改为 `<Route path="/hub/:key" element={<HubPage />} />`(`/hub` 那行不变)。
- [ ] **1.8 — 删除 `packages/web/src/pages/HubDetailPage.tsx`。** 内容已并入 `RoomDetail`;确认无其它文件 import 它:`rtk proxy grep -rn "HubDetailPage" packages/web/src`(应仅剩已改的 App.tsx 无引用)。若 grep 命中残留 import,一并清掉。
- [ ] **1.9 — build + typecheck gate。** 依次跑:
  ```
  cd packages/web && rtk proxy pnpm build
  ```
  再回根:
  ```
  rtk proxy pnpm typecheck
  ```
  两者都必须 0 error。常见坑:`RunCard` 新 props 的 `onClick` 事件类型、`selectedRun` 可能 undefined 时 `selected` 传值(用 `selectedRun?.streamKey ?? ""` 已处理)。
- [ ] **1.10 — 手动清单(启动服务本地验证)。** 启动:`node dist/douyin-rec.mjs task serve --port 7860 --hub`(需先 `pnpm bundle` + `cd packages/web && pnpm build`;master 模式才显示 Hub 页)。逐条核对:
  - [ ] `/hub` 打开 → 左列表出现房间、右详情默认选中**第一个**房间。
  - [ ] 点左侧某房间 → URL 变为 `/hub/{platform}.{roomSlug}` + 右详情切到该房间。
  - [ ] 浏览器直达 `/hub/{key}`(粘贴 URL 回车)→ 对应房间**选中态**(左侧 accent 竖条)+ 右详情正确。
  - [ ] 右详情顶部渲染**最近一次 run 的完整 PipelineFlow**(fork/join 图、进行中节点脉冲/连线动画)。
  - [ ] 运行记录列表点某条 run → 上方 graph 切到该 run(选中卡高亮);点日志图标弹 JobLogDialog(不触发选中)。
  - [ ] 房间头 Switch 切启用/暂停即时生效;编辑(HubRuleDialog)保存后详情刷新;删除(ConfirmDialog)确认后 URL 回 `/hub` 且选中落到第一个房间。
  - [ ] 无规则时:整页空态 + 「新建规则」。某房间无 run 时:右侧显示「尚无运行」文案(不渲染空 graph)+ 运行记录「该直播间还没有…」。
  - [ ] 窄屏(< 820px):master-detail 变上下堆叠(左列表在上、详情在下);graph 宽时自身横向滚,页面不横向滚。
  - [ ] 顶栏语言切 zh/en:新加的 chips/参与 worker/rooms 标题/空态提示两语都正确、无 raw key。
- [ ] **1.11 — commit。** 只 add 本任务涉及文件:
  ```
  git add packages/web/src/pages/HubPage.tsx packages/web/src/pages/HubDetailPage.tsx packages/web/src/components/RoomDetail.tsx packages/web/src/components/HubJobs.tsx packages/web/src/App.tsx packages/web/src/lib/i18n.tsx
  git commit -m "$(cat <<'EOF'
  refactor(web): Hub 页改 master-detail(左房间列表 + 右详情)

  - HubPage 重构为左房间列表 + 右 RoomDetail 详情 pane;/hub 与 /hub/:key 共用同一组件,按 URL param 选中(默认第一个房间)
  - 新增 RoomDetail 组件承接原 HubDetailPage 内容:房间头(启用 Switch/编辑/删除)+ 配置/参与-worker chips + 最近 run 完整 PipelineFlow + RunCard 运行记录列表(点某条切上方图)
  - HubJobs 导出 PipelineFlow;RunCard 加性支持 hideGraph/selected/onSelect(默认行为不变)
  - 删除独立 HubDetailPage;i18n hub.detail/hub.page 新增文案(zh+en)
  EOF
  )"
  ```

---

## Task 2 — Workers 浮层(顶栏 pill + 滑入 overlay)

把 `WorkersCard` 内容移入 `WorkersPanel`(从右滑入的 overlay:scrim + Esc + scrim 点击关闭);顶栏加「Workers · N」pill 按钮(带健康点,复用实时 `getWorkersStatus`)控制开关。为让 pill 关闭时也显示健康状态,把 workers 列表 + status 轮询**提升到 HubPage**(单一来源、按 hubEnabled 门控),`WorkersPanel` 变纯展示 + 自持增删改弹窗。

### Files
- **Create** `packages/web/src/components/WorkersPanel.tsx`(滑入浮层,承接 WorkersCard 内容)。
- **Delete** `packages/web/src/components/WorkersCard.tsx`(内容已迁入 WorkersPanel;确认无其它引用)。
- **Modify** `packages/web/src/pages/HubPage.tsx`(移除 `<WorkersCard />`;新增 workers/status 轮询 + 顶栏 pill + WorkersPanel 挂载与开关 state)。
- **Modify** `packages/web/src/lib/i18n.tsx`(`hub.workers` 新增 pill/close 文案 zh+en)。

### Interfaces
- Produces `WorkersPanel`:
  ```ts
  export function WorkersPanel({
    open,
    onClose,
    workers,       // 父层轮询得到(单一来源)
    status,        // id → WorkerStatus(父层轮询)
    onChanged,     // 增删改后 → 父层重拉 workers
  }: {
    open: boolean;
    onClose: () => void;
    workers: WorkerDTO[];
    status: Record<string, WorkerStatus>;
    onChanged: () => void;
  }): ReactNode
  ```
- Consumes:`api.deleteWorker`、`WorkerDialog`、`ConfirmDialog`、`Button`/`IconButton`、`useT`、`errMessage`/`useToast`。
- HubPage 新 Consumes:`api.listWorkers`/`api.getWorkersStatus`、`WorkerStatus` type、`usePolling`(门控 `hubEnabled === true`)。

### Steps

- [ ] **2.1 — i18n:pill/close 文案(zh)。** 在 `DICT.zh.hub.workers` 追加(与现有 `title/subtitle/add/...` 并列):
  ```ts
  pill: "Workers · {count}", close: "关闭 Workers 面板", statusFail: "离线", statusMixed: "部分离线",
  ```
- [ ] **2.2 — i18n:对称补 en。** 在 `DICT.en.hub.workers` 追加:
  ```ts
  pill: "Workers · {count}", close: "Close Workers panel", statusFail: "Offline", statusMixed: "Some offline",
  ```
- [ ] **2.3 — 新建 `WorkersPanel.tsx`(滑入浮层 = scrim + 右侧 aside,承接 WorkersCard 表格/增删改)。** 写整个文件(真实代码,worker 行/状态点/增删改照搬 WorkersCard,去掉自持轮询、改吃 props):
  ```tsx
  import { Pencil, Plus, Trash2, X } from "lucide-react";
  import { useEffect, useState, type ReactNode } from "react";
  import { api, type WorkerDTO, type WorkerStatus } from "../api/client";
  import { Button, IconButton } from "./Button";
  import { ConfirmDialog } from "./ConfirmDialog";
  import { errMessage, useToast } from "../lib/hooks";
  import { WorkerDialog } from "../modals/WorkerDialog";
  import { useT } from "../lib/i18n";

  /** Workers 滑入浮层:录制节点列表(name/kind/host/实时状态点)+ 增删改。状态由父层轮询下发。 */
  export function WorkersPanel({
    open,
    onClose,
    workers,
    status,
    onChanged,
  }: {
    open: boolean;
    onClose: () => void;
    workers: WorkerDTO[];
    status: Record<string, WorkerStatus>;
    onChanged: () => void;
  }): ReactNode {
    const t = useT();
    const toast = useToast();
    const [dialogOpen, setDialogOpen] = useState(false);
    const [editing, setEditing] = useState<WorkerDTO | null>(null);
    const [pendingDelete, setPendingDelete] = useState<string | null>(null);

    // Esc 关闭(仅 open 时挂监听)。
    useEffect(() => {
      if (!open) return;
      const onKey = (e: KeyboardEvent): void => {
        if (e.key === "Escape") onClose();
      };
      window.addEventListener("keydown", onKey);
      return () => window.removeEventListener("keydown", onKey);
    }, [open, onClose]);

    const openCreate = (): void => {
      setEditing(null);
      setDialogOpen(true);
    };
    const openEdit = (w: WorkerDTO): void => {
      setEditing(w);
      setDialogOpen(true);
    };
    const doDelete = async (id: string): Promise<void> => {
      try {
        await api.deleteWorker(id);
        toast(t("hub.workers.deleted"), "info");
        onChanged();
      } catch (e) {
        toast(errMessage(e), "error");
      }
    };

    // 三态:绿=ok / 红=fail / 灰=首次结果返回前(checking)。
    const dotColor = (w: WorkerDTO): string => {
      const s = status[w.id];
      return !s ? "var(--muted-soft)" : s.ok ? "var(--success)" : "var(--error)";
    };
    const dotTitle = (w: WorkerDTO): string => {
      const s = status[w.id];
      if (!s) return t("hub.workers.statusChecking");
      return s.ok ? t("hub.workers.statusOk") : (s.error ?? t("hub.workerDialog.unknownError"));
    };

    return (
      <>
        {/* scrim:open 才可见/可点(点击关闭)。 */}
        <div
          className="modal-backdrop"
          style={{
            opacity: open ? 1 : 0,
            pointerEvents: open ? "auto" : "none",
            transition: "opacity 0.18s ease",
          }}
          onClick={onClose}
        />
        {/* 右侧滑入面板 */}
        <aside
          className="fixed top-0 right-0 h-full w-[92vw] max-w-[420px] overflow-y-auto"
          style={{
            zIndex: 101,
            background: "var(--raised)",
            borderLeft: "1px solid var(--hairline)",
            boxShadow: "0 24px 60px -20px rgba(0,0,0,0.35)",
            transform: open ? "translateX(0)" : "translateX(100%)",
            transition: "transform 0.22s ease",
          }}
          role="dialog"
          aria-modal="true"
        >
          <div className="flex items-start justify-between gap-3 p-5 pb-3">
            <div>
              <h2 className="headline text-[20px] leading-tight">{t("hub.workers.title")}</h2>
              <p className="text-muted text-xs mt-1">{t("hub.workers.subtitle")}</p>
            </div>
            <IconButton title={t("hub.workers.close")} onClick={onClose}>
              <X className="w-4 h-4" />
            </IconButton>
          </div>

          <div className="px-5 pb-3">
            <Button small onClick={openCreate}>
              <Plus className="w-4 h-4" />
              {t("hub.workers.add")}
            </Button>
          </div>

          <div className="px-3 pb-5 space-y-1">
            {workers.length === 0 && (
              <div className="text-center text-muted text-sm py-8">{t("hub.workers.empty")}</div>
            )}
            {workers.map((w) => (
              <div key={w.id} className="flex items-center gap-3 rounded-lg px-2 py-2.5">
                <span className="dot shrink-0" style={{ background: dotColor(w) }} title={dotTitle(w)} />
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-ink truncate">{w.name}</div>
                  <div className="font-mono text-[11px] text-muted-soft truncate">
                    {w.kind}{w.host ? ` · ${w.host}` : ""}
                  </div>
                </div>
                <div className="inline-flex items-center gap-2 shrink-0">
                  <IconButton title={t("hub.common.edit")} onClick={() => openEdit(w)}>
                    <Pencil className="w-4 h-4" />
                  </IconButton>
                  {w.id !== "local" && (
                    <IconButton title={t("hub.common.delete")} style={{ color: "var(--error)" }} onClick={() => setPendingDelete(w.id)}>
                      <Trash2 className="w-4 h-4" />
                    </IconButton>
                  )}
                </div>
              </div>
            ))}
          </div>
        </aside>

        <WorkerDialog open={dialogOpen} onClose={() => setDialogOpen(false)} worker={editing} onSaved={onChanged} />
        <ConfirmDialog
          open={pendingDelete !== null}
          title={t("hub.workers.deleteConfirmTitle")}
          confirmLabel={t("hub.common.delete")}
          destructive
          onConfirm={() => {
            const id = pendingDelete;
            setPendingDelete(null);
            if (id !== null) void doDelete(id);
          }}
          onCancel={() => setPendingDelete(null)}
        />
      </>
    );
  }
  ```
  说明:① 面板始终挂载(用 transform 控制滑入/滑出)以有动画;scrim 与 aside 用 inline style 的 transform/opacity 过渡(沿用 `.modal-backdrop` 的底色/blur);② `role="dialog" aria-modal`;③ worker 行从表格改为紧凑行(浮层窄),状态点/dotColor/dotTitle/删除保护(`local` 不可删)全照搬 WorkersCard 逻辑;④ 不再自持轮询,workers/status 全来自 props。
- [ ] **2.4 — 改 `HubPage.tsx`:提升 workers/status 轮询 + 顶栏 pill + 挂 WorkersPanel。** 在 Task 1 版基础上改动:
  - 顶部 import 增补:
    ```tsx
    import { Server } from "lucide-react";
    import { type WorkerDTO, type WorkerStatus } from "../api/client";  // 合并进现有 client import
    import { WorkersPanel } from "../components/WorkersPanel";
    ```
    并删除 `import { WorkersCard } from "../components/WorkersCard";`。
  - 组件内新增 state + 轮询(放在现有 rules/jobs 之后;`enabled` 门控用 `hubEnabled === true`,slave/未知时不轮询):
    ```tsx
    const [workers, setWorkers] = useState<WorkerDTO[]>([]);
    const [workerStatus, setWorkerStatus] = useState<Record<string, WorkerStatus>>({});
    const [panelOpen, setPanelOpen] = useState(false);

    const refreshWorkers = async (): Promise<void> => {
      try {
        setWorkers(await api.listWorkers());
      } catch {
        /* 静默:轮询会重试 */
      }
    };
    usePolling(() => void refreshWorkers(), 3000, hubEnabled === true);

    const fetchWorkerStatus = async (): Promise<void> => {
      try {
        const list = await api.getWorkersStatus();
        setWorkerStatus(Object.fromEntries(list.map((s) => [s.id, s])));
      } catch {
        /* 保留上次 status */
      }
    };
    // worker 存活轮询周期(ms):5 分钟(沿用原 WorkersCard 常量)。
    usePolling(() => void fetchWorkerStatus(), 300_000, hubEnabled === true);
    ```
  - pill 健康点聚合(放在 `selectRoom` 附近):
    ```tsx
    // pill 健康点:全 ok=绿 / 有 fail=红 / 尚无结果=灰。
    const statuses = workers.map((w) => workerStatus[w.id]).filter(Boolean) as WorkerStatus[];
    const anyFail = statuses.some((s) => !s.ok);
    const allOk = statuses.length > 0 && statuses.every((s) => s.ok);
    const pillDot = anyFail ? "var(--error)" : allOk ? "var(--success)" : "var(--muted-soft)";
    const pillTitle = anyFail ? t("hub.workers.statusMixed") : allOk ? t("hub.workers.statusOk") : t("hub.workers.statusChecking");
    ```
  - 顶栏按钮区:把现有单个「新建规则」Button 换成 pill + 新建规则:
    ```tsx
    <div className="flex items-center gap-2">
      <button
        onClick={() => setPanelOpen(true)}
        className="btn-secondary btn-sm inline-flex items-center gap-2"
        title={pillTitle}
      >
        <Server className="w-4 h-4" />
        {t("hub.workers.pill", { count: workers.length })}
        <span className="dot" style={{ background: pillDot }} />
      </button>
      <Button onClick={() => setDialogOpen(true)}>
        <Plus className="w-4 h-4" />
        {t("hub.page.newRule")}
      </Button>
    </div>
    ```
  - 删除 `<WorkersCard />` 那一行。
  - 在最外层 `</>` 之前(与 HubRuleDialog 并列)挂面板:
    ```tsx
    <WorkersPanel
      open={panelOpen}
      onClose={() => setPanelOpen(false)}
      workers={workers}
      status={workerStatus}
      onChanged={() => void refreshWorkers()}
    />
    ```
  说明:pill 用 `<button className="btn-secondary btn-sm">`(沿用现有按钮样式 token,不新增配色);health 点复用 `.dot` + 聚合 `getWorkersStatus`;轮询 `enabled` 门控确保 slave/未确认时不打接口(「只在相关时轮询」)。
- [ ] **2.5 — 删除 `WorkersCard.tsx`。** 确认无其它引用:`rtk proxy grep -rn "WorkersCard" packages/web/src`(应为空)。然后删除文件。
- [ ] **2.6 — build + typecheck gate。**
  ```
  cd packages/web && rtk proxy pnpm build
  ```
  ```
  rtk proxy pnpm typecheck
  ```
  两者 0 error。留意:`Server` 图标从 lucide 引入是否存在(存在);`WorkerStatus` type import 合并进 `../api/client` 的既有 import 语句。
- [ ] **2.7 — 手动清单。**（`task serve --hub` 已启动)
  - [ ] 顶栏出现「Workers · N」pill,N = worker 数;pill 上健康点:全在线=绿、有离线=红、结果未回=灰(hover 有 tooltip)。
  - [ ] 点 pill → 面板从右滑入 + scrim 出现;面板内 worker 列表 + 实时状态点正确。
  - [ ] Esc 关闭面板;点 scrim(面板外暗区)关闭面板。
  - [ ] 面板内「添加 Worker」→ WorkerDialog 打开,保存后列表刷新;编辑现有 worker 保存后刷新;删除非-local worker 弹 ConfirmDialog,确认后消失;`local` 无删除按钮。
  - [ ] 面板关闭状态下,pill 健康点仍随 5 分钟轮询更新(状态源在 HubPage,不依赖面板开启)。
  - [ ] slave 节点(`task serve` 无 `--hub`)→ 仍是 child-node 提示页,无 pill、无 workers 轮询请求(可看 network 面板确认不打 `/api/hub/workers`)。
  - [ ] 语言 zh/en:pill 文案「Workers · N」、关闭 aria、statusMixed/statusFail 两语正确。
  - [ ] 窄屏:面板 `w-[92vw] max-w-[420px]` 覆盖大部分屏宽、可滚动,页面不横向滚。
- [ ] **2.8 — commit。**
  ```
  git add packages/web/src/pages/HubPage.tsx packages/web/src/components/WorkersPanel.tsx packages/web/src/components/WorkersCard.tsx packages/web/src/lib/i18n.tsx
  git commit -m "$(cat <<'EOF'
  feat(web): Workers 移入顶栏 pill 触发的滑入浮层

  - WorkersCard → WorkersPanel(右侧滑入 overlay:scrim + Esc + scrim 点击关闭),worker 行/状态点/增删改照搬
  - 顶栏新增「Workers · N」pill 按钮,健康点复用实时 getWorkersStatus(全在线绿/有离线红/未知灰)
  - workers 列表 + status 轮询提升到 HubPage(单一来源,按 hubEnabled 门控,只在 master 相关时轮询),面板变纯展示 + 自持增删改弹窗
  - i18n hub.workers 新增 pill/close/status 文案(zh+en)
  EOF
  )"
  ```

---

## Self-review(实现前对照)

- **spec 每节都有落点**:布局(顶栏 pill + master-detail 网格 + Workers 浮层)→ Task1 外壳 + Task2 浮层;左房间列表(紧凑可选卡 + accent 竖条 + disabled 降透明 + 空态)→ Task1 1.6;右房间详情(房间头 + 配置/worker chips + 完整 PipelineFlow + RunCard 列表)→ Task1 1.5;deep-link(/hub/:key 选中 + /hub 默认第一个 + 直达选中)→ Task1 1.6/1.7;组件组织(RoomDetail 抽出、HubDetailPage 内容并入、WorkersPanel)→ Task1+Task2;视觉(沿用 token 不新增配色)→ 全程 inline style 只引用现有 `var(--*)`;错误/边界(无房间/无 run/slave/窄屏/宽内容滚)→ 手动清单覆盖。
- **无占位符**:所有新文件给出完整可编译代码;修改点给出真实 diff 片段。
- **命名/键一致**:`RoomDetail`/`WorkersPanel`/`PipelineFlow`(exported)/`hideGraph`/`selected`/`onSelect`/`onChanged`/`onDeleted`/`panelOpen` 跨任务一致;新 i18n 键 `hub.detail.{workersLabel,allWorkers,chipUploadPrivate,chipUploadPublic,chipStageOnly,noRunGraph}`、`hub.page.{roomsHeading,selectRoomHint}`、`hub.workers.{pill,close,statusFail,statusMixed}` zh/en 对称。
- **deep-link 正确**:`/hub` 与 `/hub/:key` 同渲染 `HubPage`;`useParams().key` 命中 rules 用之,否则回落 `rules[0]`;选房间 `navigate('/hub/'+encodeURIComponent(key))`;删除后 `navigate('/hub')`。`RoomDetail` 用 `key={rule.key}` 强制切房间重挂载,避免陈旧本地 state。

## 已知 spec-vs-code 取舍(实现者知悉)

1. **RunCard 复用需加性改动**:spec 说「复用 RunCard 精简版 + 上方单独完整 graph」,但现 `RunCard` 内嵌自己的 `PipelineFlow`。为「不重写」,本计划对 `RunCard` 只做**加性** props(`hideGraph`/`selected`/`onSelect`,默认不变)并 `export PipelineFlow`,非重写。
2. **worker status 轮询位置**:spec 语气像 WorkersPanel 自持;但 pill 在面板**关闭**时也要显示健康点,故把 workers/status 轮询提升到 HubPage(单一来源、hubEnabled 门控),WorkersPanel 变纯展示。行为等价、更省重复轮询。
</content>
</invoke>
