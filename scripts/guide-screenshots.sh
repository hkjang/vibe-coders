#!/usr/bin/env bash
# 가이드 화면 캡처 — docs/images/guide/*.png 를 실제 화면에서 다시 만든다.
#
# 남의 배포를 건드리지 않는다: 임시 디렉터리의 SQLite 위에 일회용 게이트웨이를
# 띄우고, 가짜 업스트림으로 트래픽을 흘려 화면을 채운 뒤, 끝나면 전부 지운다.
# 계정·토큰은 실행할 때마다 무작위로 만들어 환경 변수로만 넘긴다.
#
# 사용법:
#   ./scripts/guide-screenshots.sh            # web/dist 가 없으면 먼저 빌드한다
#   GUIDE_CAPTURE_OUT=/tmp/shots ./scripts/guide-screenshots.sh
#
# 필요한 것: go, node ≥22 + corepack(pnpm), Chrome/Chromium (GUIDE_CAPTURE_BROWSER 로 지정 가능).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${GUIDE_CAPTURE_OUT:-$ROOT/docs/images/guide}"
PORT="${GUIDE_CAPTURE_PORT:-18090}"
MOCK_PORT="${GUIDE_CAPTURE_MOCK_PORT:-18091}"
BASE_URL="http://127.0.0.1:$PORT"

tmp="$(mktemp -d)"
pids=()
cleanup() {
    for pid in "${pids[@]:-}"; do [ -n "$pid" ] && kill "$pid" 2>/dev/null || true; done
    # 임베드 자리에는 마커만 남긴다 — go build 가 커밋되면 안 되는 번들을 끌어안지 않도록.
    find "$ROOT/internal/appui/dist" -mindepth 1 ! -name .gitkeep -exec rm -rf {} + 2>/dev/null || true
    rm -rf "$tmp"
}
trap cleanup EXIT

rand() { openssl rand -hex 16; }

# 1) 콘솔 번들 → 게이트웨이 바이너리
if [ ! -s "$ROOT/web/dist/index.html" ]; then
    (cd "$ROOT/web" && corepack pnpm install --frozen-lockfile && VITE_UI_VERSION=guide corepack pnpm build)
fi
cp -R "$ROOT/web/dist/." "$ROOT/internal/appui/dist/"
(cd "$ROOT" && go build -ldflags "-X vibe-coders/internal/proxy.AppVersion=$(git -C "$ROOT" describe --tags --abbrev=0 2>/dev/null || echo dev)" -o "$tmp/gateway" ./cmd/gateway)

# 2) 가짜 업스트림 — 어떤 모델을 물어도 짧은 답과 usage 를 돌려준다
node - "$MOCK_PORT" >"$tmp/mock.log" 2>&1 <<'NODE' &
const http = require("node:http");
const port = Number(process.argv[2]);
const models = ["gpt-4.1-mini", "gpt-4.1", "claude-sonnet-4", "qwen-coder"];
http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      if (req.url.endsWith("/models")) {
        res.end(JSON.stringify({ object: "list", data: models.map((id) => ({ id, object: "model" })) }));
        return;
      }
      let model = "gpt-4.1-mini";
      let promptTokens = 120;
      try {
        const parsed = JSON.parse(body);
        model = parsed.model || model;
        promptTokens = Math.max(40, Math.round(JSON.stringify(parsed.messages || []).length / 4));
      } catch {}
      const completion = 60 + Math.floor(Math.random() * 400);
      setTimeout(() => {
        res.end(
          JSON.stringify({
            id: "chatcmpl-guide",
            object: "chat.completion",
            model,
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "요청하신 함수를 리팩터링했습니다. 테스트를 함께 갱신했습니다." },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: promptTokens, completion_tokens: completion, total_tokens: promptTokens + completion },
          }),
        );
      }, 80 + Math.floor(Math.random() * 500));
    });
  })
  .listen(port, "127.0.0.1");
NODE
pids+=($!)

# 3) 일회용 게이트웨이 — 로그인 계정과 비밀값은 이 실행 안에서만 산다
ADMIN_EMAIL="admin@example.com"
ADMIN_PASSWORD="$(rand)"
KEY_HONG="$(rand)"; KEY_KIM="$(rand)"; KEY_LEE="$(rand)"
env -i PATH="$PATH" HOME="$tmp" \
    LISTEN_ADDR="127.0.0.1:$PORT" \
    DB_DRIVER=sqlite DB_DSN="$tmp/gateway.db" LOG_FALLBACK_PATH="$tmp/fallback.ndjson" \
    UPSTREAM_PROVIDER=openai UPSTREAM_BASE_URL="http://127.0.0.1:$MOCK_PORT" UPSTREAM_API_KEY="$(rand)" \
    AUTH_ENABLED=true AUTH_JWT_SECRET="$(rand)" \
    AUTH_ADMIN_BOOTSTRAP_EMAIL="$ADMIN_EMAIL" AUTH_ADMIN_BOOTSTRAP_PASSWORD="$ADMIN_PASSWORD" \
    ADMIN_TOKEN="$(rand)" GATEWAY_SECRET="$(rand)" \
    UI_APP_ENABLED=true \
    PROXY_API_KEYS="hong:$KEY_HONG:hong@example.com:platform,kim:$KEY_KIM:kim@example.com:backend,lee:$KEY_LEE:lee@example.com:data" \
    MODEL_PRICING_KRW_PER_1M='{"gpt-4.1-mini":{"input_krw_per_1m":540,"output_krw_per_1m":2160},"gpt-4.1":{"input_krw_per_1m":2700,"output_krw_per_1m":10800},"claude-sonnet-4":{"input_krw_per_1m":4050,"output_krw_per_1m":20250},"qwen-coder":{"input_krw_per_1m":150,"output_krw_per_1m":450}}' \
    "$tmp/gateway" >"$tmp/gateway.log" 2>&1 &
pids+=($!)

for _ in $(seq 1 60); do curl -sf "$BASE_URL/ready" >/dev/null 2>&1 && break; sleep 0.5; done
curl -sf "$BASE_URL/ready" >/dev/null || { echo "게이트웨이가 뜨지 않았습니다:" >&2; cat "$tmp/gateway.log" >&2; exit 1; }

# 4) 화면을 채울 트래픽 — 세 사용자, 네 모델, 세션·도구 호출을 섞는다
chat() { # $1=키 $2=모델 $3=세션 $4=프롬프트
    curl -s -o /dev/null "$BASE_URL/v1/chat/completions" \
        -H "Authorization: Bearer $1" -H "Content-Type: application/json" \
        -H "X-Vibe-Session: $3" -H "X-Vibe-Tool: roo-code" \
        -d "{\"model\":\"$2\",\"messages\":[{\"role\":\"system\",\"content\":\"You are a coding assistant.\"},{\"role\":\"user\",\"content\":\"$4\"}]}"
}
prompts=("main.go 의 에러 처리를 정리해줘" "이 SQL 쿼리에 인덱스를 추천해줘" "React 컴포넌트에 로딩 상태를 추가해줘" "테스트 케이스를 더 만들어줘" "이 함수의 시간 복잡도를 설명해줘" "README 설치 절을 다듬어줘")
i=0
for round in 1 2 3; do
    for key in "$KEY_HONG" "$KEY_KIM" "$KEY_LEE"; do
        for model in gpt-4.1-mini claude-sonnet-4 gpt-4.1 qwen-coder; do
            chat "$key" "$model" "sess-$round-${key:0:6}" "${prompts[$((i % ${#prompts[@]}))]}"
            i=$((i + 1))
        done
    done
done
# 사용량 화면의 "본인 홈"이 비지 않도록 관리자 계정으로 Chat 테스트도 한 번 흘린다
sleep 2

# 5) 캡처
GUIDE_CAPTURE_BASE_URL="$BASE_URL" GUIDE_CAPTURE_EMAIL="$ADMIN_EMAIL" GUIDE_CAPTURE_PASSWORD="$ADMIN_PASSWORD" \
GUIDE_CAPTURE_OUT="$OUT" GUIDE_CAPTURE_BROWSER="${GUIDE_CAPTURE_BROWSER:-}" \
    node "$ROOT/web/scripts/guide-screenshots.mjs"
echo "캡처 완료: $OUT"
