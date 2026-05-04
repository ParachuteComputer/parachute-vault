import { Link, Navigate, Route, Routes } from "react-router-dom";
import { getMountedVaultName } from "./lib/mount.ts";
import { VaultDetail } from "./routes/VaultDetail.tsx";
import { VaultTokens } from "./routes/VaultTokens.tsx";
import { VaultsList } from "./routes/VaultsList.tsx";

export function App() {
  // When the SPA is mounted under a specific vault (`/vault/<name>/admin/*`
  // post-vault#252), the `/` landing page should jump straight to that
  // vault's detail page — `/vaults/list` isn't proxied by hub, so the
  // generic picker would render an empty/erroring list. The legacy origin-
  // rooted `/admin/*` and stand-alone `/` mounts still get the picker.
  const mountedVault = getMountedVaultName();
  const homeElement = mountedVault ? (
    <Navigate to={`/vault/${encodeURIComponent(mountedVault)}`} replace />
  ) : (
    <VaultsList />
  );

  return (
    <div className="page">
      <nav className="nav">
        <Link to="/" className="brand">
          Parachute Vault <span className="sub">admin</span>
        </Link>
        {mountedVault ? (
          <Link to={`/vault/${encodeURIComponent(mountedVault)}`}>
            <code>{mountedVault}</code>
          </Link>
        ) : (
          <Link to="/">Vaults</Link>
        )}
      </nav>

      <Routes>
        <Route path="/" element={homeElement} />
        <Route path="/vault/:name" element={<VaultDetail />} />
        <Route path="/vault/:name/tokens" element={<VaultTokens />} />
        <Route
          path="*"
          element={
            <div className="empty">
              404 — back to <Link to="/">vault</Link>.
            </div>
          }
        />
      </Routes>
    </div>
  );
}
