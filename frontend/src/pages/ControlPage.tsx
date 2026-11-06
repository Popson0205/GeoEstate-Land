import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button, ErrorText, useAction } from "../components/ui";
import { api } from "../lib/api";
import type { Control, Me } from "../lib/types";
import { useLoad } from "../lib/useLoad";

const fix = (v: string | number) => Number(v).toLocaleString("en-NG", { minimumFractionDigits: 3, maximumFractionDigits: 3 });

/** Ground control points on a survey grid, the corrections they give, and which one the registry uses. */
export default function ControlPage({ me }: { me: Me }) {
  const grids = useLoad(() => api.grids());
  const settings = useLoad(() => api.settings());
  const [epsg, setEpsg] = useState<number | null>(null);
  const [c, setC] = useState<Control | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [f, setF] = useState({ name: "", plan_e: "", plan_n: "", true_e: "", true_n: "", notes: "" });
  const { busy, run } = useAction();
  useEffect(() => { if (settings.data && epsg == null) setEpsg(settings.data.default_epsg === 4326 ? 26332 : settings.data.default_epsg); }, [settings.data, epsg]);
  useEffect(() => { if (epsg) void api.control(epsg).then((x) => { setC(x); setErr(null); }, setErr); }, [epsg]);
  const can = me.role === "registrar" && me.can_write;
  const add = async () => {
    const got = await run("add", () => api.addControl({ epsg: epsg!, name: f.name, plan_e: Number(f.plan_e), plan_n: Number(f.plan_n),
      true_e: Number(f.true_e), true_n: Number(f.true_n), notes: f.notes }), `${f.name} added`);
    if (got) { setC(got); setF({ name: "", plan_e: "", plan_n: "", true_e: "", true_n: "", notes: "" }); }
  };
  const use = async (method: string) => { const got = await run(`use-${method}`, () => api.setCorrection(epsg!, method), method === "off" ? "Correction off" : "Correction on"); if (got) setC(got); };
  return (
    <>
      <div className="head"><h1>Ground control</h1><Link to="/settings">Back to settings</Link></div>
      <section className="ge-card">
        <div className="ge-field"><label htmlFor="cgrid">Survey grid</label>
          <select id="cgrid" value={epsg ?? ""} onChange={(e) => setEpsg(Number(e.target.value))}>
            {(grids.data ?? []).filter((g) => g.epsg !== 4326).map((g) => <option key={g.epsg} value={g.epsg}>{g.name} · EPSG:{g.epsg}</option>)}</select></div>
        <ErrorText error={err} />
        {c && <p style={{ marginBottom: 0 }}>Surveys on this grid are {c.method === "off" ? <strong>not corrected</strong> : <>corrected by <strong>{c.fits[c.method]?.method_name}</strong></>}.</p>}
      </section>
      {c && <>
        <section className="ge-card">
          <h2>Control points</h2>
          {c.points.length ? (
            <div className="table-wrap"><table className="ge-table">
              <thead><tr><th>Point</th><th className="num">Plan E</th><th className="num">Plan N</th><th className="num">True E</th><th className="num">True N</th><th className="num">Difference</th>{can && <th />}</tr></thead>
              <tbody>{c.points.map((p) => (
                <tr key={p.id}><td>{p.name}{p.notes && <div className="ge-muted ge-small">{p.notes}</div>}</td>
                  <td className="num mono">{fix(p.plan_e)}</td><td className="num mono">{fix(p.plan_n)}</td><td className="num mono">{fix(p.true_e)}</td><td className="num mono">{fix(p.true_n)}</td>
                  <td className="num mono">{(Number(p.true_e) - Number(p.plan_e)).toFixed(3)}, {(Number(p.true_n) - Number(p.plan_n)).toFixed(3)}</td>
                  {can && <td><Button small variant="ghost" busy={busy === p.id} onClick={async () => { const got = await run(p.id, () => api.removeControl(p.id), `${p.name} removed`); if (got) setC(got); }}>Remove</Button></td>}</tr>
              ))}</tbody>
            </table></div>
          ) : <p className="ge-muted">No control points on this grid yet.</p>}
          {can && (
            <form className="form-grid" style={{ marginTop: 14 }} onSubmit={(e) => { e.preventDefault(); void add(); }}>
              <div className="ge-field"><label htmlFor="cn">Name</label><input id="cn" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. XSU 1234" /></div>
              <div className="ge-field"><label htmlFor="pe">Plan easting</label><input id="pe" inputMode="decimal" value={f.plan_e} onChange={(e) => setF({ ...f, plan_e: e.target.value })} /></div>
              <div className="ge-field"><label htmlFor="pn">Plan northing</label><input id="pn" inputMode="decimal" value={f.plan_n} onChange={(e) => setF({ ...f, plan_n: e.target.value })} /></div>
              <div className="ge-field"><label htmlFor="te">True easting</label><input id="te" inputMode="decimal" value={f.true_e} onChange={(e) => setF({ ...f, true_e: e.target.value })} /></div>
              <div className="ge-field"><label htmlFor="tn">True northing</label><input id="tn" inputMode="decimal" value={f.true_n} onChange={(e) => setF({ ...f, true_n: e.target.value })} /></div>
              <div className="ge-field"><label htmlFor="cnotes">Notes</label><input id="cnotes" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} placeholder="e.g. GNSS, 2026" /></div>
              <div className="wide"><button className="ge-btn" type="submit" disabled={!f.name || !f.plan_e || !f.plan_n || !f.true_e || !f.true_n || busy === "add"}>Add the point</button></div>
            </form>
          )}
        </section>
        <section className="ge-card">
          <h2>Corrections</h2>
          <div className="table-wrap"><table className="ge-table">
            <thead><tr><th>Correction</th><th className="num">Shift E</th><th className="num">Shift N</th><th>Scale, rotation</th><th className="num">RMS</th>{can && <th />}</tr></thead>
            <tbody>{Object.values(c.fits).map((x) => (
              <tr key={x.method}><td>{x.method_name}</td>
                {x.error ? <td colSpan={4} className="ge-muted ge-small">{x.error}</td> : <>
                  <td className="num mono">{x.shift_e}</td><td className="num mono">{x.shift_n}</td>
                  <td className="ge-small">{x.scale_ppm != null ? `${x.scale_ppm} ppm, ${x.rotation_sec}″` : "—"}</td><td className="num mono">{x.rms_m} m</td></>}
                {can && <td>{c.method === x.method ? <span className="ge-badge ge-badge-ok">In use</span>
                  : <Button small disabled={!!x.error} busy={busy === `use-${x.method}`} onClick={() => use(x.method)}>Use</Button>}</td>}</tr>
            ))}</tbody>
          </table></div>
          {can && c.method !== "off" && <div style={{ marginTop: 12 }}><Button small variant="ghost" busy={busy === "use-off"} onClick={() => use("off")}>Stop correcting this grid</Button></div>}
          <p className="ge-small ge-muted">The correction applies to surveys captured from now on; parcels already registered keep their position. RMS is how far the
            control points sit from the fitted correction: a large one means a point is wrong, or the grid needs a fuller correction.</p>
        </section>
      </>}
    </>
  );
}
