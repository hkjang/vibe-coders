export function validDwRetryJobId(value: string): boolean {
  return /^dwr_[a-f0-9]{64}$/u.test(value);
}
