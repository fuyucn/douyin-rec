import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import type { ReactNode } from "react";

interface Props {
  /** 提示内容;undefined/空串时不包 tooltip,直接渡回 children(如两个时区相同时没必要提示)。 */
  content?: ReactNode;
  children: ReactNode;
}

/** Cal.com 风格 hover tooltip,包 Base UI Tooltip 原语(与 Dialog/Switch 同一套组件库)。 */
export function Tooltip({ content, children }: Props): ReactNode {
  if (!content) return <>{children}</>;
  return (
    <BaseTooltip.Root>
      <BaseTooltip.Trigger delay={80} render={<span className="tooltip-trigger inline-flex" />}>
        {children}
      </BaseTooltip.Trigger>
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner sideOffset={6} className="tooltip-positioner">
          <BaseTooltip.Popup className="tooltip-popup">{content}</BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}
