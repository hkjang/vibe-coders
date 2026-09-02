package proxy

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"sync"
	"testing"

	"vibe-coders/internal/secret"
	"vibe-coders/internal/store"
)

func TestProviderRefIsStableURLSafeAndSeparatesDisplayCollisions(t *testing.T) {
	serverA, _, _ := newAdminModelsTestServer(t, "")
	serverB, _, _ := newAdminModelsTestServer(t, "")
	unsafeA := "sk-ant-first-provider-secret"
	unsafeB := "Bearer second-provider-secret"
	if boundedModelsProviderLabel(unsafeA) != boundedModelsProviderLabel(unsafeB) {
		t.Fatal("test requires colliding redacted display labels")
	}
	refA := serverA.providerRef(unsafeA)
	if refA != serverA.providerRef(unsafeA) || refA != serverB.providerRef(unsafeA) {
		t.Fatal("provider ref is not stable across calls and same-secret servers")
	}
	if refA == serverA.providerRef(unsafeB) || refA == serverA.providerRef("vibe") || refA == serverA.providerRef("*") {
		t.Fatal("provider ref did not preserve distinct raw/system identities")
	}
	if len(refA) != providerRefLength || !regexp.MustCompile(`^prv_[A-Za-z0-9_-]{43}$`).MatchString(refA) {
		t.Fatalf("provider ref is not bounded URL-safe text: %q", refA)
	}
	for _, sentinel := range []string{"*", "vibe", "aggregate", "[provider-name-omitted]"} {
		if serverA.providerRef(sentinel) == serverA.systemProviderRef(sentinel) {
			t.Fatalf("physical and system provider refs collided for %q", sentinel)
		}
	}
}

func TestProviderAuditJSONIsStableAcrossSecretRotation(t *testing.T) {
	server, _, _ := newAdminModelsTestServer(t, "")
	provider := store.ProviderConfig{
		Name: "sk-ant-legacy-audit-secret", BaseURL: "https://provider.example", Enabled: true,
	}
	before := providerAuditJSON(provider)
	rotated, err := secret.New("rotated-audit-reference-secret")
	if err != nil {
		t.Fatal(err)
	}
	server.secrets.Store(rotated)
	after := providerAuditJSON(provider)
	if before != after {
		t.Fatalf("provider audit changed after secret rotation: before=%s after=%s", before, after)
	}
	if strings.Contains(after, provider.Name) || strings.Contains(after, "provider_ref") || !strings.Contains(after, "[provider-name-omitted]") {
		t.Fatalf("provider audit contains an unstable or unsafe identity: %s", after)
	}
}

func TestAdminModelsProviderRefsSeparatePhysicalAndSystemIdentities(t *testing.T) {
	server, _, _ := newAdminModelsTestServer(t, "")
	refs := server.providerRefsSnapshot()
	response := adminModelsResponse{
		Models: []adminModel{
			{ID: "physical", Provider: "vibe", OwnedBy: "vibe"},
			{ID: "virtual", Provider: "vibe", ProviderRef: refs.system("vibe"), OwnedBy: "agent-route"},
		},
		Providers: []adminModelProvider{
			{Provider: "vibe"},
			{Provider: "vibe", ProviderRef: refs.system("vibe"), Source: adminModelSourceAgentRoute},
		},
		PartialFailures: []adminModelPartialFailure{{
			Provider: "*", ProviderRef: refs.system("*"), Code: "models_response_limit_exceeded", Message: "truncated",
		}},
	}
	recorder := httptest.NewRecorder()
	writeAdminModelsResponse(recorder, response, refs.physical)
	if recorder.Code != 200 {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	var got adminModelsResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Models[0].ProviderRef != refs.physical("vibe") || got.Models[1].ProviderRef != refs.system("vibe") || got.Models[0].ProviderRef == got.Models[1].ProviderRef {
		t.Fatalf("physical/system model identities collided: %+v", got.Models)
	}
	if got.Providers[0].ProviderRef != refs.physical("vibe") || got.Providers[1].ProviderRef != refs.system("vibe") {
		t.Fatalf("physical/system provider identities collided: %+v", got.Providers)
	}
	if got.PartialFailures[0].ProviderRef != refs.system("*") || got.PartialFailures[0].ProviderRef == refs.physical("*") {
		t.Fatalf("global failure did not use system namespace: %+v", got.PartialFailures)
	}
}

func TestAdminModelsHandlerSeparatesLegacyReservedProviderFromAgentProvider(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"data":[{"id":"physical-vibe"}]}`))
	}))
	t.Cleanup(upstream.Close)
	server, db, gateway := newAdminModelsTestServer(t, "")
	addAdminModelsProvider(t, server, db, store.ProviderConfig{
		Name: "vibe", BaseURL: upstream.URL, TimeoutMS: 1_000, Enabled: true,
	}, "provider-secret")
	if err := db.UpsertAgentRoute(t.Context(), store.AgentRoute{
		ID: "agent-vibe", VirtualModel: "virtual-vibe", Name: "Agent", Enabled: true,
	}); err != nil {
		t.Fatal(err)
	}

	response, body := getAdminModels(t, gateway.URL+"/admin/models?provider=vibe", "")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status=%d body=%+v", response.StatusCode, body)
	}
	wantPhysical := server.providerRef("vibe")
	wantSystem := server.systemProviderRef("vibe")
	if wantPhysical == wantSystem {
		t.Fatal("test precondition failed: physical and system refs collided")
	}
	seenProviders := map[adminModelSource]string{}
	for _, provider := range body.Providers {
		seenProviders[provider.Source] = provider.ProviderRef
	}
	if seenProviders[adminModelSourceLive] != wantPhysical || seenProviders[adminModelSourceAgentRoute] != wantSystem {
		t.Fatalf("provider summaries did not preserve separate identities: %+v", body.Providers)
	}
	seenModels := map[adminModelSource]string{}
	for _, model := range body.Models {
		seenModels[model.Source] = model.ProviderRef
	}
	if seenModels[adminModelSourceLive] != wantPhysical || seenModels[adminModelSourceAgentRoute] != wantSystem {
		t.Fatalf("model rows did not preserve separate identities: %+v", body.Models)
	}
}

func TestAdminModelsProviderRefsUseOneSecretEpochDuringRotation(t *testing.T) {
	server, _, _ := newAdminModelsTestServer(t, "")
	provider := "sk-ant-provider-reference-must-never-leak"
	providerRef := server.providerRefSnapshot()
	want := providerRef(provider)

	first, err := secret.New("rotated-provider-reference-secret-a")
	if err != nil {
		t.Fatal(err)
	}
	second, err := secret.New("rotated-provider-reference-secret-b")
	if err != nil {
		t.Fatal(err)
	}
	stop := make(chan struct{})
	started := make(chan struct{})
	var rotations sync.WaitGroup
	rotations.Add(1)
	go func() {
		defer rotations.Done()
		server.secrets.Store(first)
		close(started)
		for {
			select {
			case <-stop:
				return
			default:
				server.secrets.Store(first)
				server.secrets.Store(second)
			}
		}
	}()
	<-started

	response := adminModelsResponse{
		Models: []adminModel{
			{ID: "one", Provider: provider, OwnedBy: provider},
			{ID: "two", Provider: provider, OwnedBy: provider},
		},
		Providers: []adminModelProvider{{Provider: provider}},
		PartialFailures: []adminModelPartialFailure{{
			Provider: provider,
			Code:     "provider_models_unavailable",
			Message:  "Provider model catalog is unavailable.",
		}},
	}
	recorder := httptest.NewRecorder()
	writeAdminModelsResponse(recorder, response, providerRef)
	close(stop)
	rotations.Wait()
	if recorder.Code != 200 {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	var got adminModelsResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	for _, model := range got.Models {
		if model.ProviderRef != want {
			t.Fatalf("model provider_ref mixed key epochs: got=%q want=%q", model.ProviderRef, want)
		}
	}
	if len(got.Providers) != 1 || got.Providers[0].ProviderRef != want {
		t.Fatalf("provider provider_ref mixed key epochs: %+v", got.Providers)
	}
	if len(got.PartialFailures) != 1 || got.PartialFailures[0].ProviderRef != want {
		t.Fatalf("failure provider_ref mixed key epochs: %+v", got.PartialFailures)
	}
	if want == server.providerRef(provider) {
		t.Fatal("test did not observe a secret rotation after taking the response snapshot")
	}
}
