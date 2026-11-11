import { useAuth } from "@/app/auth/AuthProvider";
import { safeRegressionText } from "./regression-model";

export function RegressionText({ label, value }: { label: string; value: string }) {
  const { credentialPrefixes } = useAuth();
  return (
    <section className="regression-text">
      <h3>{label}</h3>
      <pre tabIndex={0} aria-label={label}>
        {safeRegressionText(value, credentialPrefixes) || "미등록"}
      </pre>
    </section>
  );
}
