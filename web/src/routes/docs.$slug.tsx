import { Link, createFileRoute } from "@tanstack/react-router";
import { DocBody } from "../docs/DocBody";
import { NAV, pageBySlug } from "../docs/content";

function flatSlugs() {
  return NAV.flatMap((g) => g.items.map((i) => i.slug));
}

function DocPageView() {
  const { slug } = Route.useParams();
  const page = pageBySlug(slug);
  if (!page) {
    return (
      <article className="doc">
        <h1 className="doc__title">Not found</h1>
        <p className="doc__lead">No documentation page matches “{slug}”.</p>
        <Link className="back-link" to="/docs">← back to docs</Link>
      </article>
    );
  }

  const all = flatSlugs();
  const idx = all.indexOf(slug);
  const prev = idx > 0 ? all[idx - 1] : undefined;
  const next = idx >= 0 && idx < all.length - 1 ? all[idx + 1] : undefined;

  return (
    <article className="doc">
      <span className="eyebrow">// {page.group.toLowerCase()}</span>
      <h1 className="doc__title">{page.title}</h1>
      <p className="doc__lead">{page.description}</p>

      <DocBody blocks={page.blocks} />

      <div className="doc-pager">
        {prev ? (
          <Link to="/docs/$slug" params={{ slug: prev }} className="doc-pager__btn">
            <span>← Previous</span>
            <strong>{pageBySlug(prev)?.title}</strong>
          </Link>
        ) : <span />}
        {next ? (
          <Link to="/docs/$slug" params={{ slug: next }} className="doc-pager__btn doc-pager__btn--next">
            <span>Next →</span>
            <strong>{pageBySlug(next)?.title}</strong>
          </Link>
        ) : <span />}
      </div>
    </article>
  );
}

export const Route = createFileRoute("/docs/$slug")({ component: DocPageView });
