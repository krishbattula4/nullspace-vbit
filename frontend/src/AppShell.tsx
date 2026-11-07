import { Link, Outlet } from "react-router-dom";
import { useBackendHealth } from "./lib/api";

export function AppShell() {
  const health = useBackendHealth();
  return (
    <div className="shell">
      <header className="topbar">
        <Link to="/chat" className="brand">
          Nullspace
        </Link>
        <nav>
          <Link to="/login">Login</Link>
          <Link to="/register">Register</Link>
        </nav>
        <span className={`health health-${health.state}`} title={health.detail}>
          backend: {health.state}
        </span>
      </header>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
