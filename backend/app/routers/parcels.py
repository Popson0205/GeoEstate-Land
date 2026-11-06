"""The parcel fabric: capturing a parcel (check, then save with its PIN), the register, a parcel's page, retiring one;
and the organization's settings (survey grid, PIN prefix, closure, overlap tolerance)."""
import json
from datetime import date

from psycopg.types.json import Jsonb
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field

from .. import geodesy
from ..audit import audit
from ..db import get_conn
from ..errors import Problem
from ..identity import need

router = APIRouter(tags=["parcels"])


# ---------- settings ----------
class SettingsIn(BaseModel):
    default_epsg: int
    pin_prefix: str = Field(pattern=r"^[A-Za-z0-9]{1,8}$")
    closure_ratio: int = Field(ge=500, le=100000, description="A traverse must close to better than 1 in this")
    overlap_tolerance_sqm: float = Field(ge=0, le=100)
    title_prefix: str | None = Field(None, pattern=r"^[A-Za-z0-9/]{1,12}$", description="Titles are numbered PREFIX/000001")
    public_lookup: Literal["off", "basic", "holders"] | None = Field(None, description="What anyone can see at the public lookup")


def public_allowed(user: dict) -> bool:
    return not user["features"] or "public_lookup" in user["features"]


async def org_settings(conn, user: dict) -> dict:
    """The organization's settings, made on first use; its name and Geohub address (slug) kept up to date. A plan without
    the public lookup turns it off."""
    await conn.execute("INSERT INTO settings (org_id, org_name, org_slug) VALUES (%s, %s, %s) ON CONFLICT (org_id) DO UPDATE "
                       "SET org_name = EXCLUDED.org_name, org_slug = EXCLUDED.org_slug, "
                       "    public_lookup = CASE WHEN %s THEN settings.public_lookup ELSE 'off' END "
                       "WHERE settings.org_name <> EXCLUDED.org_name OR settings.org_slug <> EXCLUDED.org_slug "
                       "   OR (NOT %s AND settings.public_lookup <> 'off')",
                       (user["org_id"], user["org_name"] or "", user.get("org_slug") or "", public_allowed(user), public_allowed(user)))
    cur = await conn.execute("SELECT * FROM settings WHERE org_id = %s", (user["org_id"],))
    s = await cur.fetchone()
    return {**s, "grid_name": geodesy.grid_name(s["default_epsg"]), "overlap_tolerance_sqm": float(s["overlap_tolerance_sqm"]),
            "public_allowed": public_allowed(user), "workflows_allowed": has(user, "workflows"), "dxf_allowed": has(user, "dxf_import")}


def has(user: dict, feature: str) -> bool:
    """Whether the organization's plan includes a feature (a token without a feature list: everything)."""
    return not user["features"] or feature in user["features"]


@router.get("/grids", summary="The survey grids Land Registry knows")
async def grids(user=Depends(need())):
    return [{"epsg": k, "name": v} for k, v in geodesy.GRIDS.items()]


@router.get("/settings", summary="The organization's survey grid, PINs, closure and overlap rules")
async def get_settings(user=Depends(need()), conn=Depends(get_conn)):
    return await org_settings(conn, user)


@router.put("/settings", summary="Change them (registrars)")
async def put_settings(body: SettingsIn, user=Depends(need("registrar", write=True)), conn=Depends(get_conn)):
    geodesy.grid_name(body.default_epsg)
    if body.default_epsg not in geodesy.GRIDS:
        raise Problem(422, "Choose one of the survey grids listed.", code="validation", fields={"default_epsg": ["unknown grid"]})
    if body.public_lookup not in (None, "off") and not public_allowed(user):
        raise Problem(403, "Your organization's Land Registry plan does not include the public lookup.", code="no_feature")
    await org_settings(conn, user)
    await conn.execute("UPDATE settings SET default_epsg = %s, pin_prefix = %s, closure_ratio = %s, overlap_tolerance_sqm = %s, "
                       "title_prefix = COALESCE(%s, title_prefix), public_lookup = COALESCE(%s, public_lookup), updated_at = now() "
                       "WHERE org_id = %s",
                       (body.default_epsg, body.pin_prefix.upper(), body.closure_ratio, body.overlap_tolerance_sqm,
                        body.title_prefix.upper() if body.title_prefix else None, body.public_lookup, user["org_id"]))
    await audit(conn, user, "settings.update", **body.model_dump())
    return await org_settings(conn, user)


# ---------- capturing a parcel ----------
class Leg(BaseModel):
    bearing: str | float = Field(description="Whole-circle bearing: 123.5, 123°30' or 123°30'15\"")
    distance_m: float = Field(gt=0, le=100000)
    beacon: str = Field("", max_length=40, description="The beacon this leg reaches")


class Point(BaseModel):
    x: float = Field(description="Easting, or longitude for EPSG:4326")
    y: float = Field(description="Northing, or latitude for EPSG:4326")
    beacon: str = Field("", max_length=40)


class Start(BaseModel):
    easting: float
    northing: float
    beacon: str = Field("", max_length=40)


class CaptureIn(BaseModel):
    method: Literal["traverse", "coordinates"]
    epsg: int | None = Field(None, description="The survey grid; the organization's own when left out")
    start: Start | None = None
    legs: list[Leg] = Field(default_factory=list, max_length=200)
    points: list[Point] = Field(default_factory=list, max_length=500)
    plan_area_sqm: float | None = Field(None, gt=0, lt=1e9, description="The area printed on the survey plan, to compare and to find a misread leg")
    close_to_start: bool = Field(False, description="Registrars: replace the last leg with the one that returns to the start, as CAD does")
    close_reason: str = Field("", max_length=500, description="Why the traverse is closed to its start (kept with the parcel)")


class ParcelIn(CaptureIn):
    land_use: str = Field("", max_length=60)
    address: str = Field("", max_length=300)
    locality: str = Field("", max_length=120)
    notes: str = Field("", max_length=4000)
    survey_plan_no: str = Field("", max_length=80)
    surveyor: str = Field("", max_length=160)
    survey_date: date | None = None


def close_to_start(user: dict, body: CaptureIn, plan_legs: list, t, problems: list, warnings: list) -> dict:
    """Close a traverse the way CAD does: the last leg becomes the line from the last beacon back to the start. Only a
    registrar, with a reason; and not when the plan's area shows the error is in another leg (closing would then put
    the error in the wrong place)."""
    diag = geodesy.leg_fixes(plan_legs, body.plan_area_sqm)
    last = diag["fixes"][-1]
    n = len(plan_legs)
    if user.get("role") != "registrar":
        problems.append("Only a registrar can close a traverse to its starting point.")
    if len(body.close_reason.strip()) < 10:
        problems.append("Say why the traverse is closed to its start (for example, confirmed with the surveyor); the reason is kept with the parcel.")
    if diag["suspect"] and diag["suspect"]["leg"] != n:
        problems.append(f"The plan's area points to leg {diag['suspect']['leg']}, not the last leg: closing to the start would put the "
                        f"error in the wrong leg. Correct leg {diag['suspect']['leg']} instead.")
    b0, d0 = plan_legs[-1]
    warnings.append(f"Closed to the starting point: leg {n} is {last['bearing_dms']} {last['distance_m']:.2f} m instead of the plan's "
                    f"{geodesy.dms(b0)} {d0:.2f} m (the plan misses by {t.misclosure_m:.2f} m, 1 in {t.ratio:,}).")
    return {"leg": n, "bearing": last["bearing"], "bearing_dms": last["bearing_dms"], "distance_m": last["distance_m"],
            "plan_bearing_dms": geodesy.dms(b0), "plan_distance_m": round(d0, 3), "plan_misclosure_m": round(t.misclosure_m, 3),
            "plan_ratio": t.ratio, "reason": body.close_reason.strip()}


async def check(conn, user: dict, body: CaptureIn, ignore: UUID | None = None) -> dict:
    """Everything about a boundary before it is saved: closure, shape, area, and overlaps with the fabric."""
    s = await org_settings(conn, user)
    epsg = body.epsg or s["default_epsg"]
    geodesy.grid_name(epsg)
    if epsg not in geodesy.GRIDS:
        raise Problem(422, "Choose one of the survey grids listed.", code="validation", fields={"epsg": ["unknown grid"]})
    problems, warnings, closure, legs = [], [], None, []
    if body.method == "traverse":
        if not body.start:
            raise Problem(422, "Give the starting beacon's easting and northing.", code="validation", fields={"start": ["missing"]})
        if epsg == 4326:
            raise Problem(422, "A traverse is walked on a projected grid (metres), not in longitude and latitude.", code="validation",
                          fields={"epsg": ["not projected"]})
        plan_legs = [(geodesy.parse_bearing(l.bearing), l.distance_m) for l in body.legs]
        t = geodesy.traverse((body.start.easting, body.start.northing), plan_legs, s["closure_ratio"])
        closed = None
        if body.close_to_start and t.ratio is not None and t.ratio < s["closure_ratio"] and len(plan_legs) >= 3:
            closed = close_to_start(user, body, plan_legs, t, problems, warnings)
            t = geodesy.traverse((body.start.easting, body.start.northing),
                                 plan_legs[:-1] + [(closed["bearing"], closed["distance_m"])], s["closure_ratio"])
        closure = {"misclosure_m": round(t.misclosure_m, 3), "misclosure_e": round(t.misclosure_e, 3),
                   "misclosure_n": round(t.misclosure_n, 3), "perimeter_m": round(t.perimeter_m, 3), "ratio": t.ratio,
                   "required_ratio": s["closure_ratio"], "adjusted": t.adjusted}
        if closed:
            closure.update(closed=closed, misclosure_m=closed["plan_misclosure_m"], ratio=closed["plan_ratio"])
        elif t.ratio is not None and t.ratio < s["closure_ratio"]:
            problems.append(f"The traverse does not close: it misses by {t.misclosure_m:.2f} m, 1 in {t.ratio:,}. "
                            f"This registry needs 1 in {s['closure_ratio']:,} or better. Check the bearings and distances.")
            diag = geodesy.leg_fixes(plan_legs, body.plan_area_sqm)
            closure["fixes"] = diag["fixes"]
            closure["suspect"] = diag["suspect"]
            if diag["suspect"]:
                f = diag["suspect"]
                problems.append(f"Leg {f['leg']} is the one to check: {f['bearing_dms']} and {f['distance_m']:.2f} m would close the traverse "
                                f"and give the plan's area of {body.plan_area_sqm:,.2f} m². Compare those figures with the plan, or with the "
                                f"beacons' coordinates if the plan lists them.")
            elif not body.plan_area_sqm:
                problems.append("Give the area printed on the plan to find which leg is off.")
        grid_pts = t.points
        names = [body.start.beacon] + [l.beacon for l in body.legs[:-1]]
        legs = t.legs
    else:
        if len(body.points) < 3:
            raise Problem(422, "A parcel needs at least 3 beacons.", code="validation", fields={"points": ["too few"]})
        grid_pts = [(p.x, p.y) for p in body.points]
        names = [p.beacon for p in body.points]
    correction = None
    method = (s["corrections"] or {}).get(str(epsg), "off")
    if method != "off" and epsg != 4326:
        try:
            fitted = await correction_for(conn, user, epsg, method)
        except Problem as e:
            problems.append(f"This grid is set to be corrected to ground control, but: {e.detail}")
            fitted = None
        if fitted:
            correction = fitted.summary()
            lonlat = geodesy.to_wgs84(fitted.apply(grid_pts), epsg)
    if not correction:
        lonlat = geodesy.to_wgs84(grid_pts, epsg)
    b = geodesy.boundary(lonlat)
    problems += b.problems
    if body.plan_area_sqm and not problems and abs(b.area_sqm - body.plan_area_sqm) > max(1.0, body.plan_area_sqm * 0.005):
        warnings.append(f"The plan gives {body.plan_area_sqm:,.2f} m²; these figures give {b.area_sqm:,.2f} m². Check the plan.")
    overlaps = []
    if not b.problems:
        cur = await conn.execute(
            "SELECT id, pin, ST_Area(ST_Intersection(geom, g)::geography) AS overlap FROM parcels, "
            "  (SELECT ST_GeomFromText(%s, 4326) AS g) x "
            "WHERE org_id = %s AND status IN ('active','pending') AND ST_Intersects(geom, g) AND (%s::uuid IS NULL OR id <> %s::uuid) "
            "ORDER BY overlap DESC", (geodesy.wkt(b.ring), user["org_id"], ignore, ignore))
        # (pending parcels hold their land too, so two waiting for approval cannot claim the same ground)
        for r in await cur.fetchall():
            if r["overlap"] < 0.01:
                continue                                   # sharing a boundary is not overlapping
            overlaps.append({"id": str(r["id"]), "pin": r["pin"], "overlap_sqm": round(r["overlap"], 2)})
        big = [o for o in overlaps if o["overlap_sqm"] > s["overlap_tolerance_sqm"]]
        if big:
            problems.append("It overlaps " + ", ".join(f"{o['pin']} by {o['overlap_sqm']:,} m²" for o in big)
                            + ". A parcel cannot overlap another parcel in the fabric.")
        elif overlaps:
            warnings.append("Slivers within the tolerance touch " + ", ".join(o["pin"] for o in overlaps) + ": kept as they are.")
    beacons = [{"seq": i + 1, "name": (names[i] if i < len(names) else "") or f"B{i + 1}",
                "easting": round(grid_pts[i][0], 3) if epsg != 4326 else None, "northing": round(grid_pts[i][1], 3) if epsg != 4326 else None,
                "lon": round(lonlat[i][0], 9), "lat": round(lonlat[i][1], 9)} for i in range(len(grid_pts))]
    return {"ok": not problems, "problems": problems, "warnings": warnings, "method": body.method, "epsg": epsg,
            "grid_name": geodesy.grid_name(epsg), "closure": closure, "legs": legs, "area_sqm": round(b.area_sqm, 2),
            "area_ha": round(b.area_sqm / 10000, 4), "perimeter_m": round(b.perimeter_m, 2),
            "geometry": {"type": "Polygon", "coordinates": [[list(p) for p in b.ring]]}, "beacons": beacons, "overlaps": overlaps,
            "correction": correction}


@router.post("/parcels/check", summary="Check a boundary without saving it")
async def check_parcel(body: CaptureIn, user=Depends(need("officer")), conn=Depends(get_conn)):
    return await check(conn, user, body)


PARCEL_SQL = ("SELECT p.id, p.pin, p.status, p.decided_by_name, p.decided_at, p.decision_note, p.correction, p.area_sqm, p.perimeter_m, p.land_use, p.address, p.locality, p.notes, p.method, "
              "  p.source_epsg, p.closure_error_m, p.closure_ratio, p.closed_to_start, p.survey_plan_no, p.surveyor, p.survey_date, p.retired_reason, "
              "  p.created_by_name, p.created_at, p.updated_at, ST_X(ST_Centroid(p.geom)) AS lon, ST_Y(ST_Centroid(p.geom)) AS lat, "
              "  (SELECT t.title_no FROM titles t WHERE t.parcel_id = p.id AND t.status = 'current') AS title_no "
              "FROM parcels p ")


@router.post("/parcels", status_code=201, summary="Register a parcel: checked, then given its PIN")
async def create_parcel(body: ParcelIn, user=Depends(need("officer", write=True)), conn=Depends(get_conn)):
    if user["features"] and "parcels" not in user["features"]:
        raise Problem(403, "Your organization's Land Registry plan does not include parcels.", code="no_feature")
    cap = (user["limits"] or {}).get("parcels")
    if cap is not None:
        cur = await conn.execute("SELECT count(*) AS n FROM parcels WHERE org_id = %s AND status = 'active'", (user["org_id"],))
        if (await cur.fetchone())["n"] >= cap:
            raise Problem(402, f"Your plan holds {cap:,} parcels and they are all in use. Ask GeoEstate NIG Limited for more.",
                          code="plan_limit")
    c = await check(conn, user, body)
    if not c["ok"]:
        raise Problem(422, " ".join(c["problems"]), code="not_registrable", check=c)
    s = await org_settings(conn, user)
    pending = steps(s, "parcel") >= 1 and user["role"] != "registrar"      # a registrar's own parcels need no one else
    pid, pin = await insert_parcel(conn, user, c["geometry"]["coordinates"][0], c["area_sqm"], c["perimeter_m"], c["beacons"],
                                   status="pending" if pending else "active", method=c["method"], source_epsg=c["epsg"],
                                   closure_error_m=(c["closure"] or {}).get("misclosure_m"), closure_ratio=(c["closure"] or {}).get("ratio"),
                                   correction=c["correction"], closed_to_start=closed_record(c, user), land_use=body.land_use.strip(), address=body.address.strip(),
                                   locality=body.locality.strip(), notes=body.notes.strip(), survey_plan_no=body.survey_plan_no.strip(),
                                   surveyor=body.surveyor.strip(), survey_date=body.survey_date)
    await audit(conn, user, "parcel.create", "parcel", pid, pin=pin, area_sqm=c["area_sqm"], method=c["method"],
                pending=True if pending else None, closed_to_start=closed_record(c, user))
    return await get_parcel(pid, user, conn)


def closed_record(c: dict, user: dict) -> dict | None:
    """What is kept when a registrar closed the traverse to its start."""
    closed = (c.get("closure") or {}).get("closed")
    return closed and {k: v for k, v in closed.items() if k != "bearing"} | {"by": user["name"], "by_id": str(user["id"])}


def steps(s: dict, kind: str) -> int:
    """How many registrars approve this kind of change in this organization's workflow."""
    default = 0 if kind == "parcel" else 1
    if not s.get("workflows_allowed", True):
        return default                                  # a plan without approval workflows: the standard one
    return int((s.get("workflow") or {}).get(kind, default))


async def insert_parcel(conn, user, ring, area_sqm, perimeter_m, beacons, *, status="active", method, source_epsg, **fields) -> tuple:
    """A new parcel with the next PIN, and its beacons."""
    cur = await conn.execute("UPDATE settings SET pin_next = pin_next + 1 WHERE org_id = %s RETURNING pin_prefix, pin_next - 1 AS n",
                             (user["org_id"],))
    s = await cur.fetchone()
    pin = f"{s['pin_prefix']}-{s['n']:06d}"
    cols = {"land_use": "", "address": "", "locality": "", "notes": "", "survey_plan_no": "", "surveyor": "", "survey_date": None,
            "closure_error_m": None, "closure_ratio": None, "correction": None, "closed_to_start": None} | fields
    for k in ("correction", "closed_to_start"):
        if cols[k] is not None:
            cols[k] = Jsonb(cols[k])
    names = ", ".join(cols)
    cur = await conn.execute(
        f"INSERT INTO parcels (org_id, pin, geom, area_sqm, perimeter_m, status, method, source_epsg, created_by, created_by_name, {names}) "
        f"VALUES (%s, %s, ST_GeomFromText(%s, 4326), %s, %s, %s, %s, %s, %s, %s, {', '.join(['%s'] * len(cols))}) RETURNING id",
        (user["org_id"], pin, geodesy.wkt([tuple(p) for p in ring]), area_sqm, perimeter_m, status, method, source_epsg, user["id"], user["name"],
         *cols.values()))
    pid = (await cur.fetchone())["id"]
    for b in beacons:
        await conn.execute("INSERT INTO beacons (parcel_id, seq, name, easting, northing, lon, lat) VALUES (%s, %s, %s, %s, %s, %s, %s)",
                           (pid, b["seq"], b["name"], b["easting"], b["northing"], b["lon"], b["lat"]))
    return pid, pin


class Decision(BaseModel):
    note: str = Field("", max_length=2000)


@router.post("/parcels/{parcel_id}/approve", summary="Approve a parcel waiting in the workflow (registrars): it joins the fabric")
async def approve_parcel(parcel_id: UUID, body: Decision, user=Depends(need("registrar", write=True)), conn=Depends(get_conn)):
    return await _decide_parcel(conn, user, parcel_id, "active", body.note)


@router.post("/parcels/{parcel_id}/reject", summary="Reject a parcel waiting in the workflow, with the reason (registrars)")
async def reject_parcel(parcel_id: UUID, body: Decision, user=Depends(need("registrar", write=True)), conn=Depends(get_conn)):
    if len(body.note.strip()) < 3:
        raise Problem(422, "Say why it is rejected: whoever captured it will see this.", code="validation", fields={"note": ["missing"]})
    return await _decide_parcel(conn, user, parcel_id, "rejected", body.note)


async def _decide_parcel(conn, user, parcel_id, status, note):
    cur = await conn.execute("UPDATE parcels SET status = %s, decided_by_name = %s, decided_at = now(), decision_note = %s, updated_at = now() "
                             "WHERE id = %s AND org_id = %s AND status = 'pending' RETURNING pin", (status, user["name"], note.strip(), parcel_id, user["org_id"]))
    row = await cur.fetchone()
    if not row:
        p = await get_parcel(parcel_id, user, conn)
        raise Problem(409, f"{p['pin']} is not waiting for a decision.", code="decided")
    await conn.execute("INSERT INTO approvals (target_type, target_id, by_id, by_name, note) VALUES ('parcel', %s, %s, %s, %s) "
                       "ON CONFLICT DO NOTHING", (parcel_id, user["id"], user["name"], note.strip()))
    await audit(conn, user, "parcel.approve" if status == "active" else "parcel.reject", "parcel", parcel_id, pin=row["pin"],
                note=note.strip() or None)
    return await get_parcel(parcel_id, user, conn)


@router.get("/parcels", summary="The register: search by PIN, address, locality, survey plan or surveyor")
async def list_parcels(q: str | None = None, status: str | None = Query("active", pattern="^(active|pending|retired|rejected|all)$"),
                       limit: int = Query(200, ge=1, le=1000), user=Depends(need()), conn=Depends(get_conn)):
    where, params = ["p.org_id = %s"], [user["org_id"]]
    if status != "all":
        where.append("p.status = %s"); params.append(status)
    if q:
        where.append("(p.pin ILIKE %s OR p.address ILIKE %s OR p.locality ILIKE %s OR p.survey_plan_no ILIKE %s OR p.surveyor ILIKE %s "
                     " OR EXISTS (SELECT 1 FROM titles t LEFT JOIN holdings h ON h.title_id = t.id AND h.to_instrument IS NULL "
                     "            LEFT JOIN parties pa ON pa.id = h.party_id "
                     "            WHERE t.parcel_id = p.id AND t.status = 'current' AND (t.title_no ILIKE %s OR pa.name ILIKE %s)))")
        params += [f"%{q.strip()}%"] * 7
    cur = await conn.execute(PARCEL_SQL + f"WHERE {' AND '.join(where)} ORDER BY p.created_at DESC LIMIT %s", (*params, limit))
    return await cur.fetchall()


@router.get("/parcels.geojson", summary="The fabric for the map, within a box (west,south,east,north)")
async def fabric(bbox: str | None = None, user=Depends(need()), conn=Depends(get_conn)):
    where, params = ["org_id = %s", "status IN ('active','pending')"], [user["org_id"]]
    if bbox:
        try:
            w, s_, e, n = (float(x) for x in bbox.split(","))
        except ValueError:
            raise Problem(422, "bbox is west,south,east,north.", code="validation")
        where.append("geom && ST_MakeEnvelope(%s, %s, %s, %s, 4326)"); params += [w, s_, e, n]
    cur = await conn.execute(f"SELECT id, pin, status, area_sqm, land_use, ST_AsGeoJSON(geom, 8) AS g FROM parcels WHERE {' AND '.join(where)} "
                             "LIMIT 20000", params)
    feats = [{"type": "Feature", "id": str(r["id"]), "geometry": json.loads(r["g"]),
              "properties": {"id": str(r["id"]), "pin": r["pin"], "status": r["status"], "area_sqm": float(r["area_sqm"]), "land_use": r["land_use"]}}
             for r in await cur.fetchall()]
    cur = await conn.execute("SELECT ST_XMin(e) AS w, ST_YMin(e) AS s, ST_XMax(e) AS e, ST_YMax(e) AS n FROM "
                             "(SELECT ST_Extent(geom) AS e FROM parcels WHERE org_id = %s AND status = 'active') x", (user["org_id"],))
    ext = await cur.fetchone()
    return {"type": "FeatureCollection", "features": feats, "bbox": [ext["w"], ext["s"], ext["e"], ext["n"]] if ext["w"] is not None else None}


@router.get("/parcels/{parcel_id}", summary="A parcel: its boundary, beacons, survey, neighbours and history")
async def get_parcel(parcel_id: UUID, user=Depends(need()), conn=Depends(get_conn)):
    cur = await conn.execute(PARCEL_SQL + "WHERE p.id = %s AND p.org_id = %s", (parcel_id, user["org_id"]))
    p = await cur.fetchone()
    if not p:
        raise Problem(404, "Parcel not found.", code="not_found")
    cur = await conn.execute("SELECT ST_AsGeoJSON(geom, 9) AS g FROM parcels WHERE id = %s", (parcel_id,))
    p["geometry"] = json.loads((await cur.fetchone())["g"])
    p["grid_name"] = geodesy.grid_name(p["source_epsg"])
    cur = await conn.execute("SELECT seq, name, easting, northing, lon, lat FROM beacons WHERE parcel_id = %s ORDER BY seq", (parcel_id,))
    p["beacons"] = await cur.fetchall()
    cur = await conn.execute(
        "SELECT n.id, n.pin, n.land_use FROM parcels n, parcels p WHERE p.id = %s AND n.org_id = p.org_id AND n.id <> p.id "
        "AND n.status = 'active' AND ST_DWithin(n.geom::geography, p.geom::geography, 1.0) ORDER BY n.pin LIMIT 50", (parcel_id,))
    p["neighbours"] = await cur.fetchall()
    cur = await conn.execute("SELECT at, actor_name, action, details FROM audit_log WHERE org_id = %s AND target_type = 'parcel' "
                             "AND target_id = %s ORDER BY id DESC LIMIT 100", (user["org_id"], str(parcel_id)))
    p["history"] = await cur.fetchall()
    cur = await conn.execute("SELECT 'parent' AS rel, l.parent_id AS id, x.pin, i.number, i.kind FROM lineage l JOIN parcels x ON x.id = l.parent_id "
                             "JOIN instruments i ON i.id = l.instrument_id WHERE l.child_id = %s UNION ALL "
                             "SELECT 'child', l.child_id, x.pin, i.number, i.kind FROM lineage l JOIN parcels x ON x.id = l.child_id "
                             "JOIN instruments i ON i.id = l.instrument_id WHERE l.parent_id = %s ORDER BY 3", (parcel_id, parcel_id))
    lin = await cur.fetchall()
    p["parents"] = [r for r in lin if r["rel"] == "parent"]
    p["children"] = [r for r in lin if r["rel"] == "child"]
    return p


class ParcelPatch(BaseModel):
    land_use: str | None = Field(None, max_length=60)
    address: str | None = Field(None, max_length=300)
    locality: str | None = Field(None, max_length=120)
    notes: str | None = Field(None, max_length=4000)
    survey_plan_no: str | None = Field(None, max_length=80)
    surveyor: str | None = Field(None, max_length=160)
    survey_date: date | None = None


@router.patch("/parcels/{parcel_id}", summary="Change a parcel's details (not its boundary)")
async def update_parcel(parcel_id: UUID, body: ParcelPatch, user=Depends(need("officer", write=True)), conn=Depends(get_conn)):
    p = await get_parcel(parcel_id, user, conn)
    data = {k: (v.strip() if isinstance(v, str) else v) for k, v in body.model_dump(exclude_unset=True).items()}
    if data:
        sets = ", ".join(f"{k} = %s" for k in data)
        await conn.execute(f"UPDATE parcels SET {sets}, updated_at = now() WHERE id = %s", (*data.values(), parcel_id))
        changed = {k: [str(p[k]) if p[k] is not None else None, str(v) if v is not None else None] for k, v in data.items()
                   if (str(p[k]) if p[k] is not None else None) != (str(v) if v is not None else None)}
        if changed:
            await audit(conn, user, "parcel.update", "parcel", parcel_id, pin=p["pin"], changed=changed)
    return await get_parcel(parcel_id, user, conn)


class RetireIn(BaseModel):
    reason: str = Field(min_length=3, max_length=500)


@router.post("/parcels/{parcel_id}/retire", summary="Retire a parcel (registrars): it leaves the fabric, its record stays")
async def retire(parcel_id: UUID, body: RetireIn, user=Depends(need("registrar", write=True)), conn=Depends(get_conn)):
    p = await get_parcel(parcel_id, user, conn)
    if p["status"] != "active":
        raise Problem(409, f"{p['pin']} is {p['status']}: only an active parcel can be retired.", code="not_active")
    cur = await conn.execute("SELECT (SELECT title_no FROM titles WHERE parcel_id = %s AND status = 'current') AS title, "
                             "(SELECT count(*) FROM instruments WHERE parcel_id = %s AND status = 'lodged') AS lodged", (parcel_id, parcel_id))
    r = await cur.fetchone()
    if r["title"]:
        raise Problem(409, f"{p['pin']} has title {r['title']}: revoke it before retiring the parcel.", code="titled")
    if r["lodged"]:
        raise Problem(409, f"{p['pin']} has instruments lodged and waiting: decide them first.", code="lodged")
    await conn.execute("UPDATE parcels SET status = 'retired', retired_reason = %s, updated_at = now() WHERE id = %s",
                       (body.reason.strip(), parcel_id))
    await audit(conn, user, "parcel.retire", "parcel", parcel_id, pin=p["pin"], reason=body.reason.strip())
    return await get_parcel(parcel_id, user, conn)


@router.get("/home", summary="The register at a glance")
async def home(user=Depends(need()), conn=Depends(get_conn)):
    cur = await conn.execute("SELECT count(*) FILTER (WHERE status = 'active') AS active, count(*) FILTER (WHERE status = 'retired') AS retired, "
                             "COALESCE(sum(area_sqm) FILTER (WHERE status = 'active'), 0) AS area_sqm, "
                             "count(*) FILTER (WHERE created_at > date_trunc('month', now())) AS this_month, "
                             "count(*) FILTER (WHERE status = 'pending') AS pending, "
                             "(SELECT count(*) FROM titles t WHERE t.org_id = %s AND t.status = 'current') AS titled, "
                             "(SELECT count(*) FROM instruments i WHERE i.org_id = %s AND i.status = 'lodged') AS lodged "
                             "FROM parcels WHERE org_id = %s",
                             (user["org_id"], user["org_id"], user["org_id"]))
    counts = await cur.fetchone()
    cur = await conn.execute(PARCEL_SQL + "WHERE p.org_id = %s ORDER BY p.created_at DESC LIMIT 8", (user["org_id"],))
    return {**counts, "area_sqm": float(counts["area_sqm"]), "latest": await cur.fetchall(),
            "limit": (user["limits"] or {}).get("parcels"), "settings": await org_settings(conn, user)}


@router.get("/audit", summary="What happened in the register, newest first (registrars)")
async def audit_log(before: int | None = None, user=Depends(need("registrar")), conn=Depends(get_conn)):
    cur = await conn.execute("SELECT id, at, actor_name, action, target_type, target_id, details FROM audit_log WHERE org_id = %s "
                             "AND (%s::bigint IS NULL OR id < %s) ORDER BY id DESC LIMIT 100", (user["org_id"], before, before))
    return await cur.fetchall()


# ---------- the organization's workflow ----------
WORKFLOW_KINDS = ("parcel", "grant", "transfer", "mortgage", "caveat", "lease", "discharge", "revocation", "subdivision", "amalgamation")


class WorkflowIn(BaseModel):
    steps: dict[Literal["parcel", "grant", "transfer", "mortgage", "caveat", "lease", "discharge", "revocation", "subdivision", "amalgamation"],
                int] = Field(description="Registrars who approve each kind: 0, 1 or 2 (a new parcel: 0 or 1)")


@router.get("/settings/workflow", summary="How many registrars approve each kind of change")
async def get_workflow(user=Depends(need()), conn=Depends(get_conn)):
    s = await org_settings(conn, user)
    return {k: steps(s, k) for k in WORKFLOW_KINDS}


@router.put("/settings/workflow", summary="Set the organization's workflow (registrars)")
async def put_workflow(body: WorkflowIn, user=Depends(need("registrar", write=True)), conn=Depends(get_conn)):
    if not has(user, "workflows"):
        raise Problem(403, "Your organization's Land Registry plan does not include approval workflows (Land Registry Advanced).", code="no_feature")
    for k, v in body.steps.items():
        if v not in ((0, 1) if k == "parcel" else (0, 1, 2)):
            raise Problem(422, f"{k}: {'0 or 1' if k == 'parcel' else '0, 1 or 2'} approvals.", code="validation", fields={k: ["out of range"]})
    s = await org_settings(conn, user)
    w = {k: steps(s, k) for k in WORKFLOW_KINDS} | body.steps
    await conn.execute("UPDATE settings SET workflow = %s, updated_at = now() WHERE org_id = %s", (Jsonb(w), user["org_id"]))
    await audit(conn, user, "settings.workflow", **{k: v for k, v in body.steps.items()})
    return w


# ---------- ground control ----------
async def correction_for(conn, user, epsg: int, method: str):
    cur = await conn.execute("SELECT name, plan_e, plan_n, true_e, true_n FROM control_points WHERE org_id = %s AND epsg = %s ORDER BY name",
                             (user["org_id"], epsg))
    return geodesy.fit(method, await cur.fetchall())


class ControlIn(BaseModel):
    epsg: int
    name: str = Field(min_length=1, max_length=60)
    plan_e: float
    plan_n: float
    true_e: float
    true_n: float
    notes: str = Field("", max_length=500)


@router.get("/control", summary="Ground control points on a grid, and the corrections they give")
async def list_control(epsg: int, user=Depends(need()), conn=Depends(get_conn)):
    s = await org_settings(conn, user)
    cur = await conn.execute("SELECT id, epsg, name, plan_e, plan_n, true_e, true_n, notes, created_at FROM control_points "
                             "WHERE org_id = %s AND epsg = %s ORDER BY name", (user["org_id"], epsg))
    pts = await cur.fetchall()
    fits = {}
    for m in geodesy.MIN_POINTS:
        try:
            f = geodesy.fit(m, pts)
            fits[m] = {**f.summary(), "residuals": f.residuals}
        except Problem as e:
            fits[m] = {"method": m, "method_name": geodesy.METHOD_NAME[m], "error": e.detail}
    return {"epsg": epsg, "grid_name": geodesy.grid_name(epsg), "method": (s["corrections"] or {}).get(str(epsg), "off"),
            "points": pts, "fits": fits}


@router.post("/control", status_code=201, summary="Add a ground control point (registrars)")
async def add_control(body: ControlIn, user=Depends(need("registrar", write=True)), conn=Depends(get_conn)):
    if body.epsg not in geodesy.GRIDS or body.epsg == 4326:
        raise Problem(422, "Ground control is for a projected survey grid.", code="validation", fields={"epsg": ["not a survey grid"]})
    if abs(body.plan_e - body.true_e) > 2000 or abs(body.plan_n - body.true_n) > 2000:
        raise Problem(422, "The plan and true positions are more than 2 km apart: check that both are on the same grid.", code="validation")
    await org_settings(conn, user)
    cur = await conn.execute("INSERT INTO control_points (org_id, epsg, name, plan_e, plan_n, true_e, true_n, notes) "
                             "VALUES (%s, %s, %s, %s, %s, %s, %s, %s) ON CONFLICT (org_id, epsg, name) DO NOTHING RETURNING id",
                             (user["org_id"], body.epsg, body.name.strip(), body.plan_e, body.plan_n, body.true_e, body.true_n, body.notes.strip()))
    if not await cur.fetchone():
        raise Problem(409, f"There is already a control point called {body.name.strip()} on this grid.", code="duplicate")
    await audit(conn, user, "control.add", epsg=body.epsg, name=body.name.strip())
    return await list_control(body.epsg, user, conn)


@router.delete("/control/{cid}", summary="Remove a ground control point (registrars)")
async def delete_control(cid: UUID, user=Depends(need("registrar", write=True)), conn=Depends(get_conn)):
    cur = await conn.execute("DELETE FROM control_points WHERE id = %s AND org_id = %s RETURNING epsg, name", (cid, user["org_id"]))
    row = await cur.fetchone()
    if not row:
        raise Problem(404, "Control point not found.", code="not_found")
    await audit(conn, user, "control.remove", epsg=row["epsg"], name=row["name"])
    return await list_control(row["epsg"], user, conn)


class CorrectionIn(BaseModel):
    epsg: int
    method: Literal["off", "shift", "helmert", "affine"]


@router.put("/settings/corrections", summary="Correct a grid's plans to ground control from now on (registrars)")
async def put_correction(body: CorrectionIn, user=Depends(need("registrar", write=True)), conn=Depends(get_conn)):
    if body.method != "off":
        await correction_for(conn, user, body.epsg, body.method)       # refuses when there are too few points
    await org_settings(conn, user)
    await conn.execute("UPDATE settings SET corrections = corrections || jsonb_build_object(%s::text, %s::text), updated_at = now() "
                       "WHERE org_id = %s", (str(body.epsg), body.method, user["org_id"]))
    await audit(conn, user, "settings.correction", epsg=body.epsg, method=body.method)
    return await list_control(body.epsg, user, conn)


# ---------- importing a survey drawing ----------
class DxfIn(BaseModel):
    filename: str = Field("", max_length=200)
    content: str = Field(max_length=15_000_000, description="The DXF file's text")


@router.post("/parcels/import/dxf", summary="Read the closed boundaries out of a DXF drawing (nothing is saved)")
async def import_dxf(body: DxfIn, user=Depends(need("officer"))):
    if not has(user, "dxf_import"):
        raise Problem(403, "Your organization's Land Registry plan does not include survey plan (DXF) import (Land Registry Advanced).", code="no_feature")
    import anyio
    from .. import dxf
    out = await anyio.to_thread.run_sync(dxf.read, body.content)
    if not out["shapes"]:
        raise Problem(422, "No closed boundaries were found in this drawing. Parcels must be closed polylines.", code="no_shapes")
    return {"filename": body.filename, **out}
