# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
ARG NODE_VERSION=24.20.0
ARG GO_VERSION=1.26.8
ARG VERSION=dev
ARG VCS_REF=unknown

# Multi-platform manifest digests are pinned so rebuilding an annotated release
# cannot silently pick up a different builder or runtime image.
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf AS web-build
WORKDIR /src/web

# packageManager in web/package.json pins pnpm itself. Keeping dependency installation
# in its own layer makes normal source-only changes reuse the frozen dependency graph.
RUN corepack enable
COPY web/package.json web/pnpm-lock.yaml web/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY web/ ./
ARG VERSION
ENV VITE_UI_VERSION=$VERSION
RUN pnpm build \
    && test -s dist/index.html \
    && test -d dist/assets \
    && test -n "$(find dist/assets -type f -print -quit)"

FROM --platform=$BUILDPLATFORM golang:${GO_VERSION}-alpine@sha256:34efdd6036c92e155c8b0162a5da7626586b612ea636590035602c970eece564 AS go-build
WORKDIR /src

ENV CGO_ENABLED=0 \
    GOFLAGS=-trimpath \
    GO111MODULE=on

COPY go.mod go.sum ./
RUN go mod download

COPY cmd/ ./cmd/
COPY internal/ ./internal/
COPY --from=web-build /src/web/dist/ ./internal/appui/dist/

ARG TARGETOS
ARG TARGETARCH
ARG VERSION
RUN test -s internal/appui/dist/index.html \
    && test -n "$(find internal/appui/dist/assets -type f -print -quit)" \
    && GOOS=${TARGETOS} GOARCH=${TARGETARCH} go build \
        -ldflags "-s -w -X vibe-coders/internal/proxy.AppVersion=${VERSION}" \
        -o /out/gateway \
        ./cmd/gateway \
    && mkdir -p /out/data \
    && chown 65532:65532 /out/data

FROM gcr.io/distroless/static:nonroot@sha256:1c2c046bc09ed40fad370b599a0b1ae7987f55b01e247cf27a7c27cd97e5bbc7 AS runtime
ARG VERSION
ARG VCS_REF
WORKDIR /app

LABEL org.opencontainers.image.title="vibe-coders" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.source="https://github.com/hkjang/vibe-coders"

COPY --from=go-build /out/gateway /app/gateway
COPY --from=go-build --chown=nonroot:nonroot /out/data /data

ENV LISTEN_ADDR=:8080 \
    DB_DRIVER=sqlite \
    DB_DSN=/data/gateway.db \
    LOG_FALLBACK_PATH=/data/fallback.ndjson

VOLUME ["/data"]
EXPOSE 8080

USER nonroot:nonroot
ENTRYPOINT ["/app/gateway"]
