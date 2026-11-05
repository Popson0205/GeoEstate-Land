import { Link } from "react-router-dom";
import { ENC_NAME, STATUS_NAME, STATUS_TONE, day, naira } from "../lib/format";
import type { Instrument, Register } from "../lib/types";

export function InstrumentLine({ i, showPin = false }: { i: Instrument; showPin?: boolean }) {
  return (
    <div className="inst">
      <Link className="num-col" to={`/instruments/${i.id}`}>{i.number}</Link>
      <span><strong>{i.kind_name}</strong>{showPin && <> · <span className="pin">{i.pin}</span></>} <span className="ge-muted">{i.summary}</span></span>
      <span className={`ge-badge ${STATUS_TONE[i.status]}`}>{STATUS_NAME[i.status]}</span>
      <span className="sub">Lodged {day(i.lodged_at)} by {i.lodged_by_name}
        {i.decided_at && i.status !== "lodged" && <> · {STATUS_NAME[i.status].toLowerCase()} {day(i.decided_at)} by {i.decided_by_name}</>}
        {i.decision_note && <> · “{i.decision_note}”</>}</span>
    </div>
  );
}

/** The parcel's register: title, proprietors, encumbrances (the three parts of a land register folio). */
export function Folio({ r, links = true }: { r: Register; links?: boolean }) {
  const t = r.title;
  const party = (id: string | null, name: string | null) => (links && id ? <Link to={`/parties/${id}`}>{name}</Link> : name);
  if (!t) return <p className="untitled">No title is registered on this parcel{r.past_titles.length ? ` (the last, ${r.past_titles[0].title_no}, was revoked)` : ""}.</p>;
  return (
    <div className="stack">
      <div>
        <div className="register-head"><span className="title-no">{t.title_no}</span><span className="ge-muted ge-small">by {t.granted_by_number}</span></div>
        <dl className="facts" style={{ marginTop: 8 }}>
          <dt>Title</dt><dd>{t.kind_name}</dd>
          {t.purpose && <><dt>Purpose</dt><dd>{t.purpose}</dd></>}
          {t.term_years && <><dt>Term</dt><dd>{t.term_years} years{t.starts_on && ` from ${day(t.starts_on)}`}{t.ends_on && ` to ${day(t.ends_on)}`}</dd></>}
          {t.ground_rent_ngn && <><dt>Ground rent</dt><dd>{naira(t.ground_rent_ngn)} a year</dd></>}
        </dl>
      </div>
      <div>
        <h3 className="ge-small" style={{ margin: "0 0 4px", textTransform: "uppercase", letterSpacing: ".05em", color: "var(--ge-muted)" }}>Proprietors</h3>
        <ul className="history">{r.holders.map((h) => (
          <li key={h.id}><strong>{party(h.id, h.name)}</strong>{h.share !== "1/1" && <span> · {h.share} share</span>}
            <div className="ge-muted ge-small">{[h.id_no && `${h.id_type} ${h.id_no}`, `since ${day(h.since)} (${h.since_number})`].filter(Boolean).join(" · ")}</div></li>
        ))}</ul>
      </div>
      <div>
        <h3 className="ge-small" style={{ margin: "0 0 4px", textTransform: "uppercase", letterSpacing: ".05em", color: "var(--ge-muted)" }}>Encumbrances</h3>
        {r.encumbrances.length ? <ul className="history">{r.encumbrances.map((e) => (
          <li key={e.id}><span className={`ge-badge ${e.kind === "caveat" ? "ge-badge-warn" : ""}`}>{ENC_NAME[e.kind]}</span>{" "}
            {e.kind === "mortgage" ? "to " : e.kind === "caveat" ? "by " : "to "}<strong>{party(e.party_id, e.party_name)}</strong>
            {e.amount_ngn && <> · {naira(e.amount_ngn)}{e.kind === "lease" ? " a year" : ""}</>}{e.term_years && <> · {e.term_years} years</>}
            <div className="ge-muted ge-small">{[e.details, `since ${day(e.since)} (${e.instrument_number})`].filter(Boolean).join(" · ")}</div></li>
        ))}</ul> : <p className="ge-muted" style={{ margin: 0 }}>None: the title is clear.</p>}
      </div>
    </div>
  );
}
