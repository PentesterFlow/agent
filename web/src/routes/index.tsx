import { Link, createFileRoute } from "@tanstack/react-router";
import { Terminal } from "../components/Terminal";
import { Install } from "../components/Install";
import { Reveal } from "../components/Reveal";
import { GitHubIcon } from "../components/Brand";
import {
  STATS, PILLARS, LIFECYCLE, CAPABILITIES, SKILLS, PROVIDERS, SECURITY,
} from "../data";

const REPO = "https://github.com/PentesterFlow/agent";

function Home() {
  return (
    <>
      {/* HERO */}
      <section className="hero">
        <div className="wrap hero__grid">
          <div>
            <Reveal>
              <span className="pill"><span className="dot" /> open-source · Apache-2.0 · Node 20+</span>
            </Reveal>
            <Reveal delay={0.06}>
              <h1>Agentic AI for the<br /><span className="grad">offensive security</span> terminal.</h1>
            </Reveal>
            <Reveal delay={0.12}>
              <p className="hero__lede">
                PentesterFlow is a human-in-the-loop CLI that moves through recon, enumeration,
                validation, evidence collection, and reporting — while keeping the analyst in control.
                Curl-first. Permission-gated. Every finding backed by reproduction.
              </p>
            </Reveal>
            <Reveal delay={0.18}>
              <div className="hero__cta">
                <Link className="btn btn--primary btn--lg" to="/" hash="install">
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 3v12m0 0l4-4m-4 4l-4-4M4 21h16" /></svg>
                  Install the CLI
                </Link>
                <a className="btn btn--ghost btn--lg" href={REPO} target="_blank" rel="noopener">
                  <GitHubIcon /> View on GitHub
                </a>
              </div>
            </Reveal>
            <Reveal delay={0.24}>
              <ul className="hero__stats">
                {STATS.map((s) => (
                  <li key={s.label}><strong>{s.n}</strong><span>{s.label}</span></li>
                ))}
              </ul>
            </Reveal>
          </div>
          <Reveal delay={0.1}><Terminal /></Reveal>
        </div>
      </section>

      {/* SKILL STRIP */}
      <div className="strip">
        <div className="wrap strip__inner">
          <span className="strip__label">Built-in skills</span>
          <div className="strip__items">
            {SKILLS.map((s) => <span className="chip" key={s.tag}>/{s.tag}</span>)}
          </div>
        </div>
      </div>

      {/* PILLARS */}
      <section className="section">
        <div className="wrap">
          <div className="grid-3">
            {PILLARS.map((p, i) => (
              <Reveal as="article" delay={i * 0.06} key={p.idx}>
                <div className="card">
                  <span className="card__idx">{p.idx}</span>
                  <h3>{p.title}</h3>
                  <p>{p.body}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* LIFECYCLE */}
      <section className="section section--tint" id="lifecycle">
        <div className="wrap">
          <Reveal>
            <div className="section__head">
              <span className="eyebrow">// the engagement</span>
              <h2>One loop, the whole lifecycle.</h2>
              <p>Plan, act, observe, verify, report, and learn across scoped tasks — the agent runs the cycle, you stay in the loop.</p>
            </div>
          </Reveal>
          <ol className="steps">
            {LIFECYCLE.map((s, i) => (
              <Reveal as="li" delay={(i % 2) * 0.05} key={s.n}>
                <div className="step">
                  <span className="step__n">{s.n}</span>
                  <div><h4>{s.title}</h4><p>{s.body}</p></div>
                </div>
              </Reveal>
            ))}
          </ol>
        </div>
      </section>

      {/* CAPABILITIES */}
      <section className="section" id="capabilities">
        <div className="wrap">
          <Reveal>
            <div className="section__head">
              <span className="eyebrow">// core capabilities</span>
              <h2>Built for security-specific workflows.</h2>
              <p>Where generic agents hallucinate findings and lose context, PentesterFlow brings real tooling, oversight, and reproducibility.</p>
            </div>
          </Reveal>
          <div className="grid-3">
            {CAPABILITIES.map((c, i) => (
              <Reveal as="article" delay={(i % 3) * 0.05} key={c.title}>
                <div className="card">
                  <div className="card__ico">{c.ico}</div>
                  <h3>{c.title}</h3>
                  <p>{c.body}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* SKILLS PREVIEW */}
      <section className="section section--tint" id="skills">
        <div className="wrap">
          <Reveal>
            <div className="section__head">
              <span className="eyebrow">// built-in skills</span>
              <h2>Ten playbooks. Real PoC, concrete impact.</h2>
              <p>Each skill packages methodology and payloads with curl-first discipline — no theoretical bugs.</p>
            </div>
          </Reveal>
          <div className="grid-2">
            {SKILLS.slice(0, 6).map((s, i) => (
              <Reveal delay={(i % 2) * 0.05} key={s.tag}>
                <div className="skill">
                  <span className="skill__tag">/{s.tag}</span>
                  <p>{s.body}</p>
                </div>
              </Reveal>
            ))}
          </div>
          <Reveal>
            <div style={{ marginTop: "1.5rem" }}>
              <Link className="btn btn--ghost" to="/skills">See all ten skills →</Link>
            </div>
          </Reveal>
        </div>
      </section>

      {/* PROVIDERS */}
      <section className="section" id="providers">
        <div className="wrap">
          <Reveal>
            <div className="section__head">
              <span className="eyebrow">// model backends</span>
              <h2>Local or hosted. Your choice of model.</h2>
              <p>Run private against a local model, or wire up a hosted endpoint. Eight backends behind one interface.</p>
            </div>
          </Reveal>
          <Reveal>
            <div className="strip__items">
              {PROVIDERS.map((p) => <span className="chip" key={p}>{p}</span>)}
            </div>
          </Reveal>
        </div>
      </section>

      {/* INSTALL */}
      <section className="section section--tint" id="install">
        <div className="wrap">
          <Reveal>
            <div className="section__head">
              <span className="eyebrow">// get started</span>
              <h2>Up and running in one line.</h2>
              <p>The installer fetches the standalone binary for your OS and verifies the published SHA-256.</p>
            </div>
          </Reveal>
          <Reveal><Install /></Reveal>
          <Reveal>
            <div className="warn">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /></svg>
              <span>Authorized use only. The agent can run shell commands, make HTTP requests, edit files, and process captured traffic after approval. Use it only on systems where you have explicit authorization.</span>
            </div>
          </Reveal>
        </div>
      </section>

      {/* SECURITY PREVIEW */}
      <section className="section" id="security">
        <div className="wrap">
          <Reveal>
            <div className="section__head">
              <span className="eyebrow">// security model</span>
              <h2>Defense in depth, by default.</h2>
            </div>
          </Reveal>
          <div className="grid-3">
            {SECURITY.map((s, i) => (
              <Reveal delay={(i % 3) * 0.05} key={s.title}>
                <div className="card sec"><h4>{s.title}</h4><p>{s.body}</p></div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* FINAL CTA */}
      <section className="cta">
        <div className="wrap">
          <Reveal>
            <div className="cta__inner">
              <h2>Stay in control.<br />Let the agent do the legwork.</h2>
              <div className="hero__cta">
                <a className="btn btn--primary btn--lg" href={REPO} target="_blank" rel="noopener">Star on GitHub</a>
                <Link className="btn btn--ghost btn--lg" to="/" hash="install">Install now</Link>
              </div>
            </div>
          </Reveal>
        </div>
      </section>
    </>
  );
}

export const Route = createFileRoute("/")({ component: Home });
