import { useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import MapView from "../components/MapView";
import { HoldersField, PartyField, blankParty } from "../components/Parties";
import { Button, ErrorText, useToast } from "../components/ui";
import { ApiError, api, type LodgeBody } from "../lib/api";
import { ENC_NAME, LAND_USES } from "../lib/format";
import type { HolderData, InstrumentKind, Me, PartyIn } from "../lib/types";
import { useLoad } from "../lib/useLoad";

const WHAT: Record<InstrumentKind, [string, string]> = {
  grant: ["Grant of title", "The parcel's first title"], transfer: ["Transfer", "New proprietors (an assignment)"],
  mortgage: ["Mortgage", "A charge to a lender"], caveat: ["Caveat", "Someone claims an interest"], lease: ["Lease", "A lease out of the title"],
  discharge: ["Discharge", "Ends a mortgage, caveat or lease"], revocation: ["Revocation", "Ends the title"],
  subdivision: ["Subdivision", "Cut it into parcels"], amalgamation: ["Amalgamation", "Merge with neighbours"],
};
const num = (s: string) => (s.trim() === "" ? null : Number(s.replace(/,/g, "")));

/** Lodge an instrument against a parcel: what it is, who it names, the deed's own details. */
export default function LodgePage({ me }: { me: Me }) {
  const { id = "" } = useParams();
  const go = useNavigate();
  const toast = useToast();
  const reg = useLoad(() => api.register(id), [id]);
  const parcel = useLoad(() => api.parcel(id), [id]);
  const fabricData = useLoad(() => api.fabric());
  const [params] = useSearchParams();
  const [cut, setCut] = useState<[number, number][]>([]);
  const [cutText, setCutText] = useState("");
  const [drawing, setDrawing] = useState(true);
  const [merge, setMerge] = useState<string[]>([]);
  const kinds = useLoad(() => api.kinds());
  const [kind, setKind] = useState<InstrumentKind | null>((params.get("kind") as InstrumentKind) || null);
  const [holders, setHolders] = useState<HolderData[]>([{ party: blankParty(), share: "1/1" }]);
  const [party, setParty] = useState<PartyIn>(blankParty());
  const [f, setF] = useState({ title_kind: "statutory_ro", title_no: "", purpose: "", term_years: "99", starts_on: "", ground_rent_ngn: "",
    amount_ngn: "", encumbrance_id: "", instrument_date: "", reference: "", consideration_ngn: "", details: "" });
  const [now, setNow] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const r = reg.data;
  const allowed = useMemo(() => {
    if (!r) return new Set<InstrumentKind>();
    const fab: InstrumentKind[] = r.parcel.status === "active" ? ["subdivision", "amalgamation"] : [];
    if (!r.title) return new Set<InstrumentKind>(["grant", ...fab]);
    const k: InstrumentKind[] = ["transfer", "mortgage", "caveat", "lease", "revocation", ...fab];
    if (r.encumbrances.length) k.push("discharge");
    return new Set(k);
  }, [r]);
  if (me.role === "viewer" || !me.can_write) return <section className="ge-card"><h1>Lodge an instrument</h1><p>Only registrars and officers can lodge instruments, while the subscription is current.</p></section>;
  if (reg.error) return <ErrorText error={reg.error} />;
  if (!r) return <p className="loading">Loading…</p>;
  const want = kind ?? (r.title ? null : "grant");                 // an untitled parcel most often wants its grant
  const k = want && allowed.has(want) ? want : null;
  const gridCut = (): [number, number][] | null => {
    const rows = cutText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => l.split(/[\s,;\t]+/).filter((x) => /^-?\d+(\.\d+)?$/.test(x)).map(Number));
    return rows.length ? rows.filter((r) => r.length >= 2).map((r) => [r[r.length - 2], r[r.length - 1]] as [number, number]) : null;
  };
  const set = (key: keyof typeof f, v: string) => setF({ ...f, [key]: v });

  const submit = async () => {
    if (!k) return;
    const b: LodgeBody = { kind: k, instrument_date: f.instrument_date || null, reference: f.reference, details: f.details,
      consideration_ngn: num(f.consideration_ngn), register_now: now };
    if (k === "grant") Object.assign(b, { title_kind: f.title_kind, title_no: f.title_no, purpose: f.purpose, term_years: num(f.term_years),
      starts_on: f.starts_on || null, ground_rent_ngn: num(f.ground_rent_ngn) });
    if (k === "grant" || k === "transfer") b.holders = holders.length === 1 ? [{ ...holders[0], share: "1/1" }] : holders;
    if (k === "mortgage" || k === "caveat" || k === "lease") Object.assign(b, { party, amount_ngn: num(f.amount_ngn), term_years: k === "lease" ? num(f.term_years) : null });
    if (k === "discharge") b.encumbrance_id = f.encumbrance_id;
    if (k === "subdivision") {
      const g = gridCut();
      if (g) Object.assign(b, { cut: g, cut_epsg: parcel.data?.source_epsg ?? null }); else b.cut = cut;
    }
    if (k === "amalgamation") b.parcels = merge;
    setBusy(true); setErr(null); setProblems([]);
    try {
      const i = await api.lodge(id, b);
      toast(`${i.number} ${i.status === "registered" ? "registered" : "lodged"}`);
      go(`/instruments/${i.id}`);
    } catch (e) {
      if (e instanceof ApiError && Array.isArray(e.body?.problems)) setProblems(e.body!.problems as string[]); else setErr(e);
    } finally { setBusy(false); }
  };

  return (
    <>
      <div className="head"><h1>Lodge an instrument · <span className="pin">{r.parcel.pin}</span></h1><Link to={`/parcels/${id}`}>Back to the parcel</Link></div>
      <section className="ge-card stack">
        <h2>What is it?</h2>
        <div className="kinds" role="group" aria-label="Kind of instrument">
          {(Object.keys(WHAT) as InstrumentKind[]).map((x) => (
            <button key={x} type="button" aria-pressed={k === x} disabled={!allowed.has(x)} onClick={() => { setKind(x); setProblems([]); }}
              title={!allowed.has(x) ? (r.title ? "Not possible on this title now" : "A grant comes first") : undefined}>
              <strong>{WHAT[x][0]}</strong><span>{WHAT[x][1]}</span></button>
          ))}
        </div>
        {r.title && <p className="ge-small ge-muted" style={{ margin: 0 }}>Title {r.title.title_no}, held by {r.holders.map((h) => h.name).join(", ")}.</p>}
      </section>
      {k && (
        <section className="ge-card stack">
          <h2>{WHAT[k][0]}</h2>
          {k === "grant" && (
            <div className="form-grid">
              <div className="ge-field wide"><label htmlFor="tk">Kind of title</label>
                <select id="tk" value={f.title_kind} onChange={(e) => set("title_kind", e.target.value)}>
                  {Object.entries(kinds.data?.titles ?? {}).map(([v, n]) => <option key={v} value={v}>{n}</option>)}</select></div>
              <div className="ge-field"><label htmlFor="tno">Title number</label><input id="tno" placeholder="Numbered by the registry if empty" value={f.title_no} onChange={(e) => set("title_no", e.target.value)} /></div>
              <div className="ge-field"><label htmlFor="purp">Purpose</label>
                <select id="purp" value={f.purpose} onChange={(e) => set("purpose", e.target.value)}><option value="">Not given</option>{LAND_USES.map((u) => <option key={u}>{u}</option>)}</select></div>
              <div className="ge-field"><label htmlFor="term">Term (years)</label><input id="term" inputMode="numeric" value={f.term_years} onChange={(e) => set("term_years", e.target.value)} /></div>
              <div className="ge-field"><label htmlFor="starts">Commencing</label><input id="starts" type="date" value={f.starts_on} onChange={(e) => set("starts_on", e.target.value)} /></div>
              <div className="ge-field"><label htmlFor="rent">Ground rent a year (₦)</label><input id="rent" inputMode="decimal" value={f.ground_rent_ngn} onChange={(e) => set("ground_rent_ngn", e.target.value)} /></div>
            </div>
          )}
          {(k === "grant" || k === "transfer") && <>
            <h3 className="ge-small" style={{ margin: 0 }}>{k === "grant" ? "Granted to" : "New proprietors"}</h3>
            <HoldersField value={holders} onChange={setHolders} />
          </>}
          {(k === "mortgage" || k === "caveat" || k === "lease") && <>
            <PartyField label={{ mortgage: "Mortgagee (the lender)", caveat: "Caveator (who claims the interest)", lease: "Lessee" }[k]} value={party} onChange={setParty} />
            <div className="form-grid">
              {k !== "caveat" && <div className="ge-field"><label htmlFor="amt">{k === "mortgage" ? "Amount secured (₦)" : "Rent a year (₦)"}</label>
                <input id="amt" inputMode="decimal" value={f.amount_ngn} onChange={(e) => set("amount_ngn", e.target.value)} /></div>}
              {k === "lease" && <div className="ge-field"><label htmlFor="term">Term (years)</label><input id="term" inputMode="numeric" value={f.term_years} onChange={(e) => set("term_years", e.target.value)} /></div>}
            </div>
          </>}
          {k === "subdivision" && <>
            <p className="ge-small ge-muted" style={{ margin: 0 }}>Draw the cut line across the parcel: click on the map where it starts outside the
              boundary, at each bend, and where it ends outside the boundary. Or give its points on the survey grid below.</p>
            <MapView fabric={fabricData.data} focus={parcel.data?.geometry} line={cut} fit={false} height={360} label="Draw the cut line"
              onMapClick={drawing ? (c) => setCut((x) => [...x, c]) : undefined} />
            <div className="actions">
              <span className="ge-small">{cut.length ? `${cut.length} point${cut.length === 1 ? "" : "s"} on the line` : "No line yet"}</span>
              <Button small onClick={() => setCut((x) => x.slice(0, -1))} disabled={!cut.length}>Undo the last point</Button>
              <Button small variant="ghost" onClick={() => setCut([])} disabled={!cut.length}>Clear</Button>
              <label className="ge-small actions"><input type="checkbox" checked={drawing} onChange={(e) => setDrawing(e.target.checked)} /> Drawing</label>
            </div>
            <div className="ge-field"><label htmlFor="cutgrid">…or the cut line's points on {parcel.data?.grid_name.split(" (")[0] ?? "the survey grid"} (easting, northing; one per line)</label>
              <textarea id="cutgrid" className="mono" value={cutText} onChange={(e) => setCutText(e.target.value)} placeholder={"331020, 992990\n331020, 993060"} /></div>
          </>}
          {k === "amalgamation" && (
            <fieldset className="holder">
              <legend>Merge {r.parcel.pin} with</legend>
              {parcel.data?.neighbours.length ? parcel.data.neighbours.map((n) => (
                <label key={n.id} className="actions" style={{ padding: "4px 0" }}><input type="checkbox" checked={merge.includes(n.id)}
                  onChange={(e) => setMerge((m) => (e.target.checked ? [...m, n.id] : m.filter((x) => x !== n.id)))} /> <span className="pin">{n.pin}</span>
                  <span className="ge-muted ge-small">{n.land_use}</span></label>
              )) : <p className="ge-muted" style={{ margin: 0 }}>No registered parcel touches this one.</p>}
            </fieldset>
          )}
          {k === "discharge" && (
            <div className="ge-field"><label htmlFor="enc">What is discharged</label>
              <select id="enc" value={f.encumbrance_id} onChange={(e) => set("encumbrance_id", e.target.value)}>
                <option value="">Choose…</option>
                {r.encumbrances.map((e) => <option key={e.id} value={e.id}>{ENC_NAME[e.kind]} · {e.party_name} ({e.instrument_number})</option>)}</select></div>
          )}
          <div className="form-grid">
            <div className="ge-field"><label htmlFor="idate">Date of the instrument</label><input id="idate" type="date" value={f.instrument_date} onChange={(e) => set("instrument_date", e.target.value)} /></div>
            <div className="ge-field"><label htmlFor="ref">{k === "transfer" || k === "mortgage" ? "Governor's consent number" : k === "revocation" ? "Gazette or notice number" : "Reference"}</label>
              <input id="ref" value={f.reference} onChange={(e) => set("reference", e.target.value)} /></div>
            {(k === "transfer" || k === "lease" || k === "grant") && <div className="ge-field"><label htmlFor="cons">Consideration (₦)</label>
              <input id="cons" inputMode="decimal" value={f.consideration_ngn} onChange={(e) => set("consideration_ngn", e.target.value)} /></div>}
            <div className="ge-field wide"><label htmlFor="det">{k === "caveat" ? "Grounds: the interest claimed" : k === "revocation" ? "Reason for the revocation" : "Notes"}</label>
              <textarea id="det" value={f.details} onChange={(e) => set("details", e.target.value)} /></div>
          </div>
          {problems.length > 0 && <div className="verdict is-bad" role="alert"><strong>This cannot be lodged</strong><ul>{problems.map((p) => <li key={p}>{p}</li>)}</ul></div>}
          <ErrorText error={err} />
          <div className="actions">
            <Button variant="primary" busy={busy} onClick={submit}>{now ? "Lodge and register" : "Lodge it"}</Button>
            {me.role === "registrar" && <label className="ge-small actions"><input type="checkbox" checked={now} onChange={(e) => setNow(e.target.checked)} /> Register it now</label>}
            {me.role !== "registrar" && <span className="ge-muted ge-small">A registrar registers it, or rejects it with a reason.</span>}
          </div>
        </section>
      )}
    </>
  );
}
