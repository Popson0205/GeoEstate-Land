import type { App, Control, DxfRead, EnumFeature, EnumResult, EnumSource, GeohubProject, Workflow, AuditEntry, Check, Grid, HolderData, Home, Instrument, InstrumentKind, Kinds, Me, OrgSettings, Parcel, ParcelRow, PartyDetail, PartyIn, PartyRow, PublicResult, Register } from "./types";

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string, public body?: Record<string, unknown>) { super(message); }
}
export const BASE = import.meta.env.VITE_API_URL ?? "/api";

/** Signed in by cookie; every change carries X-GeoEstate so another site's form cannot make one. */
export async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(BASE + path, { method, credentials: "same-origin",
      headers: { "X-GeoEstate": "1", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, "Can't reach Land Registry. Check your connection.");
  }
  if (!res.ok) {
    let p: Record<string, unknown> = {};
    try { p = await res.json(); } catch { /* not JSON */ }
    if (res.status === 401 && path !== "/me") window.dispatchEvent(new CustomEvent("land:signed-out", { detail: p.detail }));
    throw new ApiError(res.status, String(p.detail ?? p.title ?? res.statusText), p.code as string | undefined, p);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export const signInUrl = (next = window.location.pathname + window.location.search) => `${BASE}/auth/sign-in?next=${encodeURIComponent(next)}`;
const q = (o: Record<string, string | undefined>) => {
  const s = new URLSearchParams(Object.entries(o).filter(([, v]) => v) as [string, string][]);
  return s.size ? `?${s}` : "";
};

export interface CaptureBody {
  method: "traverse" | "coordinates"; epsg?: number;
  start?: { easting: number; northing: number; beacon: string };
  legs?: { bearing: string; distance_m: number; beacon: string }[];
  points?: { x: number; y: number; beacon: string }[];
  plan_area_sqm?: number;
}
export type ParcelDetails = { land_use?: string; address?: string; locality?: string; notes?: string; survey_plan_no?: string; surveyor?: string; survey_date?: string | null };

export const api = {
  me: () => req<Me>("GET", "/me"),
  apps: () => req<App[]>("GET", "/apps"),
  signOut: () => req<void>("POST", "/auth/sign-out"),
  grids: () => req<Grid[]>("GET", "/grids"),
  settings: () => req<OrgSettings>("GET", "/settings"),
  saveSettings: (b: { default_epsg: number; pin_prefix: string; closure_ratio: number; overlap_tolerance_sqm: number; title_prefix?: string; public_lookup?: string }) => req<OrgSettings>("PUT", "/settings", b),
  home: () => req<Home>("GET", "/home"),
  check: (b: CaptureBody) => req<Check>("POST", "/parcels/check", b),
  registerParcel: (b: CaptureBody & ParcelDetails) => req<Parcel>("POST", "/parcels", b),
  parcels: (f: { q?: string; status?: string } = {}) => req<ParcelRow[]>("GET", `/parcels${q(f)}`),
  fabric: () => req<GeoJSON.FeatureCollection & { bbox: [number, number, number, number] | null }>("GET", "/parcels.geojson"),
  parcel: (id: string) => req<Parcel>("GET", `/parcels/${id}`),
  update: (id: string, b: ParcelDetails) => req<Parcel>("PATCH", `/parcels/${id}`, b),
  retire: (id: string, reason: string) => req<Parcel>("POST", `/parcels/${id}/retire`, { reason }),
  register: (id: string) => req<Register>("GET", `/parcels/${id}/register`),
  kinds: () => req<Kinds>("GET", "/register/kinds"),
  lodge: (id: string, b: LodgeBody) => req<Instrument & { warnings?: string[] }>("POST", `/parcels/${id}/instruments`, b),
  instruments: (status = "lodged") => req<Instrument[]>("GET", `/instruments?status=${status}`),
  instrument: (id: string) => req<Instrument>("GET", `/instruments/${id}`),
  registerInstrument: (id: string, note = "") => req<Instrument>("POST", `/instruments/${id}/register`, { note }),
  rejectInstrument: (id: string, note: string) => req<Instrument>("POST", `/instruments/${id}/reject`, { note }),
  withdrawInstrument: (id: string) => req<Instrument>("POST", `/instruments/${id}/withdraw`),
  parties: (q: string) => req<PartyRow[]>("GET", `/parties${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  party: (id: string) => req<PartyDetail>("GET", `/parties/${id}`),
  publicRegistry: (slug: string) => req<{ name: string; shows_holders: boolean }>("GET", `/public/${encodeURIComponent(slug)}`),
  publicLookup: (slug: string, q: string) => req<PublicResult>("GET", `/public/${encodeURIComponent(slug)}/lookup?q=${encodeURIComponent(q)}`),
  approveParcel: (id: string, note = "") => req<Parcel>("POST", `/parcels/${id}/approve`, { note }),
  rejectParcel: (id: string, note: string) => req<Parcel>("POST", `/parcels/${id}/reject`, { note }),
  workflow: () => req<Workflow>("GET", "/settings/workflow"),
  saveWorkflow: (steps: Partial<Workflow>) => req<Workflow>("PUT", "/settings/workflow", { steps }),
  control: (epsg: number) => req<Control>("GET", `/control?epsg=${epsg}`),
  addControl: (b: { epsg: number; name: string; plan_e: number; plan_n: number; true_e: number; true_n: number; notes?: string }) => req<Control>("POST", "/control", b),
  removeControl: (id: string) => req<Control>("DELETE", `/control/${id}`),
  setCorrection: (epsg: number, method: string) => req<Control>("PUT", "/settings/corrections", { epsg, method }),
  importDxf: (filename: string, content: string) => req<DxfRead>("POST", "/parcels/import/dxf", { filename, content }),
  geohubForms: () => req<GeohubProject[]>("GET", "/enumeration/geohub"),
  sources: () => req<EnumSource[]>("GET", "/enumeration/sources"),
  source: (id: string) => req<EnumSource>("GET", `/enumeration/sources/${id}`),
  addSource: (b: { project_id: string; form_id: string; field_map: Record<string, string>; defaults: Record<string, string> }) => req<EnumSource>("POST", "/enumeration/sources", b),
  patchSource: (id: string, b: { field_map?: Record<string, string>; defaults?: Record<string, string> }) => req<EnumSource>("PATCH", `/enumeration/sources/${id}`, b),
  removeSource: (id: string) => req<void>("DELETE", `/enumeration/sources/${id}`),
  enumFeatures: (id: string, status: string, after = 0) => req<{ features: EnumFeature[]; next: number | null }>("GET", `/enumeration/sources/${id}/features?status=${status}&after=${after}`),
  enumCheck: (id: string, feature_ids: string[]) => req<EnumResult[]>("POST", `/enumeration/sources/${id}/check`, { feature_ids }),
  enumImport: (id: string, feature_ids: string[], lodge_claims: boolean) => req<EnumResult[]>("POST", `/enumeration/sources/${id}/import`, { feature_ids, lodge_claims }),
  enumClaims: (id: string) => req<{ pin: string; ok: boolean; number?: string; problems?: string[] }[]>("POST", `/enumeration/sources/${id}/claims`),
  audit: (before?: number) => req<AuditEntry[]>("GET", `/audit${before ? `?before=${before}` : ""}`),
};

export interface LodgeBody {
  kind: InstrumentKind; instrument_date?: string | null; reference?: string; consideration_ngn?: number | null; details?: string;
  title_kind?: string; title_no?: string; purpose?: string; term_years?: number | null; starts_on?: string | null; ground_rent_ngn?: number | null;
  holders?: HolderData[]; party?: PartyIn; amount_ngn?: number | null; encumbrance_id?: string; register_now?: boolean;
  cut?: [number, number][]; cut_epsg?: number | null; parcels?: string[];
}
