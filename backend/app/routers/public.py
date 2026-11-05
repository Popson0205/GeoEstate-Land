"""The public lookup: anyone can check a parcel by its PIN or title number, without signing in, when the registry
turns it on (Settings). "basic" shows the parcel and whether it is titled, encumbered or has dealings waiting; "holders"
also names the proprietors. Nothing else leaves: no ID numbers, amounts, contacts or documents."""
import time
from collections import defaultdict, deque

from fastapi import APIRouter, Depends, Query, Request

from ..db import get_conn
from ..errors import Problem
from .register import TITLE_KINDS

router = APIRouter(tags=["public lookup"])
WINDOW, MAX_LOOKUPS = 60.0, 30
_seen: dict[str, deque] = defaultdict(deque)


def limit(request: Request) -> None:
    """At most 30 lookups a minute from one address, so the register cannot be scraped."""
    ip = (request.headers.get("x-forwarded-for", "").split(",")[0].strip() or (request.client.host if request.client else "?"))
    now, q = time.monotonic(), _seen[ip]
    while q and now - q[0] > WINDOW:
        q.popleft()
    if len(q) >= MAX_LOOKUPS:
        raise Problem(429, "Too many lookups from your network. Wait a minute and try again.", code="rate_limited",
                      headers={"Retry-After": str(int(WINDOW - (now - q[0])) + 1)})
    q.append(now)
    if len(_seen) > 50000:
        _seen.clear()


async def _registry(conn, slug: str) -> dict:
    cur = await conn.execute("SELECT org_id, org_name, public_lookup FROM settings WHERE org_slug = %s AND org_slug <> '' "
                             "AND public_lookup <> 'off'", (slug,))
    s = await cur.fetchone()
    if not s:
        raise Problem(404, "This registry does not offer a public lookup.", code="not_found")
    return s


@router.get("/public/{slug}", summary="The registry behind a public lookup")
async def registry(slug: str, conn=Depends(get_conn)):
    s = await _registry(conn, slug)
    return {"name": s["org_name"], "shows_holders": s["public_lookup"] == "holders"}


@router.get("/public/{slug}/lookup", summary="Look up a parcel by PIN or title number")
async def lookup(slug: str, request: Request, q: str = Query(min_length=3, max_length=60), conn=Depends(get_conn)):
    limit(request)
    s = await _registry(conn, slug)
    q = q.strip().upper()
    cur = await conn.execute(
        "SELECT p.id, p.pin, p.status, p.area_sqm, p.land_use, p.locality, ST_X(ST_Centroid(p.geom)) AS lon, ST_Y(ST_Centroid(p.geom)) AS lat "
        "FROM parcels p WHERE p.org_id = %s AND (upper(p.pin) = %s OR EXISTS "
        "  (SELECT 1 FROM titles t WHERE t.parcel_id = p.id AND upper(t.title_no) = %s))", (s["org_id"], q, q))
    p = await cur.fetchone()
    if not p:
        raise Problem(404, f"No parcel with PIN or title number {q} in {s['org_name']}'s register.", code="not_found")
    cur = await conn.execute("SELECT id, title_no, kind, starts_on, ends_on FROM titles WHERE parcel_id = %s AND status = 'current'", (p["id"],))
    t = await cur.fetchone()
    out = {"registry": s["org_name"], "pin": p["pin"], "status": p["status"], "area_sqm": float(p["area_sqm"]), "land_use": p["land_use"],
           "locality": p["locality"], "lon": round(p["lon"], 5), "lat": round(p["lat"], 5), "title": None, "encumbrances": [],
           "dealings_pending": 0, "holders": None, "checked_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    if t:
        out["title"] = {"title_no": t["title_no"], "kind": TITLE_KINDS.get(t["kind"], t["kind"]),
                        "starts_on": t["starts_on"], "ends_on": t["ends_on"]}
        cur = await conn.execute("SELECT kind, count(*) AS n FROM encumbrances WHERE title_id = %s AND to_instrument IS NULL GROUP BY kind "
                                 "ORDER BY kind", (t["id"],))
        out["encumbrances"] = [{"kind": r["kind"], "count": r["n"]} for r in await cur.fetchall()]
        if s["public_lookup"] == "holders":
            cur = await conn.execute("SELECT pa.name, h.share FROM holdings h JOIN parties pa ON pa.id = h.party_id "
                                     "WHERE h.title_id = %s AND h.to_instrument IS NULL ORDER BY h.id", (t["id"],))
            out["holders"] = await cur.fetchall()
    cur = await conn.execute("SELECT count(*) AS n FROM instruments WHERE parcel_id = %s AND status = 'lodged'", (p["id"],))
    out["dealings_pending"] = (await cur.fetchone())["n"]
    return out
