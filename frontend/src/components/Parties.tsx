import { useEffect, useId, useState } from "react";
import { api } from "../lib/api";
import { PARTY_KIND } from "../lib/format";
import type { HolderData, PartyIn, PartyRow } from "../lib/types";

export const blankParty = (): PartyIn => ({ kind: "person", name: "", id_type: "NIN", id_no: "", phone: "", email: "", address: "" });

/** A party: one already in the registry (found by name or ID number), or a new one. */
export function PartyField({ value, onChange, label }: { value: PartyIn; onChange: (p: PartyIn) => void; label: string }) {
  const uid = useId();
  const [q, setQ] = useState("");
  const [found, setFound] = useState<PartyRow[]>([]);
  useEffect(() => {
    if (value.id || q.trim().length < 2) { setFound([]); return; }
    const t = setTimeout(() => { void api.parties(q.trim()).then(setFound, () => setFound([])); }, 250);
    return () => clearTimeout(t);
  }, [q, value.id]);

  if (value.id) {
    return (
      <div className="party is-chosen">
        <div><strong>{value.name}</strong> <span className="ge-muted ge-small">{[PARTY_KIND[value.kind ?? "person"], value.id_no && `${value.id_type} ${value.id_no}`].filter(Boolean).join(" · ")}</span></div>
        <button type="button" className="ge-btn ge-btn-ghost ge-btn-sm" onClick={() => { onChange(blankParty()); setQ(""); }}>Change</button>
      </div>
    );
  }
  const set = (k: keyof PartyIn, v: string) => onChange({ ...value, [k]: v });
  return (
    <div className="party">
      <div className="form-grid">
        <div className="ge-field wide party-search">
          <label htmlFor={`${uid}-name`}>{label}</label>
          <input id={`${uid}-name`} autoComplete="off" value={value.name} placeholder="Full name, or search the registry"
            onChange={(e) => { set("name", e.target.value); setQ(e.target.value); }} />
          {found.length > 0 && (
            <ul className="party-found" role="listbox" aria-label="Parties already in the registry">
              {found.map((f) => (
                <li key={f.id}><button type="button" role="option" aria-selected="false" onClick={() => { onChange({ id: f.id, name: f.name, kind: f.kind, id_type: f.id_type, id_no: f.id_no }); setQ(""); }}>
                  <strong>{f.name}</strong> <span className="ge-muted ge-small">{[PARTY_KIND[f.kind], f.id_no && `${f.id_type} ${f.id_no}`, f.holdings ? `holds ${f.holdings}` : ""].filter(Boolean).join(" · ")}</span>
                </button></li>
              ))}
            </ul>
          )}
        </div>
        <div className="ge-field"><label htmlFor={`${uid}-kind`}>Kind</label>
          <select id={`${uid}-kind`} value={value.kind} onChange={(e) => onChange({ ...value, kind: e.target.value, id_type: e.target.value === "company" ? "RC" : e.target.value === "person" ? "NIN" : value.id_type })}>
            {Object.entries(PARTY_KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
        <div className="ge-field"><label htmlFor={`${uid}-idt`}>ID type</label>
          <select id={`${uid}-idt`} value={value.id_type} onChange={(e) => set("id_type", e.target.value)}>
            {["NIN", "RC", "Passport", "Driver's licence", "Voter's card", "Other", ""].map((t) => <option key={t} value={t}>{t || "None"}</option>)}</select></div>
        <div className="ge-field"><label htmlFor={`${uid}-idn`}>ID number</label><input id={`${uid}-idn`} value={value.id_no} onChange={(e) => set("id_no", e.target.value)} /></div>
        <div className="ge-field"><label htmlFor={`${uid}-ph`}>Phone</label><input id={`${uid}-ph`} value={value.phone} onChange={(e) => set("phone", e.target.value)} /></div>
        <div className="ge-field"><label htmlFor={`${uid}-em`}>Email</label><input id={`${uid}-em`} type="email" value={value.email} onChange={(e) => set("email", e.target.value)} /></div>
        <div className="ge-field wide"><label htmlFor={`${uid}-ad`}>Address</label><input id={`${uid}-ad`} value={value.address} onChange={(e) => set("address", e.target.value)} /></div>
      </div>
    </div>
  );
}

/** The proprietors of a grant or transfer, with their shares. */
export function HoldersField({ value, onChange }: { value: HolderData[]; onChange: (h: HolderData[]) => void }) {
  return (
    <div className="stack">
      {value.map((h, i) => (
        <fieldset key={i} className="holder">
          <legend>Proprietor {i + 1}</legend>
          <PartyField label="Name" value={h.party} onChange={(p) => onChange(value.map((x, k) => (k === i ? { ...x, party: p } : x)))} />
          <div className="actions">
            {value.length > 1 && <>
              <label className="ge-small" htmlFor={`share-${i}`}>Share</label>
              <input id={`share-${i}`} className="share" value={h.share} onChange={(e) => onChange(value.map((x, k) => (k === i ? { ...x, share: e.target.value } : x)))} />
              <button type="button" className="ge-btn ge-btn-ghost ge-btn-sm" onClick={() => onChange(value.filter((_, k) => k !== i))}>Remove</button>
            </>}
          </div>
        </fieldset>
      ))}
      <div><button type="button" className="ge-btn ge-btn-sm" onClick={() => {
        const n = value.length + 1;
        onChange([...value.map((x) => ({ ...x, share: `1/${n}` })), { party: blankParty(), share: `1/${n}` }]);
      }}>Add a joint proprietor</button></div>
    </div>
  );
}
