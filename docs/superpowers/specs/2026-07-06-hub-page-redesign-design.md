# Hub 页面重构（master-detail + Workers 浮层）设计

> 状态：设计稿（2026-07-06，brainstorming 产出，待实现）。纯前端/视觉重构,零后端改动。
> 依据:用户不满当前"两张堆叠表格"的层次/美感;确认方向 = 左右布局(左列表右详情)+ Workers 浮层。
> mockup 已看过(本地 HTML)。关联:[architecture.md](../../architecture.md)、features 017/018/019。

## 目标

把 Hub 页从"Workers 表格 + 规则表格"两张堆叠表格,重构为 **master-detail(左房间列表 + 右详情)+ Workers 浮层**,建立清晰层次:**房间是主体、运行记录随房间、workers 是基础设施(浮层)**。仅改前端布局/组件组织,不动 REST/后端/数据。

## 布局

- **顶栏**:标题 "Hub" + 副标题 + 右侧 **「Workers · N」pill 按钮**(带健康点,点开浮层)+「新建规则」。
- **master-detail 网格**:左窄列(~288px)= 房间列表;右主区 = 选中房间详情。窄屏(< ~820px)降级为上下堆叠(列表在上、详情在下)。
- **Workers 浮层**:顶栏按钮 → 从右侧滑入的 overlay 面板(带 scrim,scrim 点击 / Esc 关闭),内容 = 现 WorkersCard(worker 行 + 实时状态点 + 增删改 + 添加)。**从主流程移到浮层**,基础设施不占主区。

## 左:房间列表

- 每房间一张紧凑可选卡:主播名 + room id(mono,muted)+ 状态行(启用点 + 最近一次运行徽标:已完成 / 上传中 / 待人工 / 已暂停)。
- 选中态:左侧 accent 竖条 + surface 高亮。暂停(disabled)规则整卡降透明度。
- 空态:无规则 → 提示 + 「新建规则」。

## 右:房间详情

- **房间头**:主播名 + `douyin · {roomId}`(mono)+ 启用 Switch + 编辑/删除(复用现 HubRuleDialog / ConfirmDialog)。
- **后处理配置**摘要 chips(plain + danmu + livechat → 上传(私)/仅合成)+ **参与 Workers** chips。
- **完整 pipeline graph**:复用现有 React Flow `PipelineFlow`(`HubJobs.tsx`)渲染**最近一次运行**的 fork/join 全图(选优→拉取→合并→[烧录轨‖上传轨]→append→完成),含实时步骤状态/耗时。
- **运行记录**:历次 run 列表(复用 `RunCard` 精简版:日期 + 状态 + BV + 日志入口);点某条 run → 上方 graph 切到该 run(默认展示最近一次)。

## Deep-link(保留)

- 路由保留 `/hub/:key`(key = `{platform}.{roomSlug}`)。选中左侧房间 → `navigate(/hub/:key)` 更新 URL;直接访问 `/hub/:key` → 打开该房间选中态。`/hub`(无 key)→ 默认选中第一个房间(无房间则空态)。用 react-router(现有)。

## 组件组织

- `HubPage.tsx`:重构为 master-detail 外壳 —— 房间列表(左)+ 详情 pane(右)+ 顶栏(含 Workers 浮层开关)。
- `HubDetailPage.tsx` 的详情内容(配置卡 + RunCard + PipelineFlow)**并入右 pane**;`/hub/:key` 仍可直达(路由渲染同一 HubPage,按 key 选中)。是否保留独立 HubDetailPage 组件由实现决定(倾向:详情抽成 `RoomDetail` 组件,HubPage 与直达路由共用)。
- `WorkersCard.tsx` → 内容移入 `WorkersPanel`(滑入浮层);顶栏 pill 按钮控制开关,pill 上的健康点复用 workers 实时 status。
- **复用不重写**:`PipelineFlow`/`RunCard`/`JobLogDialog`(HubJobs.tsx)、`HubRuleDialog`、`WorkerDialog`、`ConfirmDialog`、`Switch`、worker 实时 status 轮询、i18n(hub 词典组)。

## 视觉

- 沿用现有暗色 Cal.com 风格 token(near-black 底、hairline 边、绿=状态/启用、near-white=主按钮/选中)。层次靠布局(主/次分区)+ 卡片 accent 竖条 + 分区标签,而非新配色。运行中状态沿用现有 pulse/marching-ants 动画。

## 错误/边界

- 无房间 → 左空态 + 新建入口;无 run → 右详情显示配置 + "尚无运行"(不渲染空 graph)。
- 旧 run 无细粒度 steps → PipelineFlow 已有回落(粗粒度文字行),沿用。
- Workers 浮层:Esc / scrim 关闭;hub 未开(slave)→ 现有 hubEnabled 分支照旧(不显示 master 版 Hub 页)。
- 窄屏堆叠;宽内容(graph)自身 `overflow-x:auto`,页面不横向滚。

## 测试

- `cd packages/web && pnpm build` 绿 + 根 `pnpm typecheck` 0(web 无 vitest)。
- 手动清单:点左侧房间 → URL 变 `/hub/:key` + 右详情切换;直接访问 `/hub/:key` → 对应房间选中;`/hub` → 默认第一个;Workers pill → 浮层滑入/Esc 关;右详情渲染完整 graph + 运行记录;空态(无规则/无 run);窄屏堆叠;i18n zh/en 两语都通。

## 任务拆分

1. **master-detail 外壳 + 路由 + 右详情**:HubPage 改左列表+右 pane,`RoomDetail` 组件(并入配置卡 + PipelineFlow 完整图 + RunCard 列表),`/hub/:key` 选中同步 + `/hub` 默认选中 + 空态。i18n 新增文案。
2. **Workers 浮层**:WorkersCard → `WorkersPanel`(滑入 overlay + scrim + Esc)+ 顶栏 pill 开关(健康点用实时 status)。i18n。
