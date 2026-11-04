import { useEffect, useRef, useState } from "react";
import type { UseFormReturn } from "react-hook-form";
import { appWriteBody, type AppFormInput, type AppFormOutput } from "./app-form";
import { AppError } from "@/shared/api/error";

/** Every input event invalidates approval, including an A -> B -> A edit. */
export function useAppDefinitionReview(form: UseFormReturn<AppFormInput, unknown, AppFormOutput>) {
  const [values, setValues] = useState<AppFormOutput>();
  const [confirmed, setConfirmed] = useState(false);
  const approved = useRef<string | undefined>(undefined);
  const revision = useRef(0);
  useEffect(() => {
    const subscription = form.watch(() => {
      revision.current++;
      approved.current = undefined;
      setConfirmed(false);
      setValues(undefined);
    });
    return () => subscription.unsubscribe();
  }, [form]);
  return {
    values,
    confirmed,
    review: () => {
      const generation = revision.current;
      return form.handleSubmit((next) => {
        if (generation !== revision.current) return;
        approved.current = undefined;
        setConfirmed(false);
        setValues(next);
      })();
    },
    confirm: (checked: boolean) => {
      approved.current = checked && values ? JSON.stringify(appWriteBody(values)) : undefined;
      setConfirmed(checked && values !== undefined);
    },
    assertReviewed: (next: AppFormOutput) => {
      if (approved.current !== JSON.stringify(appWriteBody(next)))
        throw new AppError("현재 변경 내용과 적용 범위를 다시 확인하세요.", { kind: "permission" });
    },
  };
}
