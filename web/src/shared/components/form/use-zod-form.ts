import { zodResolver } from "@hookform/resolvers/zod";
import { useForm, type DefaultValues, type FieldValues, type UseFormReturn } from "react-hook-form";
import type { z } from "zod";

/** Defaults to blur validation; touched mode also validates edits after first blur. */
export function useZodForm<Input extends FieldValues, Output extends FieldValues>(
  schema: z.ZodType<Output, Input>,
  defaultValues: DefaultValues<Input>,
  options: { mode?: "onBlur" | "onTouched" } = {},
): UseFormReturn<Input, unknown, Output> {
  return useForm<Input, unknown, Output>({
    resolver: zodResolver(schema),
    defaultValues,
    mode: options.mode ?? "onBlur",
  });
}
