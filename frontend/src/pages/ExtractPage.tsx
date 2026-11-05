import { Link, useParams } from "react-router-dom";
import { Folio } from "../components/RegisterView";
import { ErrorText } from "../components/ui";
import { api } from "../lib/api";
import { area, day, metres, when } from "../lib/format";
import type { Me } from "../lib/types";
import { useLoad } from "../lib/useLoad";

/** A printable extract of the register for one parcel, as it stands at this moment. */
export default function ExtractPage({ me }: { me: Me }) {
  const { id = "" } = useParams();
  const p = useLoad(() => api.parcel(id), [id]);
  const r = useLoad(() => api.register(id), [id]);
  if (p.error || r.error) return <ErrorText error={p.error ?? r.error} />;
  if (!p.data || !r.data) return <p className="loading">Loading…</p>;
  const x = p.data;
  const pending = r.data.instruments.filter((i) => i.status === "lodged");
  return (
    <>
      <div className="head no-print"><Link to={`/parcels/${id}`}>Back to the parcel</Link><button className="ge-btn ge-btn-primary" onClick={() => window.print()}>Print or save as PDF</button></div>
      <article className="extract">
        <header><img src="/logo.png" alt="" /><div><h1>Extract of the land register</h1><div className="ge-muted">{me.org_name}</div></div></header>
        <h2>A. The property</h2>
        <dl className="facts">
          <dt>Parcel (PIN)</dt><dd>{x.pin}{x.status === "retired" && " (retired)"}</dd>
          <dt>Area</dt><dd>{area(x.area_sqm)} · perimeter {metres(x.perimeter_m)}</dd>
          <dt>Situated at</dt><dd>{[x.address, x.locality].filter(Boolean).join(", ") || "—"}</dd>
          <dt>Land use</dt><dd>{x.land_use || "—"}</dd>
          <dt>Survey</dt><dd>{x.survey_plan_no || "—"}{x.surveyor && `, ${x.surveyor}`}{x.survey_date && `, ${day(x.survey_date)}`}</dd>
          <dt>Grid</dt><dd>{x.grid_name}</dd>
          <dt>Beacons</dt><dd className="mono" style={{ fontWeight: 400 }}>{x.beacons.map((b) => `${b.name}${b.easting != null ? ` (${b.easting}E, ${b.northing}N)` : ` (${b.lat.toFixed(6)}, ${b.lon.toFixed(6)})`}`).join("; ")}</dd>
        </dl>
        <h2>B. Title and proprietors · C. Encumbrances</h2>
        <Folio r={r.data} links={false} />
        {pending.length > 0 && <><h2>Dealings lodged and not yet registered</h2>
          <ul>{pending.map((i) => <li key={i.id}>{i.number}: {i.kind_name}, lodged {day(i.lodged_at)}</li>)}</ul></>}
        <p className="foot">Issued {when(new Date().toISOString())} by {me.name}, {me.org_name}. This extract shows the register at the moment it was issued; check
          it again before relying on it. GeoEstate Land Registry.</p>
      </article>
    </>
  );
}
