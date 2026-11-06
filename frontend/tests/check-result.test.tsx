import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("maplibre-gl", () => ({ default: {} }));
vi.mock("maplibre-gl/dist/maplibre-gl.css", () => ({}));

import { CheckResult } from "../src/pages/NewParcelPage";
import type { Check } from "../src/lib/types";

afterEach(cleanup);

const FIX = { leg: 4, bearing: 294.3928, bearing_dms: "294°23'34\"", distance_m: 34.92, area_sqm: 499.49, bearing_change_deg: 1.29, distance_change_m: -0.14 };
const CHECK = { ok: false, problems: ["The traverse does not close: 0.80 m, 1 in 120."], warnings: [], area_sqm: 495, area_ha: 0.05, perimeter_m: 96.9,
  beacons: [], grid_name: "Minna / UTM zone 31N", correction: null,
  closure: { misclosure_m: 0.8, misclosure_e: 0.7, misclosure_n: 0.4, perimeter_m: 96.9, ratio: 120, required_ratio: 3000, adjusted: false, fixes: [FIX], suspect: FIX } } as unknown as Check;

describe("misclosure help", () => {
  it("offers the closing figures for the suspect leg", () => {
    const use = vi.fn();
    render(<CheckResult c={CHECK} onUseFix={use} />);
    expect(screen.getByText(/294°23'34" 34.92 m/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Use these figures for leg 4" }));
    expect(use).toHaveBeenCalledWith(4, "294°23'34\"", 34.92);
  });
  it("says nothing extra without a suspect", () => {
    render(<CheckResult c={{ ...CHECK, closure: { ...CHECK.closure!, suspect: null } }} onUseFix={() => {}} />);
    expect(screen.queryByRole("button", { name: /Use these figures/ })).toBeNull();
  });
});

import CloseToStart from "../src/components/CloseToStart";

describe("closing to the start", () => {
  it("needs a reason before it closes", () => {
    const close = vi.fn();
    render(<CloseToStart onClose={close} />);
    fireEvent.click(screen.getByRole("button", { name: "Close to the starting point…" }));
    const go = screen.getByRole("button", { name: "Close it and check again" }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Why (kept with the parcel)"), { target: { value: "Confirmed with the surveyor." } });
    fireEvent.click(go);
    expect(close).toHaveBeenCalledWith("Confirmed with the surveyor.");
  });
  it("shows what was closed", () => {
    const closed = { leg: 4, bearing_dms: "294°23'34\"", distance_m: 34.92, plan_bearing_dms: "293°06'00\"", plan_distance_m: 35.06, plan_misclosure_m: 0.8, plan_ratio: 120, reason: "x" };
    render(<CheckResult c={{ ...CHECK, ok: true, problems: [], closure: { ...CHECK.closure!, suspect: null, closed } }} />);
    expect(screen.getByText(/instead of the plan's 293°06'00" 35.06 m/)).toBeTruthy();
  });
});
