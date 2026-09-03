import { isRouteErrorResponse } from "react-router";

export function routeErrorMessage(error: unknown): string {
  if (!isRouteErrorResponse(error)) return "예기치 못한 화면 오류가 발생했습니다.";

  const suffix = `(HTTP ${error.status})`;
  switch (error.status) {
    case 401:
      return `로그인이 필요합니다. ${suffix}`;
    case 403:
      return `이 화면에 접근할 권한이 없습니다. ${suffix}`;
    case 404:
      return `요청한 화면을 찾을 수 없습니다. ${suffix}`;
    case 405:
      return `허용되지 않은 요청 방식입니다. ${suffix}`;
    case 408:
      return `화면 요청 시간이 초과되었습니다. ${suffix}`;
    case 429:
      return `요청이 너무 많습니다. 잠시 후 다시 시도하세요. ${suffix}`;
    case 500:
      return `화면을 처리하는 중 서버 오류가 발생했습니다. ${suffix}`;
    case 502:
    case 503:
    case 504:
      return `서비스에 일시적으로 연결할 수 없습니다. ${suffix}`;
    default:
      return `요청한 화면을 표시할 수 없습니다. ${suffix}`;
  }
}
