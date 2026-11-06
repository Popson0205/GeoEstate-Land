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
  parents: [], children: [], decided_by_name: null, decided_at: null, decision_note: "", correction: null, title_no: null,
  history: [{ at: "2026-11-05T10:00:00Z", actor_name: "Musa Bello", action: "parcel.create", details: {} }] };

const REG = { parcel: { id: "p7", pin: "KLA-000007", status: "active", area_sqm: "600.12", land_use: "", locality: "", address: "" },
  title: null, holders: [], encumbrances: [], instruments: [], past_titles: [] };
const TITLED = { ...REG, title: { id: "t1", title_no: "TR/000001", kind: "statutory_ro", kind_name: "Statutory right of occupancy (C of O)", status: "current",
  purpose: "residential", term_years: 99, starts_on: "2026-01-01", ends_on: "2125-01-01", ground_rent_ngn: "25000.00", granted_by_number: "INS/2026/000001", created_at: "" },
  holders: [{ id: "pa1", kind: "person", name: "Amaka Obi", id_type: "NIN", id_no: "12345678901", share: "1/1", since_number: "INS/2026/000001", since: "2026-11-05T10:00:00Z" }],
  encumbrances: [{ id: "e1", kind: "caveat", amount_ngn: null, term_years: null, details: "Claims a purchaser's interest", party_id: "pa2", party_name: "Chidi Eze", instrument_number: "INS/2026/000002", since: "2026-11-05T10:00:00Z" }] };
const INS = { id: "i9", number: "INS/2026/000009", parcel_id: "p7", pin: "KLA-000007", kind: "transfer", kind_name: "Transfer", summary: "To Halima Bello",
  status: "lodged", data: { holders: [{ party: { name: "Halima Bello", id_type: "NIN", id_no: "222" }, share: "1/1" }], details: "" }, instrument_date: null,
  reference: "GC/2026/19", consideration_ngn: "48000000.00", lodged_by: "u2", lodged_by_name: "Tunde Officer", lodged_at: "2026-11-05T10:00:00Z",
  decided_by_name: null, decided_at: null, decision_note: "", problems: [], warnings: ["The title is mortgaged to Zenith Bank Plc: the mortgage stays on it after the transfer."] };

type Handler = (body: unknown) => [number, unknown];
let routes: Record<string, Handler>;
let calls: { method: string; path: string; body: unknown; headers: Record<string, string> }[];
const ok = (v: unknown): Handler => () => [200, v];

beforeEach(() => {
  calls = [];
  routes = {
    "GET /me": ok(ME), "GET /apps": ok([]), "GET /grids": ok([{ epsg: 26332, name: "Minna / UTM zone 32N" }, { epsg: 4326, name: "WGS 84 (GPS)" }]),
    "GET /settings": ok(SETTINGS), "GET /parcels.geojson": ok({ type: "FeatureCollection", features: [], bbox: null }),
    "GET /home": ok({ active: 6, retired: 0, area_sqm: 3600, this_month: 2, titled: 1, lodged: 1, latest: [], limit: null, settings: SETTINGS }),
    "GET /parcels?status=active": ok([PARCEL]), "GET /parcels/p7": ok(PARCEL), "GET /parcels/p7/register": ok(REG),
    "GET /register/kinds": ok({ titles: { statutory_ro: "Statutory right of occupancy (C of O)", customary_ro: "Customary right of occupancy" }, instruments: {}, parties: [] }),
    "GET /parties?q=Am": ok([{ id: "pa1", kind: "person", name: "Amaka Obi", id_type: "NIN", id_no: "12345678901", phone: "", holdings: 1 }]),
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
    [["90", "30"], ["180", "20"], ["270", "30"], ["0", "20"]].forEach(([b, d], i) => { type(`Degrees ${i + 1}`, b); type(`Distance (m) ${i + 1}`, d); });
    type("Minutes 1", "30"); type("Seconds 1", "15");
    fireEvent.click(screen.getByRole("button", { name: "Check the boundary" }));
    expect(await screen.findByText("This parcel can be registered")).toBeTruthy();
    expect(screen.getByText(/1 in 25,001/)).toBeTruthy();
    const sent = calls.find((c) => c.path === "/parcels/check")!;
    expect(sent.body).toEqual({ method: "traverse", epsg: 26332, start: { beacon: "", easting: 331600, northing: 993000 },
      legs: [{ beacon: "", bearing: "90°30'15\"", distance_m: 30 }, { beacon: "", bearing: "180°0'0\"", distance_m: 20 }, { beacon: "", bearing: "270°0'0\"", distance_m: 30 }, { beacon: "", bearing: "0°0'0\"", distance_m: 20 }] });
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

  it("lodges a grant to a party already in the registry", async () => {
    routes["POST /parcels/p7/instruments"] = (b) => [201, { ...INS, id: "i1", kind: "grant", kind_name: "Grant of title", data: b }];
    routes["GET /instruments/i1"] = ok({ ...INS, id: "i1", kind: "grant", kind_name: "Grant of title" });
    open("/parcels/p7/lodge");
    expect(await screen.findByRole("heading", { name: "Grant of title" })).toBeTruthy();     // no title yet: a grant is the only choice
    expect((screen.getByRole("button", { name: /Transfer/ }) as HTMLButtonElement).disabled).toBe(true);
    type("Name", "Am");
    fireEvent.click(await screen.findByRole("option", { name: /Amaka Obi/ }));
    type("Commencing", "2026-01-01");
    fireEvent.click(screen.getByRole("button", { name: "Lodge it" }));
    await screen.findByText(/INS\/2026\/000009 lodged|INS\/2026\/000009/);
    expect(calls.find((c) => c.method === "POST")!.body).toMatchObject({ kind: "grant", title_kind: "statutory_ro", term_years: 99, starts_on: "2026-01-01",
      holders: [{ party: { id: "pa1", name: "Amaka Obi" }, share: "1/1" }], register_now: false });
  });

  it("shows the register of a titled parcel, and refuses a transfer while a caveat stands", async () => {
    routes["GET /parcels/p7/register"] = ok(TITLED);
    routes["POST /parcels/p7/instruments"] = () => [422, { detail: "A caveat by Chidi Eze stops transfers until it is discharged.", code: "not_registrable",
      problems: ["A caveat by Chidi Eze stops transfers until it is discharged."] }];
    open("/parcels/p7");
    expect(await screen.findByText("TR/000001")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Amaka Obi" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Chidi Eze" })).toBeTruthy();
    cleanup();
    open("/parcels/p7/lodge");
    fireEvent.click(await screen.findByRole("button", { name: /Transfer/ }));
    expect((screen.getByRole("button", { name: /Discharge/ }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: /Grant of title/ }) as HTMLButtonElement).disabled).toBe(true);
    type("Name", "Halima Bello");
    fireEvent.click(screen.getByRole("button", { name: "Lodge it" }));
    expect(await screen.findByText("This cannot be lodged")).toBeTruthy();
    expect(screen.getByText(/stops transfers/)).toBeTruthy();
  });

  it("lets a registrar register or reject a lodged instrument", async () => {
    routes["GET /instruments/i9"] = ok(INS);
    routes["POST /instruments/i9/reject"] = (b) => [200, { ...INS, status: "rejected", decision_note: (b as { note: string }).note, decided_by_name: "Musa Bello", decided_at: "2026-11-05T11:00:00Z" }];
    open("/instruments/i9");
    expect(await screen.findByText("It can be registered")).toBeTruthy();
    expect(screen.getByText(/mortgage stays on it/)).toBeTruthy();
    const reject = screen.getByRole("button", { name: "Reject" }) as HTMLButtonElement;
    expect(reject.disabled).toBe(true);
    type("Note (needed to reject)", "No consent attached.");
    fireEvent.click(reject);
    expect(await screen.findByText("No consent attached.")).toBeTruthy();
    expect(screen.getAllByText("Rejected").length).toBeGreaterThan(0);
  });

  it("an officer sees the instrument waiting for a registrar", async () => {
    routes["GET /me"] = ok({ ...ME, id: "u2", role: "officer", org_role: "member" });
    routes["GET /instruments/i9"] = ok(INS);
    open("/instruments/i9");
    expect(await screen.findByText("Waiting for a registrar.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Register" })).toBeNull();
    expect(screen.getByRole("button", { name: "Withdraw it" })).toBeTruthy();
  });

  it("looks up a parcel publicly, without signing in", async () => {
    routes["GET /public/kabusa"] = ok({ name: "Kabusa Estate Registry", shows_holders: false });
    routes["GET /public/kabusa/lookup?q=KLA-000007"] = ok({ registry: "Kabusa Estate Registry", pin: "KLA-000007", status: "active", area_sqm: 600.12,
      land_use: "residential", locality: "Kabusa", lon: 7.46, lat: 8.98, title: { title_no: "TR/000001", kind: "Statutory right of occupancy (C of O)", starts_on: null, ends_on: null },
      encumbrances: [{ kind: "mortgage", count: 1 }], dealings_pending: 1, holders: null, checked_at: "2026-11-05T10:00:00Z" });
    open("/lookup/kabusa");
    expect(await screen.findByText("Kabusa Estate Registry")).toBeTruthy();
    type("PIN or title number", "KLA-000007");
    fireEvent.click(screen.getByRole("button", { name: "Look up" }));
    expect(await screen.findByText("Parcel KLA-000007")).toBeTruthy();
    expect(screen.getByText("Mortgage")).toBeTruthy();
    expect(screen.getByText("1 lodged, not yet registered")).toBeTruthy();
    expect(calls.some((c) => c.path === "/me")).toBe(false);
  });

  it("approves a parcel waiting in the workflow", async () => {
    routes["GET /parcels/p7"] = ok({ ...PARCEL, status: "pending", created_by_name: "Tunde Officer" });
    routes["POST /parcels/p7/approve"] = () => [200, { ...PARCEL, status: "active", decided_by_name: "Musa Bello" }];
    open("/parcels/p7");
    expect(await screen.findByText("Waiting for a registrar")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(await screen.findByText("Active")).toBeTruthy();
    expect(calls.some((c) => c.method === "POST" && c.path === "/parcels/p7/approve")).toBe(true);
  });

  it("asks for the first of two approvals, and not from whoever lodged it", async () => {
    routes["GET /instruments/i9"] = ok({ ...INS, steps: 2, approvals: [] });
    open("/instruments/i9");
    expect(await screen.findByRole("button", { name: "Approve (1 of 2)" })).toBeTruthy();
    expect(screen.getByText(/0 of 2 so far/)).toBeTruthy();
    cleanup();
    routes["GET /instruments/i9"] = ok({ ...INS, steps: 2, lodged_by: "u1", approvals: [] });
    open("/instruments/i9");
    expect(((await screen.findByRole("button", { name: "Approve (1 of 2)" })) as HTMLButtonElement).disabled).toBe(true);
  });

  it("sets the organization's workflow", async () => {
    routes["GET /settings/workflow"] = ok({ parcel: 0, grant: 1, transfer: 1, mortgage: 1, caveat: 1, lease: 1, discharge: 1, revocation: 1, subdivision: 1, amalgamation: 1 });
    routes["PUT /settings/workflow"] = (b) => [200, { ...(b as { steps: object }).steps }];
    routes["GET /grids"] = ok([{ epsg: 26332, name: "Minna / UTM zone 32N" }]);
    open("/settings");
    const transfer = await screen.findByLabelText("Transfer") as HTMLSelectElement;
    fireEvent.change(transfer, { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("A new parcel"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "Save the workflow" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT" && c.path === "/settings/workflow")?.body).toMatchObject({ steps: { transfer: 2, parcel: 1, grant: 1 } }));
  });

  it("takes a boundary from a DXF drawing", async () => {
    routes["POST /parcels/import/dxf"] = () => [200, { filename: "layout.dxf", layers: ["PLOTS"], texts: 4, shapes: [
      { index: 0, layer: "PLOTS", label: "PLOT 1", area_plan: 1200, points: [{ x: 1, y: 2, beacon: "PB 1" }, { x: 3, y: 4, beacon: "" }, { x: 5, y: 6, beacon: "" }] },
      { index: 1, layer: "PLOTS", label: "PLOT 2", area_plan: 900, points: [{ x: 7, y: 8, beacon: "" }, { x: 9, y: 10, beacon: "" }, { x: 11, y: 12, beacon: "" }] }] }];
    open("/parcels/new");
    await screen.findByRole("heading", { name: "New parcel" });
    const file = new File(["0\nSECTION\n"], "layout.dxf", { type: "application/dxf" });
    fireEvent.change(screen.getByLabelText("Import from a DXF drawing"), { target: { files: [file] } });
    fireEvent.click(await screen.findByRole("button", { name: /PLOT 2/ }));
    expect((screen.getByLabelText("Easting 1") as HTMLInputElement).value).toBe("7");
    expect((screen.getByLabelText("Address or description") as HTMLInputElement).value).toBe("PLOT 2");
    expect(calls.find((c) => c.path === "/parcels/import/dxf")!.body).toMatchObject({ filename: "layout.dxf" });
  });

  it("lodges a subdivision along a cut line on the survey grid", async () => {
    routes["POST /parcels/p7/instruments"] = (b) => [201, { ...INS, id: "i5", kind: "subdivision", kind_name: "Subdivision", data: b }];
    routes["GET /instruments/i5"] = ok({ ...INS, id: "i5", kind: "subdivision", kind_name: "Subdivision", data: { pieces: [{ area_sqm: 300 }, { area_sqm: 300 }] } });
    open("/parcels/p7/lodge?kind=subdivision");
    expect(await screen.findByRole("heading", { name: "Subdivision" })).toBeTruthy();
    fireEvent.change(await screen.findByLabelText(/cut line's points/), { target: { value: "331020, 992990\n331020 993060" } });
    fireEvent.click(screen.getByRole("button", { name: "Lodge it" }));
    expect(await screen.findByText("300 m² + 300 m²")).toBeTruthy();
    expect(calls.find((c) => c.method === "POST")!.body).toMatchObject({ kind: "subdivision", cut: [[331020, 992990], [331020, 993060]], cut_epsg: 26332 });
  });

  it("connects a Geohub form, guessing which question holds what", async () => {
    routes["GET /enumeration/sources"] = ok([]);
    routes["GET /enumeration/geohub"] = ok([{ id: "pr1", name: "Bwari enumeration", description: "", role: "admin", forms: [{ id: "fo1", name: "Plots",
      geometry_type: "area", version: 1, features: 4, approved: 3, fields: [{ id: "q1", label: "Plot No.", type: "text" }, { id: "q2", label: "Occupant name", type: "text" },
        { id: "q3", label: "Phone number", type: "text" }, { id: "q4", label: "Land use", type: "choice" }] }] }]);
    routes["POST /enumeration/sources"] = (b) => [201, { id: "s1", ...(b as object) }];
    routes["GET /enumeration/sources/s1"] = ok({ id: "s1", project_id: "pr1", project_name: "Bwari enumeration", form_id: "fo1", form_name: "Plots", field_map: {}, defaults: {},
      created_by_name: "Musa Bello", created_at: "", imported: 0, claims_lodged: 0, form: null });
    routes["GET /enumeration/sources/s1/features?status=approved&after=0"] = ok({ features: [], next: null });
    open("/enumeration");
    fireEvent.click(await screen.findByRole("button", { name: "Connect a Geohub form" }));
    fireEvent.change(await screen.findByLabelText("Geohub form"), { target: { value: "pr1/fo1" } });
    expect((screen.getByLabelText("Plot number") as HTMLSelectElement).value).toBe("q1");
    expect((screen.getByLabelText("Occupant's (claimant's) name") as HTMLSelectElement).value).toBe("q2");
    expect((screen.getByLabelText("Occupant's phone") as HTMLSelectElement).value).toBe("q3");
    fireEvent.change(document.getElementById("dloc")!, { target: { value: "Bwari" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect the form" }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST" && c.path === "/enumeration/sources")?.body).toMatchObject({
      project_id: "pr1", form_id: "fo1", field_map: { plot_no: "q1", claimant_name: "q2", claimant_phone: "q3", land_use: "q4" }, defaults: { locality: "Bwari", title_kind: "customary_ro" } }));
    expect(await screen.findByText("No approved plots yet. A supervisor approves them in Geohub's review.")).toBeTruthy();
  });

  it("registers enumerated plots and lodges their claims", async () => {
    const SRC = { id: "s1", project_id: "pr1", project_name: "Bwari enumeration", form_id: "fo1", form_name: "Plots", field_map: {}, defaults: { title_kind: "customary_ro" },
      created_by_name: "Musa Bello", created_at: "", imported: 1, claims_lodged: 0, form: null };
    const M = { plot_no: "12", address: "", locality: "Bwari", land_use: "residential", notes: "", claimant_name: "Aisha Bako", claimant_phone: "0803", claimant_id_no: "", full_address: "Plot 12" };
    const F = (id: string, extra = {}) => ({ id, seq: 1, status: "approved", version: 1, geometry: { type: "Polygon", coordinates: [RING] }, created_by_name: "Garba", created_at: "2026-10-30T09:00:00Z",
      reviewed_by_name: null, mapped: M, properties: {}, changed_since: false, imported: null, ...extra });
    routes["GET /enumeration/sources/s1"] = ok(SRC);
    routes["GET /enumeration/sources/s1/features?status=approved&after=0"] = ok({ next: null, features: [F("f1"),
      F("f2", { mapped: { ...M, full_address: "Plot 13", claimant_name: "Yakubu" }, imported: { parcel_id: "p9", pin: "KLA-000009", status: "active", claim_number: null, claim_status: null, has_claim: true } })] });
    routes["POST /enumeration/sources/s1/import"] = () => [200, [{ id: "f1", ok: true, pin: "KLA-000010", parcel_id: "p10", status: "active", claim: { ok: true, number: "INS/2026/000011", status: "lodged" } }]];
    open("/enumeration/s1");
    expect(await screen.findByText("Plot 12")).toBeTruthy();
    expect(screen.getByRole("link", { name: "KLA-000009" })).toBeTruthy();
    expect(screen.getByText("Claim not lodged yet")).toBeTruthy();
    expect(screen.queryByLabelText("Plot Plot 13")).toBeNull();                       // already in the register: not offered again
    fireEvent.click(screen.getByLabelText("All plots not yet registered"));
    fireEvent.click(screen.getByRole("button", { name: "Register 1 plot" }));
    await waitFor(() => expect(calls.find((c) => c.path === "/enumeration/sources/s1/import")?.body).toEqual({ feature_ids: ["f1"], lodge_claims: true }));
  });
});
