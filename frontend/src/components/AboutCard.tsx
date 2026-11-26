import type { Me } from "../lib/types";

const longDate = (d: string | null) =>
  d ? new Date(`${d.slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" }) : null;

const STATUS: Record<string, string> = {
  demo: "Demo", active: "Active", grace: "In grace", expired: "Expired", suspended: "Suspended",
};

/** Read-only "About this deployment" panel: who the install is for, its plan, maintenance window,
 *  software version and provenance. Data comes from the signed GeoEstate ID session, so a genuine
 *  deployment shows a genuine customer and plan here. Visible to everyone. */
export default function AboutCard({ me, appName }: { me: Me; appName: string }) {
  const p = me.product;
  const ends = longDate(p?.subscription_ends ?? null);
  const maintenance = p?.subscription_ends ? `Maintenance and updates until ${ends}` : "No maintenance end date";
  const rows: [string, string][] = [
    ["Product", p?.name ?? appName],
    ["Organization", me.org_name ?? "—"],
    ["Plan", p?.plan_name ?? "—"],
    ["Status", p?.status ? (STATUS[p.status] ?? p.status) : "—"],
    ["Maintenance", maintenance],
    ["Software version", `v${__APP_VERSION__}`],
  ];
  return (
    <section className="ge-card" aria-labelledby="about-h">
      <h2 id="about-h">About this deployment</h2>
      <dl className="about-grid" style={{ display: "grid", gridTemplateColumns: "max-content 1fr", gap: "4px 16px", margin: 0 }}>
        {rows.map(([k, v]) => (
          <div key={k} style={{ display: "contents" }}>
            <dt className="ge-small ge-muted" style={{ margin: 0 }}>{k}</dt>
            <dd style={{ margin: 0 }}>{v}</dd>
          </div>
        ))}
      </dl>
      <p className="ge-small ge-muted" style={{ marginBottom: 0, marginTop: 12 }}>
        Authentic {appName} deployment, signed in through GeoEstate ID. Part of the GeoEstate platform — GeoEstate NIG Limited.
      </p>
    </section>
  );
}
