import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button, ErrorText, useAction } from "../components/ui";
import { api } from "../lib/api";
import { LAND_USES, day } from "../lib/format";
import type { GeohubForm, Me } from "../lib/types";
import { useLoad } from "../lib/useLoad";

export const MEANINGS: [string, string][] = [["plot_no", "Plot number"], ["address", "Address or description"], ["locality", "Locality"],
  ["land_use", "Land use"], ["notes", "Notes"], ["claimant_name", "Occupant's (claimant's) name"], ["claimant_phone", "Occupant's phone"],
  ["claimant_id_no", "Occupant's NIN"], ["claimant_kind", "Occupant is a person, company…"], ["claimant_rc", "Occupant's CAC RC number"],
  ["acquired", "How it was acquired"], ["acquired_year", "Year acquired"], ["documents", "Documents held"], ["dispute", "Disputed (yes / no)"],
  ["dispute_note", "Who disputes it, and why"]];
/** Geohub's ready-made Plot enumeration form: the same question ids every time. */
export const TEMPLATE_MAP: Record<string, Record<string, string>> = { land_enumeration: {
  plot_no: "plot_no", address: "address", locality: "locality", land_use: "land_use", notes: "remarks", claimant_name: "occupant_name",
  claimant_phone: "occupant_phone", claimant_id_no: "occupant_nin", claimant_kind: "occupant_kind", claimant_rc: "occupant_rc",
  acquired: "acquired", acquired_year: "acquired_year", documents: "documents", dispute: "dispute", dispute_note: "dispute_note" } };
const GUESS: Record<string, RegExp> = { plot_no: /plot|parcel\s*no/i, address: /address|street/i, locality: /locality|community|village|town|lga/i,
  land_use: /use/i, notes: /remark|note|comment/i, claimant_name: /occupant|owner|claimant|name/i, claimant_phone: /phone|tel/i, claimant_id_no: /nin|national id/i,
  claimant_kind: /occupant (is|type)|owner type/i, claimant_rc: /\brc\b|cac/i, acquired: /acquir/i, acquired_year: /year/i, documents: /document|papers/i,
  dispute: /disput/i, dispute_note: /disput.*(why|note|who)/i };

/** Questions → meanings: a select per meaning, guessed from the questions' labels to start with. */
export function FieldMap({ form, value, onChange }: { form: GeohubForm; value: Record<string, string>; onChange: (m: Record<string, string>) => void }) {
  return (
    <div className="form-grid">
      {MEANINGS.map(([k, label]) => (
        <div className="ge-field" key={k}><label htmlFor={`map-${k}`}>{label}</label>
          <select id={`map-${k}`} value={value[k] ?? ""} onChange={(e) => onChange({ ...value, [k]: e.target.value })}>
            <option value="">Not asked</option>{form.fields.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}</select></div>
      ))}
    </div>
  );
}

export function guessMap(form: GeohubForm): Record<string, string> {
  if (form.template && TEMPLATE_MAP[form.template]) return { ...TEMPLATE_MAP[form.template] };
  const used = new Set<string>(), out: Record<string, string> = {};
  for (const [k] of MEANINGS) {
    const f = form.fields.find((x) => !used.has(x.id) && GUESS[k].test(x.label));
    if (f) { out[k] = f.id; used.add(f.id); }
  }
  return out;
}

function Connect({ onDone }: { onDone: (id: string) => void }) {
  const projects = useLoad(() => api.geohubForms());
  const kinds = useLoad(() => api.kinds());
  const [pf, setPf] = useState("");
  const [map, setMap] = useState<Record<string, string>>({});
  const [def, setDef] = useState({ locality: "", land_use: "", title_kind: "customary_ro", survey_plan_no: "" });
  const { busy, run } = useAction();
  const options = useMemo(() => (projects.data ?? []).flatMap((p) => p.forms.map((f) => ({ p, f }))), [projects.data]);
  const chosen = options.find((o) => `${o.p.id}/${o.f.id}` === pf);
  if (projects.error) return <ErrorText error={projects.error} />;
  if (!projects.data) return <p className="loading">Asking Geohub for your projects…</p>;
  if (!options.length) return <p className="ge-muted">None of your Geohub projects has a published form that maps areas. In Geohub, open a project, choose
    New form and start from <strong>Plot enumeration</strong> (for Land Registry), publish it, and enumerate with it.</p>;
  const save = async () => {
    if (!chosen) return;
    const got = await run("c", () => api.addSource({ project_id: chosen.p.id, form_id: chosen.f.id, field_map: map, defaults: def }), `${chosen.f.name} connected`);
    if (got) onDone(got.id);
  };
  return (
    <div className="stack">
      <div className="ge-field"><label htmlFor="pf">Geohub form</label>
        <select id="pf" value={pf} onChange={(e) => { setPf(e.target.value); const o = options.find((x) => `${x.p.id}/${x.f.id}` === e.target.value); setMap(o ? guessMap(o.f) : {}); }}>
          <option value="">Choose…</option>
          {options.map(({ p, f }) => <option key={f.id} value={`${p.id}/${f.id}`}>{p.name} · {f.name} ({f.approved} approved of {f.features})</option>)}</select></div>
      {chosen && <>
        {chosen.f.template && TEMPLATE_MAP[chosen.f.template]
          ? <details className="paste"><summary>Made from Geohub's Plot enumeration template: every question is matched already</summary>
              <FieldMap form={chosen.f} value={map} onChange={setMap} /></details>
          : <><h3 className="ge-small" style={{ margin: 0 }}>Which question holds what</h3>
              <FieldMap form={chosen.f} value={map} onChange={setMap} /></>}
        <h3 className="ge-small" style={{ margin: 0 }}>When the form does not say</h3>
        <div className="form-grid">
          <div className="ge-field"><label htmlFor="dloc">Default locality</label><input id="dloc" value={def.locality} onChange={(e) => setDef({ ...def, locality: e.target.value })} /></div>
          <div className="ge-field"><label htmlFor="dlu">Default land use</label><select id="dlu" value={def.land_use} onChange={(e) => setDef({ ...def, land_use: e.target.value })}>
            <option value="">Not given</option>{LAND_USES.map((u) => <option key={u}>{u}</option>)}</select></div>
          <div className="ge-field"><label htmlFor="dplan">Survey plan or scheme number</label><input id="dplan" value={def.survey_plan_no} onChange={(e) => setDef({ ...def, survey_plan_no: e.target.value })} /></div>
          <div className="ge-field"><label htmlFor="dtk">Occupants' claims are lodged as</label><select id="dtk" value={def.title_kind} onChange={(e) => setDef({ ...def, title_kind: e.target.value })}>
            {Object.entries(kinds.data?.titles ?? { customary_ro: "Customary right of occupancy" }).map(([v, n]) => <option key={v} value={v}>{n}</option>)}</select></div>
        </div>
        <div><Button variant="primary" busy={busy === "c"} onClick={save}>Connect the form</Button></div>
      </>}
    </div>
  );
}

/** Enumeration: Geohub forms that field teams map parcels with, connected to the register. */
export default function EnumerationPage({ me }: { me: Me }) {
  const list = useLoad(() => api.sources());
  const [adding, setAdding] = useState(false);
  const go = useNavigate();
  return (
    <>
      <div className="head"><h1>Enumeration</h1>
        {me.role === "registrar" && me.can_write && !adding && <Button variant="primary" onClick={() => setAdding(true)}>Connect a Geohub form</Button>}</div>
      <p className="ge-muted" style={{ marginTop: 0 }}>Field teams map plots with a Geohub form that draws areas; once a supervisor approves them in Geohub, they can
        be checked and registered here, and each occupant's claim lodged as a grant for a registrar to decide.</p>
      {adding && <section className="ge-card"><h2>Connect a Geohub form</h2><Connect onDone={(id) => go(`/enumeration/${id}`)} /></section>}
      <ErrorText error={list.error} />
      <section className="ge-card">
        {!list.data ? <p className="loading">Loading…</p> : !list.data.length ? <p className="empty">No Geohub form is connected yet.</p> : (
          <ul className="history">{list.data.map((s) => (
            <li key={s.id}><Link to={`/enumeration/${s.id}`}><strong>{s.form_name}</strong></Link> <span className="ge-muted">· {s.project_name}</span>
              <div className="ge-muted ge-small">{s.imported} registered · {s.claims_lodged} claims lodged · connected {day(s.created_at)} by {s.created_by_name}</div></li>
          ))}</ul>
        )}
      </section>
    </>
  );
}
