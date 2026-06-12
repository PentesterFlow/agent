import { useState } from "react";
import { Link, Outlet, createRootRoute } from "@tanstack/react-router";
import { Brand } from "../components/Brand";
import { StarButton } from "../components/StarButton";
import { Footer } from "../components/Footer";
import { useTheme } from "../components/theme";

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" />
    </svg>
  );
}
function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  );
}
function MenuIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  );
}

function RootLayout() {
  const { theme, toggle } = useTheme();
  const [open, setOpen] = useState(false);

  return (
    <>
      <header className="nav">
        <div className="wrap nav__inner">
          <Brand />
          <nav className={`nav__links ${open ? "open" : ""}`} onClick={() => setOpen(false)}>
            <Link to="/" hash="lifecycle">Lifecycle</Link>
            <Link to="/skills">Skills</Link>
            <Link to="/security">Security</Link>
            <Link to="/docs">Docs</Link>
            <Link to="/blog">Blog</Link>
          </nav>
          <div className="nav__right">
            <button className="icon-btn" aria-label="Toggle theme" onClick={toggle}>
              {theme === "light" ? <MoonIcon /> : <SunIcon />}
            </button>
            <StarButton />
            <Link className="btn btn--primary" to="/" hash="install">Install</Link>
            <button className="icon-btn nav__menu" aria-label="Menu" onClick={() => setOpen((o) => !o)}>
              <MenuIcon />
            </button>
          </div>
        </div>
      </header>
      <main>
        <Outlet />
      </main>
      <Footer />
    </>
  );
}

export const Route = createRootRoute({ component: RootLayout });
