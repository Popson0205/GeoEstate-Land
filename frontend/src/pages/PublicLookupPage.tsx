import { useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { ErrorText } from "../components/ui";
import { api } from "../lib/api";
import { ENC_NAME, area, day, when } from "../lib/format";
import type { PublicResult } from "../lib/types";

/** Anyone, without signing in: is this parcel registered, titled, encumbered, or with a dealing waiting? */
export default function PublicLookupPage() {
  const { slug = "" } = useParams();
  const [reg, setReg] = useState<{ name: string; shows_holders: boolean } | null>(null);
  const [regErr, setRegErr] = useState<unknown>(null);
  const [q, setQ] = useState("");
  const [res, setRes] = useState<PublicResult | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { void api.publicRegistry(slug).then(setReg, setRegErr); }, [slug]);
  const look = async (e: FormEvent) => {
    e.preventDefault();
    if (q.trim().length < 3) return;
    setBusy(true); setErr(null); setRes(null);
    try { setRes(await api.publicLookup(slug, q.trim())); } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  return (
    <main className="ge-main">
      <div className="lookup">
        <section className="ge-card">
          <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 12 }}>
            <img src="/logo.png" alt="GeoEstate" style={{ height: 48 }} />
            <div><h1 style={{ margin: 0, fontSize: 22 }}>Land register lookup</h1><div className="ge-muted">{reg?.name ?? " "}</div></div>
          </div>
          {regErr ? <ErrorText error={regErr} /> : <>
            <p className="ge-muted">Enter a parcel number (PIN) or a title number to see whether the land is registered, titled, or encumbered.</p>
            <form onSubmit={look} role="search">
              <label className="sr-only" htmlFor="q">PIN or title number</label>
              <input id="q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. KLA-000123 or KB/CO/000045" />
              <button className="ge-btn ge-btn-primary" type="submit" disabled={busy}>Look up</button>
            </form>
          </>}
        </section>
        <ErrorText error={err} />
        {res && (
          <section className="ge-card" aria-live="polite">
            <h2>Parcel {res.pin}{res.status === "retired" && <span className="ge-badge ge-badge-bad" style={{ marginLeft: 8 }}>Retired</span>}</h2>
            <dl className="facts">
              <dt>Area</dt><dd>{area(res.area_sqm)}</dd>
              {res.locality && <><dt>Locality</dt><dd>{res.locality}</dd></>}
              {res.land_use && <><dt>Land use</dt><dd>{res.land_use}</dd></>}
              <dt>Title</dt><dd>{res.title ? `${res.title.title_no} · ${res.title.kind}${res.title.ends_on ? `, to ${day(res.title.ends_on)}` : ""}` : "No title registered"}</dd>
              {res.holders && <><dt>Proprietors</dt><dd>{res.holders.map((h) => h.name + (h.share !== "1/1" ? ` (${h.share})` : "")).join(", ")}</dd></>}
              <dt>Encumbrances</dt><dd>{res.encumbrances.length ? res.encumbrances.map((e) => `${ENC_NAME[e.kind] ?? e.kind}${e.count > 1 ? ` ×${e.count}` : ""}`).join(", ") : "None"}</dd>
              <dt>Dealings waiting</dt><dd>{res.dealings_pending ? `${res.dealings_pending} lodged, not yet registered` : "None"}</dd>
            </dl>
            <p className="ge-small ge-muted" style={{ marginBottom: 0 }}>As at {when(res.checked_at)}. For a certified search, apply to {res.registry}.</p>
          </section>
        )}
      </div>
    </main>
  );
}
