import { useState } from "react";

export function useKeyRevokeAttempts(ownsResult: () => boolean, refetch: () => unknown) {
  const [attempts, setAttempts] = useState<ReadonlySet<string>>(new Set());
  const record = (id: string) => setAttempts((current) => new Set([...current, id]));
  const reject = (id: string) => {
    if (!ownsResult()) return;
    setAttempts((current) => new Set([...current].filter((value) => value !== id)));
    // A fresh dialog must review the latest catalog; never replay the mutation.
    void refetch();
  };
  return { attempts, record, reject };
}
