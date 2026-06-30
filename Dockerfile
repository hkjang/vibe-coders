# syntax=docker/dockerfile:1.7
FROM golang:1.26-alpine AS build
WORKDIR /src

ENV CGO_ENABLED=0 \
    GOFLAGS=-trimpath \
    GO111MODULE=on

COPY go.mod go.sum ./
RUN go mod download

COPY . .

ARG TARGETOS=linux
ARG TARGETARCH=amd64
ARG VERSION=dev
RUN GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -ldflags "-s -w -X main.version=${VERSION}" -o /out/gateway ./cmd/gateway

FROM gcr.io/distroless/static:nonroot AS runtime
WORKDIR /app
USER nonroot:nonroot

COPY --from=build /out/gateway /app/gateway

ENV LISTEN_ADDR=:8080 \
    DB_DRIVER=sqlite \
    DB_DSN=/data/gateway.db \
    LOG_FALLBACK_PATH=/data/fallback.ndjson

VOLUME ["/data"]
EXPOSE 8080

ENTRYPOINT ["/app/gateway"]
