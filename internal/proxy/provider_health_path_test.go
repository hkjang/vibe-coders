package proxy

import (
	"regexp"
	"strings"
	"testing"
)

// providerHealthMap is called two or three times per request, and the uncached
// ProviderHealthScores reads every request_logs row in its window. Calling the uncached
// form from here makes the cost of one request grow with how much traffic the gateway has
// recently served — measured at 190ms per request once fifty thousand rows are in the
// window, which is around fifty requests a second.
//
// The obvious way to reintroduce that is to "fix" a freshness complaint by reverting to
// the exact call, so the build says no. Freshness is not the lever here: the window is
// fifteen minutes and the cache holds for three seconds.
func TestTheRequestPathUsesTheCachedProviderHealth(t *testing.T) {
	src := readProxyFile(t, "intelligent_routing.go")

	start := strings.Index(src, "func (s *Server) providerHealthMap(")
	if start < 0 {
		t.Fatal("providerHealthMap is gone; this check needs rewriting against whatever replaced it")
	}
	end := strings.Index(src[start+1:], "\nfunc ")
	if end < 0 {
		t.Fatal("could not find the end of providerHealthMap")
	}
	body := src[start : start+1+end]

	if !strings.Contains(body, "ProviderHealthWindow(") {
		t.Error("providerHealthMap does not call ProviderHealthWindow, the cached form.\n" +
			"It runs several times per request and the uncached form scans every request_logs\n" +
			"row in the window, so this makes the gateway slower the busier it gets.")
	}
	if regexp.MustCompile(`ProviderHealthScores\(`).MatchString(body) {
		t.Error("providerHealthMap calls ProviderHealthScores, which is the uncached form.\n" +
			"Use ProviderHealthWindow; the uncached one is for admin screens that ask about a\n" +
			"specific instant.")
	}
}
