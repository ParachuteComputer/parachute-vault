import { Link, Route, Routes } from "react-router-dom";
import { VaultDetail } from "./routes/VaultDetail.tsx";
import { VaultTokens } from "./routes/VaultTokens.tsx";
import { VaultsList } from "./routes/VaultsList.tsx";

export function App() {
  return (
    <div className="page">
      <nav className="nav">
        <Link to="/" className="brand">
          Parachute Vault <span className="sub">admin</span>
        </Link>
        <Link to="/">Vaults</Link>
      </nav>

      <Routes>
        <Route path="/" element={<VaultsList />} />
        <Route path="/vault/:name" element={<VaultDetail />} />
        <Route path="/vault/:name/tokens" element={<VaultTokens />} />
        <Route
          path="*"
          element={
            <div className="empty">
              404 — back to <Link to="/">vaults</Link>.
            </div>
          }
        />
      </Routes>
    </div>
  );
}
