import type { ReactNode } from "react";
import { Popover } from "@base-ui/react/popover";
import { experimentalDefaultKey, getExperimentalFeature } from "@drec/experimental";
import { useT } from "../lib/i18n";

const ISSUES_URL = "https://github.com/fuyucn/douyin-rec/issues";

/**
 * 「实验性」徽标(issue #43):挂在实验功能的**原有控件旁**,不另设分区。
 * 文案全部来自 core 注册表(`@drec/experimental` = core/src/experimental.ts):
 * 名称 / 说明 / 风险(具体后果)/ 默认策略 / 去向 / 退役条件 / 跟踪票。
 * 点击(或键盘 Enter/Space)就地展开,悬浮也可预览 —— 移动端无 hover 也能看。
 * id 未登记 → 不渲染(功能转正后删登记项即摘徽标,调用点无需改)。
 *
 * 徽标只标注「这个功能是实验性的」,不反映开关状态:开没开以 hub 规则配置为准
 * (直接改规则文件开启的,界面照常按规则显示,不假装未开)。
 */
export function ExperimentalBadge({ id }: { id: string }): ReactNode {
  const t = useT();
  const f = getExperimentalFeature(id);
  if (!f) return null;
  const name = `${t(f.nameKey)} · ${t("experimental.badge")}`;
  return (
    <Popover.Root>
      <Popover.Trigger
        openOnHover
        delay={150}
        type="button"
        className="chip chip-experimental"
        aria-label={name}
        // 徽标常放在 <label> 里:阻止冒泡,避免点徽标时误触发旁边的开关
        onClick={(e) => e.stopPropagation()}
      >
        {t("experimental.badge")}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={6} className="tooltip-positioner">
          <Popover.Popup className="tooltip-popup experimental-popup" data-experimental-id={f.id}>
            <div className="flex flex-col gap-1">
              <div className="font-semibold">{name}</div>
              <div>{t(f.descKey)}</div>
              <div>{t("experimental.riskPrefix")}{t(f.riskKey)}</div>
              <div>{t("experimental.defaultPrefix")}{t(experimentalDefaultKey(f))}</div>
              <div>{t(f.whereKey)}</div>
              <div>{t("experimental.truthNote")}</div>
              <div>{t("experimental.graduationPrefix")}{t(f.graduationKey)}</div>
              {f.trackingIssue !== null && (
                <div>
                  {t("experimental.trackingPrefix")}
                  <a className="underline" href={`${ISSUES_URL}/${f.trackingIssue}`} target="_blank" rel="noopener noreferrer">#{f.trackingIssue}</a>
                </div>
              )}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
