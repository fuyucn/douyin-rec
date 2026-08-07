import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "danger";

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  /** Compact table-action size. */
  small?: boolean;
  /** Show an inline spinner before the label (disables nothing on its own). */
  loading?: boolean;
  children?: ReactNode;
}

/** 控制台按钮:primary=信号色 / secondary=描边 / danger=破坏性操作。 */
export function Button({
  variant = "primary",
  small,
  loading,
  className = "",
  children,
  ...rest
}: Props): ReactNode {
  const base =
    variant === "primary" ? "btn-primary" : variant === "danger" ? "btn-danger" : "btn-secondary";
  const sm = small ? "btn-sm" : "";
  return (
    <button className={`${base} ${sm} ${className}`.trim()} {...rest}>
      {loading && <span className="spinner" />}
      {children}
    </button>
  );
}

/** 方形 34px 图标按钮,用于表格行操作 / 弹窗关闭。 */
export function IconButton({
  className = "",
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement>): ReactNode {
  return (
    <button className={`btn-icon ${className}`.trim()} {...rest}>
      {children}
    </button>
  );
}
