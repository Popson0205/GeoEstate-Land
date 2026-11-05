import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import MapView from "../components/MapView";
import { Button, ErrorText } from "../components/ui";
import { ApiError, api } from "../lib/api";
import { LAND_USES, area } from "../lib/format";
import { MAX_DXF, readText } from "../lib/readFile";
import type { Check, DxfRead, Me } from "../lib/types";
import { useLoad } from "../lib/useLoad";

type Row = { checked?: Check; error?: string; done?: { id: string; pin: string; status: string } };

/** A whole layout (an estate's plots) from one surveyor's drawing: read it, check every plot, register the good ones. */
export default function LayoutImportPage({ me }: { me: Me }) {
  const grids = useLoad(() => api.grids());
  const settings = useLoad(() => api.settings());
  const fabric = useLoad(() => api.fabric());
  const [epsg, setEpsg] = useState<number | null>(null);
  const [dxf, setDxf] = useState<DxfRead | null>(null);
  const [layer, setLayer] = useState("");
  const [pick, setPick] = useState<Set<number>>(new Set());
  const [rows, setRows] = useState<Record<number, Row>>({});
  const [d, setD] = useState({ land_use: "residential", locality: "", survey_plan_no: "", surveyor: "" });
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  useEffect(() => { if (settings.data && epsg == null) setEpsg(settings.data.default_epsg === 4326 ? 26332 : settings.data.default_epsg); }, [settings.data, epsg]);
  const shapes = useMemo(() => (dxf?.shapes ?? []).filter((s) => !layer || s.layer === layer), [dxf, layer]);
  const preview = useMemo((): GeoJSON.FeatureCollection => ({ type: "FeatureCollection", features: Object.values(rows).filter((r) => r.checked)
    .map((r) => ({ type: "Feature", geometry: r.checked!.geometry, properties: {} })) }), [rows]);

  if (me.role === "viewer" || !me.can_write) return <section className="ge-card"><h1>Import a layout</h1><p>Only registrars and officers can register parcels.</p></section>;
  const open = async (file?: File) => {
    if (!file) return;
    if (file.size > MAX_DXF) { setErr("The drawing is over 15 MB. Export only the parcel boundaries."); return; }
    setBusy("read"); setErr(null); setRows({});
    try {
      const got = await api.importDxf(file.name, await readText(file));
      setDxf(got); setLayer(got.layers.length > 1 ? got.layers[0] : ""); setPick(new Set(got.shapes.map((s) => s.index)));
    } catch (e) { setErr(e); setDxf(null); } finally { setBusy(null); }
  };
  const body = (i: number) => ({ method: "coordinates" as const, epsg: epsg ?? undefined, points: dxf!.shapes[i].points });
  const checkAll = async () => {
    setBusy("check");
    for (const s of shapes.filter((x) => pick.has(x.index))) {
      try { const c = await api.check(body(s.index)); setRows((r) => ({ ...r, [s.index]: { checked: c } })); }
      catch (e) { setRows((r) => ({ ...r, [s.index]: { error: e instanceof Error ? e.message : String(e) } })); }
    }
    setBusy(null);
  };
  const good = shapes.filter((s) => pick.has(s.index) && rows[s.index]?.checked?.ok && !rows[s.index]?.done);
  const registerAll = async () => {
    setBusy("register");
    for (const s of good) {
      try {
        const p = await api.registerParcel({ ...body(s.index), ...d, address: s.label });
        setRows((r) => ({ ...r, [s.index]: { ...r[s.index], done: { id: p.id, pin: p.pin, status: p.status } } }));
      } catch (e) {
        setRows((r) => ({ ...r, [s.index]: { ...r[s.index], error: e instanceof ApiError ? e.message : String(e) } }));
        if (e instanceof ApiError && (e.status === 402 || e.status === 403)) break;
      }
    }
    setBusy(null);
  };
  const done = Object.values(rows).filter((r) => r.done).length;

  return (
    <>
      <div className="head"><h1>Import a layout</h1><Link to="/parcels/new">One parcel instead</Link></div>
      <section className="ge-card stack">
        <p className="ge-muted" style={{ margin: 0 }}>A surveyor's DXF of a layout: every closed boundary becomes a parcel, its plot number (the text inside it) its
          address, and the numbers by its corners its beacons. Each is checked like any other survey before it is registered.</p>
        <div className="form-grid">
          <div className="ge-field wide"><label htmlFor="lgrid">The drawing's survey grid</label>
            <select id="lgrid" value={epsg ?? ""} onChange={(e) => { setEpsg(Number(e.target.value)); setRows({}); }}>
              {(grids.data ?? []).map((g) => <option key={g.epsg} value={g.epsg}>{g.name} · EPSG:{g.epsg}</option>)}</select></div>
        </div>
        <div className="actions">
          <label className="ge-btn ge-btn-primary" htmlFor="ldxf">{busy === "read" ? "Reading…" : dxf ? "Choose another drawing" : "Choose the DXF drawing"}</label>
          <input id="ldxf" type="file" accept=".dxf" className="sr-only" onChange={(e) => { void open(e.target.files?.[0]); e.target.value = ""; }} />
          {dxf && <span className="ge-small">{dxf.filename}: {dxf.shapes.length} closed boundaries{dxf.layers.length > 1 && ` on ${dxf.layers.length} layers`}</span>}
        </div>
        <ErrorText error={err} />
      </section>
      {dxf && (
        <div className="two">
          <section className="ge-card">
            <div className="head" style={{ marginBottom: 8 }}><h2>Plots</h2>
              {dxf.layers.length > 1 && <select aria-label="Layer" value={layer} onChange={(e) => setLayer(e.target.value)}
                style={{ font: "inherit", minHeight: 34, borderRadius: 8, border: "1px solid #c9d1de" }}>
                <option value="">All layers</option>{dxf.layers.map((l) => <option key={l}>{l}</option>)}</select>}</div>
            <div className="table-wrap" style={{ maxHeight: 460, overflowY: "auto" }}>
              <table className="ge-table">
                <thead><tr><th><input type="checkbox" aria-label="All plots" checked={shapes.every((s) => pick.has(s.index))}
                  onChange={(e) => setPick(new Set(e.target.checked ? shapes.map((s) => s.index) : []))} /></th><th>Plot</th><th className="num">Area</th><th>Check</th></tr></thead>
                <tbody>{shapes.map((s) => {
                  const r = rows[s.index];
                  return (
                    <tr key={s.index}>
                      <td><input type="checkbox" aria-label={`Plot ${s.label || s.index + 1}`} checked={pick.has(s.index)} disabled={!!r?.done}
                        onChange={(e) => setPick((p) => { const n = new Set(p); if (e.target.checked) n.add(s.index); else n.delete(s.index); return n; })} /></td>
                      <td>{s.label || <span className="ge-muted">Shape {s.index + 1}</span>}<div className="ge-muted ge-small">{s.points.length} beacons · {s.layer}</div></td>
                      <td className="num">{area(r?.checked?.area_sqm ?? s.area_plan)}</td>
                      <td className="ge-small">{r?.done ? <Link className="pin" to={`/parcels/${r.done.id}`}>{r.done.pin}</Link>
                        : r?.error ? <span className="row-bad">{r.error}</span>
                        : r?.checked ? (r.checked.ok ? <span className="row-ok">Can be registered</span> : <span className="row-bad">{r.checked.problems.join(" ")}</span>)
                        : <span className="ge-muted">Not checked</span>}</td>
                    </tr>
                  );
                })}</tbody>
              </table>
            </div>
          </section>
          <section className="ge-card stack">
            <MapView fabric={fabric.data} preview={preview.features.length ? preview : null} height={300} label="Map of the layout" />
            <div className="form-grid">
              <div className="ge-field"><label htmlFor="llu">Land use</label><select id="llu" value={d.land_use} onChange={(e) => setD({ ...d, land_use: e.target.value })}>
                <option value="">Not given</option>{LAND_USES.map((u) => <option key={u}>{u}</option>)}</select></div>
              <div className="ge-field"><label htmlFor="lloc">Locality or estate</label><input id="lloc" value={d.locality} onChange={(e) => setD({ ...d, locality: e.target.value })} /></div>
              <div className="ge-field"><label htmlFor="lplan">Survey plan number</label><input id="lplan" value={d.survey_plan_no} onChange={(e) => setD({ ...d, survey_plan_no: e.target.value })} /></div>
              <div className="ge-field"><label htmlFor="lsurv">Surveyor</label><input id="lsurv" value={d.surveyor} onChange={(e) => setD({ ...d, surveyor: e.target.value })} /></div>
            </div>
            <div className="actions">
              <Button busy={busy === "check"} disabled={!pick.size || !!busy} onClick={checkAll}>Check {[...pick].filter((i) => shapes.some((s) => s.index === i)).length} plots</Button>
              <Button variant="primary" busy={busy === "register"} disabled={!good.length || !!busy} onClick={registerAll}>Register {good.length} plot{good.length === 1 ? "" : "s"}</Button>
            </div>
            {done > 0 && <p className="ge-small" role="status" style={{ margin: 0 }}>{done} registered. They are in the <Link to="/">register</Link>.</p>}
          </section>
        </div>
      )}
    </>
  );
}
