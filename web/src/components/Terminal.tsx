import { useEffect, useRef } from "react";

type Line = { c: string; t: string; instant?: boolean; fast?: boolean; prompt?: boolean };

const SCRIPT: Line[] = [
  { c: "t-dim", t: "╭────────────────────────────────────────────────╮", instant: true },
  { c: "t-dim", t: "│  PentesterFlow                                 │", instant: true },
  { c: "t-dim", t: "│  local agent · tools ready · analyst approved  │", instant: true },
  { c: "t-dim", t: "╰────────────────────────────────────────────────╯", instant: true },
  { c: "blank", t: "" },
  { c: "t-prompt", t: "› /target https://app.example.com", prompt: true },
  { c: "t-dim", t: "  target set to https://app.example.com", instant: true, fast: true },
  { c: "blank", t: "" },
  { c: "t-prompt", t: "› test the orders API for broken access control", prompt: true },
  { c: "t-tool", t: "⏺ Skill webvuln", instant: true, fast: true },
  { c: "t-dim", t: "  ⎿ loaded skill: webvuln", instant: true, fast: true },
  { c: "t-tool", t: "⏺ http GET /api/v1/orders/1043", instant: true, fast: true },
  { c: "t-ok", t: "  ⎿ 200 OK", instant: true, fast: true },
  { c: "t-tool", t: '⏺ BashTool(curl -s -H "Authorization: Bearer $USER_B" …)', instant: true, fast: true },
  { c: "t-ok", t: "  ⎿ cross-account response confirmed", instant: true, fast: true },
  { c: "t-find", t: "⏺ Confirmed Finding (high) IDOR on /api/v1/orders/{id}", instant: true },
  { c: "t-dim", t: "  ⎿ written to ./findings/idor-orders.md", instant: true, fast: true },
];

export function Terminal() {
  const ref = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let cancelled = false;
    const timers: number[] = [];
    const wait = (ms: number) =>
      new Promise<void>((res) => timers.push(window.setTimeout(res, ms)));

    const cursor = document.createElement("span");
    cursor.className = "t-cursor";

    const addSpan = (cls: string) => {
      const s = document.createElement("span");
      if (cls && cls !== "blank") s.className = cls;
      host.appendChild(s);
      return s;
    };
    const newline = () => host.appendChild(document.createTextNode("\n"));

    async function typeLine(line: Line) {
      const span = addSpan(line.c);
      if (line.instant || reduce) {
        span.textContent = line.t;
        span.appendChild(cursor);
        newline();
        await wait(reduce ? 0 : line.fast ? 90 : 230);
        return;
      }
      const speed = line.prompt ? 26 : 18;
      for (let i = 0; i <= line.t.length; i++) {
        if (cancelled) return;
        span.textContent = line.t.slice(0, i);
        span.appendChild(cursor);
        await wait(speed + Math.random() * 16);
      }
      newline();
      await wait(line.prompt ? 360 : 150);
    }

    async function play() {
      host.textContent = "";
      for (const line of SCRIPT) {
        if (cancelled) return;
        if (line.c === "blank") {
          newline();
          await wait(reduce ? 0 : 110);
        } else {
          await typeLine(line);
        }
      }
      if (!cancelled) addSpan("").appendChild(cursor);
    }

    const io = new IntersectionObserver(
      (entries, obs) => {
        if (entries[0]?.isIntersecting) {
          obs.disconnect();
          window.setTimeout(() => { if (!cancelled) void play(); }, 320);
        }
      },
      { threshold: 0.3 }
    );
    io.observe(host);

    return () => {
      cancelled = true;
      io.disconnect();
      timers.forEach(clearTimeout);
    };
  }, []);

  return (
    <div className="terminal" aria-hidden="true">
      <div className="terminal__bar">
        <span className="tdot tdot--r" />
        <span className="tdot tdot--y" />
        <span className="tdot tdot--g" />
        <span className="terminal__title">pentesterflow — local agent</span>
      </div>
      <pre className="terminal__body" ref={ref} />
    </div>
  );
}
