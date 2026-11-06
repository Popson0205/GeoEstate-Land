import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import MapView from "../components/MapView";
import { Button, ErrorText, useToast } from "../components/ui";
import { ApiError, api, type CaptureBody } from "../lib/api";
import { LAND_USES, area, joinBearing, metres, parseRows, splitBearing } from "../lib/format";
import type { Check, DxfRead, Me } from "../lib/types";
import { MAX_DXF, readText } from "../lib/readFile";
import { useLoad } from "../lib/useLoad";

type Method = "traverse" | "coordinates";
// A traverse leg: to beacon, degrees, minutes, seconds, distance. A beacon: name, easting, northing.
type Row = string[];
const LEG = 5, POINT = 3;
const blank = (n: number, cols: number): Row[] => Array.from({ length: n }, () => Array(cols).fill(""));
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
        {c.correction && <><dt>Corrected</dt><dd>to ground control ({c.correction.method_name.split(" (")[0]}, {c.correction.shift_e} m E, {c.correction.shift_n} m N; RMS {c.correction.rms_m} m)</dd></>}
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
  const [start, setStart] = useState<[string, string]>(["", ""]);          // the starting point's easting and northing
  const [legs, setLegs] = useState<Row[]>(blank(4, LEG));
  const [points, setPoints] = useState<Row[]>(blank(4, POINT));
  const [paste, setPaste] = useState("");
  const [d, setD] = useState({ land_use: "", address: "", locality: "", survey_plan_no: "", surveyor: "", survey_date: "", notes: "" });
  const [check, setCheck] = useState<{ c: Check; for: string } | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState<"check" | "register" | "dxf" | null>(null);
  const [dxf, setDxf] = useState<DxfRead | null>(null);
  const openDxf = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_DXF) { setErr("The drawing is over 15 MB. Export only the parcel boundaries."); return; }
    setBusy("dxf"); setErr(null);
    try {
      const got = await api.importDxf(file.name, await readText(file));
      setDxf(got);
      if (got.shapes.length === 1) takeShape(got.shapes[0].points, got.shapes[0].label);
    } catch (e) { setErr(e); } finally { setBusy(null); }
  };
  const takeShape = (pts: { x: number; y: number; beacon: string }[], label: string) => {
    setMethod("coordinates");
    setPoints([...pts.map((p) => [p.beacon, String(p.x), String(p.y)]), ["", "", ""]]);
    if (label) setD((x) => ({ ...x, address: x.address || label }));
    setCheck(null);
  };
  useEffect(() => { if (settings.data && epsg == null) setEpsg(settings.data.default_epsg); }, [settings.data, epsg]);

  const rows = method === "traverse" ? legs : points;
  const setRows = method === "traverse" ? setLegs : setPoints;
  const body = useMemo((): CaptureBody | string => {
    const filled = rows.filter((r) => r.some((x) => x.trim()));
    if (method === "traverse") {
      const [e, n] = start;
      if (!Number.isFinite(num(e)) || !Number.isFinite(num(n))) return "Give the starting point's easting and northing.";
      if (filled.length < 3) return "A traverse needs at least 3 legs.";
      for (const [i, r] of filled.entries()) {
        if (!joinBearing(r[1], r[2], r[3])) return `Leg ${i + 1}: degrees 0 to 359, minutes and seconds 0 to 59.`;
        if (!(num(r[4]) > 0)) return `Leg ${i + 1} needs a distance.`;
      }
      return { method, epsg: epsg ?? undefined, start: { beacon: "", easting: num(e), northing: num(n) },
        legs: filled.map((r) => ({ beacon: r[0].trim(), bearing: joinBearing(r[1], r[2], r[3])!, distance_m: num(r[4]) })) };
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
    setRows([...got.map((r) => (method === "traverse" ? [r[0], ...splitBearing(r[1]), r[2]] : r)), ...blank(1, method === "traverse" ? LEG : POINT)]);
    setPaste("");
    setErr(bad.length ? `Lines ${bad.join(", ")} were left out: they did not have the values needed.` : null);
  };
  const edit = (i: number, j: number, v: string) => setRows((rs) => {
    const next = rs.map((r) => [...r]);
    next[i][j] = v;
    if (i === next.length - 1 && v.trim()) next.push(Array(next[i].length).fill(""));
    return next;
  });
  const remove = (i: number) => setRows((rs) => (rs.length > 1 ? rs.filter((_, k) => k !== i) : rs));

  if (me.role === "viewer") return <section className="ge-card"><h1>New parcel</h1><p>Only registrars and officers can register parcels.</p></section>;
  const projected = epsg !== 4326;
  const heads = method === "traverse" ? ["To beacon", "Degrees", "Minutes", "Seconds", "Distance (m)"] : ["Beacon", projected ? "Easting" : "Longitude", projected ? "Northing" : "Latitude"];

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
                <legend>Starting point</legend>
                <div className="ge-field"><label htmlFor="se">Easting (m)</label><input id="se" inputMode="decimal" value={start[0]} onChange={(e) => setStart([e.target.value, start[1]])} /></div>
                <div className="ge-field"><label htmlFor="sn">Northing (m)</label><input id="sn" inputMode="decimal" value={start[1]} onChange={(e) => setStart([start[0], e.target.value])} /></div>
              </fieldset>
            )}
            <div>
              <p className="ge-small ge-muted" style={{ margin: "0 0 6px" }}>
                {method === "traverse"
                  ? "One leg per row, in order around the parcel; the last leg comes back to the starting point. Bearings are whole-circle from grid north, in degrees, minutes and seconds."
                  : "One beacon per row, in order around the parcel. The first beacon is not repeated at the end."}
              </p>
              <div className="table-wrap">
                <table className={`ge-table capture${method === "traverse" ? " is-legs" : ""}`} aria-label={method === "traverse" ? "Traverse legs" : "Beacon coordinates"}>
                  <thead><tr><th>#</th>{heads.map((h) => <th key={h}>{h}</th>)}<th><span className="sr-only">Remove</span></th></tr></thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={i}>
                        <td className="ge-muted">{i + 1}</td>
                        {r.map((v, j) => <td key={j}><input aria-label={`${heads[j]} ${i + 1}`} value={v} inputMode={j ? (method === "traverse" && j < 4 ? "numeric" : "decimal") : undefined}
                          maxLength={method === "traverse" && j > 0 && j < 4 ? (j === 1 ? 3 : 5) : undefined} placeholder={method === "traverse" ? ["", "°", "′", "″", "m"][j] : undefined}
                          className={j ? "mono" : undefined} onChange={(e) => edit(i, j, e.target.value)} /></td>)}
                        <td><button type="button" className="ge-btn ge-btn-ghost ge-btn-sm" aria-label={`Remove row ${i + 1}`} onClick={() => remove(i)}>×</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            {settings.data?.dxf_allowed !== false && <div className="actions">
              <label className="ge-btn ge-btn-sm" htmlFor="dxf">{busy === "dxf" ? "Reading the drawing…" : "Import from a DXF drawing"}</label>
              <input id="dxf" type="file" accept=".dxf" className="sr-only" onChange={(e) => { void openDxf(e.target.files?.[0]); e.target.value = ""; }} />
              <Link className="ge-small" to="/parcels/import">Register a whole layout from one drawing</Link>
            </div>}
            {dxf && dxf.shapes.length > 1 && (
              <div className="ge-small">
                <strong>{dxf.filename}</strong> has {dxf.shapes.length} closed boundaries. Choose one:
                <div className="chips" style={{ marginTop: 6 }}>{dxf.shapes.slice(0, 60).map((sh) => (
                  <button key={sh.index} type="button" className="chip" onClick={() => takeShape(sh.points, sh.label)}>
                    {sh.label || `Shape ${sh.index + 1}`} · {Math.round(sh.area_plan).toLocaleString("en-NG")} m²</button>))}</div>
              </div>
            )}
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
