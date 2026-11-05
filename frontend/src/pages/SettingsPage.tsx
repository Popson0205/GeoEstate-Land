import { useEffect, useState } from "react";
import { Button, ErrorText, useAction } from "../components/ui";
import { api } from "../lib/api";
import type { Me } from "../lib/types";
import { useLoad } from "../lib/useLoad";

/** The organization's survey rules (registrars). */
export default function SettingsPage({ me }: { me: Me }) {
  const s = useLoad(() => api.settings());
  const grids = useLoad(() => api.grids());
  const { busy, run } = useAction();
  const [f, setF] = useState({ default_epsg: 26332, pin_prefix: "", closure_ratio: 5000, overlap_tolerance_sqm: 1 });
  useEffect(() => { if (s.data) setF({ default_epsg: s.data.default_epsg, pin_prefix: s.data.pin_prefix, closure_ratio: s.data.closure_ratio, overlap_tolerance_sqm: s.data.overlap_tolerance_sqm }); }, [s.data]);
  if (me.role !== "registrar") return <section className="ge-card"><h1>Settings</h1><p>Only registrars can change the settings.</p></section>;
  const save = async () => {
    const got = await run("save", () => api.saveSettings({ ...f, pin_prefix: f.pin_prefix.trim().toUpperCase() }), "Settings saved");
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
        </div>
        <div className="actions" style={{ marginTop: 16 }}><Button type="submit" variant="primary" busy={busy === "save"} disabled={ro || !s.data}>Save</Button></div>
      </form>
    </>
  );
}
