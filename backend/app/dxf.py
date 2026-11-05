"""Reading parcels out of a surveyor's DXF (AutoCAD, Civil 3D, BricsCAD, QGIS…): every closed polyline is a candidate
boundary, in the drawing's own coordinates (the survey grid), with the beacon numbers and plot labels written near it."""
import io
import math

import ezdxf
from ezdxf.lldxf.const import DXFError
from shapely.geometry import Point, Polygon

from .errors import Problem

MAX_SHAPES = 2000


def _texts(msp) -> list[tuple[str, float, float]]:
    out = []
    for e in msp.query("TEXT MTEXT"):
        try:
            text = e.plain_text() if e.dxftype() == "MTEXT" else e.dxf.text
            ins = e.dxf.insert
        except Exception:  # noqa: BLE001 - a broken label is skipped, not fatal
            continue
        text = " ".join(str(text).split())
        if text:
            out.append((text, float(ins.x), float(ins.y)))
    return out


def read(content: str | bytes) -> dict:
    """The closed shapes in the drawing, each with its vertices, the nearest label to each vertex (a beacon number, within
    3 m) and the label inside it (the plot number)."""
    try:
        if isinstance(content, bytes):
            doc = ezdxf.read(io.BytesIO(content)) if content[:22] == b"AutoCAD Binary DXF\r\n\x1a\x00" else ezdxf.read(io.StringIO(content.decode("utf-8", "replace")))
        else:
            doc = ezdxf.read(io.StringIO(content))
    except (DXFError, ValueError, UnicodeError, IndexError) as e:
        raise Problem(422, f"This is not a DXF file Land Registry can read ({str(e)[:120]}). Save it from the CAD program as DXF (R12 or later).",
                      code="bad_dxf")
    msp = doc.modelspace()
    shapes = []
    for e in msp.query("LWPOLYLINE POLYLINE"):
        try:
            if e.dxftype() == "LWPOLYLINE":
                closed = e.closed
                pts = [(float(x), float(y)) for x, y, *_ in e.get_points("xy")]
            else:
                if e.is_3d_polyline is False and not e.is_2d_polyline:
                    continue
                closed = e.is_closed
                pts = [(float(v.dxf.location.x), float(v.dxf.location.y)) for v in e.vertices]
        except Exception:  # noqa: BLE001
            continue
        if len(pts) > 1 and math.dist(pts[0], pts[-1]) < 1e-6:
            pts, closed = pts[:-1], True
        if not closed or len(pts) < 3:
            continue
        poly = Polygon(pts)
        if poly.area < 1:
            continue
        shapes.append({"layer": e.dxf.layer, "points": pts, "poly": poly})
        if len(shapes) > MAX_SHAPES:
            raise Problem(422, f"The drawing has more than {MAX_SHAPES:,} closed shapes. Export only the parcel boundaries layer.", code="bad_dxf")
    texts = _texts(msp)
    out = []
    for i, s in enumerate(sorted(shapes, key=lambda s: (-s["poly"].centroid.y, s["poly"].centroid.x))):
        poly = s["poly"]
        inside = [t for t in texts if poly.contains(Point(t[1], t[2]))]
        # the label inside: the shortest text near the middle, e.g. "PLOT 12" or "12"
        label = min(inside, key=lambda t: (Point(t[1], t[2]).distance(poly.centroid), len(t[0])))[0] if inside else ""
        beacons = []
        for x, y in s["points"]:
            near = [t for t in texts if math.dist((x, y), (t[1], t[2])) <= 3.0 and len(t[0]) <= 20 and t[0] != label]
            beacons.append(min(near, key=lambda t: math.dist((x, y), (t[1], t[2])))[0] if near else "")
        out.append({"index": i, "layer": s["layer"], "label": label, "area_plan": round(poly.area, 2),
                    "points": [{"x": round(x, 3), "y": round(y, 3), "beacon": b} for (x, y), b in zip(s["points"], beacons)]})
    layers = sorted({s["layer"] for s in out})
    return {"shapes": out, "layers": layers, "texts": len(texts)}
