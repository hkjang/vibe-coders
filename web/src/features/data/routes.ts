import { defineFeatureModules } from "@/features/feature-module";

// Screens owned by the data domain. Register each implemented feature here.
export const dataFeatureModules = defineFeatureModules([
  {
    featureId: "data.warehouse",
    load: () => import("@/features/data/warehouse/WarehousePage").then((module) => module.WarehousePage),
    queryKeys: ["bucket", "days", "dimension", "order_by", "tab", "table", "window"],
  },
  {
    featureId: "data.products",
    load: () => import("@/features/data/products/ProductsPage").then((module) => module.ProductsPage),
    queryKeys: ["min_count", "product", "status", "tab", "window"],
  },
]);
