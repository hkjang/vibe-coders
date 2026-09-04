export const appRequestsContractHeader = "X-Vibe-App-Requests-Version";
export const appRequestsContractVersion = "2";

export const appRequestsContractHeaders = {
  [appRequestsContractHeader]: appRequestsContractVersion,
} as const;
