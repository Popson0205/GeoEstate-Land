import { useNavigate } from "react-router-dom";
import MapView from "../components/MapView";
import { ErrorText } from "../components/ui";
import { api } from "../lib/api";
import { useLoad } from "../lib/useLoad";

/** The fabric: every active parcel. Click one to open it. */
export default function MapPage() {
  const go = useNavigate();
  const fabric = useLoad(() => api.fabric());
  const n = fabric.data?.features.length ?? 0;
  return (
    <div className="map-page">
      <div className="head">
        <h1>Map of the fabric</h1>
        <span className="ge-muted">{fabric.data ? (n ? `${n.toLocaleString("en-NG")} active parcel${n === 1 ? "" : "s"} · click one to open it` : "No parcels yet") : "Loading…"}</span>
      </div>
      <ErrorText error={fabric.error} />
      <MapView fabric={fabric.data} onSelect={(id) => go(`/parcels/${id}`)} label="Map of the parcel fabric" />
    </div>
  );
}
