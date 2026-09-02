import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, type ButtonHTMLAttributes } from "react";

import { cn } from "@/shared/utils/cn";

const buttonVariants = cva("button", {
  variants: {
    variant: {
      primary: "button-primary",
      secondary: "button-secondary",
      ghost: "button-ghost",
      danger: "button-danger",
    },
    size: {
      small: "button-small",
      default: "button-default",
      icon: "button-icon",
    },
  },
  defaultVariants: { variant: "secondary", size: "default" },
});

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, size, variant, type = "button", ...props },
  ref,
) {
  return (
    <button ref={ref} type={type} className={cn(buttonVariants({ size, variant }), className)} {...props} />
  );
});
