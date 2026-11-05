import { useState } from "react";
import { Link } from "react-router-dom";
import { Button, ErrorText } from "../components/ui";
import { api } from "../lib/api";
import { when } from "../lib/format";
import type { AuditEntry } from "../lib/types";
import { useLoad } from "../lib/useLoad";

const WHAT: Record<string, string> = { "parcel.create": "registered", "parcel.update": "changed", "parcel.retire": "retired", "settings.update": "changed the settings" };

export function describe(a: { action: string; details: Record<string, unknown> }): string {
  const d = a.details ?? {};
  if (a.action === "parcel.update") return `changed ${Object.keys((d.changed as object) ?? {}).map((k) => k.replace(/_/g, " ")).join(", ") || "details"}`;
  if (a.action === "parcel.retire") return `retired it: ${d.reason ?? ""}`;
  return WHAT[a.action] ?? a.action;
}

/** Everything that happened in the register (registrars). */
export default function ActivityPage() {
  const first = useLoad(() => api.audit());
  const [more, setMore] = useState<AuditEntry[]>([]);
  const [end, setEnd] = useState(false);
  const rows = [...(first.data ?? []), ...more];
  const next = async () => {
    const got = await api.audit(rows[rows.length - 1]?.id);
    setMore((m) => [...m, ...got]);
    if (got.length < 100) setEnd(true);
  };
  return (
    <>
      <h1>Activity</h1>
      <ErrorText error={first.error} />
      <section className="ge-card">
        {!first.data ? <p className="loading">Loading…</p> : !rows.length ? <p className="empty">Nothing has happened yet.</p> : (
          <ul className="history">
            {rows.map((a) => (
              <li key={a.id}><strong>{a.actor_name ?? "Someone"}</strong>{" "}
                {a.target_type === "parcel" && a.target_id
                  ? <>{a.action === "parcel.create" ? "registered" : describe(a).startsWith("changed") ? "changed" : "retired"}{" "}
                    <Link className="pin" to={`/parcels/${a.target_id}`}>{String(a.details.pin ?? "a parcel")}</Link>
                    {a.action === "parcel.update" && <span className="ge-muted"> ({describe(a).replace(/^changed /, "")})</span>}
                    {a.action === "parcel.retire" && <span className="ge-muted">: {String(a.details.reason ?? "")}</span>}</>
                  : describe(a)}
                <div className="ge-muted ge-small">{when(a.at)}</div></li>
            ))}
          </ul>
        )}
        {first.data && first.data.length >= 100 && !end && <Button small onClick={next}>Older</Button>}
      </section>
    </>
  );
}
