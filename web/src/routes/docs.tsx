import { useState } from "react";
import { Link, Outlet, createFileRoute } from "@tanstack/react-router";
import { NAV, REPO_URL } from "../docs/content";

function DocsSidebar({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav className="docs-side" aria-label="Documentation">
      <Link
        to="/docs"
        activeOptions={{ exact: true }}
        className="docs-side__link"
        activeProps={{ className: "docs-side__link is-active" }}
        onClick={onNavigate}
      >
        Overview
      </Link>
      {NAV.map((group) => (
        <div className="docs-side__group" key={group.label}>
          <span className="docs-side__label">{group.label}</span>
          {group.items.map((it) => (
            <Link
              key={it.slug}
              to="/docs/$slug"
              params={{ slug: it.slug }}
              className="docs-side__link"
              activeProps={{ className: "docs-side__link is-active" }}
              onClick={onNavigate}
            >
              {it.title}
            </Link>
          ))}
        </div>
      ))}
      <a className="docs-side__link docs-side__ext" href={`${REPO_URL}#readme`} target="_blank" rel="noopener">
        Repository README ↗
      </a>
    </nav>
  );
}

function DocsLayout() {
  const [open, setOpen] = useState(false);
  return (
    <div className="wrap docs-shell">
      <button className="docs-toc-toggle" onClick={() => setOpen((o) => !o)}>
        {open ? "Hide" : "Contents"}
      </button>
      <aside className={`docs-aside ${open ? "open" : ""}`}>
        <DocsSidebar onNavigate={() => setOpen(false)} />
      </aside>
      <div className="docs-main">
        <Outlet />
      </div>
    </div>
  );
}

export const Route = createFileRoute("/docs")({ component: DocsLayout });
