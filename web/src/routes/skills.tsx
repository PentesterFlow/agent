import { Link, createFileRoute } from "@tanstack/react-router";
import { Reveal } from "../components/Reveal";
import { SKILLS } from "../data";

function Skills() {
  return (
    <>
      <section className="page-head">
        <div className="wrap">
          <Reveal>
            <span className="eyebrow">// built-in skills</span>
            <h1>Ten playbooks for real findings.</h1>
            <p>
              Skills are Markdown playbooks that package methodology, payloads, constraints, and
              allowed tools. Each enforces curl-first discipline — real PoC and concrete impact,
              never theoretical bugs. Discovery order lets project-local and personal skills
              override the built-ins.
            </p>
          </Reveal>
        </div>
      </section>

      <section className="section">
        <div className="wrap">
          <div className="grid-2">
            {SKILLS.map((s, i) => (
              <Reveal delay={(i % 2) * 0.05} key={s.tag}>
                <div className="skill">
                  <span className="skill__tag">/{s.tag}</span>
                  <p>{s.body}</p>
                </div>
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

export const Route = createFileRoute("/skills")({ component: Skills });
