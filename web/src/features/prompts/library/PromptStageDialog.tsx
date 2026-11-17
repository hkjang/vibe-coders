import { useState, type RefObject } from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useAuth } from "@/app/auth/AuthProvider";
import { apiClient } from "@/shared/api/client";
import { isAppError } from "@/shared/api/error";
import { promptStages, stageEndpoints } from "@/shared/api/domains/prompt-stages";
import type { PromptStageWorkspaceItem, PromptStageChange } from "@/shared/api/generated";
import { FormDialog } from "@/shared/components/form/FormDialog";
import { FormField } from "@/shared/components/form/FormField";
import { Checkbox } from "@/shared/components/ui/Checkbox";
import { Input } from "@/shared/components/ui/Input";
import { Select } from "@/shared/components/ui/Select";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { stageReasonSchema } from "./stage-form";
import { LibraryWriteNotice } from "./LibraryWriteNotice";
import { useLibraryAccess, useLibraryBusy, useLibraryMutation } from "./use-library-mutation";
import { libraryError, libraryRouteId } from "./library-model";
import { stageMessages as text } from "./stage-messages";

type Draft = { stage: (typeof promptStages)[number]; reason: string; confirmed: boolean };
export function PromptStageDialog({
  row,
  onClose,
  returnFocusRef,
}: {
  row: PromptStageWorkspaceItem;
  onClose: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}) {
  const { credentialPrefixes } = useAuth();
  const access = useLibraryAccess();
  const busy = useLibraryBusy();
  const [conflict, setConflict] = useState(false);
  const schema = z.object({
    stage: z.enum(promptStages).refine((value) => value !== row.stage, text.different),
    reason: stageReasonSchema(credentialPrefixes),
    confirmed: z.boolean().refine(Boolean, text.confirmRequired),
  });
  const form = useForm<Draft>({
    resolver: zodResolver(schema),
    defaultValues: {
      stage: row.stage === "unknown" ? "experiment" : row.stage,
      reason: "",
      confirmed: false,
    },
  });
  const stage = useWatch({ control: form.control, name: "stage" });
  const mutation = useLibraryMutation({
    mutate: (value: PromptStageChange) =>
      apiClient.request(stageEndpoints.change, {
        query: { view: "workspace" },
        body: value,
        routeId: libraryRouteId,
        retryUnauthorized: false,
      }),
    validate: (result, value) => {
      if (
        result.reference !== row.reference ||
        result.stage !== value.stage ||
        result.revision === row.revision
      )
        throw libraryError("unknown");
    },
    invalidates: [["prompts", "stages"]],
    successMessage: text.success,
    errorMessage: text.failure,
  });
  const blocked = !access.allowed || busy || mutation.uncertain || conflict;
  const errors = form.formState.errors;
  return (
    <FormDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      returnFocusRef={returnFocusRef}
      form={form}
      title={text.dialog}
      description={`${row.name} · ${row.version}`}
      submitLabel={text.save}
      submitDisabled={blocked}
      errorFormatter={(error) =>
        isAppError(error) && error.status === 409 ? text.conflict : safeAppErrorMessage(error, text.failure)
      }
      onSubmit={async (values) => {
        try {
          await mutation.mutateAsync({
            name: row.name,
            version: row.version,
            revision: row.revision,
            stage: values.stage,
            reason: values.reason,
          });
        } catch (error) {
          if (isAppError(error) && error.status === 409) setConflict(true);
          throw error;
        }
      }}
    >
      <InlineNotice tone="info" title={text.tab}>
        {text.scope}
      </InlineNotice>
      <LibraryWriteNotice uncertain={mutation.uncertain} />
      <FormField label={text.target} required error={errors.stage?.message}>
        {(props) => (
          <Select
            {...props}
            {...form.register("stage", { onChange: () => form.setValue("confirmed", false) })}
            disabled={!access.allowed}
            className={form.formState.dirtyFields.stage ? "prompt-stage-dirty" : undefined}
          >
            {promptStages.map((value) => (
              <option key={value} value={value}>
                {text.stages[value]}
              </option>
            ))}
          </Select>
        )}
      </FormField>
      <FormField label={text.reason} description={text.reasonHelp} required error={errors.reason?.message}>
        {(props) => (
          <Input
            {...props}
            {...form.register("reason", { onChange: () => form.setValue("confirmed", false) })}
            disabled={!access.allowed}
            autoComplete="off"
            className={form.formState.dirtyFields.reason ? "prompt-stage-dirty" : undefined}
          />
        )}
      </FormField>
      <section className="page-stack" aria-label={text.review}>
        <h3>{text.review}</h3>
        <div className="prompt-change-comparison">
          <div>
            <strong>{text.before}</strong>
            <p>{text.stages[row.stage]}</p>
          </div>
          <div>
            <strong>{text.after}</strong>
            <p>{text.stages[stage]}</p>
          </div>
        </div>
        <p className="muted">{text.changedHelp}</p>
      </section>
      <Checkbox
        label={text.confirm}
        {...form.register("confirmed")}
        disabled={!access.allowed}
        aria-invalid={Boolean(errors.confirmed)}
        aria-describedby={errors.confirmed ? "stage-confirm-error" : undefined}
      />
      {errors.confirmed ? (
        <p className="field-error" role="alert" id="stage-confirm-error">
          {errors.confirmed.message}
        </p>
      ) : null}
    </FormDialog>
  );
}
