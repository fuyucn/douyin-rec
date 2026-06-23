import { Switch as BaseSwitch } from "@base-ui/react/switch";
import type { ReactNode } from "react";

interface Props {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  name?: string;
  disabled?: boolean;
  id?: string;
}

/** Cal.com-style toggle built on Base UI Switch (headless). */
export function Switch({ checked, onCheckedChange, name, disabled, id }: Props): ReactNode {
  return (
    <BaseSwitch.Root
      id={id}
      name={name}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      className="switch-root"
    >
      <BaseSwitch.Thumb className="switch-thumb" />
    </BaseSwitch.Root>
  );
}
