package proxy

import (
	"errors"
	"net/http"
	"net/url"
	"strings"
	"unicode"
	"unicode/utf8"

	"vibe-coders/internal/store"
)

func validText2SQLSchemaName(name string) bool {
	return name != "" && name == strings.TrimSpace(name) && utf8.ValidString(name) && len(name) <= 2048 && utf8.RuneCountInString(name) <= 512 && strings.IndexFunc(name, func(r rune) bool { return unicode.IsControl(r) || unicode.Is(unicode.Cf, r) }) < 0
}

func text2SQLSchemaDetailQuery(raw string) (string, bool, error) {
	present := false
	for _, part := range strings.Split(raw, "&") {
		key, err := url.QueryUnescape(strings.SplitN(part, "=", 2)[0])
		if err == nil && (key == "view" || key == "name") {
			present = true
			break
		}
	}
	if !present {
		return "", false, nil
	}
	query, err := url.ParseQuery(raw)
	if err != nil || len(query) != 2 || len(query["view"]) != 1 || query.Get("view") != "schema" || len(query["name"]) != 1 || !validText2SQLSchemaName(query.Get("name")) {
		return "", true, errors.New("invalid schema detail query")
	}
	return query.Get("name"), true, nil
}

func (s *Server) writeText2SQLSchemaDetail(w http.ResponseWriter, r *http.Request, name string) {
	teams, scoped, err := requestTeamScopeForCallerChecked(s, r)
	if err != nil {
		writeOpenAIError(w, 500, "Text2SQL scope could not be resolved", "server_error", "text2sql_scope_failed")
		return
	}
	schemas, err := s.db.ListText2SQLSchemasByName(r.Context(), name)
	if err != nil {
		writeOpenAIError(w, 500, "Text2SQL schema could not be loaded", "server_error", "text2sql_schema_failed")
		return
	}
	if scoped {
		schemas = text2SQLSchemasForTeams(schemas, teams)
	}
	if len(schemas) != 1 {
		writeOpenAIError(w, 404, "Text2SQL schema is unavailable", "invalid_request_error", "schema_not_found")
		return
	}
	raw := s.canViewRawPrompts(r)
	if !raw {
		s.projectText2SQLSchemasForExternal(schemas)
	}
	writeJSON(w, 200, map[string]any{"schema": schemas[0], "raw_content_available": raw})
}

func (s *Server) projectText2SQLSchemasForExternal(schemas []store.Text2SQLSchema) {
	projectionArgs := s.externalCredentialProjectionArgs()
	project := func(value string) string { return boundedExternalProviderText(value, projectionArgs...) }
	for index := range schemas {
		schema := &schemas[index]
		schema.Team = project(schema.Team)
		schema.Name = project(schema.Name)
		schema.Dialect = project(schema.Dialect)
		schema.SchemaText = text2SQLSensitiveContentOmitted
		schema.AllowedTables = []string{}
		schema.CollectedAt = project(schema.CollectedAt)
		schema.SourceFingerprint = project(schema.SourceFingerprint)
		schema.UpdatedAt = project(schema.UpdatedAt)
	}
}
