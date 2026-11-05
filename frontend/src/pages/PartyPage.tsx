import { Link, useParams } from "react-router-dom";
import { ErrorText } from "../components/ui";
import { api } from "../lib/api";
import { ENC_NAME, PARTY_KIND, day, naira } from "../lib/format";
import { useLoad } from "../lib/useLoad";

/** A party: who they are, and the land they hold, held, or have rights over. */
export default function PartyPage() {
  const { id = "" } = useParams();
  const p = useLoad(() => api.party(id), [id]);
  if (p.error) return <ErrorText error={p.error} />;
  if (!p.data) return <p className="loading">Loading…</p>;
  const x = p.data;
  const now = x.holdings.filter((h) => !h.to_number), past = x.holdings.filter((h) => h.to_number);
  return (
    <>
      <h1>{x.name}</h1>
      <section className="ge-card">
        <dl className="facts">
          <dt>Kind</dt><dd>{PARTY_KIND[x.kind]}</dd>
          {x.id_no && <><dt>{x.id_type || "ID"}</dt><dd>{x.id_no}</dd></>}
          {x.phone && <><dt>Phone</dt><dd>{x.phone}</dd></>}
          {x.email && <><dt>Email</dt><dd>{x.email}</dd></>}
          {x.address && <><dt>Address</dt><dd>{x.address}</dd></>}
        </dl>
      </section>
      <section className="ge-card">
        <h2>Holds</h2>
        {now.length ? <ul className="history">{now.map((h, k) => <li key={k}><Link className="pin" to={`/parcels/${h.parcel_id}`}>{h.pin}</Link> · title {h.title_no}{h.share !== "1/1" && ` · ${h.share} share`}
          <div className="ge-muted ge-small">{[h.address, h.locality].filter(Boolean).join(", ")} · since {day(h.since)} ({h.from_number})</div></li>)}</ul>
          : <p className="ge-muted" style={{ margin: 0 }}>No land at present.</p>}
      </section>
      {(past.length > 0 || x.interests.length > 0) && (
        <div className="two">
          {past.length > 0 && <section className="ge-card"><h2>Held before</h2><ul className="history">{past.map((h, k) => (
            <li key={k}><Link className="pin" to={`/parcels/${h.parcel_id}`}>{h.pin}</Link> · title {h.title_no}
              <div className="ge-muted ge-small">{day(h.since)} to {day(h.until)} ({h.from_number} → {h.to_number})</div></li>))}</ul></section>}
          {x.interests.length > 0 && <section className="ge-card"><h2>Rights over land</h2><ul className="history">{x.interests.map((e, k) => (
            <li key={k}>{ENC_NAME[e.kind]} on <Link className="pin" to={`/parcels/${e.parcel_id}`}>{e.pin}</Link>{e.amount_ngn && ` · ${naira(e.amount_ngn)}`}
              {!e.active && <span className="ge-muted"> · discharged</span>}</li>))}</ul></section>}
        </div>
      )}
    </>
  );
}
