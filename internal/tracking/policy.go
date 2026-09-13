package tracking

import "strings"

// Policy widens a page's content security policy by exactly what the snippet
// needs: the request nonce in script-src, the provider's origins in
// script-src / connect-src / img-src, and a report-uri so the browser says
// what it still refuses. The base policy is returned untouched when tracking
// is not active for the page, so turning tracking off narrows the policy back
// to what it was.
//
// 'unsafe-inline' is never added. It would allow every inline script on the
// page, and it would stay in the policy after tracking is switched off.
func Policy(base string, c Config, adminPage bool, nonce string) string {
	if !c.Active(adminPage) || nonce == "" {
		return base
	}
	scripts, connects, images := c.PolicySources()
	directives := splitDirectives(base)
	directives = appendSources(directives, "script-src", append([]string{"'nonce-" + nonce + "'"}, scripts...))
	directives = appendSources(directives, "connect-src", connects)
	directives = appendSources(directives, "img-src", images)
	directives = append(directives, "report-uri "+ReportPath)
	return strings.Join(directives, "; ")
}

func splitDirectives(policy string) []string {
	parts := strings.Split(policy, ";")
	out := make([]string, 0, len(parts)+4)
	for _, part := range parts {
		if part = strings.TrimSpace(part); part != "" {
			out = append(out, part)
		}
	}
	return out
}

// appendSources adds sources to a directive, creating it when the base
// policy has none. A directive that only says 'none' is replaced, since
// 'none' cannot be combined with other sources.
func appendSources(directives []string, name string, sources []string) []string {
	if len(sources) == 0 {
		return directives
	}
	for i, directive := range directives {
		fields := strings.Fields(directive)
		if len(fields) == 0 || !strings.EqualFold(fields[0], name) {
			continue
		}
		existing := fields[1:]
		if len(existing) == 1 && strings.EqualFold(existing[0], "'none'") {
			existing = nil
		}
		directives[i] = name + " " + strings.Join(append(existing, sources...), " ")
		return directives
	}
	return append(directives, name+" "+strings.Join(sources, " "))
}
