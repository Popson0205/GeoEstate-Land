import { useCallback, useEffect, useState } from "react";
import { Route, Routes, useLocation } from "react-router-dom";
import Bar from "./components/Bar";
import { ApiError, api, signInUrl } from "./lib/api";
import type { Me } from "./lib/types";
import ActivityPage from "./pages/ActivityPage";
import HomePage from "./pages/HomePage";
import MapPage from "./pages/MapPage";
import NewParcelPage from "./pages/NewParcelPage";
import ParcelPage from "./pages/ParcelPage";
import SettingsPage from "./pages/SettingsPage";
import SignedOutPage from "./pages/SignedOutPage";
import ExtractPage from "./pages/ExtractPage";
import InstrumentPage from "./pages/InstrumentPage";
import InstrumentsPage from "./pages/InstrumentsPage";
import LodgePage from "./pages/LodgePage";
import PartyPage from "./pages/PartyPage";
import PublicLookupPage from "./pages/PublicLookupPage";

/** Land Registry has no sign-in page of its own: someone not signed in goes to Geohub and comes straight back. */
export default function App() {
  const loc = useLocation();
  const [me, setMe] = useState<Me | null>(null);
  const [stop, setStop] = useState<string | null>(null);
  const out = loc.pathname === "/signed-out";
  const open = loc.pathname.startsWith("/lookup/");          // the public lookup: no sign-in

  const load = useCallback(async () => {
    try { setMe(await api.me()); }
    catch (e) {
      if (e instanceof ApiError && e.status === 401 && e.code !== "no_product") { window.location.assign(signInUrl()); return; }
      setStop(e instanceof Error ? e.message : "Land Registry could not open.");
    }
  }, []);
  useEffect(() => { if (!out && !open) void load(); }, [load, out, open]);
  useEffect(() => {
    const gone = (e: Event) => {
      const why = (e as CustomEvent).detail;
      window.location.assign(`/signed-out?reason=${encodeURIComponent(typeof why === "string" ? why : "Your sign-in has ended. Sign in again.")}`);
    };
    window.addEventListener("land:signed-out", gone);
    return () => window.removeEventListener("land:signed-out", gone);
  }, []);

  if (open) return <Routes><Route path="/lookup/:slug" element={<PublicLookupPage />} /></Routes>;
  if (out) return <SignedOutPage />;
  if (stop) return <SignedOutPage reason={stop} />;
  if (!me) return <p className="loading">Opening Land Registry…</p>;
  const signOut = async () => {
    try { await api.signOut(); } finally { window.location.assign("/signed-out?bye=1"); }
  };
  return (
    <>
      <Bar me={me} onSignOut={signOut} />
      <main className="ge-main" id="main">
        <Routes>
          <Route path="/" element={<HomePage me={me} />} />
          <Route path="/map" element={<MapPage />} />
          <Route path="/parcels/new" element={<NewParcelPage me={me} />} />
          <Route path="/parcels/:id" element={<ParcelPage me={me} />} />
          <Route path="/parcels/:id/lodge" element={<LodgePage me={me} />} />
          <Route path="/parcels/:id/extract" element={<ExtractPage me={me} />} />
          <Route path="/instruments" element={<InstrumentsPage />} />
          <Route path="/instruments/:id" element={<InstrumentPage me={me} />} />
          <Route path="/parties/:id" element={<PartyPage />} />
          <Route path="/settings" element={<SettingsPage me={me} />} />
          <Route path="/activity" element={<ActivityPage />} />
          <Route path="*" element={<div className="ge-card"><h1>Not found</h1><p><a href="/">Back to the register</a></p></div>} />
        </Routes>
      </main>
    </>
  );
}
