import type { UseFormReturn } from "react-hook-form";
import type { EditKeyForm } from "./api-key-form";
import { FormField } from "@/shared/components/form/FormField";
import { Input } from "@/shared/components/ui/Input";
import { Select } from "@/shared/components/ui/Select";

export function ApiKeyEditFields({ form }: { form: UseFormReturn<EditKeyForm> }): React.JSX.Element {
  return (
    <>
      <FormField label="이름">{(control) => <Input {...control} {...form.register("name")} />}</FormField>
      <FormField label="소유자">{(control) => <Input {...control} {...form.register("owner")} />}</FormField>
      <FormField label="팀">{(control) => <Input {...control} {...form.register("team")} />}</FormField>
      <FormField label="역할">{(control) => <Input {...control} {...form.register("role")} />}</FormField>
      <FormField label="상태">
        {(control) => (
          <Select {...control} {...form.register("status")}>
            <option value="active">사용</option>
            <option value="disabled">중지</option>
          </Select>
        )}
      </FormField>
    </>
  );
}
