import { Link, createFileRoute } from "@tanstack/react-router";
import { Reveal } from "../components/Reveal";
import { SECURITY } from "../data";

function Security() {
  return (
    <>
      <section className="page-head">
        <div className="wrap">
          <Reveal>
            <span className="eyebrow">// security model</span>
            <h1>Defense in depth, by default.</h1>
            <p>
              PentesterFlow is built for authorized work and keeps the analyst in control at every
              step. Permission gates, shell safeguards, SSRF and sensitive-path protection, and
              credential redaction compose into a system you can audit end to end.
            </p>
          </Reveal>
        </div>
      </section>

      <section className="section">
        <div className="wrap">
          <div className="grid-3">
            {SECURITY.map((s, i) => (
              <Reveal delay={(i % 3) * 0.05} key={s.title}>
                <div className="card sec"><h4>{s.title}</h4><p>{s.body}</p></div>
              </Reveal>
            ))}
          </div>
          <Reveal>
            <Link className="back-link" to="/">← back to overview</Link>
          </Reveal>
        </div>
      </section>
    </>
  );
}

export const Route = createFileRoute("/security")({ component: Security });
