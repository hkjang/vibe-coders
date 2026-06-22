package proxy

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestDoctorRank(t *testing.T) {
	if doctorRank("fail") <= doctorRank("warn") || doctorRank("warn") <= doctorRank("pass") {
		t.Fatalf("rank ordering wrong: fail=%d warn=%d pass=%d", doctorRank("fail"), doctorRank("warn"), doctorRank("pass"))
	}
	if doctorRank("unknown") != 0 {
		t.Fatalf("unknown rank should be 0")
	}
}

func TestMCPClientsClassification(t *testing.T) {
	if !mcpClients["cursor"] || !mcpClients["claude-desktop-mcp"] {
		t.Fatal("cursor/claude-desktop-mcp should be MCP clients")
	}
	if mcpClients["openai-sdk"] {
		t.Fatal("openai-sdk should not be an MCP client")
	}
}

func TestConnectionDoctorMethodNotAllowed(t *testing.T) {
	s := &Server{}
	req := httptest.NewRequest(http.MethodGet, "http://gw.local/me/connection-doctor", nil)
	rec := httptest.NewRecorder()
	s.handleConnectionDoctor(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", rec.Code)
	}
}
