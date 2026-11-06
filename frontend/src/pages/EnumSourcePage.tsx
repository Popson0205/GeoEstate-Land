import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import CloseToStart from "../components/CloseToStart";
import MapView from "../components/MapView";
import { Button, ErrorText, useAction } from "../components/ui";
import { api } from "../lib/api";
import { day } from "../lib/format";
import type { EnumFeature, EnumResult, Me } from "../lib/types";
import { useLoad } from "../lib/useLoad";
import { FieldMap } from "./EnumerationPage";

const STATUS_WORD: Record<string, string> = { approved: "Approved", submitted: "Submitted", draft: "Draft", rejected: "Rejected" };

/** One connected Geohub form: its enumerated plots, which are in the register, and bringing in the rest. */
export default function EnumSourcePage({ me }: { me: Me }) {
  const { id = "" } = useParams();
  const go = useNavigate();
  const src = useLoad(() => api.source(id), [id]);
  const fabric = useLoad(() => api.fabric());
  const [status, setStatus] = useState("approved");
  const [rows, setRows] = useState<EnumFeature[] | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [pick, setPick] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<Record<string, EnumResult>>({});
  const [claims, setClaims] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [mapping, setMapping] = useState(false);
  const [map, setMap] = useState<Record<string, string>>({});
  const act = useAction();

  const load = async (after = 0) => {
    try {
      const got = await api.enumFeatures(id, status, after);
      setRows((r) => (after ? [...(r ?? []), ...got.features] : got.features)); setNext(got.next); setErr(null);
    } catch (e) { setErr(e); }
  };
  useEffect(() => { setRows(null); setPick(new Set()); setResult({}); void load(); }, [id, status]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (src.data) setMap(src.data.field_map); }, [src.data]);

  const open = (rows ?? []).filter((f) => !f.imported);
  const preview = useMemo((): GeoJSON.FeatureCollection => ({ type: "FeatureCollection", features: (rows ?? []).filter((f) => f.geometry.type !== "Point")
    .map((f) => ({ type: "Feature", geometry: f.geometry, properties: {} })) }), [rows]);
  const can = me.role !== "viewer" && me.can_write;
  const chosen = [...pick];

  const doCheck = async () => {
    setBusy("check");
    try { const got = await api.enumCheck(id, chosen); setResult((r) => ({ ...r, ...Object.fromEntries(got.map((x) => [x.id, x])) })); }
    catch (e) { setErr(e); } finally { setBusy(null); }
  };
  const doImport = async () => {
    setBusy("import");
    try {
      for (let i = 0; i < chosen.length; i += 50) {          // in batches, so a long list shows progress
        const got = await api.enumImport(id, chosen.slice(i, i + 50), claims);
        setResult((r) => ({ ...r, ...Object.fromEntries(got.map((x) => [x.id, x])) }));
      }
      setPick(new Set()); await load(); void fabric.reload(); void src.reload();
    } catch (e) { setErr(e); } finally { setBusy(null); }
  };
  /** A registrar closes one plot's traverse to its start, with why, and registers it. */
  const closeOne = async (fid: string, reason: string) => {
    setBusy("close:" + fid);
    try {
      const got = await api.enumImport(id, [fid], claims, { [fid]: reason });
      setResult((r) => ({ ...r, ...Object.fromEntries(got.map((x) => [x.id, x])) }));
      if (got.some((x) => x.ok)) { setPick((p) => { const n = new Set(p); n.delete(fid); return n; }); await load(); void fabric.reload(); void src.reload(); }
    } catch (e) { setErr(e); } finally { setBusy(null); }
  };
  const doClaims = async () => {
    const got = await act.run("claims", () => api.enumClaims(id));
    if (got) {
      const ok = got.filter((x) => x.ok).length;
      setErr(got.length ? (ok === got.length ? null : got.filter((x) => !x.ok).map((x) => `${x.pin}: ${x.problems?.join(" ")}`).join(" · ")) : "No claims are waiting: every registered parcel's claim is lodged, or its parcel is waiting for approval.");
      if (ok) await load();
    }
  };

  if (src.error) return <ErrorText error={src.error} />;
  if (!src.data) return <p className="loading">Loading…</p>;
  const s = src.data;
  return (
    <>
      <div className="head"><h1>{s.form_name} <span className="ge-muted" style={{ fontSize: 16, fontWeight: 500 }}>· {s.project_name}</span></h1>
        <Link to="/enumeration">All forms</Link></div>
      <section className="ge-card">
        <div className="actions">
          <span>{s.imported} registered · {s.claims_lodged} claims lodged</span>
          {can && <Button small busy={act.busy === "claims"} onClick={doClaims}>Lodge claims waiting</Button>}
          {me.role === "registrar" && me.can_write && s.form && <Button small variant="ghost" onClick={() => setMapping((v) => !v)}>Which question holds what</Button>}
          {me.role === "registrar" && me.can_write && s.imported === 0 && <Button small variant="ghost" onClick={async () => { const ok = await act.run("rm", () => api.removeSource(id), "Disconnected"); if (ok !== undefined) go("/enumeration"); }}>Disconnect</Button>}
        </div>
        {!s.form && <p className="ge-small ge-muted">Geohub does not show you this form now (it may have been removed, or you are no longer in its project).</p>}
        {mapping && s.form && <div className="stack" style={{ marginTop: 14 }}>
          <FieldMap form={s.form} value={map} onChange={setMap} />
          <div><Button small variant="primary" busy={act.busy === "map"} onClick={async () => { const got = await act.run("map", () => api.patchSource(id, { field_map: map }), "Saved"); if (got) { src.setData({ ...s, ...got }); setMapping(false); void load(); } }}>Save</Button></div>
        </div>}
      </section>
      <div className="two">
        <section className="ge-card">
          <div className="head" style={{ marginBottom: 8 }}>
            <h2>Plots from Geohub</h2>
            <select aria-label="Which plots" value={status} onChange={(e) => setStatus(e.target.value)} style={{ font: "inherit", minHeight: 34, borderRadius: 8, border: "1px solid #c9d1de" }}>
              <option value="approved">Approved in Geohub</option><option value="submitted">Waiting for review in Geohub</option><option value="all">All</option></select>
          </div>
          <ErrorText error={err} />
          {!rows ? <p className="loading">Asking Geohub…</p> : !rows.length ? <p className="empty">{status === "approved" ? "No approved plots yet. A supervisor approves them in Geohub's review." : "None."}</p> : (
            <div className="table-wrap" style={{ maxHeight: 520, overflowY: "auto" }}>
              <table className="ge-table">
                <thead><tr>
                  <th>{can && <input type="checkbox" aria-label="All plots not yet registered" checked={open.length > 0 && open.every((f) => pick.has(f.id))}
                    onChange={(e) => setPick(new Set(e.target.checked ? open.map((f) => f.id) : []))} />}</th>
                  <th>Plot</th><th>Occupant</th><th>In the register</th></tr></thead>
                <tbody>{rows.map((f) => {
                  const r = result[f.id];
                  return (
                    <tr key={f.id}>
                      <td>{can && !f.imported && f.status === "approved" && <input type="checkbox" aria-label={`Plot ${f.mapped.full_address || f.seq}`} checked={pick.has(f.id)}
                        onChange={(e) => setPick((p) => { const n = new Set(p); if (e.target.checked) n.add(f.id); else n.delete(f.id); return n; })} />}</td>
                      <td>{f.mapped.full_address || <span className="ge-muted">No plot number</span>}
                        <div className="ge-muted ge-small">{[f.located_by === "plan" ? "From the survey plan" : f.located_by === "gps" ? "By GPS" : "Drawn on the map",
                          f.created_by_name, day(f.created_at), f.status !== "approved" && STATUS_WORD[f.status]].filter(Boolean).join(" · ")}</div></td>
                      <td>{f.mapped.claimant_name || <span className="ge-muted">—</span>}{f.mapped.claimant_phone && <div className="ge-muted ge-small">{f.mapped.claimant_phone}</div>}
                        {f.mapped.dispute && <div><span className="ge-badge ge-badge-warn" title={f.mapped.dispute_note}>Disputed</span></div>}</td>
                      <td className="ge-small">{f.imported ? <>
                          <Link className="pin" to={`/parcels/${f.imported.parcel_id}`}>{f.imported.pin}</Link>
                          {f.imported.status === "pending" && <span className="ge-badge ge-badge-warn" style={{ marginLeft: 6 }}>Waiting</span>}
                          <div className="ge-muted">{f.imported.claim_number ? `Claim ${f.imported.claim_number}: ${f.imported.claim_status}` : f.imported.has_claim ? "Claim not lodged yet" : "No claimant"}</div>
                          {f.changed_since && <div className="row-bad">Changed in Geohub since</div>}</>
                        : r ? (r.ok ? (r.pin ? <span className="row-ok">Registered as {r.pin}</span> : <span className="row-ok">Can be registered{r.area_sqm ? ` · ${Math.round(r.area_sqm).toLocaleString("en-NG")} m²` : ""}{r.closure?.ratio ? ` · closes 1 in ${r.closure.ratio.toLocaleString("en-NG")}` : ""}</span>)
                          : <><span className="row-bad">{r.problems?.join(" ")}</span>
                            {me.role === "registrar" && me.can_write && r.closure?.ratio != null && r.closure.required_ratio != null && r.closure.ratio < r.closure.required_ratio
                              && <CloseToStart compact busy={busy === "close:" + f.id} onClose={(why) => closeOne(f.id, why)} />}</>)
                        : <span className="ge-muted">Not yet</span>}</td>
                    </tr>
                  );
                })}</tbody>
              </table>
            </div>
          )}
          {next && <div style={{ marginTop: 10 }}><Button small onClick={() => load(next)}>More</Button></div>}
        </section>
        <section className="ge-card stack">
          <MapView fabric={fabric.data} preview={preview.features.length ? preview : null} height={340} label="Map of the enumerated plots" />
          {can && <>
            <label className="ge-small actions"><input type="checkbox" checked={claims} onChange={(e) => setClaims(e.target.checked)} />
              Lodge each occupant's claim as a grant ({(s.defaults.title_kind ?? "customary_ro") === "customary_ro" ? "customary right of occupancy" : s.defaults.title_kind}) for a registrar to decide</label>
            <div className="actions">
              <Button busy={busy === "check"} disabled={!chosen.length || !!busy} onClick={doCheck}>Check {chosen.length || ""}</Button>
              <Button variant="primary" busy={busy === "import"} disabled={!chosen.length || !!busy} onClick={doImport}>Register {chosen.length || ""} plot{chosen.length === 1 ? "" : "s"}</Button>
            </div>
            <p className="ge-small ge-muted" style={{ margin: 0 }}>Each plot is checked like any survey (shape, overlaps) and goes through your workflow. A plot is never registered twice.</p>
          </>}
        </section>
      </div>
    </>
  );
}
