import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import MapView from "../components/MapView";
import { Button, ErrorText, useAction } from "../components/ui";
import { api, type ParcelDetails } from "../lib/api";
import { LAND_USES, area, day, metres, when } from "../lib/format";
import type { Me, Parcel } from "../lib/types";
import { useLoad } from "../lib/useLoad";
import { describe } from "./ActivityPage";
import { Folio, InstrumentLine } from "../components/RegisterView";

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

function Pending({ p, me, onDone }: { p: Parcel; me: Me; onDone: (p: Parcel) => void }) {
  const [note, setNote] = useState("");
  const { busy, run } = useAction();
  return (
    <section className="ge-card" style={{ borderColor: "#e9c97a" }}>
      <h2>Waiting for a registrar</h2>
      <p className="ge-small" style={{ marginTop: 0 }}>{p.created_by_name} captured this parcel. Until a registrar approves it, it holds its ground (nothing else can
        overlap it) but no title or dealing can be lodged on it.</p>
      {me.role === "registrar" && me.can_write && <>
        <div className="ge-field"><label htmlFor="pnote">Note (needed to reject)</label><input id="pnote" value={note} onChange={(e) => setNote(e.target.value)} /></div>
        <div className="actions" style={{ marginTop: 10 }}>
          <Button variant="primary" busy={busy === "a"} onClick={async () => { const n = await run("a", () => api.approveParcel(p.id, note), `${p.pin} approved`); if (n) onDone(n); }}>Approve</Button>
          <Button variant="danger" busy={busy === "r"} disabled={note.trim().length < 3} onClick={async () => { const n = await run("r", () => api.rejectParcel(p.id, note), `${p.pin} rejected`); if (n) onDone(n); }}>Reject</Button>
        </div>
      </>}
    </section>
  );
}

/** A parcel: where it is, its survey and beacons, its neighbours and what happened to it. */
export default function ParcelPage({ me }: { me: Me }) {
  const { id = "" } = useParams();
  const go = useNavigate();
  const p = useLoad(() => api.parcel(id), [id]);
  const fabric = useLoad(() => api.fabric());
  const reg = useLoad(() => api.register(id), [id]);
  const [editing, setEditing] = useState(false);
  if (p.error) return <><h1>Parcel</h1><ErrorText error={p.error} /><p><Link to="/">Back to the register</Link></p></>;
  if (!p.data) return <p className="loading">Loading the parcel…</p>;
  const x = p.data;
  const canEdit = me.role !== "viewer" && me.can_write && x.status === "active";
  const projected = x.source_epsg !== 4326;
  return (
    <>
      <div className="head">
        <h1><span className="pin">{x.pin}</span> <span className={`ge-badge ${{ active: "ge-badge-ok", pending: "ge-badge-warn", retired: "ge-badge-bad", rejected: "ge-badge-bad" }[x.status]}`}>
          {{ active: "Active", pending: "Waiting for approval", retired: "Retired", rejected: "Rejected" }[x.status]}</span></h1>
        <div className="actions">
          <Link className="ge-btn ge-btn-sm" to={`/parcels/${x.id}/extract`}>Register extract</Link>
          {canEdit && !editing && <Button small onClick={() => setEditing(true)}>Edit details</Button>}
          {canEdit && <Link className="ge-btn ge-btn-sm" to={`/parcels/${x.id}/lodge?kind=subdivision`}>Subdivide</Link>}
          {canEdit && x.neighbours.length > 0 && <Link className="ge-btn ge-btn-sm" to={`/parcels/${x.id}/lodge?kind=amalgamation`}>Amalgamate</Link>}
          {me.role === "registrar" && me.can_write && x.status === "active" && <Retire p={x} onDone={(n) => p.setData(n)} />}
        </div>
      </div>
      {x.status === "retired" && <p className="ge-notice ge-notice-bad" style={{ borderRadius: 10, marginTop: 0 }}>Retired: {x.retired_reason}</p>}
      {x.status === "rejected" && <p className="ge-notice ge-notice-bad" style={{ borderRadius: 10, marginTop: 0 }}>Rejected by {x.decided_by_name}: {x.decision_note}</p>}
      {x.status === "pending" && <Pending p={x} me={me} onDone={(n) => p.setData(n)} />}
      {(x.parents.length > 0 || x.children.length > 0) && (
        <p className="ge-notice ge-notice-info" style={{ borderRadius: 10, marginTop: 0 }}>
          {x.parents.length > 0 && <>{x.parents[0].kind === "subdivision" ? "Subdivided out of " : "Amalgamated from "}
            {x.parents.map((r, k) => <span key={r.id}>{k > 0 && ", "}<Link to={`/parcels/${r.id}`}>{r.pin}</Link></span>)} by {x.parents[0].number}. </>}
          {x.children.length > 0 && <>{x.children[0].kind === "subdivision" ? "Subdivided into " : "Amalgamated into "}
            {x.children.map((r, k) => <span key={r.id}>{k > 0 && ", "}<Link to={`/parcels/${r.id}`}>{r.pin}</Link></span>)} by {x.children[0].number}.</>}
        </p>
      )}
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
              {x.correction && <><dt>Corrected</dt><dd>to ground control by {x.correction.method_name.split(" (")[0]}: {x.correction.shift_e >= 0 ? "+" : ""}{x.correction.shift_e} m E,
                {" "}{x.correction.shift_n >= 0 ? "+" : ""}{x.correction.shift_n} m N <span className="ge-muted">(RMS {x.correction.rms_m} m, {x.correction.points} points)</span></dd></>}
              {x.closure_ratio != null && <><dt>Closure</dt><dd>1 in {x.closure_ratio.toLocaleString("en-NG")} ({metres(x.closure_error_m ?? 0)})</dd></>}
              {x.closed_to_start && <><dt>Closed to start</dt><dd>Leg {x.closed_to_start.leg} taken as {x.closed_to_start.bearing_dms} {x.closed_to_start.distance_m.toFixed(2)} m
                instead of the plan's {x.closed_to_start.plan_bearing_dms} {x.closed_to_start.plan_distance_m.toFixed(2)} m
                <div className="ge-muted ge-small" style={{ fontWeight: 400 }}>By {x.closed_to_start.by ?? "a registrar"}: “{x.closed_to_start.reason}”</div></dd></>}
              <dt>Centre</dt><dd className="mono">{x.lat.toFixed(6)}, {x.lon.toFixed(6)}</dd>
              <dt>Registered</dt><dd>{day(x.created_at)} by {x.created_by_name}</dd>
              {x.notes && <><dt>Notes</dt><dd style={{ fontWeight: 400, whiteSpace: "pre-wrap" }}>{x.notes}</dd></>}
            </dl>
          )}
        </section>
      </div>
      <div className="two" style={{ marginTop: 18 }}>
        <section className="ge-card" aria-label="The register">
          <div className="head" style={{ marginBottom: 10 }}><h2>Title and proprietors</h2>
            {canEdit && <Link className="ge-btn ge-btn-primary ge-btn-sm" to={`/parcels/${x.id}/lodge`}>Lodge an instrument</Link>}</div>
          <ErrorText error={reg.error} />
          {reg.data ? <Folio r={reg.data} /> : !reg.error && <p className="loading">Loading…</p>}
        </section>
        <section className="ge-card">
          <h2>Instruments</h2>
          {reg.data && (reg.data.instruments.length ? reg.data.instruments.map((i) => <InstrumentLine key={i.id} i={i} />)
            : <p className="ge-muted" style={{ margin: 0 }}>None lodged yet.</p>)}
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
