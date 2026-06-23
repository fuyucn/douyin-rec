import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary";

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  /** Compact table-action size. */
  small?: boolean;
  /** Show an inline spinner before the label (disables nothing on its own). */
  loading?: boolean;
  children?: ReactNode;
}

/** Cal.com-style primary/secondary button. */
export function Button({
  variant = "primary",
  small,
  loading,
  className = "",
  children,
  ...rest
}: Props): ReactNode {
  const base = variant === "primary" ? "btn-primary" : "btn-secondary";
  const sm = small ? "btn-sm" : "";
  return (
    <button className={`${base} ${sm} ${className}`.trim()} {...rest}>
      {loading && <span className="spinner" />}
      {children}
    </button>
  );
}

/** Round 36px icon button used in table rows / modal close. */
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
