import { useEffect, useRef } from "react";
import maplibregl, { type GeoJSONSource, type LngLatBoundsLike, type Map as MlMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

const BASEMAP = import.meta.env.VITE_BASEMAP_URL || "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const NAVY = "#1b2b5e", GREEN = "#2f8a34", RED = "#b42318";
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
export default function MapView({ fabric, focus, preview, previewOk = true, onSelect, label = "Map of the parcels", height = 420 }: {
  fabric?: GeoJSON.FeatureCollection | null; focus?: GeoJSON.Polygon | null; preview?: GeoJSON.Polygon | null; previewOk?: boolean;
  onSelect?: (id: string) => void; label?: string; height?: number | string;
}) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<MlMap | null>(null);
  const ready = useRef(false);
  const latest = useRef({ fabric, focus, preview, previewOk });
  latest.current = { fabric, focus, preview, previewOk };
  const select = useRef(onSelect);
  select.current = onSelect;

  const paint = () => {
    const m = map.current;
    if (!m || !ready.current) return;
    const { fabric: f, focus: fo, preview: pv, previewOk: ok } = latest.current;
    (m.getSource("fabric") as GeoJSONSource).setData(f ?? empty);
    (m.getSource("focus") as GeoJSONSource).setData(one(fo));
    (m.getSource("preview") as GeoJSONSource).setData(one(pv));
    m.setPaintProperty("preview-line", "line-color", ok ? GREEN : RED);
    m.setPaintProperty("preview-fill", "fill-color", ok ? GREEN : RED);
    const b = bounds(pv ?? fo ?? f ?? null);
    if (b) m.fitBounds(b, { padding: 48, maxZoom: 19, duration: 0 });
  };

  useEffect(() => {
    if (!el.current) return;
    const m = new maplibregl.Map({
      container: el.current, attributionControl: { compact: true },
      style: { version: 8, glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
        sources: { base: { type: "raster", tiles: [BASEMAP], tileSize: 256, attribution: "© OpenStreetMap contributors", maxzoom: 19 } },
        layers: [{ id: "base", type: "raster", source: "base" }] },
      center: [8.0, 9.0], zoom: 5.2,
    });
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    m.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");
    m.on("load", () => {
      m.addSource("fabric", { type: "geojson", data: empty });
      m.addSource("focus", { type: "geojson", data: empty });
      m.addSource("preview", { type: "geojson", data: empty });
      m.addLayer({ id: "fabric-fill", type: "fill", source: "fabric", paint: { "fill-color": NAVY, "fill-opacity": 0.12 } });
      m.addLayer({ id: "fabric-line", type: "line", source: "fabric", paint: { "line-color": NAVY, "line-width": 1.4 } });
      m.addLayer({ id: "fabric-pin", type: "symbol", source: "fabric", minzoom: 16,
        layout: { "text-field": ["get", "pin"], "text-size": 11, "text-font": ["Open Sans Semibold"] },
        paint: { "text-color": NAVY, "text-halo-color": "#fff", "text-halo-width": 1.5 } });
      m.addLayer({ id: "focus-fill", type: "fill", source: "focus", paint: { "fill-color": GREEN, "fill-opacity": 0.25 } });
      m.addLayer({ id: "focus-line", type: "line", source: "focus", paint: { "line-color": GREEN, "line-width": 3 } });
      m.addLayer({ id: "preview-fill", type: "fill", source: "preview", paint: { "fill-color": GREEN, "fill-opacity": 0.18 } });
      m.addLayer({ id: "preview-line", type: "line", source: "preview", paint: { "line-color": GREEN, "line-width": 2.5, "line-dasharray": [2, 1.5] } });
      m.on("click", "fabric-fill", (e) => { const id = e.features?.[0]?.properties?.id; if (id && select.current) select.current(String(id)); });
      m.on("mouseenter", "fabric-fill", () => { if (select.current) m.getCanvas().style.cursor = "pointer"; });
      m.on("mouseleave", "fabric-fill", () => { m.getCanvas().style.cursor = ""; });
      ready.current = true;
      paint();
    });
    map.current = m;
    return () => { ready.current = false; m.remove(); map.current = null; };
  }, []);
  useEffect(paint, [fabric, focus, preview, previewOk]);

  return <div ref={el} className="map" style={{ height }} role="region" aria-label={label} />;
}
