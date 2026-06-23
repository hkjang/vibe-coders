package proxy

import (
	"net/http"
	"sort"
	"strconv"
	"strings"
)

// AI Asset SBOM — a unified dependency/ownership/verification manifest across the gateway's
// managed assets (skills, workflows, AI apps, model contracts, prompt assets). The governance
// value is surfacing what runs WITHOUT a clear owner, so teams can close accountability gaps.

type sbomEntry struct {
	Type   string   `json:"type"` // skill | workflow | app | model_contract | prompt_asset
	ID     string   `json:"id"`
	Name   string   `json:"name"`
	Owner  string   `json:"owner"`
	Status string   `json:"status"`
	Deps   string   `json:"deps"` // short human dependency summary
	Gaps   []string `json:"gaps"` // governance gaps (e.g., "owner 없음")
}

func (e *sbomEntry) flagOwner() {
	if strings.TrimSpace(e.Owner) == "" {
		e.Owner = "(미지정)"
		e.Gaps = append(e.Gaps, "owner 없음")
	}
}

// handleSBOM assembles the AI asset SBOM. GET /admin/sbom?type=
func (s *Server) handleSBOM(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	ctx := r.Context()
	typeFilter := strings.TrimSpace(r.URL.Query().Get("type"))
	entries := []sbomEntry{}

	if typeFilter == "" || typeFilter == "skill" {
		if skills, err := s.db.ListSkills(ctx, ""); err == nil {
			for _, sk := range skills {
				deps := "model: " + firstNonEmpty(sk.AllowedModels, "*") + " · tool: " + firstNonEmpty(sk.AllowedTools, "*")
				e := sbomEntry{Type: "skill", ID: sk.Name, Name: sk.Name, Owner: sk.Owner, Status: sk.Status, Deps: deps}
				e.flagOwner()
				if sk.Status == "production" && sk.RiskLevel == "high" {
					e.Gaps = append(e.Gaps, "high 위험 production")
				}
				entries = append(entries, e)
			}
		}
	}
	if typeFilter == "" || typeFilter == "workflow" {
		if wfs, err := s.db.ListWorkflows(ctx); err == nil {
			for _, wf := range wfs {
				status := "disabled"
				if wf.Enabled {
					status = "enabled"
				}
				e := sbomEntry{Type: "workflow", ID: wf.ID, Name: wf.Name, Owner: wf.CreatedBy, Status: status,
					Deps: strconv.Itoa(len(wf.Steps)) + " step"}
				e.flagOwner()
				entries = append(entries, e)
			}
		}
	}
	if typeFilter == "" || typeFilter == "app" {
		if apps, err := s.db.ListWorkApps(ctx); err == nil {
			for _, a := range apps {
				e := sbomEntry{Type: "app", ID: a.ID, Name: a.Title, Owner: a.Owner, Status: a.Status,
					Deps: strconv.Itoa(len(a.Components)) + " component"}
				e.flagOwner()
				entries = append(entries, e)
			}
		}
	}
	if typeFilter == "" || typeFilter == "model_contract" {
		if mcs, err := s.db.ListModelContracts(ctx, false); err == nil {
			for _, mc := range mcs {
				status := "disabled"
				if mc.Enabled {
					status = "enabled"
				}
				e := sbomEntry{Type: "model_contract", ID: mc.ID, Name: mc.Name, Owner: mc.CreatedBy, Status: status,
					Deps: "task: " + firstNonEmpty(mc.TaskType, "*")}
				e.flagOwner()
				entries = append(entries, e)
			}
		}
	}
	if typeFilter == "" || typeFilter == "prompt_asset" {
		if assets, err := s.db.ListPromptAssets(ctx, "", "", "", ""); err == nil {
			for _, p := range assets {
				e := sbomEntry{Type: "prompt_asset", ID: p.ID, Name: p.Name, Owner: p.ApprovedBy, Status: firstNonEmpty(p.Status, "draft"),
					Deps: "category: " + firstNonEmpty(p.Category, "-")}
				e.flagOwner()
				entries = append(entries, e)
			}
		}
	}

	// Stable order: type, then name.
	sort.SliceStable(entries, func(i, j int) bool {
		if entries[i].Type != entries[j].Type {
			return entries[i].Type < entries[j].Type
		}
		return entries[i].Name < entries[j].Name
	})

	byType := map[string]int{}
	gaps := 0
	for _, e := range entries {
		byType[e.Type]++
		if len(e.Gaps) > 0 {
			gaps++
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"total":     len(entries),
		"by_type":   byType,
		"gap_count": gaps,
		"entries":   entries,
		"note":      "게이트웨이가 관리하는 AI 자산(스킬·워크플로·앱·모델계약·프롬프트 자산)의 소유권·상태·의존성 명세입니다. gaps는 책임자 미지정 등 거버넌스 공백입니다. 원문 지침/프롬프트는 포함되지 않습니다.",
	})
}
