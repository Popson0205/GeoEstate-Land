"""The parcel fabric: capturing a parcel (check, then save with its PIN), the register, a parcel's page, retiring one;
and the organization's settings (survey grid, PIN prefix, closure, overlap tolerance)."""
import json
from datetime import date
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


async def org_settings(conn, user: dict) -> dict:
    await conn.execute("INSERT INTO settings (org_id, org_name) VALUES (%s, %s) ON CONFLICT (org_id) DO UPDATE "
                       "SET org_name = EXCLUDED.org_name WHERE settings.org_name <> EXCLUDED.org_name",
                       (user["org_id"], user["org_name"] or ""))
    cur = await conn.execute("SELECT * FROM settings WHERE org_id = %s", (user["org_id"],))
    s = await cur.fetchone()
    return {**s, "grid_name": geodesy.grid_name(s["default_epsg"]), "overlap_tolerance_sqm": float(s["overlap_tolerance_sqm"])}


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
    await org_settings(conn, user)
    await conn.execute("UPDATE settings SET default_epsg = %s, pin_prefix = %s, closure_ratio = %s, overlap_tolerance_sqm = %s, "
                       "updated_at = now() WHERE org_id = %s",
                       (body.default_epsg, body.pin_prefix.upper(), body.closure_ratio, body.overlap_tolerance_sqm, user["org_id"]))
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


class ParcelIn(CaptureIn):
    land_use: str = Field("", max_length=60)
    address: str = Field("", max_length=300)
    locality: str = Field("", max_length=120)
    notes: str = Field("", max_length=4000)
    survey_plan_no: str = Field("", max_length=80)
    surveyor: str = Field("", max_length=160)
    survey_date: date | None = None


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
        t = geodesy.traverse((body.start.easting, body.start.northing),
                             [(geodesy.parse_bearing(l.bearing), l.distance_m) for l in body.legs], s["closure_ratio"])
        closure = {"misclosure_m": round(t.misclosure_m, 3), "misclosure_e": round(t.misclosure_e, 3),
                   "misclosure_n": round(t.misclosure_n, 3), "perimeter_m": round(t.perimeter_m, 3), "ratio": t.ratio,
                   "required_ratio": s["closure_ratio"], "adjusted": t.adjusted}
        if t.ratio is not None and t.ratio < s["closure_ratio"]:
            problems.append(f"The traverse does not close: it misses by {t.misclosure_m:.2f} m, 1 in {t.ratio:,}. "
                            f"This registry needs 1 in {s['closure_ratio']:,} or better. Check the bearings and distances.")
        grid_pts = t.points
        names = [body.start.beacon] + [l.beacon for l in body.legs[:-1]]
        legs = t.legs
    else:
        if len(body.points) < 3:
            raise Problem(422, "A parcel needs at least 3 beacons.", code="validation", fields={"points": ["too few"]})
        grid_pts = [(p.x, p.y) for p in body.points]
        names = [p.beacon for p in body.points]
    lonlat = geodesy.to_wgs84(grid_pts, epsg)
    b = geodesy.boundary(lonlat)
    problems += b.problems
    overlaps = []
    if not b.problems:
        cur = await conn.execute(
            "SELECT id, pin, ST_Area(ST_Intersection(geom, g)::geography) AS overlap FROM parcels, "
            "  (SELECT ST_GeomFromText(%s, 4326) AS g) x "
            "WHERE org_id = %s AND status = 'active' AND ST_Intersects(geom, g) AND (%s::uuid IS NULL OR id <> %s::uuid) "
            "ORDER BY overlap DESC", (geodesy.wkt(b.ring), user["org_id"], ignore, ignore))
        for r in await cur.fetchall():
            if r["overlap"] < 0.01:
                continue                                   # sharing a boundary is not overlapping
            overlaps.append({"id": str(r["id"]), "pin": r["pin"], "overlap_sqm": round(r["overlap"], 2)})
        big = [o for o in overlaps if o["overlap_sqm"] > s["overlap_tolerance_sqm"]]
        if big:
            problems.append("It overlaps " + ", ".join(f"{o['pin']} by {o['overlap_sqm']:,} m²" for o in big)
                            + ". A parcel cannot overlap another active parcel.")
        elif overlaps:
            warnings.append("Slivers within the tolerance touch " + ", ".join(o["pin"] for o in overlaps) + ": kept as they are.")
    beacons = [{"seq": i + 1, "name": (names[i] if i < len(names) else "") or f"B{i + 1}",
                "easting": round(grid_pts[i][0], 3) if epsg != 4326 else None, "northing": round(grid_pts[i][1], 3) if epsg != 4326 else None,
                "lon": round(lonlat[i][0], 9), "lat": round(lonlat[i][1], 9)} for i in range(len(grid_pts))]
    return {"ok": not problems, "problems": problems, "warnings": warnings, "method": body.method, "epsg": epsg,
            "grid_name": geodesy.grid_name(epsg), "closure": closure, "legs": legs, "area_sqm": round(b.area_sqm, 2),
            "area_ha": round(b.area_sqm / 10000, 4), "perimeter_m": round(b.perimeter_m, 2),
            "geometry": {"type": "Polygon", "coordinates": [[list(p) for p in b.ring]]}, "beacons": beacons, "overlaps": overlaps}


@router.post("/parcels/check", summary="Check a boundary without saving it")
async def check_parcel(body: CaptureIn, user=Depends(need("officer")), conn=Depends(get_conn)):
    return await check(conn, user, body)


PARCEL_SQL = ("SELECT p.id, p.pin, p.status, p.area_sqm, p.perimeter_m, p.land_use, p.address, p.locality, p.notes, p.method, "
              "  p.source_epsg, p.closure_error_m, p.closure_ratio, p.survey_plan_no, p.surveyor, p.survey_date, p.retired_reason, "
              "  p.created_by_name, p.created_at, p.updated_at, ST_X(ST_Centroid(p.geom)) AS lon, ST_Y(ST_Centroid(p.geom)) AS lat "
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
    cur = await conn.execute("UPDATE settings SET pin_next = pin_next + 1 WHERE org_id = %s RETURNING pin_prefix, pin_next - 1 AS n",
                             (user["org_id"],))
    s = await cur.fetchone()
    pin = f"{s['pin_prefix']}-{s['n']:06d}"
    ring = [tuple(p) for p in c["geometry"]["coordinates"][0]]
    cur = await conn.execute(
        "INSERT INTO parcels (org_id, pin, geom, area_sqm, perimeter_m, land_use, address, locality, notes, method, source_epsg, "
        "  closure_error_m, closure_ratio, survey_plan_no, surveyor, survey_date, created_by, created_by_name) "
        "VALUES (%s, %s, ST_GeomFromText(%s, 4326), %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING id",
        (user["org_id"], pin, geodesy.wkt(ring), c["area_sqm"], c["perimeter_m"], body.land_use.strip(), body.address.strip(),
         body.locality.strip(), body.notes.strip(), c["method"], c["epsg"], (c["closure"] or {}).get("misclosure_m"),
         (c["closure"] or {}).get("ratio"), body.survey_plan_no.strip(), body.surveyor.strip(), body.survey_date, user["id"], user["name"]))
    pid = (await cur.fetchone())["id"]
    for b in c["beacons"]:
        await conn.execute("INSERT INTO beacons (parcel_id, seq, name, easting, northing, lon, lat) VALUES (%s, %s, %s, %s, %s, %s, %s)",
                           (pid, b["seq"], b["name"], b["easting"], b["northing"], b["lon"], b["lat"]))
    await audit(conn, user, "parcel.create", "parcel", pid, pin=pin, area_sqm=c["area_sqm"], method=c["method"])
    return await get_parcel(pid, user, conn)


@router.get("/parcels", summary="The register: search by PIN, address, locality, survey plan or surveyor")
async def list_parcels(q: str | None = None, status: str | None = Query("active", pattern="^(active|retired|all)$"),
                       limit: int = Query(200, ge=1, le=1000), user=Depends(need()), conn=Depends(get_conn)):
    where, params = ["p.org_id = %s"], [user["org_id"]]
    if status != "all":
        where.append("p.status = %s"); params.append(status)
    if q:
        where.append("(p.pin ILIKE %s OR p.address ILIKE %s OR p.locality ILIKE %s OR p.survey_plan_no ILIKE %s OR p.surveyor ILIKE %s)")
        params += [f"%{q.strip()}%"] * 5
    cur = await conn.execute(PARCEL_SQL + f"WHERE {' AND '.join(where)} ORDER BY p.created_at DESC LIMIT %s", (*params, limit))
    return await cur.fetchall()


@router.get("/parcels.geojson", summary="The fabric for the map, within a box (west,south,east,north)")
async def fabric(bbox: str | None = None, user=Depends(need()), conn=Depends(get_conn)):
    where, params = ["org_id = %s", "status = 'active'"], [user["org_id"]]
    if bbox:
        try:
            w, s_, e, n = (float(x) for x in bbox.split(","))
        except ValueError:
            raise Problem(422, "bbox is west,south,east,north.", code="validation")
        where.append("geom && ST_MakeEnvelope(%s, %s, %s, %s, 4326)"); params += [w, s_, e, n]
    cur = await conn.execute(f"SELECT id, pin, area_sqm, land_use, ST_AsGeoJSON(geom, 8) AS g FROM parcels WHERE {' AND '.join(where)} "
                             "LIMIT 20000", params)
    feats = [{"type": "Feature", "id": str(r["id"]), "geometry": json.loads(r["g"]),
              "properties": {"id": str(r["id"]), "pin": r["pin"], "area_sqm": float(r["area_sqm"]), "land_use": r["land_use"]}}
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
    if p["status"] == "retired":
        raise Problem(409, f"{p['pin']} is already retired.", code="retired")
    await conn.execute("UPDATE parcels SET status = 'retired', retired_reason = %s, updated_at = now() WHERE id = %s",
                       (body.reason.strip(), parcel_id))
    await audit(conn, user, "parcel.retire", "parcel", parcel_id, pin=p["pin"], reason=body.reason.strip())
    return await get_parcel(parcel_id, user, conn)


@router.get("/home", summary="The register at a glance")
async def home(user=Depends(need()), conn=Depends(get_conn)):
    cur = await conn.execute("SELECT count(*) FILTER (WHERE status = 'active') AS active, count(*) FILTER (WHERE status = 'retired') AS retired, "
                             "COALESCE(sum(area_sqm) FILTER (WHERE status = 'active'), 0) AS area_sqm, "
                             "count(*) FILTER (WHERE created_at > date_trunc('month', now())) AS this_month FROM parcels WHERE org_id = %s",
                             (user["org_id"],))
    counts = await cur.fetchone()
    cur = await conn.execute(PARCEL_SQL + "WHERE p.org_id = %s ORDER BY p.created_at DESC LIMIT 8", (user["org_id"],))
    return {**counts, "area_sqm": float(counts["area_sqm"]), "latest": await cur.fetchall(),
            "limit": (user["limits"] or {}).get("parcels"), "settings": await org_settings(conn, user)}


@router.get("/audit", summary="What happened in the register, newest first (registrars)")
async def audit_log(before: int | None = None, user=Depends(need("registrar")), conn=Depends(get_conn)):
    cur = await conn.execute("SELECT id, at, actor_name, action, target_type, target_id, details FROM audit_log WHERE org_id = %s "
                             "AND (%s::bigint IS NULL OR id < %s) ORDER BY id DESC LIMIT 100", (user["org_id"], before, before))
    return await cur.fetchall()
