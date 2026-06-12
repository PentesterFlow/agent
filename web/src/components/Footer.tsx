import { Link } from "@tanstack/react-router";
import { Brand } from "./Brand";

const REPO = "https://github.com/PentesterFlow/agent";

export function Footer() {
  return (
    <footer className="footer">
      <div className="wrap footer__inner">
        <div className="footer__brand">
          <Brand />
          <p>Human-in-the-loop agentic AI CLI for authorized offensive-security work.</p>
        </div>
        <div className="footer__col">
          <h5>Project</h5>
          <a href={REPO} target="_blank" rel="noopener">Repository</a>
          <a href={`${REPO}/releases`} target="_blank" rel="noopener">Releases</a>
          <a href={`${REPO}/blob/main/CHANGELOG.md`} target="_blank" rel="noopener">Changelog</a>
        </div>
        <div className="footer__col">
          <h5>Product</h5>
          <Link to="/skills">Skills</Link>
          <Link to="/security">Security model</Link>
          <Link to="/" hash="install">Install</Link>
        </div>
        <div className="footer__col">
          <h5>Community</h5>
          <a href={`${REPO}/issues`} target="_blank" rel="noopener">Report an issue</a>
          <a href={`${REPO}/issues/new`} target="_blank" rel="noopener">Request a feature</a>
          <a href="https://github.com/PentesterFlow/Burp-Integration" target="_blank" rel="noopener">Burp integration</a>
        </div>
      </div>
      <div className="wrap footer__bar">
        <span>Apache-2.0 — use responsibly and only with authorization.</span>
        <span className="mono">$ pentesterflow --version</span>
      </div>
    </footer>
  );
}
