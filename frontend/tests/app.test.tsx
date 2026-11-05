import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("maplibre-gl", () => {
  class Map { on() {} addControl() {} remove() {} addSource() {} addLayer() {} getSource() { return { setData() {} }; } setPaintProperty() {} fitBounds() {} getCanvas() { return { style: {} }; } }
  class Ctl {}
  return { default: { Map, NavigationControl: Ctl, ScaleControl: Ctl } };
});
vi.mock("maplibre-gl/dist/maplibre-gl.css", () => ({}));

import App from "../src/App";
import { ToastProvider } from "../src/components/ui";

const ME = { id: "u1", name: "Musa Bello", email: "musa@kanoland.gov.ng", org_id: "o1", org_name: "Kano Land Agency", org_role: "owner",
  role: "registrar", staff_role: null, licence: "active", can_write: true, features: [], limits: {}, geohub_url: "http://hub",
  product: { name: "Land Registry", plan_name: "Standard", status: "active", licence_kind: "paid", subscription_ends: "2027-01-01", grace_ends: "2027-01-31" } };
const SETTINGS = { org_id: "o1", org_name: "Kano Land Agency", default_epsg: 26332, grid_name: "Minna / UTM zone 32N (east)", pin_prefix: "KLA", pin_next: 7, closure_ratio: 5000, overlap_tolerance_sqm: 1 };
const RING = [[7.46, 8.98], [7.4603, 8.98], [7.4603, 8.9798], [7.46, 8.9798], [7.46, 8.98]];
const CHECK = { ok: true, problems: [], warnings: [], method: "traverse", epsg: 26332, grid_name: "Minna / UTM zone 32N", area_sqm: 600.12, area_ha: 0.06,
  perimeter_m: 100.01, closure: { misclosure_m: 0.004, misclosure_e: 0, misclosure_n: -0.004, perimeter_m: 100.004, ratio: 25001, required_ratio: 5000, adjusted: true },
  legs: [], geometry: { type: "Polygon", coordinates: [RING] }, beacons: [1, 2, 3, 4].map((i) => ({ seq: i, name: `B${i}`, easting: 0, northing: 0, lon: 7.46, lat: 8.98 })), overlaps: [] };
const PARCEL = { id: "p7", pin: "KLA-000007", status: "active", area_sqm: "600.12", perimeter_m: "100.01", land_use: "residential", address: "Plot 7", locality: "Kabusa",
  notes: "", method: "traverse", source_epsg: 26332, closure_error_m: "0.004", closure_ratio: 25001, survey_plan_no: "FCT/SP/1", surveyor: "", survey_date: null,
  retired_reason: null, created_by_name: "Musa Bello", created_at: "2026-11-05T10:00:00Z", updated_at: "2026-11-05T10:00:00Z", lon: 7.46, lat: 8.98,
  geometry: { type: "Polygon", coordinates: [RING] }, grid_name: "Minna / UTM zone 32N", beacons: CHECK.beacons, neighbours: [],
  history: [{ at: "2026-11-05T10:00:00Z", actor_name: "Musa Bello", action: "parcel.create", details: {} }] };

type Handler = (body: unknown) => [number, unknown];
let routes: Record<string, Handler>;
let calls: { method: string; path: string; body: unknown; headers: Record<string, string> }[];
const ok = (v: unknown): Handler => () => [200, v];

beforeEach(() => {
  calls = [];
  routes = {
    "GET /me": ok(ME), "GET /apps": ok([]), "GET /grids": ok([{ epsg: 26332, name: "Minna / UTM zone 32N" }, { epsg: 4326, name: "WGS 84 (GPS)" }]),
    "GET /settings": ok(SETTINGS), "GET /parcels.geojson": ok({ type: "FeatureCollection", features: [], bbox: null }),
    "GET /home": ok({ active: 6, retired: 0, area_sqm: 3600, this_month: 2, latest: [], limit: null, settings: SETTINGS }),
    "GET /parcels?status=active": ok([PARCEL]), "GET /parcels/p7": ok(PARCEL),
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET", path = url.replace(/^\/api/, "");
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body, headers: (init.headers ?? {}) as Record<string, string> });
    const h = routes[`${method} ${path}`];
    const [status, v] = h ? h(body) : [404, { detail: `no route ${method} ${path}` }];
    return new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const open = (path: string) => render(<MemoryRouter initialEntries={[path]}><ToastProvider><App /></ToastProvider></MemoryRouter>);
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe("Land Registry", () => {
  it("sends someone not signed in to Geohub", async () => {
    routes["GET /me"] = () => [401, { detail: "Sign in to continue.", code: "unauthenticated" }];
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign, pathname: "/map", search: "" });
    open("/map");
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/api/auth/sign-in?next=%2Fmap"));
  });

  it("explains when the organization does not have Land Registry", async () => {
    routes["GET /me"] = () => [401, { detail: "Kano Land Agency does not have Land Registry.", code: "no_product" }];
    open("/");
    expect(await screen.findByText("Kano Land Agency does not have Land Registry.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Sign in with GeoEstate" })).toBeTruthy();
  });

  it("shows the register, and a viewer gets no New parcel", async () => {
    routes["GET /me"] = ok({ ...ME, role: "viewer", org_role: "viewer" });
    open("/");
    expect(await screen.findByRole("link", { name: "KLA-000007" })).toBeTruthy();
    expect(screen.getByText("Active parcels")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "New parcel" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Settings" })).toBeNull();
  });

  it("shows the licence notice under the bar", async () => {
    routes["GET /me"] = ok({ ...ME, licence: "expired", can_write: false, product: { ...ME.product, status: "expired" } });
    open("/");
    expect(await screen.findByText(/subscription has ended, so it is read-only/)).toBeTruthy();
  });

  it("checks a traverse, then registers it", async () => {
    routes["POST /parcels/check"] = ok(CHECK);
    routes["POST /parcels"] = () => [201, PARCEL];
    open("/parcels/new");
    await screen.findByRole("heading", { name: "New parcel" });
    await waitFor(() => expect((screen.getByLabelText("Survey grid") as HTMLSelectElement).value).toBe("26332"));
    const register = screen.getByRole("button", { name: "Register and give it a PIN" }) as HTMLButtonElement;
    expect(register.disabled).toBe(true);
    type("Easting (m)", "331600"); type("Northing (m)", "993000");
    [["90", "30"], ["180", "20"], ["270", "30"], ["0", "20"]].forEach(([b, d], i) => { type(`Bearing ${i + 1}`, b); type(`Distance (m) ${i + 1}`, d); });
    fireEvent.click(screen.getByRole("button", { name: "Check the boundary" }));
    expect(await screen.findByText("This parcel can be registered")).toBeTruthy();
    expect(screen.getByText(/1 in 25,001/)).toBeTruthy();
    const sent = calls.find((c) => c.path === "/parcels/check")!;
    expect(sent.body).toEqual({ method: "traverse", epsg: 26332, start: { beacon: "", easting: 331600, northing: 993000 },
      legs: [{ beacon: "", bearing: "90", distance_m: 30 }, { beacon: "", bearing: "180", distance_m: 20 }, { beacon: "", bearing: "270", distance_m: 30 }, { beacon: "", bearing: "0", distance_m: 20 }] });
    expect(sent.headers["X-GeoEstate"]).toBe("1");
    // changing the survey after the check means checking again
    type("Distance (m) 4", "19");
    await waitFor(() => expect(register.disabled).toBe(true));
    type("Distance (m) 4", "20");
    await waitFor(() => expect(register.disabled).toBe(false));
    type("Survey plan number", "FCT/SP/1");
    fireEvent.click(register);
    expect(await screen.findByRole("heading", { name: /KLA-000007/ })).toBeTruthy();
    expect(calls.find((c) => c.method === "POST" && c.path === "/parcels")!.body).toMatchObject({ survey_plan_no: "FCT/SP/1", survey_date: null });
  });

  it("shows why a boundary cannot be registered", async () => {
    routes["POST /parcels/check"] = ok({ ...CHECK, ok: false, problems: ["It overlaps KLA-000003 by 150.02 m². A parcel cannot overlap another active parcel."] });
    open("/parcels/new");
    await screen.findByRole("heading", { name: "New parcel" });
    fireEvent.click(screen.getByRole("button", { name: "Beacon coordinates" }));
    [["1", "2"], ["3", "4"], ["5", "6"]].forEach(([x, y], i) => { type(`Easting ${i + 1}`, x); type(`Northing ${i + 1}`, y); });
    fireEvent.click(screen.getByRole("button", { name: "Check the boundary" }));
    expect(await screen.findByText(/overlaps KLA-000003/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Register and give it a PIN" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("retires a parcel with a reason (registrars)", async () => {
    routes["POST /parcels/p7/retire"] = (b) => [200, { ...PARCEL, status: "retired", retired_reason: (b as { reason: string }).reason }];
    open("/parcels/p7");
    fireEvent.click(await screen.findByRole("button", { name: "Retire" }));
    type("Why", "Re-surveyed");
    fireEvent.click(screen.getByRole("button", { name: "Retire it" }));
    expect(await screen.findByText("Retired: Re-surveyed")).toBeTruthy();
  });
});
