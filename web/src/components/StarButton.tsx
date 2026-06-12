import { useEffect, useState } from "react";
import { GitHubIcon } from "./Brand";

const REPO = "https://github.com/PentesterFlow/agent";
const API = "https://api.github.com/repos/PentesterFlow/agent";

function StarIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
      <path d="M12 2.2l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.9 6.1 20.7l1.2-6.5L2.5 9.6l6.6-.9L12 2.2z" />
    </svg>
  );
}

const fmt = (n: number) =>
  n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n);

export function StarButton() {
  const [stars, setStars] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(API, { headers: { Accept: "application/vnd.github+json" } })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (alive && d && typeof d.stargazers_count === "number") setStars(d.stargazers_count);
      })
      .catch(() => {
        /* offline / rate-limited — just hide the count */
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <a
      className="star-btn"
      href={REPO}
      target="_blank"
      rel="noopener"
      aria-label="Star PentesterFlow on GitHub"
    >
      <GitHubIcon />
      <span className="star-btn__label">Star</span>
      <span className="star-btn__count">
        <StarIcon />
        {stars === null ? "—" : fmt(stars)}
      </span>
    </a>
  );
}
