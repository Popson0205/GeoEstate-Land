export type Role = "registrar" | "officer" | "viewer";
export interface Me {
  id: string; name: string; email: string; org_id: string | null; org_name: string | null; org_role: string | null; role: Role;
  staff_role: string | null; licence: string | null; can_write: boolean; features: string[]; limits: Record<string, number | null>;
  product: { name: string; plan_name: string; status: string; licence_kind: string; subscription_ends: string | null; grace_ends: string | null } | null;
  geohub_url: string;
}
export interface App { product: string; name: string; status: string; url: string | null; current: boolean }
export interface Grid { epsg: number; name: string }
export interface OrgSettings { org_id: string; org_name: string; default_epsg: number; grid_name: string; pin_prefix: string; pin_next: number;
  closure_ratio: number; overlap_tolerance_sqm: number }
export interface Beacon { seq: number; name: string; easting: number | null; northing: number | null; lon: number; lat: number }
export interface Check {
  ok: boolean; problems: string[]; warnings: string[]; method: "traverse" | "coordinates"; epsg: number; grid_name: string;
  closure: { misclosure_m: number; misclosure_e: number; misclosure_n: number; perimeter_m: number; ratio: number | null; required_ratio: number; adjusted: boolean } | null;
  legs: { bearing: number; bearing_dms: string; distance_m: number }[]; area_sqm: number; area_ha: number; perimeter_m: number;
  geometry: GeoJSON.Polygon; beacons: Beacon[]; overlaps: { id: string; pin: string; overlap_sqm: number }[];
}
export interface ParcelRow {
  id: string; pin: string; status: "active" | "retired"; area_sqm: string; perimeter_m: string; land_use: string; address: string; locality: string;
  notes: string; method: string; source_epsg: number; closure_error_m: string | null; closure_ratio: number | null; survey_plan_no: string;
  surveyor: string; survey_date: string | null; retired_reason: string | null; created_by_name: string; created_at: string; updated_at: string;
  lon: number; lat: number;
}
export interface Parcel extends ParcelRow {
  geometry: GeoJSON.Polygon; grid_name: string; beacons: Beacon[]; neighbours: { id: string; pin: string; land_use: string }[];
  history: { at: string; actor_name: string; action: string; details: Record<string, unknown> }[];
}
export interface Home { active: number; retired: number; area_sqm: number; this_month: number; latest: ParcelRow[]; limit: number | null; settings: OrgSettings }
export interface AuditEntry { id: number; at: string; actor_name: string | null; action: string; target_type: string | null; target_id: string | null; details: Record<string, unknown> }
