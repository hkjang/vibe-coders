import { toast as sonnerToast } from "sonner";

type Notice = Parameters<typeof sonnerToast.error>;

/** Keep notification lifetimes consistent across direct actions and mutation hooks. */
export const toast = {
  success: (...args: Parameters<typeof sonnerToast.success>) => sonnerToast.success(...args),
  info: (...args: Parameters<typeof sonnerToast.info>) => sonnerToast.info(...args),
  error: (message: Notice[0], options?: Notice[1]) =>
    sonnerToast.error(message, { ...options, duration: Number.POSITIVE_INFINITY }),
  warning: (message: Notice[0], options?: Notice[1]) =>
    sonnerToast.warning(message, { ...options, duration: 10_000 }),
};
