import { Link, createFileRoute } from "@tanstack/react-router";
import { Reveal } from "../components/Reveal";

const REPO = "https://github.com/PentesterFlow/agent";

type Entry = {
  version: string;
  date: string;
  title: string;
  summary: string;
  changes: { kind: "Added" | "Changed" | "Fixed"; text: string }[];
};

const ENTRIES: Entry[] = [
  {
    version: "0.2.0",
    date: "2026-06-06",
    title: "Hardening, model tuning & a transcript overhaul",
    summary:
      "A pass over the permission model, Kimi K2.6/K2.5 behavior, and making long-running turns legible — plus Claude Code-style permission bypass.",
    changes: [
      { kind: "Added", text: "--yolo flag and a pinned SuperMode status badge when approvals are skipped." },
      { kind: "Added", text: "temperature and max_tokens config options, auto-omitted for models that reject them." },
      { kind: "Added", text: "Markdown tables/links and severity-colored finding cards in the transcript." },
      { kind: "Changed", text: "Session-scoped approvals keyed to the exact command, origin, or path — not the bare tool name." },
      { kind: "Changed", text: "Kimi auto-compaction sized to the real 256K context window instead of the generic 16K default." },
      { kind: "Fixed", text: "\"Stuck on planning\" — streaming now advances to \"answering\" on the first delta." },
    ],
  },
  {
    version: "0.1.6",
    date: "2026-05-22",
    title: "Standalone binaries & continuous learning",
    summary:
      "Installer-managed standalone binaries (Bun baseline runtime, no AVX2) and the local continuous-learning system that sharpens future sessions.",
    changes: [
      { kind: "Added", text: "Project + personal intelligence stores written to scenarios.jsonl with secret redaction." },
      { kind: "Added", text: "Five-minute automatic context snapshots and resume recap on --resume." },
      { kind: "Changed", text: "Coverage tracking now crosses endpoint × parameter × vuln-class for /next suggestions." },
    ],
  },
  {
    version: "0.1.0",
    date: "2026-04-30",
    title: "First public preview",
    summary:
      "The initial agent loop, ten built-in skills, eight model backends, and the curl-first, permission-gated execution model.",
    changes: [
      { kind: "Added", text: "Plan → act → observe loop with per-turn step caps and skill-based tool gating." },
      { kind: "Added", text: "Built-in skills: recon, webvuln, ssrf, ssti, jwt, graphql, race, takeover, supabase, deserialize." },
      { kind: "Added", text: "Evidence-backed confirm_finding writing to ./findings/<slug>.md." },
    ],
  },
];

const KIND_COLOR: Record<Entry["changes"][number]["kind"], string> = {
  Added: "var(--green)",
  Changed: "var(--blue)",
  Fixed: "var(--orange)",
};

function Blog() {
  return (
    <>
      <section className="page-head">
        <div className="wrap">
          <Reveal>
            <span className="eyebrow">// changelog</span>
            <h1>Blog &amp; releases</h1>
            <p>
              Release notes and product updates for PentesterFlow. Every entry maps to a tagged
              release — the full history lives in the repository changelog.
            </p>
          </Reveal>
        </div>
      </section>

      <section className="section">
        <div className="wrap" style={{ maxWidth: 820 }}>
          {ENTRIES.map((e, i) => (
            <Reveal as="article" delay={(i % 3) * 0.05} key={e.version}>
              <article className="card" style={{ marginBottom: "1.1rem" }}>
                <div style={{ display: "flex", alignItems: "center", gap: ".7rem", flexWrap: "wrap" }}>
                  <span className="skill__tag">v{e.version}</span>
                  <span style={{ fontFamily: "var(--mono)", fontSize: ".78rem", color: "var(--muted-fg)" }}>
                    {e.date}
                  </span>
                </div>
                <h3 style={{ marginTop: ".8rem" }}>{e.title}</h3>
                <p>{e.summary}</p>
                <ul style={{ listStyle: "none", marginTop: "1rem", display: "grid", gap: ".55rem" }}>
                  {e.changes.map((c, ci) => (
                    <li key={ci} style={{ display: "flex", gap: ".7rem", alignItems: "baseline" }}>
                      <span
                        style={{
                          fontFamily: "var(--mono)", fontSize: ".68rem", fontWeight: 600,
                          color: KIND_COLOR[c.kind], border: "1px dashed var(--border)",
                          borderRadius: 5, padding: ".12rem .4rem", flex: "none", minWidth: "4.6rem", textAlign: "center",
                        }}
                      >
                        {c.kind}
                      </span>
                      <span style={{ color: "var(--muted-fg)", fontSize: ".92rem" }}>{c.text}</span>
                    </li>
                  ))}
                </ul>
              </article>
            </Reveal>
          ))}
          <Reveal>
            <div style={{ display: "flex", gap: ".75rem", flexWrap: "wrap", marginTop: ".4rem" }}>
              <a className="btn btn--ghost" href={`${REPO}/blob/main/CHANGELOG.md`} target="_blank" rel="noopener">
                Full changelog ↗
              </a>
              <Link className="btn btn--ghost" to="/">← back to overview</Link>
            </div>
          </Reveal>
        </div>
      </section>
    </>
  );
}

export const Route = createFileRoute("/blog")({ component: Blog });
