import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ErrorText } from "../components/ui";
import { api } from "../lib/api";
import { area, day } from "../lib/format";
import type { Me, ParcelRow } from "../lib/types";
import { useLoad } from "../lib/useLoad";

export function ParcelTable({ rows, empty }: { rows: ParcelRow[]; empty: string }) {
  const go = useNavigate();
  if (!rows.length) return <p className="empty">{empty}</p>;
  return (
    <div className="table-wrap">
      <table className="ge-table">
        <thead><tr><th>PIN</th><th>Title</th><th>Address</th><th>Land use</th><th className="num">Area</th><th>Survey plan</th><th>Registered</th></tr></thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.id} className="is-link" onClick={() => go(`/parcels/${p.id}`)}>
              <td><Link className="pin" to={`/parcels/${p.id}`} onClick={(e) => e.stopPropagation()}>{p.pin}</Link>
                {p.status !== "active" && <> <span className={`ge-badge ${p.status === "pending" ? "ge-badge-warn" : "ge-badge-bad"}`}>
                  {{ pending: "Waiting", retired: "Retired", rejected: "Rejected", active: "" }[p.status]}</span></>}</td>
              <td>{p.title_no ?? <span className="ge-muted">—</span>}</td>
              <td>{[p.address, p.locality].filter(Boolean).join(", ") || <span className="ge-muted">—</span>}</td>
              <td>{p.land_use || <span className="ge-muted">—</span>}</td>
              <td className="num">{area(p.area_sqm)}</td>
              <td>{p.survey_plan_no || <span className="ge-muted">—</span>}</td>
              <td>{day(p.created_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The register: the numbers, and every parcel, searchable. */
export default function HomePage({ me }: { me: Me }) {
  const home = useLoad(() => api.home());
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("active");
  const [search, setSearch] = useState({ q: "", status: "active" });
  const list = useLoad(() => api.parcels(search), [search.q, search.status]);
  const h = home.data;
  const submit = (e: FormEvent) => { e.preventDefault(); setSearch({ q: q.trim(), status }); };

  return (
    <>
      <div className="head">
        <h1>Register of parcels</h1>
        {me.role !== "viewer" && me.can_write && <Link className="ge-btn ge-btn-primary" to="/parcels/new">New parcel</Link>}
      </div>
      <ErrorText error={home.error} />
      {h && (
        <div className="stats">
          <div className="stat"><span>Active parcels</span><strong>{h.active.toLocaleString("en-NG")}{h.limit != null && <small className="ge-muted ge-small"> of {h.limit.toLocaleString("en-NG")}</small>}</strong></div>
          <div className="stat"><span>Land registered</span><strong>{area(h.area_sqm)}</strong></div>
          <div className="stat"><span>Titled parcels</span><strong>{h.titled.toLocaleString("en-NG")}</strong></div>
          <div className="stat"><span>Waiting for a registrar</span><strong>{h.lodged + h.pending ? <>
            {h.lodged > 0 && <Link to="/instruments">{h.lodged} instrument{h.lodged === 1 ? "" : "s"}</Link>}{h.lodged > 0 && h.pending > 0 && ", "}
            {h.pending > 0 && <a href="#q" onClick={(e) => { e.preventDefault(); setStatus("pending"); setSearch({ q: "", status: "pending" }); }}>{h.pending} parcel{h.pending === 1 ? "" : "s"}</a>}</> : 0}</strong></div>
        </div>
      )}
      <form className="toolbar" role="search" onSubmit={submit}>
        <label className="sr-only" htmlFor="q">Search the register</label>
        <input id="q" type="search" style={{ flex: "1 1 260px" }} placeholder="PIN, title number, proprietor, address, survey plan…" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="sr-only" htmlFor="status">Which parcels</label>
        <select id="status" value={status} onChange={(e) => { setStatus(e.target.value); setSearch({ q: q.trim(), status: e.target.value }); }}>
          <option value="active">Active</option><option value="pending">Waiting for approval</option><option value="retired">Retired</option>
          <option value="rejected">Rejected</option><option value="all">All</option>
        </select>
        <button className="ge-btn" type="submit">Search</button>
      </form>
      <ErrorText error={list.error} />
      {list.data ? <ParcelTable rows={list.data} empty={search.q ? `Nothing in the register matches “${search.q}”.` : "No parcels yet. Register the first one from a survey."} />
        : !list.error && <p className="loading">Loading the register…</p>}
    </>
  );
}
