import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button, ErrorText, useAction } from "../components/ui";
import WorkflowCard from "../components/WorkflowCard";
import { api } from "../lib/api";
import type { Me } from "../lib/types";
import { useLoad } from "../lib/useLoad";

/** The organization's survey rules (registrars). */
export default function SettingsPage({ me }: { me: Me }) {
  const s = useLoad(() => api.settings());
  const grids = useLoad(() => api.grids());
  const { busy, run } = useAction();
  const [f, setF] = useState({ default_epsg: 26332, pin_prefix: "", closure_ratio: 5000, overlap_tolerance_sqm: 1, title_prefix: "", public_lookup: "off" });
  useEffect(() => { if (s.data) setF({ default_epsg: s.data.default_epsg, pin_prefix: s.data.pin_prefix, closure_ratio: s.data.closure_ratio,
    overlap_tolerance_sqm: s.data.overlap_tolerance_sqm, title_prefix: s.data.title_prefix, public_lookup: s.data.public_lookup }); }, [s.data]);
  if (me.role !== "registrar") return <section className="ge-card"><h1>Settings</h1><p>Only registrars can change the settings.</p></section>;
  const save = async () => {
    const got = await run("save", () => api.saveSettings({ ...f, pin_prefix: f.pin_prefix.trim().toUpperCase(), title_prefix: f.title_prefix.trim().toUpperCase() }), "Settings saved");
    if (got) s.setData(got);
  };
  const ro = !me.can_write;
  return (
    <>
      <h1>Settings</h1>
      <ErrorText error={s.error} />
      <form className="ge-card" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <h2>{s.data?.org_name ?? me.org_name}'s register</h2>
        <div className="form-grid">
          <div className="ge-field wide"><label htmlFor="grid">Survey grid</label>
            <select id="grid" disabled={ro} value={f.default_epsg} onChange={(e) => setF({ ...f, default_epsg: Number(e.target.value) })}>
              {(grids.data ?? []).map((g) => <option key={g.epsg} value={g.epsg}>{g.name} · EPSG:{g.epsg}</option>)}</select>
            <span className="ge-small ge-muted">The grid your surveyors' plans use. A survey can name another when it is captured.</span></div>
          <div className="ge-field"><label htmlFor="prefix">PIN prefix</label>
            <input id="prefix" disabled={ro} maxLength={8} value={f.pin_prefix} onChange={(e) => setF({ ...f, pin_prefix: e.target.value })} />
            <span className="ge-small ge-muted">Next PIN: {(f.pin_prefix || "…").toUpperCase()}-{String(s.data?.pin_next ?? 1).padStart(6, "0")}</span></div>
          <div className="ge-field"><label htmlFor="ratio">Closure needed (1 in …)</label>
            <input id="ratio" disabled={ro} type="number" min={500} max={100000} step={500} value={f.closure_ratio} onChange={(e) => setF({ ...f, closure_ratio: Number(e.target.value) })} />
            <span className="ge-small ge-muted">A traverse that closes worse than this is refused.</span></div>
          <div className="ge-field"><label htmlFor="tol">Overlap allowed (m²)</label>
            <input id="tol" disabled={ro} type="number" min={0} max={100} step={0.1} value={f.overlap_tolerance_sqm} onChange={(e) => setF({ ...f, overlap_tolerance_sqm: Number(e.target.value) })} />
            <span className="ge-small ge-muted">Slivers up to this size, from digitizing, are let through with a warning.</span></div>
          <div className="ge-field"><label htmlFor="tprefix">Title number prefix</label>
            <input id="tprefix" disabled={ro} maxLength={12} value={f.title_prefix} onChange={(e) => setF({ ...f, title_prefix: e.target.value })} />
            <span className="ge-small ge-muted">Titles granted without a number get the next: {(f.title_prefix || "…").toUpperCase()}/{String(s.data?.title_next ?? 1).padStart(6, "0")}</span></div>
          <div className="ge-field wide"><label htmlFor="public">Public lookup</label>
            <select id="public" disabled={ro || !s.data?.public_allowed} value={f.public_lookup} onChange={(e) => setF({ ...f, public_lookup: e.target.value })}>
              <option value="off">Off</option>
              <option value="basic">On: the parcel, whether it is titled, encumbered or has dealings waiting</option>
              <option value="holders">On, and name the proprietors</option>
            </select>
            <span className="ge-small ge-muted">
              {!s.data?.public_allowed ? "Your plan does not include the public lookup." : s.data?.public_lookup !== "off" && s.data?.org_slug
                ? <>Anyone can look up a parcel at <a href={`/lookup/${s.data.org_slug}`} target="_blank" rel="noreferrer">{window.location.origin}/lookup/{s.data.org_slug}</a>. ID numbers, amounts and contacts are never shown.</>
                : "Lets buyers, banks and lawyers check a parcel by its PIN or title number without signing in."}
            </span></div>
        </div>
        <div className="actions" style={{ marginTop: 16 }}><Button type="submit" variant="primary" busy={busy === "save"} disabled={ro || !s.data}>Save</Button></div>
      </form>
      <WorkflowCard readOnly={ro} allowed={s.data?.workflows_allowed ?? true} />
      <section className="ge-card">
        <h2>Ground control</h2>
        <p className="ge-small ge-muted" style={{ marginTop: 0 }}>Old plans on the Minna grids can sit metres off the true ground. With control points whose true positions
          are known, Land Registry corrects every survey captured on that grid.</p>
        <Link className="ge-btn" to="/settings/control">Control points and corrections</Link>
      </section>
    </>
  );
}
