import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "@/shared/utils/cn";

interface SectionCardProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  actions?: ReactNode;
  children: ReactNode;
  description?: ReactNode;
  title: ReactNode;
  /** Heading level; pages use h2 for top-level sections and h3 inside tabs. */
  headingLevel?: 2 | 3;
}

export function SectionCard({
  actions,
  children,
  className,
  description,
  headingLevel = 2,
  title,
  ...props
}: SectionCardProps): React.JSX.Element {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <section className={cn("section-card", className)} {...props}>
      <header className="section-card-header">
        <div>
          <Heading>{title}</Heading>
          {description ? <p>{description}</p> : null}
        </div>
        {actions ? <div className="section-card-actions">{actions}</div> : null}
      </header>
      <div className="section-card-body">{children}</div>
    </section>
  );
}
