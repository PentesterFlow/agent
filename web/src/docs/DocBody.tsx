import { useState } from "react";
import type { Block } from "./content";

function CodeBlock({ text, lang }: { text: string; lang?: string }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* clipboard unavailable */
    }
    setDone(true);
    window.setTimeout(() => setDone(false), 1500);
  };
  return (
    <div className="doc-code">
      {lang && <span className="doc-code__lang">{lang}</span>}
      <button className="copy" data-done={done} onClick={copy}>
        {done ? "copied ✓" : "copy"}
      </button>
      <pre>
        <code>{text}</code>
      </pre>
    </div>
  );
}

export function DocBody({ blocks }: { blocks: Block[] }) {
  return (
    <div className="doc">
      {blocks.map((b, i) => {
        switch (b.t) {
          case "p":
            return <p key={i}>{b.text}</p>;
          case "h":
            return <h2 key={i}>{b.text}</h2>;
          case "ul":
            return (
              <ul key={i}>
                {b.items.map((it, j) => <li key={j}>{it}</li>)}
              </ul>
            );
          case "ol":
            return (
              <ol key={i}>
                {b.items.map((it, j) => <li key={j}>{it}</li>)}
              </ol>
            );
          case "code":
            return <CodeBlock key={i} text={b.text} lang={b.lang} />;
          case "note":
            return (
              <div key={i} className="doc-note">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /></svg>
                <span>{b.text}</span>
              </div>
            );
          case "table":
            return (
              <div key={i} className="doc-table-wrap">
                <table className="doc-table">
                  <thead>
                    <tr>{b.head.map((h, j) => <th key={j}>{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, ri) => (
                      <tr key={ri}>{r.map((c, ci) => <td key={ci}>{c}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          default:
            return null;
        }
      })}
    </div>
  );
}
