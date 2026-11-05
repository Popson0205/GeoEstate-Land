"""The survey engine: from a surveyor's traverse or beacon coordinates to a checked parcel boundary.

A traverse walks bearing-and-distance legs from a starting beacon on the surveyor's plane grid (Minna / UTM, the old
Nigeria zones…), as plane trigonometry, which is how survey plans are computed. Its misclosure (where the last leg
ends against where the first began) is the survey's accuracy: closure ratio = perimeter / misclosure, e.g. 1:12,000.
Within the organization's tolerance, the misclosure is spread around the legs by the Bowditch (compass) rule, as a
surveyor would, and the boundary is moved to WGS84 for the map and the overlap checks.

Bearings are whole-circle from grid north, clockwise: 123.5, 123°30', 123°30'00", "123 30 00" or "123-30-00"."""
import math
import re
from dataclasses import dataclass, field

from pyproj import Geod, Transformer
from shapely.geometry import Polygon
from shapely.validation import explain_validity

from .errors import Problem

# The grids Nigerian survey plans use, and plain GPS. Minna-based grids carry the datum's own uncertainty (metres),
# which ground control points correct (a later step).
GRIDS = {
    26331: "Minna / UTM zone 31N (south-west: Lagos, Ogun, Oyo, Osun, Ondo, Ekiti, Kwara)",
    26332: "Minna / UTM zone 32N (east and centre: FCT, Rivers, Delta, Anambra, Enugu, Kano, Kaduna…)",
    26391: "Minna / Nigeria West Belt (legacy plans)",
    26392: "Minna / Nigeria Mid Belt (legacy plans)",
    26393: "Minna / Nigeria East Belt (legacy plans)",
    32631: "WGS 84 / UTM zone 31N",
    32632: "WGS 84 / UTM zone 32N",
    4326: "WGS 84 longitude / latitude (GPS)",
}
GEOD = Geod(ellps="WGS84")
_transformers: dict[int, Transformer] = {}


def grid_name(epsg: int) -> str:
    return GRIDS.get(epsg, f"EPSG:{epsg}")


def _to_wgs84(epsg: int) -> Transformer:
    if epsg not in GRIDS:
        raise Problem(422, f"EPSG:{epsg} is not one of the survey grids Land Registry knows.", code="validation",
                      fields={"epsg": ["unknown grid"]})
    if epsg not in _transformers:
        _transformers[epsg] = Transformer.from_crs(f"EPSG:{epsg}", "EPSG:4326", always_xy=True)
    return _transformers[epsg]


def to_wgs84(points: list[tuple[float, float]], epsg: int) -> list[tuple[float, float]]:
    if epsg == 4326:
        return list(points)
    t = _to_wgs84(epsg)
    return [t.transform(x, y) for x, y in points]


def from_wgs84(points: list[tuple[float, float]], epsg: int) -> list[tuple[float, float]]:
    if epsg == 4326:
        return list(points)
    t = Transformer.from_crs("EPSG:4326", f"EPSG:{epsg}", always_xy=True)
    return [t.transform(x, y) for x, y in points]


BEARING = re.compile(r"^\s*(\d{1,3})(?:\s*[°\-\s]\s*(\d{1,2})(?:\s*['′\-\s]\s*(\d{1,2}(?:\.\d+)?))?)?\s*(?:['′\"″]+)?\s*$")


def parse_bearing(value) -> float:
    """Degrees, 0 to under 360, from a number or degrees-minutes-seconds text."""
    if isinstance(value, (int, float)):
        deg = float(value)
    else:
        s = str(value).strip().replace("º", "°")
        if re.fullmatch(r"\d{1,3}(\.\d+)?", s):
            deg = float(s)
        else:
            m = BEARING.match(s)
            if not m:
                raise Problem(422, f"\"{value}\" is not a bearing. Write it as 123.5, 123°30' or 123°30'15\".", code="validation",
                              fields={"bearing": ["not a bearing"]})
            d, mi, se = int(m.group(1)), int(m.group(2) or 0), float(m.group(3) or 0)
            if mi >= 60 or se >= 60:
                raise Problem(422, f"\"{value}\": minutes and seconds go up to 59.", code="validation", fields={"bearing": ["out of range"]})
            deg = d + mi / 60 + se / 3600
    if not 0 <= deg < 360:
        raise Problem(422, f"A bearing is from 0 to under 360 degrees, not {deg}.", code="validation", fields={"bearing": ["out of range"]})
    return deg


def dms(deg: float) -> str:
    total = round(deg * 3600)
    d, rest = divmod(total, 3600)
    m, s = divmod(rest, 60)
    return f"{d % 360}°{m:02d}'{s:02d}\""


@dataclass
class Traverse:
    points: list[tuple[float, float]]          # adjusted beacons, in order, the start not repeated
    misclosure_m: float
    misclosure_e: float
    misclosure_n: float
    perimeter_m: float
    ratio: int | None                          # 1 : ratio; None = closes exactly
    adjusted: bool
    legs: list[dict] = field(default_factory=list)


def traverse(start: tuple[float, float], legs: list[tuple[float, float]], max_ratio: int) -> Traverse:
    """Walk the legs from the start; measure the misclosure; adjust by the Bowditch rule when it is good enough.
    `legs` = (bearing in degrees, distance in metres); the last leg should come back to the start."""
    if len(legs) < 3:
        raise Problem(422, "A parcel's traverse needs at least 3 legs.", code="validation", fields={"legs": ["too few"]})
    e, n = start
    raw = [(e, n)]
    for b, d in legs:
        if d <= 0:
            raise Problem(422, "Every leg needs a distance above 0 m.", code="validation", fields={"legs": ["zero distance"]})
        e += d * math.sin(math.radians(b))
        n += d * math.cos(math.radians(b))
        raw.append((e, n))
    perimeter = sum(d for _, d in legs)
    de, dn = raw[-1][0] - start[0], raw[-1][1] - start[1]
    mis = math.hypot(de, dn)
    ratio = None if mis < 1e-6 else int(perimeter / mis)
    ok = ratio is None or ratio >= max_ratio
    pts = raw
    if ok and ratio is not None:            # Bowditch: each point moves in proportion to the distance walked to it
        walked, pts = 0.0, [raw[0]]
        for i, (_, d) in enumerate(legs, start=1):
            walked += d
            k = walked / perimeter
            pts.append((raw[i][0] - de * k, raw[i][1] - dn * k))
    out = [{"bearing": round(b, 6), "bearing_dms": dms(b), "distance_m": round(d, 3)} for b, d in legs]
    return Traverse(points=pts[:-1], misclosure_m=mis, misclosure_e=de, misclosure_n=dn, perimeter_m=perimeter,
                    ratio=ratio, adjusted=ok and ratio is not None, legs=out)


@dataclass
class Boundary:
    ring: list[tuple[float, float]]            # WGS84, closed
    area_sqm: float
    perimeter_m: float
    problems: list[str]


def boundary(lonlat: list[tuple[float, float]]) -> Boundary:
    """The parcel's polygon on the ground, its true area and perimeter, and what is wrong with its shape."""
    pts = [p for i, p in enumerate(lonlat) if i == 0 or p != lonlat[i - 1]]
    if len(pts) > 1 and pts[0] == pts[-1]:
        pts = pts[:-1]
    problems = []
    if len(pts) < 3:
        raise Problem(422, "A parcel needs at least 3 different beacons.", code="validation", fields={"points": ["too few"]})
    for lon, lat in pts:
        if not (2.5 <= lon <= 15.0 and 4.0 <= lat <= 14.0):
            problems.append(f"A beacon falls outside Nigeria ({lat:.5f}, {lon:.5f}): check the grid and the coordinates.")
            break
    ring = pts + [pts[0]]
    poly = Polygon(ring)
    if not poly.is_valid:
        why = explain_validity(poly)
        problems.append("The boundary crosses itself: check the order of the beacons." if "Self-intersection" in why
                        else f"The boundary is not a proper shape ({why}).")
    area, perim = GEOD.polygon_area_perimeter([p[0] for p in ring], [p[1] for p in ring])
    if abs(area) < 1:
        problems.append("The parcel has no area: the beacons are on one line.")
    return Boundary(ring=ring if area > 0 else list(reversed(ring)), area_sqm=abs(area), perimeter_m=perim, problems=problems)


def wkt(ring: list[tuple[float, float]]) -> str:
    return "POLYGON((" + ", ".join(f"{x:.9f} {y:.9f}" for x, y in ring) + "))"


# ---------- ground control: correcting a grid's plans to the true ground ----------
MIN_POINTS = {"shift": 1, "helmert": 2, "affine": 3}
METHOD_NAME = {"shift": "shift (translation)", "helmert": "similarity (Helmert: shift, rotation, scale)", "affine": "affine (6 parameters)"}


@dataclass
class Correction:
    method: str
    params: list[float]                       # shift: [tx, ty]; helmert: [a, b, tx, ty]; affine: [a, b, c, d, tx, ty] (about the centroid)
    origin: tuple[float, float]               # the plan points' centroid, for numerical sense
    residuals: list[dict]                     # per control point: name, de, dn, d
    rms_m: float

    def apply(self, pts: list[tuple[float, float]]) -> list[tuple[float, float]]:
        ox, oy = self.origin
        out = []
        for x, y in pts:
            u, v = x - ox, y - oy
            if self.method == "shift":
                tx, ty = self.params
                out.append((x + tx, y + ty))
            elif self.method == "helmert":
                a, b, tx, ty = self.params
                out.append((ox + a * u - b * v + tx, oy + b * u + a * v + ty))
            else:
                a, b, c, d, tx, ty = self.params
                out.append((ox + a * u + b * v + tx, oy + c * u + d * v + ty))
        return out

    def summary(self) -> dict:
        tx, ty = (self.params[-2], self.params[-1])
        s = {"method": self.method, "method_name": METHOD_NAME[self.method], "shift_e": round(tx, 3), "shift_n": round(ty, 3),
             "rms_m": round(self.rms_m, 3), "points": len(self.residuals)}
        if self.method == "helmert":
            a, b = self.params[0], self.params[1]
            s["scale_ppm"] = round((math.hypot(a, b) - 1) * 1e6, 1)
            s["rotation_sec"] = round(math.degrees(math.atan2(b, a)) * 3600, 2)
        return s


def fit(method: str, control: list[dict]) -> Correction:
    """Least squares from the control points' plan positions to their true ones. `control` has name, plan_e, plan_n, true_e, true_n."""
    import numpy as np
    if method not in MIN_POINTS:
        raise Problem(422, f"Unknown correction \"{method}\".", code="validation")
    if len(control) < MIN_POINTS[method]:
        raise Problem(422, f"A {METHOD_NAME[method]} correction needs at least {MIN_POINTS[method]} control point"
                           f"{'s' if MIN_POINTS[method] > 1 else ''} on this grid; there {'is' if len(control) == 1 else 'are'} {len(control)}.",
                      code="too_few_control")
    P = np.array([[float(c["plan_e"]), float(c["plan_n"])] for c in control])
    T = np.array([[float(c["true_e"]), float(c["true_n"])] for c in control])
    o = P.mean(axis=0)
    U = P - o
    if method == "shift":
        params = list((T - P).mean(axis=0))
    elif method == "helmert":
        A = np.zeros((2 * len(P), 4)); L = np.zeros(2 * len(P))
        for i, (u, v) in enumerate(U):
            A[2 * i] = [u, -v, 1, 0]; A[2 * i + 1] = [v, u, 0, 1]
            L[2 * i], L[2 * i + 1] = T[i, 0] - o[0], T[i, 1] - o[1]
        params = list(np.linalg.lstsq(A, L, rcond=None)[0])
    else:
        A = np.zeros((2 * len(P), 6)); L = np.zeros(2 * len(P))
        for i, (u, v) in enumerate(U):
            A[2 * i] = [u, v, 0, 0, 1, 0]; A[2 * i + 1] = [0, 0, u, v, 0, 1]
            L[2 * i], L[2 * i + 1] = T[i, 0] - o[0], T[i, 1] - o[1]
        sol, _, rank, _ = np.linalg.lstsq(A, L, rcond=None)
        if rank < 6:
            raise Problem(422, "The control points lie on one line: an affine correction needs them spread around the area.", code="too_few_control")
        params = list(sol)
    c = Correction(method, [float(x) for x in params], (float(o[0]), float(o[1])), [], 0.0)
    fitted = c.apply([tuple(p) for p in P])
    res = []
    for ctl, (fx, fy), t in zip(control, fitted, T):
        de, dn = float(t[0] - fx), float(t[1] - fy)
        res.append({"name": ctl["name"], "de": round(de, 3), "dn": round(dn, 3), "d": round(math.hypot(de, dn), 3)})
    c.residuals = res
    c.rms_m = math.sqrt(sum(r["d"] ** 2 for r in res) / len(res))
    return c
