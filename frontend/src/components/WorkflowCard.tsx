import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { Workflow } from "../lib/types";
import { useLoad } from "../lib/useLoad";
import { Button, ErrorText, useAction } from "./ui";

const ROWS: [keyof Workflow, string, string][] = [
  ["parcel", "A new parcel", "captured by an officer"], ["grant", "Grant of title", ""], ["transfer", "Transfer", ""], ["mortgage", "Mortgage", ""],
  ["caveat", "Caveat", ""], ["lease", "Lease", ""], ["discharge", "Discharge", ""], ["revocation", "Revocation", ""],
  ["subdivision", "Subdivision", ""], ["amalgamation", "Amalgamation", ""],
];
const CHOICES = [[0, "Takes effect when lodged"], [1, "One registrar approves"], [2, "Two registrars approve"]] as const;

/** Each organization's own workflow: how many registrars approve each kind of change. */
export default function WorkflowCard({ readOnly, allowed = true }: { readOnly: boolean; allowed?: boolean }) {
  const w = useLoad(() => api.workflow());
  const [f, setF] = useState<Workflow | null>(null);
  const { busy, run } = useAction();
  useEffect(() => { if (w.data) setF(w.data); }, [w.data]);
  const save = async () => { if (f) { const got = await run("w", () => api.saveWorkflow(f), "Workflow saved"); if (got) w.setData(got); } };
  return (
    <section className="ge-card">
      <h2>Workflow</h2>
      <p className="ge-small ge-muted" style={{ marginTop: 0 }}>Who approves each kind of change before it reaches the register. With two, neither may be whoever lodged
        it. Registrars' own new parcels never wait.</p>
      {!allowed && <p className="ge-notice ge-notice-info" style={{ borderRadius: 8 }}>Your plan uses the standard workflow (one registrar approves each instrument;
        new parcels need no approval). Choosing your own is part of Land Registry Advanced.</p>}
      <ErrorText error={w.error} />
      {f && (
        <div className="table-wrap">
          <table className="ge-table">
            <thead><tr><th>Change</th><th>Approval</th></tr></thead>
            <tbody>{ROWS.map(([k, name, sub]) => (
              <tr key={k}><td><label htmlFor={`wf-${k}`}>{name}</label>{sub && <div className="ge-muted ge-small">{sub}</div>}</td>
                <td><select id={`wf-${k}`} disabled={readOnly || !allowed} value={f[k]} onChange={(e) => setF({ ...f, [k]: Number(e.target.value) })}
                  style={{ font: "inherit", minHeight: 36, padding: "4px 8px", border: "1px solid #c9d1de", borderRadius: 8 }}>
                  {CHOICES.filter(([n]) => k !== "parcel" || n < 2).map(([n, label]) => <option key={n} value={n}>{label}</option>)}</select></td></tr>
            ))}</tbody>
          </table>
        </div>
      )}
      <div className="actions" style={{ marginTop: 14 }}><Button variant="primary" busy={busy === "w"} disabled={readOnly || !allowed || !f} onClick={save}>Save the workflow</Button></div>
    </section>
  );
}
