"""For the other GeoEstate products (LandCheck): what the published registries hold at a place. Only registries that
offer a public lookup are searched, and only what that lookup shows leaves (holders only where the registry shows
them). Called service to service with the platform key (PLATFORM_KEY, the same in both), never from a browser."""
import hmac
import time

from fastapi import APIRouter, Depends, Header, Query

from ..config import settings
from ..db import get_conn
from ..errors import Problem
from .public import parcel_status

router = APIRouter(prefix="/platform", tags=["platform"])
NEAR_M, MAX_NEAR = 50.0, 5


def platform(x_platform_key: str = Header("", alias="X-Platform-Key")) -> None:
    if not settings.platform_key:
        raise Problem(503, "This Land Registry is not set up to answer other GeoEstate products (PLATFORM_KEY).", code="not_configured")
    if not hmac.compare_digest(x_platform_key.encode(), settings.platform_key.encode()):
        raise Problem(401, "A GeoEstate product's platform key is needed.", code="bad_key")


SQL = ("SELECT p.id, p.pin, p.status, p.area_sqm, p.land_use, p.locality, ST_X(ST_Centroid(p.geom)) AS lon, "
       "  ST_Y(ST_Centroid(p.geom)) AS lat, s.org_name, s.org_slug, s.public_lookup, "
       "  ST_Distance(p.geom::geography, x.g::geography) AS distance_m "
       "FROM parcels p JOIN settings s ON s.org_id = p.org_id AND s.public_lookup <> 'off' AND s.org_slug <> '', "
       "  (SELECT ST_SetSRID(ST_MakePoint(%s, %s), 4326) AS g) x "
       "WHERE p.status = 'active' AND ST_DWithin(p.geom::geography, x.g::geography, %s) ORDER BY distance_m, p.pin LIMIT 20")


@router.get("/title-status", summary="Registered parcels at a point, and near it, in the published registries")
async def title_status(lat: float = Query(ge=-90, le=90), lng: float = Query(ge=-180, le=180), _=Depends(platform), conn=Depends(get_conn)):
    cur = await conn.execute(SQL, (lng, lat, NEAR_M))
    rows = await cur.fetchall()
    cur = await conn.execute("SELECT count(*) AS n FROM settings WHERE public_lookup <> 'off' AND org_slug <> ''")
    published = (await cur.fetchone())["n"]
    at, near = [], []
    for r in rows:
        st = await parcel_status(conn, r, r["org_name"], r["public_lookup"] == "holders")
        st["lookup_url"] = f"{settings.app_url}/lookup/{r['org_slug']}?q={r['pin']}"
        if r["distance_m"] < 0.01:
            at.append(st)
        elif len(near) < MAX_NEAR:
            near.append(st | {"distance_m": round(r["distance_m"], 1)})
    return {"checked_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "registries_searched": published,
            "at": at, "near": near, "near_within_m": NEAR_M}
