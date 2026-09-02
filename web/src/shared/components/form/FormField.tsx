import { useId, type ReactNode } from "react";

interface FieldControlProps {
  id: string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
  "aria-required"?: true;
}

interface FormFieldProps {
  children: (controlProps: FieldControlProps) => ReactNode;
  description?: string;
  error?: string;
  id?: string;
  label: string;
  required?: boolean;
}

export function FormField({
  children,
  description,
  error,
  id,
  label,
  required = false,
}: FormFieldProps): React.JSX.Element {
  const generatedId = useId();
  const controlId = id ?? `field-${generatedId}`;
  const descriptionId = description ? `${controlId}-description` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;
  const describedBy = [descriptionId, errorId].filter(Boolean).join(" ") || undefined;

  return (
    <div className="form-field" data-invalid={error ? "true" : undefined}>
      <label htmlFor={controlId}>
        {label}
        {required ? (
          <span className="field-required" aria-hidden="true">
            *
          </span>
        ) : null}
      </label>
      {children({
        id: controlId,
        "aria-describedby": describedBy,
        "aria-invalid": error ? true : undefined,
        "aria-required": required ? true : undefined,
      })}
      {description ? (
        <p className="field-description" id={descriptionId}>
          {description}
        </p>
      ) : null}
      {error ? (
        <p className="field-error" id={errorId} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
