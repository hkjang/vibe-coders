import { ArrowDown, ArrowUp, StarOff } from "lucide-react";
import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Button } from "@/shared/components/ui/Button";
import { Dialog } from "@/shared/components/ui/Dialog";
import { MigrationStatusBadge } from "@/shared/components/page/MigrationStatus";
import { usePreferences } from "@/shared/stores/preferences";
import { navigationLabels as labels } from "./navigation-labels";
import { orderedNavigationItems, useNavigationItems } from "./use-navigation-items";

export default function FavoritesDialog({
  onClose,
  returnFocusRef,
}: {
  onClose: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}) {
  const available = useNavigationItems();
  const favorites = usePreferences((state) => state.favoriteFeatures);
  const toggle = usePreferences((state) => state.toggleFavorite);
  const move = usePreferences((state) => state.moveFavorite);
  const clear = usePreferences((state) => state.clearFavorites);
  const items = orderedNavigationItems(favorites, available);
  const rows = useRef(new Map<string, HTMLSpanElement>());
  const close = useRef<HTMLButtonElement>(null);
  const focusTarget = useRef<string | null | undefined>(undefined);
  const [announcement, setAnnouncement] = useState<{ id: string; action: "move" | "remove" }>();
  const announcedItem = available.find(({ feature }) => feature.featureId === announcement?.id);
  useLayoutEffect(() => {
    if (focusTarget.current === undefined) return;
    const target = focusTarget.current ? rows.current.get(focusTarget.current) : close.current;
    (target ?? close.current)?.focus();
    focusTarget.current = undefined;
  }, [favorites]);

  return (
    <Dialog
      open
      title={labels.manage}
      description={labels.description}
      scrollBody
      returnFocusRef={returnFocusRef}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      footer={
        <>
          <Button
            variant="secondary"
            disabled={favorites.length === 0}
            onClick={() => {
              focusTarget.current = null;
              setAnnouncement(undefined);
              clear();
            }}
          >
            {labels.clear}
          </Button>
          <Button ref={close} onClick={onClose}>
            완료
          </Button>
        </>
      }
    >
      <p className="sr-only" role="status" aria-atomic="true">
        {announcedItem
          ? `${announcedItem.feature.title} ${announcement?.action === "move" ? "순서를 변경했습니다." : "즐겨찾기를 해제했습니다."}`
          : ""}
      </p>
      {items.length ? (
        <ol className="favorite-settings-list">
          {items.map(({ feature, effective }, index) => (
            <li key={feature.featureId}>
              <div className="favorite-settings-title">
                <span
                  tabIndex={-1}
                  ref={(element) => {
                    if (element) rows.current.set(feature.featureId, element);
                    else rows.current.delete(feature.featureId);
                  }}
                >
                  {feature.title}
                </span>
                <small>{feature.group}</small>
                <MigrationStatusBadge status={effective.status} />
              </div>
              <div className="favorite-settings-actions">
                {([-1, 1] as const).map((direction) => (
                  <Button
                    key={direction}
                    size="icon"
                    variant="ghost"
                    aria-label={direction === -1 ? labels.up(feature.title) : labels.down(feature.title)}
                    title={direction === -1 ? "위로 이동" : "아래로 이동"}
                    disabled={!items[index + direction]}
                    onClick={() => {
                      const adjacent = items[index + direction];
                      if (!adjacent) return;
                      focusTarget.current = feature.featureId;
                      move(feature.featureId, adjacent.feature.featureId);
                      setAnnouncement({ id: feature.featureId, action: "move" });
                    }}
                  >
                    {direction === -1 ? <ArrowUp aria-hidden="true" /> : <ArrowDown aria-hidden="true" />}
                  </Button>
                ))}
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={labels.remove(feature.title)}
                  title="즐겨찾기 해제"
                  onClick={() => {
                    focusTarget.current =
                      items[index + 1]?.feature.featureId ?? items[index - 1]?.feature.featureId ?? null;
                    toggle(feature.featureId);
                    setAnnouncement({ id: feature.featureId, action: "remove" });
                  }}
                >
                  <StarOff aria-hidden="true" />
                </Button>
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <p className="favorite-empty">{labels.empty}</p>
      )}
    </Dialog>
  );
}
