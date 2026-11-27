// Package workintel classifies LLM requests into business work categories and
// derives the analytics built on top of that classification (trend signals,
// automation candidates, savings estimates, insights).
//
// It is deliberately pure: no database, no net/http and no dependency on the
// proxy or store packages. The storage and HTTP layers feed it plain values
// (redacted prompt text, the task type, detected languages, MCP tool names,
// aggregated counters) and persist what it returns. That keeps the rules
// testable against a labelled fixture and lets the classification worker run
// outside the request path.
//
// # Policy
//
// A Policy is the admin-editable document: a category tree of up to three
// levels ("dev", "dev.codegen", "dev.codegen.api"), action types, thresholds,
// the LLM prompt and productivity baselines. Normalize cleans a document,
// Validate reports problems as path/message pairs and Compile turns a valid
// policy into an immutable, concurrency-safe Engine.
//
// # Rule matching
//
// Keyword matching is case-insensitive for ASCII and treats whitespace runs as
// one space. A keyword that starts with an ASCII letter or digit only matches
// at the start of a word; when its last word is four characters or shorter it
// must match the whole word (common inflections such as "tests"/"testing" are
// accepted), longer ones match as a prefix ("deploy" matches "deployment").
// Korean keywords match as substrings. When one matched keyword lies inside a
// longer matched keyword only the longer one counts, so a phrase like "코드 리뷰"
// takes precedence over a generic "리뷰".
//
// MCP hints are matched against whole segments of a server or tool name
// ("pods" matches "mcp__k8s__pods_list" but not "tripods"); a hint of six
// characters or more also matches the start of a segment ("postgres" matches
// "postgresql"), and a hint with several segments ("create_issue") must
// appear as that sequence. Tools, servers and languages each count once per
// category, however many of them a request has.
//
// A keyword, MCP hint, language, task type or client listed under several
// top-level categories is weaker evidence for each of them: its weight is
// divided by the number of top-level categories that list it. The top-level
// category "other" never competes with a substantive category; it is chosen
// only when nothing else has usable evidence, or for very short texts such as
// "hi" and "test".
package workintel
