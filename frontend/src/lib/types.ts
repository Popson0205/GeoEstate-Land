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
  closure_ratio: number; overlap_tolerance_sqm: number; org_slug: string; title_prefix: string; title_next: number;
  public_lookup: "off" | "basic" | "holders"; public_allowed: boolean; workflows_allowed: boolean; dxf_allowed: boolean }
export interface Beacon { seq: number; name: string; easting: number | null; northing: number | null; lon: number; lat: number }
export interface Check {
  ok: boolean; problems: string[]; warnings: string[]; method: "traverse" | "coordinates"; epsg: number; grid_name: string;
  closure: { misclosure_m: number; misclosure_e: number; misclosure_n: number; perimeter_m: number; ratio: number | null; required_ratio: number; adjusted: boolean;
    fixes?: LegFix[]; suspect?: LegFix | null; closed?: ClosedToStart } | null;
  legs: { bearing: number; bearing_dms: string; distance_m: number }[]; area_sqm: number; area_ha: number; perimeter_m: number;
  geometry: GeoJSON.Polygon; beacons: Beacon[]; overlaps: { id: string; pin: string; overlap_sqm: number }[]; correction: Correction | null;
}
export interface Correction { method: string; method_name: string; shift_e: number; shift_n: number; rms_m: number; points: number; scale_ppm?: number; rotation_sec?: number }
export interface ParcelRow {
  id: string; pin: string; status: "pending" | "active" | "retired" | "rejected"; decided_by_name: string | null; decided_at: string | null;
  decision_note: string; correction: Correction | null; area_sqm: string; perimeter_m: string; land_use: string; address: string; locality: string;
  notes: string; method: string; source_epsg: number; closure_error_m: string | null; closure_ratio: number | null; closed_to_start?: ClosedToStart | null; survey_plan_no: string;
  surveyor: string; survey_date: string | null; retired_reason: string | null; created_by_name: string; created_at: string; updated_at: string;
  lon: number; lat: number; title_no: string | null;
}
export interface Parcel extends ParcelRow {
  geometry: GeoJSON.Polygon; grid_name: string; beacons: Beacon[]; neighbours: { id: string; pin: string; land_use: string }[];
  history: { at: string; actor_name: string; action: string; details: Record<string, unknown> }[];
  parents: { id: string; pin: string; number: string; kind: string }[]; children: { id: string; pin: string; number: string; kind: string }[];
}
export interface Home { pending: number; active: number; retired: number; area_sqm: number; this_month: number; titled: number; lodged: number; latest: ParcelRow[]; limit: number | null; settings: OrgSettings }
export interface AuditEntry { id: number; at: string; actor_name: string | null; action: string; target_type: string | null; target_id: string | null; details: Record<string, unknown> }

export type InstrumentKind = "grant" | "transfer" | "mortgage" | "caveat" | "lease" | "discharge" | "revocation" | "subdivision" | "amalgamation";
export interface PartyIn { id?: string; kind?: string; name: string; id_type?: string; id_no?: string; phone?: string; email?: string; address?: string }
export interface HolderData { party: PartyIn; share: string }
export interface Instrument {
  id: string; number: string; parcel_id: string; pin: string; kind: InstrumentKind; kind_name: string; summary: string;
  status: "lodged" | "registered" | "rejected" | "withdrawn"; data: Record<string, unknown> & { holders?: HolderData[]; party?: PartyIn; details?: string };
  instrument_date: string | null; reference: string; consideration_ngn: string | null; lodged_by: string; lodged_by_name: string; lodged_at: string;
  decided_by_name: string | null; decided_at: string | null; decision_note: string; problems?: string[]; warnings?: string[];
  approvals?: { by_id: string; by_name: string; at: string; note: string }[]; steps?: number;
}
export interface Title {
  id: string; title_no: string; kind: string; kind_name: string; status: string; purpose: string; term_years: number | null;
  starts_on: string | null; ends_on: string | null; ground_rent_ngn: string | null; granted_by_number: string; created_at: string;
}
export interface Holder { id: string; kind: string; name: string; id_type: string; id_no: string; share: string; since_number: string; since: string }
export interface Encumbrance { id: string; kind: "mortgage" | "caveat" | "lease"; amount_ngn: string | null; term_years: number | null; details: string;
  party_id: string | null; party_name: string | null; instrument_number: string; since: string }
export interface Register {
  parcel: { id: string; pin: string; status: string; area_sqm: string; land_use: string; locality: string; address: string };
  title: Title | null; holders: Holder[]; encumbrances: Encumbrance[]; instruments: Instrument[];
  past_titles: { title_no: string; kind: string; status: string; created_at: string; ended_by_number: string | null; ended_at: string | null }[];
}
export interface PartyRow { id: string; kind: string; name: string; id_type: string; id_no: string; phone: string; holdings: number }
export interface PartyDetail { id: string; kind: string; name: string; id_type: string; id_no: string; phone: string; email: string; address: string;
  holdings: { parcel_id: string; pin: string; address: string; locality: string; title_no: string; share: string; from_number: string; since: string; to_number: string | null; until: string | null }[];
  interests: { parcel_id: string; pin: string; kind: string; amount_ngn: string | null; active: boolean }[] }
export interface Kinds { titles: Record<string, string>; instruments: Record<InstrumentKind, string>; parties: string[] }
export interface PublicResult {
  registry: string; pin: string; status: string; area_sqm: number; land_use: string; locality: string; lon: number; lat: number;
  title: { title_no: string; kind: string; starts_on: string | null; ends_on: string | null } | null;
  encumbrances: { kind: string; count: number }[]; dealings_pending: number; holders: { name: string; share: string }[] | null; checked_at: string;
}

export type Workflow = Record<"parcel" | InstrumentKind, number>;
export interface ControlPoint { id: string; epsg: number; name: string; plan_e: string; plan_n: string; true_e: string; true_n: string; notes: string }
export interface Fit extends Partial<Correction> { method: string; method_name: string; error?: string; residuals?: { name: string; de: number; dn: number; d: number }[] }
export interface Control { epsg: number; grid_name: string; method: string; points: ControlPoint[]; fits: Record<string, Fit> }
export interface DxfShape { index: number; layer: string; label: string; area_plan: number; points: { x: number; y: number; beacon: string }[] }
export interface DxfRead { filename: string; shapes: DxfShape[]; layers: string[]; texts: number }

export interface GeohubField { id: string; label: string; type: string; choices?: string[] }
export interface GeohubForm { id: string; name: string; geometry_type: string; version: number; features: number; approved: number; fields: GeohubField[];
  template?: string | null }
export interface GeohubProject { id: string; name: string; description: string; role: string; forms: GeohubForm[] }
export interface EnumSource { id: string; project_id: string; project_name: string; form_id: string; form_name: string;
  field_map: Record<string, string>; defaults: Record<string, string>; created_by_name: string; created_at: string; imported: number; claims_lodged: number;
  form?: GeohubForm | null }
export interface Mapped { plot_no: string; address: string; locality: string; land_use: string; notes: string; claimant_name: string;
  claimant_phone: string; claimant_id_no: string; full_address: string;
  claimant_kind?: string; dispute?: string; dispute_note?: string; tenure?: string }
export interface EnumFeature { id: string; seq: number; status: string; version: number; geometry: GeoJSON.Geometry; created_by_name: string | null;
  created_at: string; reviewed_by_name: string | null; mapped: Mapped; properties: Record<string, unknown>; changed_since: boolean;
  located_by?: "plan" | "gps" | "map";
  imported: { parcel_id: string; pin: string; status: string; claim_number: string | null; claim_status: string | null; has_claim: boolean } | null }
export interface EnumResult { id: string; ok: boolean; problems?: string[]; warnings?: string[]; area_sqm?: number; pin?: string; parcel_id?: string;
  closure?: { ratio: number | null; required_ratio?: number; closed?: ClosedToStart } | null;
  status?: string; claim?: { ok: boolean; number?: string; status?: string; problems?: string[] } }

/** The bearing and distance that would close a traverse if only this leg were wrong, and the area that would give. */
export interface LegFix { leg: number; bearing: number; bearing_dms: string; distance_m: number; area_sqm: number; bearing_change_deg: number; distance_change_m: number }
/** A traverse a registrar closed to its starting point: the plan's last leg and the one used instead, who and why. */
export interface ClosedToStart { leg: number; bearing_dms: string; distance_m: number; plan_bearing_dms: string; plan_distance_m: number;
  plan_misclosure_m: number; plan_ratio: number; reason: string; by?: string }
