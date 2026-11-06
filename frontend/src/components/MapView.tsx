import { useEffect, useRef, useState } from "react";
import maplibregl, { type ExpressionSpecification, type GeoJSONSource, type LngLatBoundsLike, type Map as MlMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

// OpenStreetMap's own tile servers refuse apps (403 "Access blocked"), so the maps come from Esri's, which need no key.
// VITE_BASEMAP_URL replaces the street map (e.g. a MapTiler or Stadia address with your key).
const STREETS = import.meta.env.VITE_BASEMAP_URL || "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}";
const IMAGERY = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const credit = (u: string) => (/arcgis|esri/i.test(u) ? "Esri, Maxar, Earthstar Geographics, HERE, Garmin, © OpenStreetMap contributors" : "© OpenStreetMap contributors");
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
export default function MapView({ fabric, focus, preview, previewOk = true, onSelect, label = "Map of the parcels", height = 420, line, onMapClick, fit = true }: {
  fabric?: GeoJSON.FeatureCollection | null; focus?: GeoJSON.Polygon | null; preview?: GeoJSON.Polygon | GeoJSON.FeatureCollection | null; previewOk?: boolean;
  onSelect?: (id: string) => void; label?: string; height?: number | string;
  /** a line being drawn (a cut line), and clicks on the map, in longitude/latitude */
  line?: [number, number][]; onMapClick?: (lonlat: [number, number]) => void; fit?: boolean;
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
    if (b) { m.fitBounds(b, { padding: 48, maxZoom: 19, duration: 0 }); fitted.current = true; }
  };

  useEffect(() => {
    if (!el.current) return;
    const m = new maplibregl.Map({
      container: el.current, attributionControl: { compact: true },
      style: { version: 8, glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
        sources: { base: { type: "raster", tiles: [STREETS], tileSize: 256, attribution: credit(STREETS), maxzoom: 19 },
          imagery: { type: "raster", tiles: [IMAGERY], tileSize: 256, attribution: credit(IMAGERY), maxzoom: 19 } },
        layers: [{ id: "base", type: "raster", source: "base", layout: { visibility: baseRef.current === "streets" ? "visible" : "none" } },
          { id: "imagery", type: "raster", source: "imagery", layout: { visibility: baseRef.current === "imagery" ? "visible" : "none" } }] },
      center: [8.0, 9.0], zoom: 5.2,
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
      m.on("click", "fabric-fill", (e) => {
        if (clicked.current) return; const id = e.features?.[0]?.properties?.id; if (id && select.current) select.current(String(id)); });
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
