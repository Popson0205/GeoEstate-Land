/** 1,234.56 m² (0.1235 ha) */
export const area = (sqm: number | string) => {
  const n = Number(sqm);
  return n >= 10000 ? `${(n / 10000).toLocaleString("en-NG", { maximumFractionDigits: 4 })} ha` : `${n.toLocaleString("en-NG", { maximumFractionDigits: 2 })} m²`;
};
export const metres = (m: number | string) => `${Number(m).toLocaleString("en-NG", { maximumFractionDigits: 3 })} m`;
export const day = (d: string | null | undefined) =>
  d ? new Date(d.length === 10 ? `${d}T00:00:00` : d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "";
export const when = (d: string) => new Date(d).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
export const ROLE_NAME = { registrar: "Registrar", officer: "Officer", viewer: "Viewer" } as const;
export const LAND_USES = ["residential", "commercial", "mixed use", "industrial", "agricultural", "institutional", "recreational", "vacant"];

/**
 * Rows pasted from a spreadsheet or typed: one per line, values split by tabs, commas or spaces.
 * Traverse rows: beacon, bearing, distance (beacon optional; a bearing may have spaces: "123 30 15").
 * Coordinate rows: beacon, easting, northing (beacon optional).
 */
export function parseRows(text: string, kind: "traverse" | "coordinates"): { rows: string[][]; bad: number[] } {
  const rows: string[][] = [], bad: number[] = [];
  text.split(/\r?\n/).map((l) => l.trim()).forEach((line, i) => {
    if (!line) return;
    const cells = line.includes("\t") ? line.split("\t") : line.includes(",") ? line.split(",") : line.split(/\s+/);
    const c = cells.map((x) => x.trim()).filter((x) => x !== "");
    if (kind === "coordinates") {
      const nums = c.filter((x) => /^-?\d+(\.\d+)?$/.test(x));
      if (nums.length < 2) { bad.push(i + 1); return; }
      const name = c.length > 2 && !/^-?\d+(\.\d+)?$/.test(c[0]) ? c[0] : "";
      rows.push([name, nums[nums.length - 2], nums[nums.length - 1]]);
    } else {
      const dist = c[c.length - 1];
      if (!/^\d+(\.\d+)?$/.test(dist ?? "") || c.length < 2) { bad.push(i + 1); return; }
      const first = c[0];
      const hasName = c.length >= 3 && !/^\d/.test(first);
      const bearing = (hasName ? c.slice(1, -1) : c.slice(0, -1)).join(" ");
      rows.push([hasName ? first : "", bearing, dist]);
    }
  });
  return { rows, bad };
}
export const naira = (n: number | string | null | undefined) =>
  n == null || n === "" ? "" : `₦${Number(n).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const STATUS_TONE: Record<string, string> = { lodged: "ge-badge-info", registered: "ge-badge-ok", rejected: "ge-badge-bad", withdrawn: "" };
export const STATUS_NAME: Record<string, string> = { lodged: "Lodged", registered: "Registered", rejected: "Rejected", withdrawn: "Withdrawn" };
export const ENC_NAME: Record<string, string> = { mortgage: "Mortgage", caveat: "Caveat", lease: "Lease" };
export const PARTY_KIND: Record<string, string> = { person: "Person", company: "Company", government: "Government", community: "Community or family", trustees: "Trustees" };

/** A bearing as degrees, minutes and seconds, from 123°30'15", 123 30 15, 123-30-15 or 123.5 (decimal degrees). */
export function splitBearing(text: string): [string, string, string] {
  const t = text.trim().replace(/º/g, "°");
  if (/^\d{1,3}(\.\d+)?$/.test(t) && t.includes(".")) {
    const total = Math.round(Number(t) * 3600);
    return [String(Math.floor(total / 3600)), String(Math.floor((total % 3600) / 60)), String(total % 60)];
  }
  const parts = t.split(/[°'′"″\s-]+/).filter(Boolean);
  return [parts[0] ?? "", parts[1] ?? "", parts[2] ?? ""];
}

/** Degrees, minutes and seconds as the API takes a bearing (123°30'15"); an empty minute or second is 0. */
export function joinBearing(d: string, m: string, s: string): string | null {
  const D = d.trim(), M = m.trim() || "0", S = s.trim() || "0";
  if (!/^\d{1,3}$/.test(D) || !/^\d{1,2}$/.test(M) || !/^\d{1,2}(\.\d+)?$/.test(S)) return null;
  if (Number(D) >= 360 || Number(M) >= 60 || Number(S) >= 60) return null;
  return `${D}°${M}'${S}"`;
}
