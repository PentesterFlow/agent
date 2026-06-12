import { useState, type ReactNode } from "react";

type Tab = { id: string; label: string; copy: string; body: ReactNode };

const TABS: Tab[] = [
  {
    id: "unix",
    label: "macOS / Linux",
    copy: "curl -fsSL https://raw.githubusercontent.com/PentesterFlow/agent/main/install.sh | sh",
    body: (
      <code>
        <span className="c-c"># macOS / Linux</span>{"\n"}
        <span className="c-p">curl</span> -fsSL https://raw.githubusercontent.com/PentesterFlow/agent/main/install.sh | <span className="c-p">sh</span>
      </code>
    ),
  },
  {
    id: "win",
    label: "Windows",
    copy: "irm https://raw.githubusercontent.com/PentesterFlow/agent/main/install.ps1 | iex",
    body: (
      <code>
        <span className="c-c"># Windows PowerShell</span>{"\n"}
        <span className="c-p">irm</span> https://raw.githubusercontent.com/PentesterFlow/agent/main/install.ps1 | <span className="c-p">iex</span>
      </code>
    ),
  },
  {
    id: "quick",
    label: "Quickstart",
    copy: "ollama pull qwen2.5-coder:32b\npentesterflow",
    body: (
      <code>
        <span className="c-c"># pull a local model, then launch</span>{"\n"}
        <span className="c-p">ollama</span> pull qwen2.5-coder:32b{"\n"}
        <span className="c-p">pentesterflow</span>{"\n\n"}
        <span className="c-c"># inside the CLI</span>{"\n"}
        <span className="c-g">/target</span> https://app.example.com{"\n"}
        map the authenticated API surface and test for IDOR
      </code>
    ),
  },
];

export function Install() {
  const [active, setActive] = useState("unix");
  const [done, setDone] = useState(false);
  const tab = TABS.find((t) => t.id === active)!;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(tab.copy);
    } catch {
      /* clipboard unavailable */
    }
    setDone(true);
    window.setTimeout(() => setDone(false), 1500);
  };

  return (
    <div className="install">
      <div className="install__tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            className="install__tab"
            data-active={t.id === active}
            role="tab"
            aria-selected={t.id === active}
            onClick={() => setActive(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="install__body">
        <button className="copy" data-done={done} onClick={copy}>
          {done ? "copied ✓" : "copy"}
        </button>
        <pre>{tab.body}</pre>
      </div>
    </div>
  );
}
