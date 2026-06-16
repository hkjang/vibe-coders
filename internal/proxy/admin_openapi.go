package proxy

import (
	"fmt"
	"net/http"
)

// handleOpenAPISpec serves a curated OpenAPI 3.0 document describing the gateway's main
// public and admin endpoints. It is intentionally a representative subset (not exhaustive)
// to give integrators a browsable reference. Public (no auth) so the docs are reachable.
// GET /openapi.json
func (s *Server) handleOpenAPISpec(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = fmt.Fprintf(w, openAPISpecJSON, AppVersion)
}

// handleSwaggerUI serves a Swagger UI page pointing at /openapi.json. Swagger UI assets are
// loaded from a CDN; in an air-gapped network the page won't render, but /openapi.json is
// always downloadable directly.
// GET /swagger
func (s *Server) handleSwaggerUI(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write([]byte(swaggerUIHTML))
}

const swaggerUIHTML = `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AI Gateway API — Swagger</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css">
  <style>body{margin:0}#hint{font:13px system-ui;padding:8px 14px;background:#fff3cd;color:#664d03;border-bottom:1px solid #ffe69c}</style>
</head>
<body>
  <div id="hint">오프라인(폐쇄망)에서는 Swagger UI 자산 로드가 실패할 수 있습니다. 그 경우 <a href="/openapi.json">/openapi.json</a>을 직접 내려받아 사용하세요.</div>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js" crossorigin></script>
  <script>
    window.addEventListener('load', function () {
      if (!window.SwaggerUIBundle) return;
      window.ui = SwaggerUIBundle({ url: '/openapi.json', dom_id: '#swagger-ui', deepLinking: true });
    });
  </script>
</body>
</html>`

// openAPISpecJSON is a printf template — %s is the gateway version (info.version).
const openAPISpecJSON = `{
  "openapi": "3.0.3",
  "info": {
    "title": "AI Proxy Gateway API",
    "version": "%s",
    "description": "OpenAI-compatible AI control-plane gateway. This document is a curated subset of the available endpoints."
  },
  "servers": [{ "url": "/", "description": "this gateway" }],
  "tags": [
    { "name": "inference", "description": "OpenAI-compatible inference" },
    { "name": "ops", "description": "health & metrics" },
    { "name": "auth", "description": "authentication" },
    { "name": "self-service", "description": "caller's own resources" },
    { "name": "admin", "description": "administration" },
    { "name": "okf", "description": "Open Knowledge Format" }
  ],
  "paths": {
    "/v1/chat/completions": {
      "post": {
        "tags": ["inference"],
        "summary": "Chat completions (OpenAI-compatible; supports SSE streaming and vibe/text2sql-* virtual models)",
        "security": [{ "bearerAuth": [] }],
        "responses": { "200": { "description": "completion (or text/event-stream when stream=true)" } }
      }
    },
    "/v1/models": {
      "get": { "tags": ["inference"], "summary": "List available models", "responses": { "200": { "description": "model list" } } }
    },
    "/health": { "get": { "tags": ["ops"], "summary": "Liveness", "responses": { "200": { "description": "ok" } } } },
    "/ready": { "get": { "tags": ["ops"], "summary": "Readiness", "responses": { "200": { "description": "ready" } } } },
    "/metrics": { "get": { "tags": ["ops"], "summary": "Prometheus metrics", "responses": { "200": { "description": "metrics text" } } } },
    "/auth/login": { "post": { "tags": ["auth"], "summary": "Log in (email/password) → access+refresh tokens", "responses": { "200": { "description": "tokens" } } } },
    "/auth/refresh": { "post": { "tags": ["auth"], "summary": "Exchange a refresh token for a new access token", "responses": { "200": { "description": "tokens" } } } },
    "/auth/me": { "get": { "tags": ["auth"], "summary": "Current identity, gateway version, and session expiry", "security": [{ "bearerAuth": [] }], "responses": { "200": { "description": "identity" } } } },
    "/me/keys": {
      "get": { "tags": ["self-service"], "summary": "List the caller's own API keys", "security": [{ "bearerAuth": [] }], "responses": { "200": { "description": "keys" } } },
      "post": { "tags": ["self-service"], "summary": "Issue a new API key for the caller", "security": [{ "bearerAuth": [] }], "responses": { "201": { "description": "created (plaintext secret returned once)" } } }
    },
    "/me/dashboard": { "get": { "tags": ["self-service"], "summary": "The caller's personal usage dashboard", "security": [{ "bearerAuth": [] }], "responses": { "200": { "description": "dashboard" } } } },
    "/admin/settings": { "get": { "tags": ["admin"], "summary": "List runtime settings (env overlaid with admin overrides)", "security": [{ "bearerAuth": [] }], "responses": { "200": { "description": "settings" } } } },
    "/admin/settings/by-key/{key}": {
      "put": { "tags": ["admin"], "summary": "Set a runtime setting", "security": [{ "bearerAuth": [] }], "parameters": [{ "name": "key", "in": "path", "required": true, "schema": { "type": "string" } }], "responses": { "200": { "description": "applied" } } },
      "delete": { "tags": ["admin"], "summary": "Revert a setting to its env default", "security": [{ "bearerAuth": [] }], "parameters": [{ "name": "key", "in": "path", "required": true, "schema": { "type": "string" } }], "responses": { "200": { "description": "reverted" } } }
    },
    "/admin/pricing": { "get": { "tags": ["admin"], "summary": "Effective model pricing + version history", "security": [{ "bearerAuth": [] }], "responses": { "200": { "description": "pricing" } } } },
    "/admin/requests/{id}": { "get": { "tags": ["admin"], "summary": "Request detail (prompts, response, spans, evaluations)", "security": [{ "bearerAuth": [] }], "parameters": [{ "name": "id", "in": "path", "required": true, "schema": { "type": "string" } }], "responses": { "200": { "description": "detail" } } } },
    "/admin/dw/clickhouse/overview": { "get": { "tags": ["admin"], "summary": "ClickHouse DW health overview", "security": [{ "bearerAuth": [] }], "responses": { "200": { "description": "overview" } } } },
    "/admin/dw/clickhouse/bootstrap": { "post": { "tags": ["admin"], "summary": "Create the ClickHouse rollup/fact tables (IF NOT EXISTS)", "security": [{ "bearerAuth": [] }], "responses": { "200": { "description": "created" } } } },
    "/admin/okf/documents": {
      "get": { "tags": ["okf"], "summary": "List OKF knowledge documents", "security": [{ "bearerAuth": [] }], "responses": { "200": { "description": "documents" } } },
      "post": { "tags": ["okf"], "summary": "Create/update an OKF document", "security": [{ "bearerAuth": [] }], "responses": { "201": { "description": "saved" } } }
    },
    "/admin/okf/export": { "get": { "tags": ["okf"], "summary": "Export an OKF bundle (documents + links)", "security": [{ "bearerAuth": [] }], "responses": { "200": { "description": "bundle" } } } },
    "/admin/okf/import": { "post": { "tags": ["okf"], "summary": "Import an OKF bundle", "security": [{ "bearerAuth": [] }], "responses": { "200": { "description": "imported counts" } } } }
  },
  "components": {
    "securitySchemes": {
      "bearerAuth": { "type": "http", "scheme": "bearer", "bearerFormat": "JWT or API key" }
    }
  }
}`
