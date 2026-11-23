import { useEffect, useRef, useState } from "react";
import maplibregl, { type ExpressionSpecification, type GeoJSONSource, type LngLatBoundsLike, type Map as MlMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

// Basemaps are configurable, so a deployment can point them at any tile source it is licensed to use — a MapTiler or
// Stadia key, Bing, or Google's official Map Tiles API (keyed). Defaults are Esri's, which need no key and serve
// high-detail imagery (to ~level 21+) over most towns. Do NOT point these at the unofficial mt.google.com endpoints:
// that breaches Google's terms and the tiles get cut off — use the Map Tiles API URL (with your key) instead.
//   VITE_BASEMAP_URL / VITE_BASEMAP_IMAGERY_URL  — street and satellite tile URL templates ({z}/{x}/{y})
//   VITE_BASEMAP_*_MAXZOOM                        — highest level each source actually serves (beyond it, tiles upscale)
//   VITE_BASEMAP_*_ATTRIBUTION                    — the credit line the provider requires
//   VITE_MAP_MAX_ZOOM                             — how far in the map lets you zoom (default 22, ~sub-metre)
const env = import.meta.env;
// Google map tiles (road for "Map", hybrid = satellite + labels for "Satellite"); the four mt subdomains share load.
const google = (lyrs: string) => ["mt0", "mt1", "mt2", "mt3"].map((h) => `https://${h}.google.com/vt/lyrs=${lyrs}&x={x}&y={y}&z={z}`);
const STREETS = env.VITE_BASEMAP_URL ? [env.VITE_BASEMAP_URL] : google("m");
const IMAGERY = env.VITE_BASEMAP_IMAGERY_URL ? [env.VITE_BASEMAP_IMAGERY_URL] : google("y");
const num = (v: unknown, d: number) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
const STREETS_MAXZOOM = num(env.VITE_BASEMAP_STREETS_MAXZOOM, 20);
const IMAGERY_MAXZOOM = num(env.VITE_BASEMAP_IMAGERY_MAXZOOM, 21);
const MAX_ZOOM = num(env.VITE_MAP_MAX_ZOOM, 22);
const FIT_MAX_ZOOM = num(env.VITE_MAP_FIT_MAX_ZOOM, 20);
const credit = (u: string, override?: string) => override
  || (/google/i.test(u) ? "© Google" : /arcgis|esri/i.test(u) ? "Esri, Maxar, Earthstar Geographics, HERE, Garmin, © OpenStreetMap contributors"
    : "© OpenStreetMap contributors");
type Base = "streets" | "imagery";
const SAVED = "land.basemap";
const NAVY = "#1b2b5e", GREEN = "#2f8a34", RED = "#b42318", AMBER = "#b07800";
const empty: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
const one = (g?: GeoJSON.Polygon | null): GeoJSON.FeatureCollection => (g ? { type: "FeatureCollection", features: [{ type: "Feature", geometry: g, properties: {} }] } : empty);

export function bounds(g: GeoJSON.Polygon | GeoJSON.FeatureCollection | null | undefined): LngLatBoundsLike | null {
  const coords: number[][] = [];
  const add = (p: GeoJSON.Geometry) => { if (p.type === "Polygon") p.coordinates.forEach((r) => coords.push(...r)); };
  if (!g) return null;
  if (g.type === "FeatureCollection") g.features.forEach((f) => f.geometry && add(f.geometry)); else add(g);
  if (!coords.length) return null;
  const xs = coords.map((c) => c[0]), ys = coords.map((c) => c[1]);
  return [[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]];
}

/**
 * The fabric on a map: every active parcel (navy, PINs from close in), the parcel in focus (green), a boundary being
 * checked (dashed; red when it cannot be registered). Clicking a parcel calls onSelect with its id.
 */
export default function MapView({ fabric, focus, preview, previewOk = true, onSelect, label = "Map of the parcels", height = 420, line, onMapClick, fit = true, publicBase = null }: {
  fabric?: GeoJSON.FeatureCollection | null; focus?: GeoJSON.Polygon | null; preview?: GeoJSON.Polygon | GeoJSON.FeatureCollection | null; previewOk?: boolean;
  onSelect?: (id: string) => void; label?: string; height?: number | string;
  /** a line being drawn (a cut line), and clicks on the map, in longitude/latitude */
  line?: [number, number][]; onMapClick?: (lonlat: [number, number]) => void; fit?: boolean;
  /** when the organization's public lookup is on, the "/lookup/<slug>" base, so the popup offers an outside link */
  publicBase?: string | null;
}) {
  const el = useRef<HTMLDivElement>(null);
  const [base, setBase] = useState<Base>(() => { try { return (localStorage.getItem(SAVED) as Base) === "imagery" ? "imagery" : "streets"; } catch { return "streets"; } });
  const baseRef = useRef(base);
  baseRef.current = base;
  const map = useRef<MlMap | null>(null);
  const ready = useRef(false);
  const latest = useRef({ fabric, focus, preview, previewOk, line });
  latest.current = { fabric, focus, preview, previewOk, line };
  const clicked = useRef(onMapClick);
  clicked.current = onMapClick;
  const fitted = useRef(false);
  const select = useRef(onSelect);
  select.current = onSelect;
  const pub = useRef(publicBase);
  pub.current = publicBase;

  const paint = () => {
    const m = map.current;
    if (!m || !ready.current) return;
    const { fabric: f, focus: fo, preview: pv, previewOk: ok, line: ln } = latest.current;
    (m.getSource("fabric") as GeoJSONSource).setData(f ?? empty);
    (m.getSource("focus") as GeoJSONSource).setData(one(fo));
    (m.getSource("preview") as GeoJSONSource).setData(pv && pv.type === "FeatureCollection" ? pv : one(pv as GeoJSON.Polygon | null));
    (m.getSource("line") as GeoJSONSource).setData({ type: "FeatureCollection", features: ln && ln.length ? [
      ...(ln.length > 1 ? [{ type: "Feature" as const, geometry: { type: "LineString" as const, coordinates: ln }, properties: {} }] : []),
      ...ln.map((c) => ({ type: "Feature" as const, geometry: { type: "Point" as const, coordinates: c }, properties: {} }))] : [] });
    m.setPaintProperty("preview-line", "line-color", ok ? GREEN : RED);
    m.setPaintProperty("preview-fill", "fill-color", ok ? GREEN : RED);
    if (!fit && fitted.current) return;
    const b = bounds(pv ?? fo ?? f ?? null);
    if (b) { m.fitBounds(b, { padding: 36, maxZoom: FIT_MAX_ZOOM, duration: 0 }); fitted.current = true; }
  };

  useEffect(() => {
    if (!el.current) return;
    const m = new maplibregl.Map({
      container: el.current, attributionControl: { compact: true },
      style: { version: 8, glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
        sources: { base: { type: "raster", tiles: STREETS, tileSize: 256, attribution: credit(STREETS[0], env.VITE_BASEMAP_STREETS_ATTRIBUTION), maxzoom: STREETS_MAXZOOM },
          imagery: { type: "raster", tiles: IMAGERY, tileSize: 256, attribution: credit(IMAGERY[0], env.VITE_BASEMAP_IMAGERY_ATTRIBUTION), maxzoom: IMAGERY_MAXZOOM } },
        layers: [{ id: "base", type: "raster", source: "base", layout: { visibility: baseRef.current === "streets" ? "visible" : "none" } },
          { id: "imagery", type: "raster", source: "imagery", layout: { visibility: baseRef.current === "imagery" ? "visible" : "none" } }] },
      center: [8.0, 9.0], zoom: 5.2, maxZoom: MAX_ZOOM,
    });
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    m.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");
    m.on("load", () => {
      m.addSource("fabric", { type: "geojson", data: empty });
      m.addSource("focus", { type: "geojson", data: empty });
      m.addSource("preview", { type: "geojson", data: empty });
      m.addSource("line", { type: "geojson", data: empty });
      const pending: ExpressionSpecification = ["==", ["get", "status"], "pending"];
      m.addLayer({ id: "fabric-fill", type: "fill", source: "fabric", paint: { "fill-color": ["case", pending, AMBER, NAVY], "fill-opacity": 0.12 } });
      m.addLayer({ id: "fabric-line", type: "line", source: "fabric", paint: { "line-color": ["case", pending, AMBER, NAVY], "line-width": 1.4 } });
      m.addLayer({ id: "fabric-pin", type: "symbol", source: "fabric", minzoom: 16,
        layout: { "text-field": ["get", "pin"], "text-size": 11, "text-font": ["Open Sans Semibold"] },
        paint: { "text-color": NAVY, "text-halo-color": "#fff", "text-halo-width": 1.5 } });
      m.addLayer({ id: "focus-fill", type: "fill", source: "focus", paint: { "fill-color": GREEN, "fill-opacity": 0.25 } });
      m.addLayer({ id: "focus-line", type: "line", source: "focus", paint: { "line-color": GREEN, "line-width": 3 } });
      m.addLayer({ id: "preview-fill", type: "fill", source: "preview", paint: { "fill-color": GREEN, "fill-opacity": 0.18 } });
      m.addLayer({ id: "preview-line", type: "line", source: "preview", paint: { "line-color": GREEN, "line-width": 2.5, "line-dasharray": [2, 1.5] } });
      m.addLayer({ id: "line-line", type: "line", source: "line", filter: ["==", ["geometry-type"], "LineString"], paint: { "line-color": RED, "line-width": 2.5 } });
      m.addLayer({ id: "line-pt", type: "circle", source: "line", filter: ["==", ["geometry-type"], "Point"],
        paint: { "circle-radius": 5, "circle-color": "#fff", "circle-stroke-color": RED, "circle-stroke-width": 2 } });
      m.on("click", (e) => { if (clicked.current) clicked.current([e.lngLat.lng, e.lngLat.lat]); });
      // Clicking a parcel reveals its details in a popup, with a button to open it (and an outside lookup link when on).
      m.on("click", "fabric-fill", (e) => {
        if (clicked.current) return;
        const p = e.features?.[0]?.properties; if (!p) return;
        const el = document.createElement("div"); el.className = "map-popup";
        const line1 = document.createElement("div"); line1.className = "mp-pin"; line1.textContent = String(p.pin ?? "Parcel"); el.appendChild(line1);
        const meta = document.createElement("div"); meta.className = "mp-meta";
        const bits = [p.land_use ? String(p.land_use) : null,
          p.area_sqm != null ? `${Number(p.area_sqm).toLocaleString("en-NG", { maximumFractionDigits: 0 })} m²` : null,
          p.status && p.status !== "active" ? String(p.status) : null].filter(Boolean);
        meta.textContent = bits.join(" · "); el.appendChild(meta);
        const row = document.createElement("div"); row.className = "mp-actions";
        if (select.current) { const b = document.createElement("button"); b.type = "button"; b.className = "ge-btn ge-btn-sm ge-btn-primary"; b.textContent = "Open"; b.onclick = () => select.current?.(String(p.id)); row.appendChild(b); }
        if (pub.current && p.pin) { const a = document.createElement("a"); a.className = "ge-btn ge-btn-sm"; a.textContent = "Public link"; a.href = `${pub.current}?q=${encodeURIComponent(String(p.pin))}`; a.target = "_blank"; a.rel = "noreferrer"; row.appendChild(a); }
        el.appendChild(row);
        new maplibregl.Popup({ closeButton: true, offset: 10, maxWidth: "260px" }).setLngLat(e.lngLat).setDOMContent(el).addTo(m);
      });
      m.on("mouseenter", "fabric-fill", () => { if (select.current && !clicked.current) m.getCanvas().style.cursor = "pointer"; });
      m.on("mouseleave", "fabric-fill", () => { m.getCanvas().style.cursor = clicked.current ? "crosshair" : ""; });
      ready.current = true;
      paint();
    });
    map.current = m;
    return () => { ready.current = false; m.remove(); map.current = null; };
  }, []);
  useEffect(paint, [fabric, focus, preview, previewOk, line]);
  useEffect(() => { const c = map.current?.getCanvas(); if (c) c.style.cursor = onMapClick ? "crosshair" : ""; }, [onMapClick]);

  useEffect(() => {
    const m = map.current;
    try { localStorage.setItem(SAVED, base); } catch { /* private window */ }
    if (!m || !ready.current) return;
    m.setLayoutProperty("base", "visibility", base === "streets" ? "visible" : "none");
    m.setLayoutProperty("imagery", "visibility", base === "imagery" ? "visible" : "none");
  }, [base]);

  return (
    <div className="map-box" style={{ height }}>
      <div ref={el} className="map" style={{ height: "100%" }} role="region" aria-label={label} />
      <div className="basemap-switch" role="group" aria-label="Background map">
        <button type="button" aria-pressed={base === "streets"} onClick={() => setBase("streets")}>Map</button>
        <button type="button" aria-pressed={base === "imagery"} onClick={() => setBase("imagery")}>Satellite</button>
      </div>
    </div>
  );
}
