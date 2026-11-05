import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import MapView from "../components/MapView";
import { Button, ErrorText, useToast } from "../components/ui";
import { ApiError, api, type CaptureBody } from "../lib/api";
import { LAND_USES, area, metres, parseRows } from "../lib/format";
import type { Check, Me } from "../lib/types";
import { useLoad } from "../lib/useLoad";

type Method = "traverse" | "coordinates";
type Row = [string, string, string];          // beacon, bearing | easting, distance | northing
const blank = (n: number): Row[] => Array.from({ length: n }, () => ["", "", ""] as Row);
const num = (s: string) => (s.trim() === "" ? NaN : Number(s.replace(/,/g, "")));

export function CheckResult({ c }: { c: Check }) {
  const cl = c.closure;
  return (
    <>
      <div className={`verdict ${c.ok ? "is-ok" : "is-bad"}`} role="status">
        <strong>{c.ok ? "This parcel can be registered" : "This parcel cannot be registered yet"}</strong>
        {!c.ok && <ul>{c.problems.map((p) => <li key={p}>{p}</li>)}</ul>}
      </div>
      {c.warnings.length > 0 && <div className="warnings"><ul>{c.warnings.map((w) => <li key={w}>{w}</li>)}</ul></div>}
      <dl className="facts">
        <dt>Area</dt><dd>{area(c.area_sqm)}{c.area_sqm >= 10000 ? "" : ` (${c.area_ha} ha)`}</dd>
        <dt>Perimeter</dt><dd>{metres(c.perimeter_m)}</dd>
        <dt>Beacons</dt><dd>{c.beacons.length}</dd>
        <dt>Grid</dt><dd>{c.grid_name}</dd>
        {cl && <>
          <dt>Misclosure</dt><dd>{cl.ratio == null ? "closes exactly" : `${metres(cl.misclosure_m)} (ΔE ${cl.misclosure_e} m, ΔN ${cl.misclosure_n} m)`}</dd>
          <dt>Closure</dt><dd>{cl.ratio == null ? "exact" : `1 in ${cl.ratio.toLocaleString("en-NG")}`} <span className="ge-muted">· needs 1 in {cl.required_ratio.toLocaleString("en-NG")}</span></dd>
          {cl.adjusted && <><dt>Adjustment</dt><dd>Spread around the legs (Bowditch)</dd></>}
        </>}
      </dl>
    </>
  );
}

/** Capture a parcel from a surveyor's traverse or beacon coordinates, check it, then register it. */
export default function NewParcelPage({ me }: { me: Me }) {
  const go = useNavigate();
  const toast = useToast();
  const grids = useLoad(() => api.grids());
  const settings = useLoad(() => api.settings());
  const fabric = useLoad(() => api.fabric());
  const [method, setMethod] = useState<Method>("traverse");
  const [epsg, setEpsg] = useState<number | null>(null);
  const [start, setStart] = useState<Row>(["", "", ""]);
  const [legs, setLegs] = useState<Row[]>(blank(4));
  const [points, setPoints] = useState<Row[]>(blank(4));
  const [paste, setPaste] = useState("");
  const [d, setD] = useState({ land_use: "", address: "", locality: "", survey_plan_no: "", surveyor: "", survey_date: "", notes: "" });
  const [check, setCheck] = useState<{ c: Check; for: string } | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState<"check" | "register" | null>(null);
  useEffect(() => { if (settings.data && epsg == null) setEpsg(settings.data.default_epsg); }, [settings.data, epsg]);

  const rows = method === "traverse" ? legs : points;
  const setRows = method === "traverse" ? setLegs : setPoints;
  const body = useMemo((): CaptureBody | string => {
    const filled = rows.filter((r) => r.some((x) => x.trim()));
    if (method === "traverse") {
      const [b, e, n] = start;
      if (!Number.isFinite(num(e)) || !Number.isFinite(num(n))) return "Give the starting beacon's easting and northing.";
      if (filled.length < 3) return "A traverse needs at least 3 legs.";
      for (const [i, r] of filled.entries()) {
        if (!r[1].trim() || !(num(r[2]) > 0)) return `Leg ${i + 1} needs a bearing and a distance.`;
      }
      return { method, epsg: epsg ?? undefined, start: { beacon: b.trim(), easting: num(e), northing: num(n) },
        legs: filled.map((r) => ({ beacon: r[0].trim(), bearing: r[1].trim(), distance_m: num(r[2]) })) };
    }
    if (filled.length < 3) return "A parcel needs at least 3 beacons.";
    for (const [i, r] of filled.entries()) {
      if (!Number.isFinite(num(r[1])) || !Number.isFinite(num(r[2]))) return `Beacon ${i + 1} needs both coordinates.`;
    }
    return { method, epsg: epsg ?? undefined, points: filled.map((r) => ({ beacon: r[0].trim(), x: num(r[1]), y: num(r[2]) })) };
  }, [method, epsg, start, rows]);
  const key = typeof body === "string" ? "" : JSON.stringify(body);
  const fresh = check && check.for === key ? check.c : null;

  const runCheck = async () => {
    if (typeof body === "string") { setErr(body); return; }
    setBusy("check"); setErr(null);
    try { setCheck({ c: await api.check(body), for: key }); }
    catch (e) { setErr(e); setCheck(null); }
    finally { setBusy(null); }
  };
  const register = async () => {
    if (typeof body === "string" || !fresh?.ok) return;
    setBusy("register"); setErr(null);
    try {
      const p = await api.registerParcel({ ...body, ...d, survey_date: d.survey_date || null });
      toast(`Registered ${p.pin}`);
      go(`/parcels/${p.id}`);
    } catch (e) {
      if (e instanceof ApiError && e.body?.check) setCheck({ c: e.body.check as Check, for: key });
      setErr(e);
    } finally { setBusy(null); }
  };
  const usePaste = () => {
    const { rows: got, bad } = parseRows(paste, method);
    if (!got.length) { setErr("Nothing to use: put one row per line."); return; }
    setRows([...got.map((r) => r as Row), ...blank(1)]);
    setPaste("");
    setErr(bad.length ? `Lines ${bad.join(", ")} were left out: they did not have the values needed.` : null);
  };
  const edit = (i: number, j: number, v: string) => setRows((rs) => {
    const next = rs.map((r) => [...r] as Row);
    next[i][j] = v;
    if (i === next.length - 1 && v.trim()) next.push(["", "", ""]);
    return next;
  });
  const remove = (i: number) => setRows((rs) => (rs.length > 1 ? rs.filter((_, k) => k !== i) : rs));

  if (me.role === "viewer") return <section className="ge-card"><h1>New parcel</h1><p>Only registrars and officers can register parcels.</p></section>;
  const projected = epsg !== 4326;
  const heads = method === "traverse" ? ["To beacon", "Bearing", "Distance (m)"] : ["Beacon", projected ? "Easting" : "Longitude", projected ? "Northing" : "Latitude"];

  return (
    <>
      <div className="head"><h1>New parcel</h1><Link to="/">Back to the register</Link></div>
      {!me.can_write && <p className="ge-notice ge-notice-bad">The subscription has ended, so you can check a survey but not register it.</p>}
      <div className="two">
        <div>
          <section className="ge-card stack">
            <h2>1. The survey</h2>
            <div className="toolbar" style={{ margin: 0 }}>
              <div className="seg" role="group" aria-label="How the boundary is given">
                <button type="button" aria-pressed={method === "traverse"} onClick={() => { setMethod("traverse"); if (epsg === 4326) setEpsg(settings.data?.default_epsg ?? 26332); }}>Bearings and distances</button>
                <button type="button" aria-pressed={method === "coordinates"} onClick={() => setMethod("coordinates")}>Beacon coordinates</button>
              </div>
            </div>
            <div className="ge-field">
              <label htmlFor="grid">Survey grid</label>
              <select id="grid" value={epsg ?? ""} onChange={(e) => setEpsg(Number(e.target.value))}>
                {(grids.data ?? []).filter((g) => method === "coordinates" || g.epsg !== 4326)
                  .map((g) => <option key={g.epsg} value={g.epsg}>{g.name} · EPSG:{g.epsg}</option>)}
              </select>
            </div>
            {method === "traverse" && (
              <fieldset className="start-grid">
                <legend>Starting beacon</legend>
                <div className="ge-field"><label htmlFor="sb">Beacon</label><input id="sb" placeholder="e.g. SC/FCT 1234" value={start[0]} onChange={(e) => setStart([e.target.value, start[1], start[2]])} /></div>
                <div className="ge-field"><label htmlFor="se">Easting (m)</label><input id="se" inputMode="decimal" value={start[1]} onChange={(e) => setStart([start[0], e.target.value, start[2]])} /></div>
                <div className="ge-field"><label htmlFor="sn">Northing (m)</label><input id="sn" inputMode="decimal" value={start[2]} onChange={(e) => setStart([start[0], start[1], e.target.value])} /></div>
              </fieldset>
            )}
            <div>
              <p className="ge-small ge-muted" style={{ margin: "0 0 6px" }}>
                {method === "traverse"
                  ? "One leg per row, in order around the parcel; the last leg comes back to the starting beacon. Bearings are whole-circle from grid north: 123.5, 123°30' or 123 30 15."
                  : "One beacon per row, in order around the parcel. The first beacon is not repeated at the end."}
              </p>
              <div className="table-wrap">
                <table className="ge-table capture" aria-label={method === "traverse" ? "Traverse legs" : "Beacon coordinates"}>
                  <thead><tr><th>#</th>{heads.map((h) => <th key={h}>{h}</th>)}<th><span className="sr-only">Remove</span></th></tr></thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={i}>
                        <td className="ge-muted">{i + 1}</td>
                        {r.map((v, j) => <td key={j}><input aria-label={`${heads[j]} ${i + 1}`} value={v} inputMode={j ? "decimal" : undefined}
                          className={j ? "mono" : undefined} onChange={(e) => edit(i, j, e.target.value)} /></td>)}
                        <td><button type="button" className="ge-btn ge-btn-ghost ge-btn-sm" aria-label={`Remove row ${i + 1}`} onClick={() => remove(i)}>×</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <details className="paste">
              <summary>Paste rows from a spreadsheet or the survey plan</summary>
              <label className="sr-only" htmlFor="paste">Rows to paste</label>
              <textarea id="paste" value={paste} onChange={(e) => setPaste(e.target.value)}
                placeholder={method === "traverse" ? "B2\t90°00'00\"\t30.000\nB3\t180 00 00\t20.000\n…" : "B1\t512340.12\t998765.43\nB2\t512370.12\t998765.43\n…"} />
              <Button small onClick={usePaste}>Use these rows</Button>
            </details>
            <div className="actions">
              <Button variant="primary" busy={busy === "check"} onClick={runCheck}>Check the boundary</Button>
              {typeof body === "string" && <span className="ge-muted ge-small">{body}</span>}
            </div>
          </section>
          <section className="ge-card">
            <h2>2. The parcel's details</h2>
            <div className="form-grid">
              <div className="ge-field"><label htmlFor="lu">Land use</label>
                <select id="lu" value={d.land_use} onChange={(e) => setD({ ...d, land_use: e.target.value })}>
                  <option value="">Not given</option>{LAND_USES.map((u) => <option key={u}>{u}</option>)}</select></div>
              <div className="ge-field"><label htmlFor="loc">Locality</label><input id="loc" placeholder="e.g. Kabusa" value={d.locality} onChange={(e) => setD({ ...d, locality: e.target.value })} /></div>
              <div className="ge-field wide"><label htmlFor="addr">Address or description</label><input id="addr" value={d.address} onChange={(e) => setD({ ...d, address: e.target.value })} /></div>
              <div className="ge-field"><label htmlFor="plan">Survey plan number</label><input id="plan" value={d.survey_plan_no} onChange={(e) => setD({ ...d, survey_plan_no: e.target.value })} /></div>
              <div className="ge-field"><label htmlFor="surv">Surveyor</label><input id="surv" value={d.surveyor} onChange={(e) => setD({ ...d, surveyor: e.target.value })} /></div>
              <div className="ge-field"><label htmlFor="sdate">Survey date</label><input id="sdate" type="date" value={d.survey_date} onChange={(e) => setD({ ...d, survey_date: e.target.value })} /></div>
              <div className="ge-field wide"><label htmlFor="notes">Notes</label><textarea id="notes" value={d.notes} onChange={(e) => setD({ ...d, notes: e.target.value })} /></div>
            </div>
          </section>
        </div>
        <section className="ge-card stack" aria-label="The check">
          <h2>3. Check and register</h2>
          <MapView fabric={fabric.data} preview={check?.c.geometry} previewOk={check?.c.ok ?? true} height={320} label="Map of the boundary being checked" />
          <ErrorText error={err} />
          {check ? <>
            {!fresh && <p className="ge-small ge-muted">The survey has changed since this check. Check it again before registering.</p>}
            <CheckResult c={check.c} />
          </> : <p className="ge-muted">Check the boundary to see its area, how well it closes, and whether it overlaps a registered parcel.</p>}
          <div className="actions">
            <Button variant="primary" busy={busy === "register"} disabled={!fresh?.ok || !me.can_write} onClick={register}>
              Register and give it a PIN</Button>
            {settings.data && <span className="ge-muted ge-small">Next PIN: {settings.data.pin_prefix}-{String(settings.data.pin_next).padStart(6, "0")}</span>}
          </div>
        </section>
      </div>
    </>
  );
}
