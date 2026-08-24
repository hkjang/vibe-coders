package store

import (
	"context"
	"time"
)

// Caching the agent routes.
//
// Every /v1 request asks whether its model name is an agent route, because that is how the
// gateway decides between the normal pipeline and the agentic one. The answer is almost
// always no, and the table it is answered from is operator-defined and small.
//
// See ttl_cache.go for how invalidation and the TTL divide the work. Writes go through
// UpsertAgentRoute and DeleteAgentRoute, so an operator adding or disabling a route sees
// it take effect on the very next request.
//
// Unlike the other cached tables, AgentRoute carries two string slices. A shallow copy
// would hand every request the same backing arrays, so they are copied out with the value.
type agentRouteCache struct {
	byModel cachedValue[map[string]AgentRoute]
}

func (c *agentRouteCache) invalidate() { c.byModel.clear() }

// cloneAgentRoute copies the slices so a caller cannot reach the cached ones.
func cloneAgentRoute(a AgentRoute) AgentRoute {
	a.MCPUpstreams = append([]string(nil), a.MCPUpstreams...)
	a.AllowedTools = append([]string(nil), a.AllowedTools...)
	return a
}

// GetAgentRouteByModel resolves a route by its virtual model name, enabled or not. The
// caller decides what a disabled route means, so disabled ones are cached too.
func (s *SQLStore) GetAgentRouteByModel(ctx context.Context, virtualModel string) (AgentRoute, bool, error) {
	now := time.Now()
	if byModel, ok := s.agentRoutes.byModel.get(now); ok {
		route, found := byModel[virtualModel]
		return cloneAgentRoute(route), found, nil
	}
	gen := s.agentRoutes.byModel.begin()
	routes, err := s.ListAgentRoutes(ctx)
	if err != nil {
		return AgentRoute{}, false, err
	}
	byModel := make(map[string]AgentRoute, len(routes))
	for _, route := range routes {
		byModel[route.VirtualModel] = route
	}
	s.agentRoutes.byModel.putIfCurrent(byModel, gen, now)
	route, found := byModel[virtualModel]
	return cloneAgentRoute(route), found, nil
}
