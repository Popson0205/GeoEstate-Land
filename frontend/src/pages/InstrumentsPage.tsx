import { useState } from "react";
import { InstrumentLine } from "../components/RegisterView";
import { ErrorText } from "../components/ui";
import { api } from "../lib/api";
import { useLoad } from "../lib/useLoad";

const TABS: [string, string][] = [["lodged", "Waiting"], ["registered", "Registered"], ["rejected", "Rejected"], ["withdrawn", "Withdrawn"], ["all", "All"]];

/** The day book: instruments lodged and waiting for a registrar, and what was decided. */
export default function InstrumentsPage() {
  const [tab, setTab] = useState("lodged");
  const list = useLoad(() => api.instruments(tab), [tab]);
  return (
    <>
      <h1>Instruments</h1>
      <div className="tabs" role="tablist" aria-label="Which instruments">
        {TABS.map(([v, n]) => <button key={v} role="tab" aria-selected={tab === v} onClick={() => setTab(v)}>{n}</button>)}
      </div>
      <ErrorText error={list.error} />
      <section className="ge-card">
        {!list.data ? <p className="loading">Loading…</p> : list.data.length === 0
          ? <p className="empty">{tab === "lodged" ? "Nothing is waiting for a decision." : "None."}</p>
          : list.data.map((i) => <InstrumentLine key={i.id} i={i} showPin />)}
      </section>
    </>
  );
}
