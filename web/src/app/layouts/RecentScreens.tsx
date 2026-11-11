import { useRef } from "react";
import { Link } from "react-router";
import { featurePath } from "@/config/migration-registry";
import { Button } from "@/shared/components/ui/Button";
import { usePreferences } from "@/shared/stores/preferences";
import { navigationLabels as labels } from "./navigation-labels";
import { orderedNavigationItems, useNavigationItems } from "./use-navigation-items";

export function RecentScreens({ onNavigate }: { onNavigate: () => void }) {
  const available = useNavigationItems();
  const recent = usePreferences((state) => state.recentFeatures);
  const clear = usePreferences((state) => state.clearRecentFeatures);
  const heading = useRef<HTMLHeadingElement>(null);
  const items = orderedNavigationItems(recent, available);
  return (
    <section className="recent-screens" aria-label={labels.recent}>
      <h2 ref={heading} tabIndex={-1}>
        {labels.recent}
      </h2>
      {items.length ? (
        <ul>
          {items.map(({ feature }) => (
            <li key={feature.featureId}>
              <Link to={featurePath(feature)} onClick={onNavigate}>
                {feature.title}
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p role="status">{labels.emptyRecent}</p>
      )}
      <Button
        size="small"
        variant="ghost"
        disabled={recent.length === 0}
        onClick={() => {
          clear();
          heading.current?.focus();
        }}
      >
        {labels.clearRecent}
      </Button>
    </section>
  );
}
