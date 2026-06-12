import { Link, createFileRoute } from "@tanstack/react-router";
import { NAV } from "../docs/content";

function DocsIndex() {
  return (
    <article className="doc">
      <span className="eyebrow">// documentation</span>
      <h1 className="doc__title">PentesterFlow docs</h1>
      <p className="doc__lead">
        Everything needed to install, configure, and run PentesterFlow across the full engagement —
        generated from the codebase. Pick a topic from the sidebar, or start with the groups below.
      </p>

      {NAV.map((group) => (
        <section key={group.label} className="doc-group">
          <h2>{group.label}</h2>
          <div className="doc-cards">
            {group.items.map((it) => (
              <Link key={it.slug} to="/docs/$slug" params={{ slug: it.slug }} className="doc-card">
                <span className="doc-card__title">{it.title}</span>
                <span className="doc-card__arrow">→</span>
              </Link>
            ))}
          </div>
        </section>
      ))}
    </article>
  );
}

export const Route = createFileRoute("/docs/")({ component: DocsIndex });
