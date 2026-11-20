package store

// Catalog discovery is operational metadata, not inference. Apply this before
// LIMIT so busy catalog polling cannot crowd real requests out of monitor pages.
// Keep null metadata and match exact route reasons; model names never classify a row.
const excludeModelCatalogPredicate = "COALESCE(r.endpoint, '') <> '/v1/models' AND COALESCE(r.route_reason, '') NOT IN ('models_aggregate', 'model_aggregate')"
