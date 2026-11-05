import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import MapView from "../components/MapView";
import { Button, ErrorText, useAction } from "../components/ui";
import { api, type ParcelDetails } from "../lib/api";
import { LAND_USES, area, day, metres, when } from "../lib/format";
import type { Me, Parcel } from "../lib/types";
import { useLoad } from "../lib/useLoad";
import { describe } from "./ActivityPage";

const fix = (n: number | null, d: number) => (n == null ? "—" : n.toLocaleString("en-NG", { minimumFractionDigits: d, maximumFractionDigits: d }));

function Edit({ p, onSaved, onCancel }: { p: Parcel; onSaved: (p: Parcel) => void; onCancel: () => void }) {
  const { busy, run } = useAction();
  const [d, setD] = useState({ land_use: p.land_use, address: p.address, locality: p.locality, survey_plan_no: p.survey_plan_no,
    surveyor: p.surveyor, survey_date: p.survey_date ?? "", notes: p.notes });
  const save = async () => {
    const body: ParcelDetails = { ...d, survey_date: d.survey_date || null };
    const got = await run("save", () => api.update(p.id, body), "Saved");
    if (got) onSaved(got);
  };
  return (
    <form className="form-grid" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <div className="ge-field"><label htmlFor="lu">Land use</label>
        <select id="lu" value={d.land_use} onChange={(e) => setD({ ...d, land_use: e.target.value })}>
          <option value="">Not given</option>{[...new Set([...LAND_USES, d.land_use].filter(Boolean))].map((u) => <option key={u}>{u}</option>)}</select></div>
      <div className="ge-field"><label htmlFor="loc">Locality</label><input id="loc" value={d.locality} onChange={(e) => setD({ ...d, locality: e.target.value })} /></div>
      <div className="ge-field wide"><label htmlFor="addr">Address or description</label><input id="addr" value={d.address} onChange={(e) => setD({ ...d, address: e.target.value })} /></div>
      <div className="ge-field"><label htmlFor="plan">Survey plan number</label><input id="plan" value={d.survey_plan_no} onChange={(e) => setD({ ...d, survey_plan_no: e.target.value })} /></div>
      <div className="ge-field"><label htmlFor="surv">Surveyor</label><input id="surv" value={d.surveyor} onChange={(e) => setD({ ...d, surveyor: e.target.value })} /></div>
      <div className="ge-field"><label htmlFor="sdate">Survey date</label><input id="sdate" type="date" value={d.survey_date} onChange={(e) => setD({ ...d, survey_date: e.target.value })} /></div>
      <div className="ge-field wide"><label htmlFor="notes">Notes</label><textarea id="notes" value={d.notes} onChange={(e) => setD({ ...d, notes: e.target.value })} /></div>
      <div className="actions wide"><button className="ge-btn ge-btn-primary" type="submit" disabled={busy === "save"}>Save</button><Button variant="ghost" onClick={onCancel}>Cancel</Button></div>
    </form>
  );
}

function Retire({ p, onDone }: { p: Parcel; onDone: (p: Parcel) => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const { busy, run } = useAction();
  const go = async () => {
    const got = await run("retire", () => api.retire(p.id, reason.trim()), `${p.pin} retired`);
    if (got) { setOpen(false); onDone(got); }
  };
  return (
    <>
      <Button variant="danger" small onClick={() => setOpen(true)}>Retire</Button>
      {open && (
        <div role="dialog" aria-modal="true" aria-labelledby="retire-h" className="ge-card" style={{ position: "fixed", inset: "auto 16px", top: "20vh", maxWidth: 460, margin: "0 auto", zIndex: 40, boxShadow: "0 20px 50px rgba(27,43,94,.25)" }}>
          <h2 id="retire-h">Retire {p.pin}?</h2>
          <p className="ge-small">It leaves the map and the overlap checks, so its land can be registered again (after a merge, a re-survey or a cancelled plan). Its record and history stay in the register.</p>
          <div className="ge-field"><label htmlFor="why">Why</label><input id="why" autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. re-surveyed as a new parcel" /></div>
          <div className="actions" style={{ marginTop: 12 }}>
            <Button variant="danger" busy={busy === "retire"} disabled={reason.trim().length < 3} onClick={go}>Retire it</Button>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          </div>
        </div>
      )}
    </>
  );
}

/** A parcel: where it is, its survey and beacons, its neighbours and what happened to it. */
export default function ParcelPage({ me }: { me: Me }) {
  const { id = "" } = useParams();
  const go = useNavigate();
  const p = useLoad(() => api.parcel(id), [id]);
  const fabric = useLoad(() => api.fabric());
  const [editing, setEditing] = useState(false);
  if (p.error) return <><h1>Parcel</h1><ErrorText error={p.error} /><p><Link to="/">Back to the register</Link></p></>;
  if (!p.data) return <p className="loading">Loading the parcel…</p>;
  const x = p.data;
  const canEdit = me.role !== "viewer" && me.can_write && x.status === "active";
  const projected = x.source_epsg !== 4326;
  return (
    <>
      <div className="head">
        <h1><span className="pin">{x.pin}</span> {x.status === "retired" ? <span className="ge-badge ge-badge-bad">Retired</span> : <span className="ge-badge ge-badge-ok">Active</span>}</h1>
        <div className="actions">
          {canEdit && !editing && <Button small onClick={() => setEditing(true)}>Edit details</Button>}
          {me.role === "registrar" && me.can_write && x.status === "active" && <Retire p={x} onDone={(n) => p.setData(n)} />}
        </div>
      </div>
      {x.status === "retired" && <p className="ge-notice ge-notice-bad" style={{ borderRadius: 10, marginTop: 0 }}>Retired: {x.retired_reason}</p>}
      <div className="two">
        <MapView fabric={fabric.data} focus={x.geometry} onSelect={(nid) => nid !== x.id && go(`/parcels/${nid}`)} height={380} label={`Map of ${x.pin}`} />
        <section className="ge-card">
          {editing ? <Edit p={x} onSaved={(n) => { p.setData(n); setEditing(false); }} onCancel={() => setEditing(false)} /> : (
            <dl className="facts">
              <dt>Area</dt><dd>{area(x.area_sqm)}</dd>
              <dt>Perimeter</dt><dd>{metres(x.perimeter_m)}</dd>
              <dt>Land use</dt><dd>{x.land_use || "—"}</dd>
              <dt>Address</dt><dd>{x.address || "—"}</dd>
              <dt>Locality</dt><dd>{x.locality || "—"}</dd>
              <dt>Survey plan</dt><dd>{x.survey_plan_no || "—"}</dd>
              <dt>Surveyor</dt><dd>{x.surveyor || "—"}{x.survey_date && <span className="ge-muted"> · {day(x.survey_date)}</span>}</dd>
              <dt>Captured from</dt><dd>{x.method === "traverse" ? "Bearings and distances" : "Beacon coordinates"} on {x.grid_name.split(" (")[0]}</dd>
              {x.closure_ratio != null && <><dt>Closure</dt><dd>1 in {x.closure_ratio.toLocaleString("en-NG")} ({metres(x.closure_error_m ?? 0)})</dd></>}
              <dt>Centre</dt><dd className="mono">{x.lat.toFixed(6)}, {x.lon.toFixed(6)}</dd>
              <dt>Registered</dt><dd>{day(x.created_at)} by {x.created_by_name}</dd>
              {x.notes && <><dt>Notes</dt><dd style={{ fontWeight: 400, whiteSpace: "pre-wrap" }}>{x.notes}</dd></>}
            </dl>
          )}
        </section>
      </div>
      <section className="ge-card" style={{ marginTop: 18 }}>
        <h2>Beacons</h2>
        <div className="table-wrap">
          <table className="ge-table">
            <thead><tr><th>#</th><th>Beacon</th>{projected && <><th className="num">Easting</th><th className="num">Northing</th></>}<th className="num">Latitude</th><th className="num">Longitude</th></tr></thead>
            <tbody>{x.beacons.map((b) => (
              <tr key={b.seq}><td className="ge-muted">{b.seq}</td><td>{b.name}</td>
                {projected && <><td className="num mono">{fix(b.easting, 3)}</td><td className="num mono">{fix(b.northing, 3)}</td></>}
                <td className="num mono">{b.lat.toFixed(7)}</td><td className="num mono">{b.lon.toFixed(7)}</td></tr>
            ))}</tbody>
          </table>
        </div>
      </section>
      <div className="two" style={{ marginTop: 18 }}>
        <section className="ge-card">
          <h2>Neighbours</h2>
          {x.neighbours.length ? <ul className="history">{x.neighbours.map((n) => <li key={n.id}><Link className="pin" to={`/parcels/${n.id}`}>{n.pin}</Link> <span className="ge-muted">{n.land_use}</span></li>)}</ul>
            : <p className="ge-muted">No registered parcel touches this one.</p>}
        </section>
        <section className="ge-card">
          <h2>History</h2>
          <ul className="history">{x.history.map((h, i) => (
            <li key={i}><strong>{h.actor_name}</strong> {describe(h)}<div className="ge-muted ge-small">{when(h.at)}</div></li>
          ))}</ul>
        </section>
      </div>
    </>
  );
}
