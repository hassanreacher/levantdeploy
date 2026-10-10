import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { Spinner } from "./spinner";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "outline" | "accent";
export type ButtonSize = "sm" | "md" | "lg" | "icon" | "icon-sm";

const variants: Record<ButtonVariant, string> = {
  primary: "bg-fg text-bg hover:bg-fg/90 border border-transparent",
  secondary: "bg-surface text-fg border border-border hover:bg-surface-2 hover:border-border-strong",
  outline: "bg-transparent text-fg border border-border hover:border-border-strong hover:bg-surface-2/60",
  ghost: "bg-transparent text-muted hover:text-fg hover:bg-surface-2 border border-transparent",
  danger: "bg-danger text-white hover:bg-danger/90 border border-transparent",
  accent: "bg-accent text-accent-fg hover:bg-accent/90 border border-transparent",
};
const sizes: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-[13px] gap-1.5",
  md: "h-9 px-4 text-sm gap-2",
  lg: "h-10 px-5 text-sm gap-2",
  icon: "h-9 w-9 justify-center",
  "icon-sm": "h-8 w-8 justify-center",
};

export function buttonClass(variant: ButtonVariant = "secondary", size: ButtonSize = "md", className?: string) {
  return cn(
    "inline-flex select-none items-center justify-center whitespace-nowrap rounded-md font-medium transition-colors duration-150 disabled:pointer-events-none disabled:opacity-50",
    variants[variant],
    sizes[size],
    className,
  );
}

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", loading, leftIcon, rightIcon, className, children, disabled, type = "button", ...rest },
  ref,
) {
  return (
    <button ref={ref} type={type} disabled={disabled || loading} className={buttonClass(variant, size, className)} {...rest}>
      {loading ? <Spinner className="h-3.5 w-3.5" /> : leftIcon}
      {children}
      {rightIcon}
    </button>
  );
});

/** A Next <Link> styled as a button. */
export function LinkButton({
  href,
  variant = "secondary",
  size = "md",
  className,
  children,
  leftIcon,
  rightIcon,
  ...rest
}: { href: string; variant?: ButtonVariant; size?: ButtonSize; className?: string; children?: ReactNode; leftIcon?: ReactNode; rightIcon?: ReactNode; target?: string; rel?: string }) {
  return (
    <Link href={href} className={buttonClass(variant, size, className)} {...rest}>
      {leftIcon}
      {children}
      {rightIcon}
    </Link>
  );
}
