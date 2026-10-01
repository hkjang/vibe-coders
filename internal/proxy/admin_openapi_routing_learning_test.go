package proxy

import (
	"reflect"
	"sort"
	"strings"
	"testing"
)

func TestRoutingLearningOpenAPIContract(t *testing.T) {
	spec := buildOpenAPISpec()
	paths := spec["paths"].(map[string]any)
	schemas := spec["components"].(map[string]any)["schemas"].(map[string]any)
	if schemas["RoutingLearningReport"] == nil {
		t.Fatal("learning GET lacks its actual typed report")
	}
	assertJSONOperationSchema(t, paths, "/admin/routing/learning", "get", "200", "RoutingLearningReport")
	for _, status := range []string{"401", "405", "500"} {
		assertJSONOperationSchema(t, paths, "/admin/routing/learning", "get", status, "AppError")
	}
	op := paths["/admin/routing/learning"].(map[string]any)["get"].(map[string]any)
	if op["requestBody"] != nil || op["responses"].(map[string]any)["400"] != nil {
		t.Fatal("GET has no body and normalizes invalid query values rather than inventing 400")
	}
	for name, expected := range map[string][]string{
		"RoutingLearningReport":         {"since", "min_samples", "cells", "recommendations"},
		"RoutingLearningCell":           {"task_type", "bucket", "model", "requests", "successes", "success_rate", "fallback_rate", "avg_cost_krw", "avg_latency_ms", "thumbs_up", "thumbs_down"},
		"RoutingLearningRecommendation": {"task_type", "bucket", "recommended_model", "success_rate", "avg_cost_krw", "samples", "top_model", "top_success_rate", "differs", "confident", "rationale"},
	} {
		schema := schemas[name].(map[string]any)
		props := schema["properties"].(map[string]any)
		required := append([]string(nil), schema["required"].([]string)...)
		sort.Strings(expected)
		sort.Strings(required)
		if len(props) != len(expected) || !reflect.DeepEqual(required, expected) || schema["nullable"] == true {
			t.Fatalf("actual non-null required fields differ for %s", name)
		}
		for _, field := range expected {
			property, ok := props[field].(map[string]any)
			if !ok || property["nullable"] == true {
				t.Fatalf("missing/non-null property contract %s.%s", name, field)
			}
		}
		if bucket, ok := props["bucket"].(map[string]any); ok && (bucket["type"] != "string" || bucket["enum"] != nil) {
			t.Fatal("bucket documents current values but must remain extensible")
		}
	}
	report := schemas["RoutingLearningReport"].(map[string]any)["properties"].(map[string]any)
	if report["since"].(map[string]any)["format"] != "date-time" || report["min_samples"].(map[string]any)["type"] != "integer" {
		t.Fatal("effective report time/floor types differ")
	}
	for field, ref := range map[string]string{"cells": "RoutingLearningCell", "recommendations": "RoutingLearningRecommendation"} {
		array := report[field].(map[string]any)
		if array["type"] != "array" || array["items"].(map[string]any)["$ref"] != "#/components/schemas/"+ref {
			t.Fatal("learning report arrays must use their actual item contracts")
		}
	}
	parameters := op["parameters"].([]any)
	if len(parameters) != 2 {
		t.Fatal("learning GET must describe window and min_samples only")
	}
	for _, raw := range parameters {
		parameter := raw.(map[string]any)
		if parameter["in"] != "query" || parameter["required"] != false || parameter["schema"].(map[string]any)["type"] != "string" || parameter["schema"].(map[string]any)["enum"] != nil {
			t.Fatal("existing tolerant query strings cannot become a closed enum or required parameter")
		}
	}
	for _, fragment := range []string{"routing:read", "routing:write", "0-33", "34-66", "67-100", "task_type", "not a saved-rule", "not a snapshot", "Go duration", "default 7d", "default 20", "unmasked"} {
		if !strings.Contains(op["description"].(string), fragment) {
			t.Errorf("missing learning boundary %q", fragment)
		}
	}
}
