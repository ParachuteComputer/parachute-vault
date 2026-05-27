import { Link, Route, Routes } from "react-router-dom";
import { getMountedVaultName } from "./lib/mount.ts";
import { VaultDetail } from "./routes/VaultDetail.tsx";
import { VaultMirror } from "./routes/VaultMirror.tsx";
import { VaultTokens } from "./routes/VaultTokens.tsx";
import { VaultsList } from "./routes/VaultsList.tsx";

/**
 * The SPA carries two route shapes that don't share a tree.
 *
 * Under a per-vault mount (`/vault/<name>/admin/*` post-vault#252),
 * `<BrowserRouter basename="/vault/<name>/admin">` strips the basename
 * before matching — so `<Link to="/">` lives at the vault detail page,
 * `<Link to="/tokens">` lives at the vault's tokens page, and there is
 * no path that addresses any *other* vault. A route table that names
 * `/vault/:name` would only match `/vault/<basename>/admin/vault/:name`
 * after basename-stripping — i.e. an absurd doubled URL no link in this
 * SPA produces. So under per-vault mount we render a tiny route table
 * that's already vault-scoped and pass the mounted vault name down to
 * the route components as a prop.
 *
 * Under stand-alone mount (legacy origin-rooted `/admin/*` or unmounted
 * dev), the basename is `/admin` (or empty) and the route table looks
 * like the original picker-then-detail tree. The detail components fall
 * back to `useParams()` for `:name` in this branch.
 */
export function App() {
  const mountedVault = getMountedVaultName();
  return (
    <div className="page">
      <nav className="nav">
        <Link to="/" className="brand">
          Parachute Vault <span className="sub">admin</span>
        </Link>
        {mountedVault ? (
          <Link to="/">
            <code>{mountedVault}</code>
          </Link>
        ) : (
          <Link to="/">Vaults</Link>
        )}
      </nav>

      {mountedVault ? (
        <Routes>
          <Route path="/" element={<VaultDetail vaultName={mountedVault} />} />
          <Route path="/tokens" element={<VaultTokens vaultName={mountedVault} />} />
          <Route path="/mirror" element={<VaultMirror vaultName={mountedVault} />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      ) : (
        <Routes>
          <Route path="/" element={<VaultsList />} />
          <Route path="/vault/:name" element={<VaultDetail />} />
          <Route path="/vault/:name/tokens" element={<VaultTokens />} />
          <Route path="/vault/:name/mirror" element={<VaultMirror />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      )}
    </div>
  );
}

function NotFound() {
  return (
    <div className="empty">
      404 — back to <Link to="/">vault</Link>.
    </div>
  );
}
