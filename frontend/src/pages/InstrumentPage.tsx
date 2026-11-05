import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Button, ErrorText, useAction } from "../components/ui";
import { api } from "../lib/api";
import { PARTY_KIND, STATUS_NAME, STATUS_TONE, day, naira, when } from "../lib/format";
import type { HolderData, Me, PartyIn } from "../lib/types";
import { useLoad } from "../lib/useLoad";

const who = (p?: PartyIn) => (p ? [p.name, p.kind && p.kind !== "person" ? PARTY_KIND[p.kind] : "", p.id_no ? `${p.id_type} ${p.id_no}` : ""].filter(Boolean).join(" · ") : "");

/** One instrument: what it says, whether it can be registered now, and the registrar's decision. */
export default function InstrumentPage({ me }: { me: Me }) {
  const { id = "" } = useParams();
  const ins = useLoad(() => api.instrument(id), [id]);
  const { busy, run } = useAction();
  const [note, setNote] = useState("");
  if (ins.error) return <ErrorText error={ins.error} />;
  if (!ins.data) return <p className="loading">Loading…</p>;
  const i = ins.data, d = i.data;
  const decide = async (what: "register" | "reject" | "withdraw") => {
    const f = { register: () => api.registerInstrument(id, note), reject: () => api.rejectInstrument(id, note), withdraw: () => api.withdrawInstrument(id) }[what];
    const got = await run(what, f, { register: `${i.number} registered`, reject: `${i.number} rejected`, withdraw: `${i.number} withdrawn` }[what]);
    if (got) ins.setData(got); else void ins.reload();
  };
  const holders = (d.holders ?? []) as HolderData[];
  return (
    <>
      <div className="head">
        <h1><span className="mono" style={{ fontSize: 22 }}>{i.number}</span> <span className={`ge-badge ${STATUS_TONE[i.status]}`}>{STATUS_NAME[i.status]}</span></h1>
        <Link to={`/parcels/${i.parcel_id}`}>Parcel {i.pin}</Link>
      </div>
      <div className="two">
        <section className="ge-card">
          <h2>{i.kind_name}</h2>
          <dl className="facts">
            <dt>Parcel</dt><dd><Link className="pin" to={`/parcels/${i.parcel_id}`}>{i.pin}</Link></dd>
            {i.kind === "grant" && <>
              <dt>Title</dt><dd>{String(d.title_no || "numbered on registration")}</dd>
              {d.term_years ? <><dt>Term</dt><dd>{String(d.term_years)} years{d.starts_on ? ` from ${day(String(d.starts_on))}` : ""}</dd></> : null}
              {d.ground_rent_ngn ? <><dt>Ground rent</dt><dd>{naira(Number(d.ground_rent_ngn))} a year</dd></> : null}
            </>}
            {holders.length > 0 && <><dt>{i.kind === "grant" ? "Granted to" : "To"}</dt><dd>{holders.map((h, k) => <div key={k}>{who(h.party)}{h.share !== "1/1" && ` · ${h.share}`}</div>)}</dd></>}
            {d.party && <><dt>{{ mortgage: "Mortgagee", caveat: "Caveator", lease: "Lessee" }[i.kind as string] ?? "Party"}</dt><dd>{who(d.party)}</dd></>}
            {d.amount_ngn ? <><dt>Amount</dt><dd>{naira(Number(d.amount_ngn))}</dd></> : null}
            {i.kind === "discharge" && <><dt>Discharges</dt><dd>{String(d.encumbrance_label ?? "")}</dd></>}
            {i.consideration_ngn && <><dt>Consideration</dt><dd>{naira(i.consideration_ngn)}</dd></>}
            {i.instrument_date && <><dt>Dated</dt><dd>{day(i.instrument_date)}</dd></>}
            {i.reference && <><dt>Reference</dt><dd>{i.reference}</dd></>}
            {d.details && <><dt>Notes</dt><dd style={{ fontWeight: 400, whiteSpace: "pre-wrap" }}>{d.details}</dd></>}
            <dt>Lodged</dt><dd>{when(i.lodged_at)} by {i.lodged_by_name}</dd>
            {i.decided_at && <><dt>{STATUS_NAME[i.status]}</dt><dd>{when(i.decided_at)} by {i.decided_by_name}</dd></>}
            {i.decision_note && <><dt>Note</dt><dd style={{ fontWeight: 400 }}>{i.decision_note}</dd></>}
          </dl>
        </section>
        {i.status === "lodged" && (
          <section className="ge-card stack">
            <h2>Decision</h2>
            {i.problems && i.problems.length > 0
              ? <div className="verdict is-bad" role="status"><strong>It cannot be registered now</strong><ul>{i.problems.map((p) => <li key={p}>{p}</li>)}</ul></div>
              : <div className="verdict is-ok" role="status"><strong>It can be registered</strong></div>}
            {i.warnings && i.warnings.length > 0 && <div className="warnings"><ul>{i.warnings.map((w) => <li key={w}>{w}</li>)}</ul></div>}
            {me.role === "registrar" && me.can_write && <>
              <div className="ge-field"><label htmlFor="note">Note (needed to reject)</label><textarea id="note" value={note} onChange={(e) => setNote(e.target.value)} /></div>
              <div className="actions">
                <Button variant="primary" busy={busy === "register"} disabled={!!i.problems?.length} onClick={() => decide("register")}>Register</Button>
                <Button variant="danger" busy={busy === "reject"} disabled={note.trim().length < 3} onClick={() => decide("reject")}>Reject</Button>
              </div>
            </>}
            {me.role !== "registrar" && <p className="ge-muted ge-small" style={{ margin: 0 }}>Waiting for a registrar.</p>}
            {me.can_write && (i.lodged_by === me.id || me.role === "registrar") &&
              <div><Button variant="ghost" small busy={busy === "withdraw"} onClick={() => decide("withdraw")}>Withdraw it</Button></div>}
          </section>
        )}
      </div>
    </>
  );
}
