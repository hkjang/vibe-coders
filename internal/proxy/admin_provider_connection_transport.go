package proxy

import (
	"context"
	"errors"
	"net"
	"net/http"
)

func providerConnectionFailure(ctx context.Context, err error) string {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) || errors.Is(err, context.DeadlineExceeded) {
		return "timeout"
	}
	if errors.Is(ctx.Err(), context.Canceled) || errors.Is(err, context.Canceled) {
		return "cancelled"
	}
	var timeout net.Error
	if errors.As(err, &timeout) && timeout.Timeout() {
		return "timeout"
	}
	return "connection_failed"
}

func (s *Server) probeProviderConnection(ctx context.Context, baseURL, apiKey, mode string, result providerConnectionResult) providerConnectionResult {
	req, err := s.providerModelsHTTPRequest(ctx, baseURL, apiKey)
	if err != nil {
		result.Outcome = "connection_failed"
		return result
	}
	if mode == "none" {
		req.Header.Del("Authorization")
	}
	// A per-call shallow copy keeps the established transport/egress policy,
	// without changing redirect or cookie behavior of any existing endpoint.
	// There is no application-level retry. The shared Go transport may still
	// replay an idempotent GET after a stale pooled-connection network failure.
	client := *s.client
	client.Jar = nil
	client.Timeout = 0 // The bounded parent/probe contexts own this call's budget.
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := client.Do(req)
	if err != nil {
		result.Outcome = providerConnectionFailure(ctx, err)
		return result
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 100 && resp.StatusCode <= 599 {
		result.UpstreamStatus = &resp.StatusCode
	}
	switch {
	case resp.StatusCode >= 300 && resp.StatusCode < 400:
		result.Outcome = "redirect_blocked"
		return result
	case resp.StatusCode == 401 || resp.StatusCode == 403:
		result.Outcome = "authentication_rejected"
		return result
	case resp.StatusCode < 200 || resp.StatusCode >= 300:
		result.Outcome = "upstream_rejected"
		return result
	}
	raw, err := readBoundedModelsResponseBody(resp)
	if err != nil {
		switch {
		case isProviderModelsLimitError(err):
			result.Outcome = "response_too_large"
		case ctx.Err() != nil:
			result.Outcome = providerConnectionFailure(ctx, err)
		default:
			result.Outcome = "invalid_response"
		}
		return result
	}
	models, err := decodeProviderModelsWithPolicy(raw, true)
	if err != nil {
		if isProviderModelsLimitError(err) {
			result.Outcome = "model_limit_exceeded"
		} else {
			result.Outcome = "invalid_response"
		}
		return result
	}
	if ctx.Err() != nil {
		result.Outcome = providerConnectionFailure(ctx, ctx.Err())
		return result
	}
	count := len(models)
	result.ModelCount = &count
	result.Outcome = "catalog_available"
	return result
}
