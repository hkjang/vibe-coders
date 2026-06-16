package proxy

import (
	"sort"
	"strings"

	"vibe-coders/internal/store"
)

// skillFinding is one security issue detected in a skill definition.
type skillFinding struct {
	Severity string `json:"severity"` // high | medium | low
	Category string `json:"category"`
	Detail   string `json:"detail"`
}

// skillScanResult is the security scan verdict for a skill.
type skillScanResult struct {
	Findings    []skillFinding `json:"findings"`
	MaxSeverity string         `json:"max_severity"` // "" | low | medium | high
	HighCount   int            `json:"high_count"`
	MediumCount int            `json:"medium_count"`
	LowCount    int            `json:"low_count"`
	Clean       bool           `json:"clean"`
}

// destructiveSkillPatterns are dangerous operations that should not appear verbatim in a
// skill's instructions (lowercased substring match). Skills are manuals, not scripts, so a
// literal destructive command is a strong smell.
var destructiveSkillPatterns = []string{
	"rm -rf", "drop table", "drop database", "truncate table", "delete from ",
	"shutdown", "mkfs", "format c:", ":(){:|:&};:", "curl http", "wget http",
	"| bash", "| sh", "sudo ", "chmod 777", "git push --force", "force push",
}

// scanSkillSecurity inspects a skill's instructions, metadata, and policy hints for security
// issues: embedded secrets, prompt-injection phrasing, destructive commands, and policy
// hygiene (unrestricted models/tools for risky or production skills). It never returns raw
// secret values — only the detected secret type.
func scanSkillSecurity(sk store.Skill) skillScanResult {
	findings := []skillFinding{}
	text := sk.Instructions + "\n" + sk.Metadata

	// Embedded secrets (report type only, never the value).
	seenSecret := map[string]bool{}
	for _, f := range detectSecretsInText(text) {
		if seenSecret[f.Type] {
			continue
		}
		seenSecret[f.Type] = true
		findings = append(findings, skillFinding{Severity: "high", Category: "embedded_secret",
			Detail: "instructions/metadata contain a " + f.Type + " — store secrets outside the skill"})
	}

	// Prompt-injection / jailbreak phrasing baked into the instructions.
	if labels, _ := detectPromptInjection(sk.Instructions); len(labels) > 0 {
		findings = append(findings, skillFinding{Severity: "high", Category: "prompt_injection",
			Detail: "instructions contain injection/jailbreak phrasing: " + strings.Join(labels, ", ")})
	}

	// Destructive commands appearing literally in instructions.
	lower := strings.ToLower(sk.Instructions)
	hitDestructive := []string{}
	for _, p := range destructiveSkillPatterns {
		if strings.Contains(lower, p) {
			hitDestructive = append(hitDestructive, strings.TrimSpace(p))
		}
	}
	if len(hitDestructive) > 0 {
		findings = append(findings, skillFinding{Severity: "medium", Category: "destructive_instruction",
			Detail: "instructions reference destructive operations: " + strings.Join(hitDestructive, ", ")})
	}

	// Policy hygiene.
	noTools := strings.TrimSpace(sk.AllowedTools) == ""
	noModels := strings.TrimSpace(sk.AllowedModels) == ""
	if sk.RiskLevel == "high" && noTools {
		findings = append(findings, skillFinding{Severity: "medium", Category: "unrestricted_tools",
			Detail: "high-risk skill has no allowed_tools restriction (any tool permitted)"})
	}
	if sk.RiskLevel == "high" && noModels {
		findings = append(findings, skillFinding{Severity: "low", Category: "unrestricted_models",
			Detail: "high-risk skill has no allowed_models restriction (any model permitted)"})
	}
	if sk.Status == "production" && strings.TrimSpace(sk.Instructions) == "" {
		findings = append(findings, skillFinding{Severity: "medium", Category: "missing_instructions",
			Detail: "production skill has empty instructions"})
	}

	// Stable order: severity desc, then category.
	rank := map[string]int{"high": 0, "medium": 1, "low": 2}
	sort.SliceStable(findings, func(i, j int) bool {
		if rank[findings[i].Severity] != rank[findings[j].Severity] {
			return rank[findings[i].Severity] < rank[findings[j].Severity]
		}
		return findings[i].Category < findings[j].Category
	})

	res := skillScanResult{Findings: findings, Clean: len(findings) == 0}
	for _, f := range findings {
		switch f.Severity {
		case "high":
			res.HighCount++
		case "medium":
			res.MediumCount++
		case "low":
			res.LowCount++
		}
	}
	switch {
	case res.HighCount > 0:
		res.MaxSeverity = "high"
	case res.MediumCount > 0:
		res.MaxSeverity = "medium"
	case res.LowCount > 0:
		res.MaxSeverity = "low"
	}
	return res
}
