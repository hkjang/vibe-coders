package proxy

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"vibe-coders/internal/store"
)

const (
	routingLearnTTL    = 2 * time.Minute
	routingLearnWindow = 7 * 24 * time.Hour
)

// routingLearnSnapshot caches the learned best-model recommendations keyed by
// "<task_type>\x00<bucket>" so the auto-router can consult them on the hot path
// without a DB query per request. Enabled gates whether the loop is active.
type routingLearnSnapshot struct {
	enabled    bool
	minSamples int
	byCell     map[string]store.RoutingRecommendation
	fetchedAt  time.Time
}

// complexityBucket mirrors the bucket boundaries used by the learning query
// (low 0-33 / medium 34-66 / high 67-100).
func complexityBucket(score int) string {
	switch {
	case score >= 67:
		return "high"
	case score >= 34:
		return "medium"
	default:
		return "low"
	}
}

func (s *Server) routingLearnCached(ctx context.Context) *routingLearnSnapshot {
	if c := s.learnCache.Load(); c != nil && time.Since(c.fetchedAt) < routingLearnTTL {
		return c
	}
	snap := &routingLearnSnapshot{byCell: map[string]store.RoutingRecommendation{}, minSamples: 20, fetchedAt: time.Now()}
	if f, found, err := s.db.GetFlag(ctx, "routing_learning_auto"); err == nil && found {
		snap.enabled = f.Value == "true" || f.Value == "1"
	}
	if f, found, err := s.db.GetFlag(ctx, "routing_learning_min_samples"); err == nil && found {
		if v, perr := strconv.Atoi(strings.TrimSpace(f.Value)); perr == nil && v > 0 {
			snap.minSamples = v
		}
	}
	if snap.enabled {
		if learning, err := s.db.RoutingLearning(ctx, time.Now().Add(-routingLearnWindow), snap.minSamples); err == nil {
			for _, rec := range learning.Recommendations {
				// Only act on confident recommendations that differ from the de-facto choice.
				if rec.Confident && rec.RecommendedModel != "" {
					snap.byCell[rec.TaskType+"\x00"+rec.Bucket] = rec
				}
			}
		}
	}
	s.learnCache.Store(snap)
	return snap
}

func (s *Server) invalidateLearnCache() { s.learnCache.Store(nil) }

// learnedModelFor returns the learned best model for a (taskType, complexity) cell
// when the learning loop is enabled and a confident recommendation exists.
func (s *Server) learnedModelFor(ctx context.Context, taskType string, complexityScore int) (string, string, bool) {
	snap := s.routingLearnCached(ctx)
	if !snap.enabled {
		return "", "", false
	}
	if taskType == "" {
		taskType = "other"
	}
	rec, ok := snap.byCell[taskType+"\x00"+complexityBucket(complexityScore)]
	if !ok || rec.RecommendedModel == "" {
		return "", "", false
	}
	reason := "routing learning: " + rec.RecommendedModel + " best for " + taskType + "/" + rec.Bucket +
		" (success " + strconv.FormatFloat(rec.SuccessRate*100, 'f', 0, 64) + "%, " + strconv.FormatInt(rec.Samples, 10) + " samples)"
	return rec.RecommendedModel, reason, true
}

// handleRoutingLearningAuto toggles/reads the auto-apply routing-learning loop.
// GET /admin/routing/learning/auto · POST {enabled, min_samples}
func (s *Server) handleRoutingLearningAuto(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	switch r.Method {
	case http.MethodGet:
		snap := s.routingLearnCached(r.Context())
		writeJSON(w, http.StatusOK, map[string]any{"enabled": snap.enabled, "min_samples": snap.minSamples, "cells": len(snap.byCell)})
	case http.MethodPost:
		var p struct {
			Enabled    *bool `json:"enabled"`
			MinSamples *int  `json:"min_samples"`
		}
		if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
			return
		}
		if p.Enabled != nil {
			if err := s.db.SetFlag(r.Context(), store.RuntimeFlag{Key: "routing_learning_auto", Value: boolStr(*p.Enabled), UpdatedAt: time.Now().UTC(), UpdatedBy: adminID(r)}); err != nil {
				writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "learning_auto_save_failed")
				return
			}
		}
		if p.MinSamples != nil && *p.MinSamples > 0 {
			_ = s.db.SetFlag(r.Context(), store.RuntimeFlag{Key: "routing_learning_min_samples", Value: strconv.Itoa(*p.MinSamples), UpdatedAt: time.Now().UTC(), UpdatedBy: adminID(r)})
		}
		s.invalidateLearnCache()
		s.auditAdmin(r, "routing_learning.auto.set", "", auditJSON(p))
		snap := s.routingLearnCached(r.Context())
		writeJSON(w, http.StatusOK, map[string]any{"enabled": snap.enabled, "min_samples": snap.minSamples, "cells": len(snap.byCell)})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}
