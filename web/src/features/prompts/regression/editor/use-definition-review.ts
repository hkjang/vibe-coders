import { useEffect, useRef, useState } from "react";
import type { UseFormReturn } from "react-hook-form";
import {
  definitionSignature,
  type DefinitionInput,
  type DefinitionTarget,
  type DefinitionValues,
} from "./definition-form";
import { definitionError } from "./definition-messages";

export function useDefinitionReview(
  form: UseFormReturn<DefinitionInput, unknown, DefinitionValues>,
  target: DefinitionTarget,
) {
  const [values, setValues] = useState<DefinitionValues>();
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
      approved.current = checked && values ? definitionSignature(target, values) : undefined;
      setConfirmed(checked && values !== undefined);
    },
    assertReviewed: (next: DefinitionValues) => {
      if (approved.current !== definitionSignature(target, next)) throw definitionError("golden_review");
    },
  };
}
