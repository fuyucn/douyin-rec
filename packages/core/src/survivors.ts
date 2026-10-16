/**
 * 收尾后留存清单(plans/036 T8):按规则的 cleanup 开关算出「清理做完后各类文件还剩不剩」。
 *
 * **`.xml/.ass` 的唯一不变量:不得删掉最后一份**(两处永不同时删光)——节点源 xml 与 stage 副本互为备份:
 *   - `stageHasXmlCopy=true`(pull 路径,stage 里有 xml 副本):`stageAfterDone=false` → 节点 xml 可删(副本留在 stage);
 *     `stageAfterDone=true` → stage 的 xml/ass 随 stage 删,节点 xml 必留;
 *   - `stageHasXmlCopy=false`(节点侧上传,从不往 stage 放 xml):节点 xml 恒为最后一份,一律留。
 * 本函数是 orchestrator 清理(`cleanupSourcesShared` / `xmlKeepRule`)与后续「收尾后转格式」派发的**同一判定**,
 * 不允许在别处另写第二份。
 */

/** 规则的清理开关(与 `HubPipelineConfig.cleanup` 同形)。 */
export interface SurvivorCleanupFlags {
  /** 合并后删 stage 里拉来的源段副本(仅有合并处理的路径生效)。 */
  stageSourceAfterMerge?: boolean;
  /** job 完成后删各成员节点原录制(.xml 是否连带见 stageHasXmlCopy)。 */
  sourceAfterDone?: boolean;
  /** job 完成后清空 stage(成品 / 源段副本 / 边车副本 / xml·ass / 中间产物)。 */
  stageAfterDone?: boolean;
}

export interface SurvivorRule {
  pipeline?: { cleanup?: SurvivorCleanupFlags };
}

export interface SurvivingArtifacts {
  /** 节点 `recordings/` 里的源录像分段。 */
  nodeSourceSegments: boolean;
  /** stage 里拉来的源录像分段副本。 */
  stageSourceSegments: boolean;
  /** stage 里的三分 P 成品(plain / danmu / livechat)。 */
  stageProducts: boolean;
  /** 节点源 `.xml`。 */
  nodeXml: boolean;
  /** stage 里的 `.xml/.ass`。 */
  stageXml: boolean;
  /** stage 里随 pull 带来的会话边车副本(`*.session.json`);随 stage 清空一并删,节点那份不受影响。 */
  stageSidecarCopies: boolean;
}

/**
 * @param opts.stageHasXmlCopy 见文件头(pull 路径 true;节点侧上传 false)。
 * @param opts.stagePulled     本场是否把源段拉进了 stage(缺省 true)。节点侧上传从不往 stage 放源段副本 →
 *   传 false 时 `stageSourceSegments` 恒 false。**交付模式约束(T8 遗留)**:合并路径与分 P 路径在 done 后都按
 *   `stageSourceAfterMerge` / `stageAfterDone` 清 stage 源段副本(分 P 路径在上传成功后另行清 scratch),所以两者共用本口径;
 *   派发方另须以磁盘上实际存在为准(本清单只回答「清理开关会不会删」,不回答「文件是否存在」)。
 */
export function survivingArtifacts(
  rule: SurvivorRule,
  opts: { stageHasXmlCopy: boolean; stagePulled?: boolean },
): SurvivingArtifacts {
  const c = rule.pipeline?.cleanup ?? {};
  const stageCleared = c.stageAfterDone === true;
  const nodeXmlDeletable = opts.stageHasXmlCopy && !stageCleared;
  return {
    nodeSourceSegments: !c.sourceAfterDone,
    stageSourceSegments: opts.stagePulled !== false && !stageCleared && !c.stageSourceAfterMerge,
    stageProducts: !stageCleared,
    nodeXml: !(c.sourceAfterDone && nodeXmlDeletable),
    stageXml: !stageCleared,
    stageSidecarCopies: !stageCleared,
  };
}
