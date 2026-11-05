import { describe, expect, it } from "vitest";
import { area, parseRows } from "../src/lib/format";
import { licenceNotice } from "../src/components/Bar";

describe("parseRows", () => {
  it("reads traverse legs pasted from a spreadsheet, with or without beacon names", () => {
    const { rows, bad } = parseRows("B2\t90°00'00\"\t30.000\nB3\t180 00 00\t20.004\n270-00-00 30\n\nnonsense\n", "traverse");
    expect(rows).toEqual([["B2", "90°00'00\"", "30.000"], ["B3", "180 00 00", "20.004"], ["", "270-00-00", "30"]]);
    expect(bad).toEqual([5]);
  });
  it("reads beacon coordinates separated by commas, tabs or spaces", () => {
    const { rows, bad } = parseRows("SC/FCT 102, 331630, 993000\n331655\t993000\nB6 331655 992980\nB7 331655", "coordinates");
    expect(rows).toEqual([["SC/FCT 102", "331630", "993000"], ["", "331655", "993000"], ["B6", "331655", "992980"]]);
    expect(bad).toEqual([4]);
  });
});

describe("words", () => {
  it("shows areas in square metres or hectares", () => {
    expect(area(600.12)).toBe("600.12 m²");
    expect(area(25000)).toBe("2.5 ha");
  });
  it("explains the licence as Geohub does", () => {
    expect(licenceNotice(null)).toBeNull();
    const p = { name: "Land Registry", plan_name: "Standard", licence_kind: "paid", subscription_ends: "2026-10-31", grace_ends: "2026-11-30" };
    expect(licenceNotice({ ...p, status: "active" })).toBeNull();
    expect(licenceNotice({ ...p, status: "grace" })?.text).toMatch(/ended on 31 October 2026.*until 30 November 2026/);
    expect(licenceNotice({ ...p, status: "expired" })?.tone).toBe("bad");
  });
});
