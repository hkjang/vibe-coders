import { useAuth } from "@/app/auth/AuthProvider";
import { requestCostText, visibleRequestCurrency } from "./request-metric-format";

/** The same recorded amount and currency in the list, detail, and comparison. No conversion. */
export function RequestCost({ value, currency }: { value: number; currency: string }): React.JSX.Element {
  const { credentialPrefixes } = useAuth();
  const unit = visibleRequestCurrency(currency, credentialPrefixes);
  return (
    <span
      title={Number.isFinite(value) ? `기록된 금액: ${String(value)} ${unit ?? "(통화 미확인)"}` : undefined}
    >
      {requestCostText(value, currency, credentialPrefixes)}
    </span>
  );
}
