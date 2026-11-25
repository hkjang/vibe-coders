export function formatLoad(milliseconds: number | undefined): string {
  return milliseconds === undefined ? "측정 없음" : `${Math.round(milliseconds).toLocaleString("ko-KR")} ms`;
}
