"""Changing the fabric itself: subdividing a parcel along a cut line, and amalgamating neighbours into one.

Geometry is in WGS84 longitude/latitude (as the fabric is kept); areas and lengths are geodesic. New beacons where a
cut line crosses the boundary are named N1, N2…; beacons the new parcels share with the old keep their names."""
import math

from shapely.geometry import LineString, MultiPolygon, Polygon, mapping
from shapely.geometry.polygon import orient
from shapely.ops import split, unary_union

from . import geodesy
from .errors import Problem

EPS_DEG = 5e-7            # about 5 cm: shared boundaries captured separately rarely agree to the millimetre
MIN_PIECE_SQM = 10.0


def _close(a, b) -> bool:
    return abs(a[0] - b[0]) < 2e-7 and abs(a[1] - b[1]) < 2e-7      # about 2 cm


def pieces(parent: Polygon, line_lonlat: list[tuple[float, float]]) -> list[Polygon]:
    """The parcel cut by the line (which must cross it from one side to the other), largest first."""
    if len(line_lonlat) < 2:
        raise Problem(422, "A cut line needs at least two points.", code="validation", fields={"cut": ["too few points"]})
    line = LineString(line_lonlat)
    if not line.is_simple:
        raise Problem(422, "The cut line crosses itself.", code="validation", fields={"cut": ["crosses itself"]})
    parts = [g for g in split(parent, line).geoms if isinstance(g, Polygon)]
    if len(parts) < 2:
        raise Problem(422, "The cut line does not divide the parcel: it must cross the boundary from one side to the other.",
                      code="not_divided")
    parts = [orient(p, 1.0) for p in parts]
    out = sorted(parts, key=lambda p: -geodesy.boundary(list(p.exterior.coords)[:-1]).area_sqm)
    small = [geodesy.boundary(list(p.exterior.coords)[:-1]).area_sqm for p in out if geodesy.boundary(list(p.exterior.coords)[:-1]).area_sqm < MIN_PIECE_SQM]
    if small:
        raise Problem(422, f"The cut leaves a sliver of {small[0]:.1f} m²: move the line, or snap it to the boundary.", code="sliver")
    return out


def union(polys: list[Polygon]) -> Polygon:
    """Neighbours as one parcel: they must touch along a boundary, not just at a corner."""
    u = unary_union([p.buffer(EPS_DEG, join_style=2) for p in polys]).buffer(-EPS_DEG, join_style=2)
    if isinstance(u, MultiPolygon) or u.is_empty:
        raise Problem(422, "These parcels do not share a boundary, so they cannot become one parcel.", code="not_adjacent")
    u = Polygon(u.exterior.coords)            # holes from tiny gaps between separately captured boundaries go
    return orient(u.simplify(EPS_DEG / 5, preserve_topology=True), 1.0)


def beacons(poly: Polygon, known: list[dict], epsg: int) -> list[dict]:
    """The new parcel's beacons: names kept where they match the old beacons, new ones numbered N1, N2…"""
    ring = list(poly.exterior.coords)[:-1]
    grid = geodesy.from_wgs84(ring, epsg) if epsg != 4326 else ring
    out, n = [], 0
    for i, (lon, lat) in enumerate(ring):
        match = next((b for b in known if _close((b["lon"], b["lat"]), (lon, lat))), None)
        if match:
            name = match["name"]
        else:
            n += 1
            name = f"N{n}"
        out.append({"seq": i + 1, "name": name, "lon": round(lon, 9), "lat": round(lat, 9),
                    "easting": round(grid[i][0], 3) if epsg != 4326 else None, "northing": round(grid[i][1], 3) if epsg != 4326 else None})
    return out


def describe(poly: Polygon) -> dict:
    b = geodesy.boundary(list(poly.exterior.coords)[:-1])
    return {"area_sqm": round(b.area_sqm, 2), "perimeter_m": round(b.perimeter_m, 2), "ring": b.ring,
            "geometry": mapping(Polygon(b.ring))}


def apportion(total: float | None, areas: list[float]) -> list[float | None]:
    if total is None:
        return [None] * len(areas)
    whole = sum(areas)
    shares = [round(total * a / whole, 2) for a in areas]
    shares[0] = round(total - sum(shares[1:]), 2)
    return shares


