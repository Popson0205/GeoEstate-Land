"""Enumeration: bringing the parcels a field team mapped with a Geohub area form into the register.

A registrar connects a Geohub form (a "source") and says which of its questions hold the plot number, the address,
locality, land use and notes, and the occupant's name, phone and ID number. Officers then see the form's approved
features, check them like any survey, and register them: each becomes a parcel (through the organization's workflow),
remembered against its Geohub feature so it is never brought in twice. The occupant, as enumerated, is kept as a claim,
and can be lodged as a grant of title (customary right of occupancy, unless the source says otherwise) for a registrar
to decide: systematic first registration.

Geohub is read as the signed-in person (GeoEstate ID), so only forms they could open in Geohub are offered."""
import json
import re
from uuid import UUID

import anyio
from fastapi import APIRouter, Depends, Query, Request
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field

from .. import identity
from ..audit import audit
from ..db import get_conn
from ..errors import Problem
from ..geoestate_id import GeoEstateIDError
from ..identity import need
from .parcels import CaptureIn, check, insert_parcel, org_settings, steps
from .register import LodgeIn, lodge

router = APIRouter(prefix="/enumeration", tags=["enumeration"])
MAP_KEYS = ("plot_no", "address", "locality", "land_use", "notes", "claimant_name", "claimant_phone", "claimant_id_no", "claimant_kind",
            "claimant_rc", "acquired", "acquired_year", "documents", "dispute", "dispute_note")
# Forms made in Geohub from its ready-made templates: which question holds what is known, so nothing needs mapping.
TEMPLATE_MAP = {"land_enumeration": {
    "plot_no": "plot_no", "address": "address", "locality": "locality", "land_use": "land_use", "notes": "remarks",
    "claimant_name": "occupant_name", "claimant_phone": "occupant_phone", "claimant_id_no": "occupant_nin", "claimant_kind": "occupant_kind",
    "claimant_rc": "occupant_rc", "acquired": "acquired", "acquired_year": "acquired_year", "documents": "documents", "dispute": "dispute",
    "dispute_note": "dispute_note"}}
KIND_OF = {"person": "person", "company": "company", "community or family": "community", "community": "community", "family": "community",
           "government": "government", "trustees": "trustees"}


async def geohub(request: Request, path: str, params: dict | None = None):
    """Geohub's field data, as the signed-in person."""
    try:
        return await anyio.to_thread.run_sync(lambda: identity.client().data(request.state.at, path, params))
    except GeoEstateIDError as e:
        if e.status == 404:
            raise Problem(404, "Geohub does not show you that form any more.", code="not_found")
        raise Problem(502 if e.status >= 500 else e.status, f"Geohub: {e}", code="geohub")


def _plan(user):
    if user["features"] and "parcels" not in user["features"]:
        raise Problem(403, "Your organization's Land Registry plan does not include parcels.", code="no_feature")


# ---------- sources ----------
@router.get("/geohub", summary="The Geohub projects and area forms you can take parcels from")
async def geohub_forms(request: Request, user=Depends(need("officer"))):
    projects = await geohub(request, "projects")
    return [{**p, "forms": [f for f in p["forms"] if f["geometry_type"] == "area"]} for p in projects]


class SourceIn(BaseModel):
    project_id: UUID
    form_id: UUID
    field_map: dict[str, str] = Field(default_factory=dict)
    defaults: dict[str, str] = Field(default_factory=dict)


class SourcePatch(BaseModel):
    field_map: dict[str, str] | None = None
    defaults: dict[str, str] | None = None


def _clean(m: dict[str, str], allowed: tuple) -> dict:
    bad = [k for k in m if k not in allowed]
    if bad:
        raise Problem(422, f"Unknown: {', '.join(bad)}.", code="validation")
    return {k: v.strip() for k, v in m.items() if v and v.strip()}


DEFAULT_KEYS = ("locality", "land_use", "title_kind", "survey_plan_no", "surveyor")
SOURCE_SQL = ("SELECT s.*, (SELECT count(*) FROM enum_imports i WHERE i.source_id = s.id) AS imported, "
              "  (SELECT count(*) FROM enum_imports i WHERE i.source_id = s.id AND i.instrument_id IS NOT NULL) AS claims_lodged "
              "FROM enum_sources s ")


@router.get("/sources", summary="The Geohub forms connected to this registry")
async def sources(user=Depends(need()), conn=Depends(get_conn)):
    cur = await conn.execute(SOURCE_SQL + "WHERE s.org_id = %s ORDER BY s.created_at", (user["org_id"],))
    return await cur.fetchall()


async def _source(conn, user, sid) -> dict:
    cur = await conn.execute(SOURCE_SQL + "WHERE s.id = %s AND s.org_id = %s", (sid, user["org_id"]))
    s = await cur.fetchone()
    if not s:
        raise Problem(404, "Source not found.", code="not_found")
    return s


@router.get("/sources/{sid}", summary="A connected form, and its questions as Geohub has them now")
async def get_source(sid: UUID, request: Request, user=Depends(need()), conn=Depends(get_conn)):
    s = await _source(conn, user, sid)
    try:
        forms = [f for p in await geohub(request, "projects") for f in p["forms"] if f["id"] == str(s["form_id"])]
    except Problem:
        forms = []
    return {**s, "form": forms[0] if forms else None}


@router.post("/sources", status_code=201, summary="Connect a Geohub area form (registrars)")
async def add_source(body: SourceIn, request: Request, user=Depends(need("registrar", write=True)), conn=Depends(get_conn)):
    _plan(user)
    projects = await geohub(request, "projects")
    p = next((x for x in projects if x["id"] == str(body.project_id)), None)
    f = next((x for x in (p or {}).get("forms", []) if x["id"] == str(body.form_id)), None)
    if not f:
        raise Problem(422, "That form is not in the Geohub projects you can open.", code="validation", fields={"form_id": ["not found"]})
    if f["geometry_type"] != "area":
        raise Problem(422, "Parcels come from a form that maps areas (polygons).", code="validation", fields={"form_id": ["not an area form"]})
    asked = {q["id"] for q in f["fields"]}
    known = {k: v for k, v in TEMPLATE_MAP.get(f.get("template") or "", {}).items() if v in asked}   # questions since removed are skipped
    fm = known | _clean(body.field_map, MAP_KEYS)
    unknown = [v for v in fm.values() if v not in {q["id"] for q in f["fields"]}]
    if unknown:
        raise Problem(422, f"The form has no question {unknown[0]}.", code="validation", fields={"field_map": ["unknown question"]})
    await org_settings(conn, user)
    cur = await conn.execute("INSERT INTO enum_sources (org_id, project_id, project_name, form_id, form_name, field_map, defaults, created_by_name) "
                             "VALUES (%s, %s, %s, %s, %s, %s, %s, %s) ON CONFLICT (org_id, form_id) DO NOTHING RETURNING id",
                             (user["org_id"], body.project_id, p["name"], body.form_id, f["name"], Jsonb(fm), Jsonb(_clean(body.defaults, DEFAULT_KEYS)),
                              user["name"]))
    row = await cur.fetchone()
    if not row:
        raise Problem(409, f"{f['name']} is already connected.", code="duplicate")
    await audit(conn, user, "enumeration.connect", "source", row["id"], project=p["name"], form=f["name"])
    return await _source(conn, user, row["id"])


@router.patch("/sources/{sid}", summary="Change which questions mean what, and the defaults (registrars)")
async def patch_source(sid: UUID, body: SourcePatch, user=Depends(need("registrar", write=True)), conn=Depends(get_conn)):
    await _source(conn, user, sid)
    if body.field_map is not None:
        await conn.execute("UPDATE enum_sources SET field_map = %s WHERE id = %s", (Jsonb(_clean(body.field_map, MAP_KEYS)), sid))
    if body.defaults is not None:
        await conn.execute("UPDATE enum_sources SET defaults = %s WHERE id = %s", (Jsonb(_clean(body.defaults, DEFAULT_KEYS)), sid))
    return await _source(conn, user, sid)


@router.delete("/sources/{sid}", status_code=204, summary="Disconnect a form (registrars); parcels already registered stay")
async def delete_source(sid: UUID, user=Depends(need("registrar", write=True)), conn=Depends(get_conn)):
    s = await _source(conn, user, sid)
    if s["imported"]:
        raise Problem(409, f"{s['imported']} parcels came from {s['form_name']}: it stays connected so they keep their link.", code="in_use")
    await conn.execute("DELETE FROM enum_sources WHERE id = %s", (sid,))


# ---------- the features ----------
def mapped(s: dict, props: dict) -> dict:
    """What the feature's answers say, by meaning."""
    def val(key):
        q = s["field_map"].get(key)
        v = props.get(q) if q else None
        if isinstance(v, bool):
            return "yes" if v else ""
        if isinstance(v, float) and v.is_integer():
            v = int(v)
        if isinstance(v, list):
            v = ", ".join(str(x) for x in v)
        return str(v).strip() if v not in (None, "") else ""
    m = {k: val(k) for k in MAP_KEYS}
    m["dispute"] = "yes" if m["dispute"].lower() in ("yes", "true", "1", "y") else ""
    # what the field team learnt about how the land is held, for the parcel's notes
    held = []
    if m["acquired"]:
        held.append(f"Acquired by {m['acquired'].lower()}" + (f" in {m['acquired_year']}" if m["acquired_year"] else "") + ".")
    if m["documents"]:
        held.append(f"Documents held: {m['documents']}.")
    if m["dispute"]:
        held.append("Disputed" + (f": {m['dispute_note']}" if m["dispute_note"] else "") + ".")
    m["tenure"] = " ".join(held)
    for k in ("locality", "land_use"):
        m[k] = m[k] or s["defaults"].get(k, "")
    m["land_use"] = m["land_use"].lower()
    plot = m["plot_no"]
    if plot and re.fullmatch(r"\d+[A-Za-z]?", plot):
        plot = f"Plot {plot}"
    m["full_address"] = ", ".join(x for x in (plot, m["address"]) if x)
    return m


def plan_of(props: dict) -> dict | None:
    """Geohub's plan_json (lib/surveyPlan.ts in the collector), when it is one Land Registry can use."""
    raw = props.get("plan_json")
    if not isinstance(raw, str):
        return None
    try:
        p = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(p, dict) or p.get("v") != 1 or not isinstance(p.get("grid"), int):
        return None
    if p.get("method") == "traverse" and isinstance(p.get("start"), list) and isinstance(p.get("legs"), list) and len(p["legs"]) >= 3:
        return p
    if p.get("method") == "coordinates" and isinstance(p.get("points"), list) and len(p["points"]) >= 3:
        return p
    return None


def ring(geometry: dict) -> list[list[float]]:
    g = geometry
    if g["type"] == "MultiPolygon":
        if len(g["coordinates"]) != 1:
            raise Problem(422, f"It is {len(g['coordinates'])} separate areas, not one parcel.", code="multipart")
        return g["coordinates"][0][0]
    if g["type"] != "Polygon":
        raise Problem(422, "It is not an area.", code="not_area")
    if len(g["coordinates"]) > 1:
        raise Problem(422, "It has a hole in it: a parcel is one boundary.", code="hole")
    return g["coordinates"][0]


def capture(geometry: dict, props: dict | None = None) -> CaptureIn:
    """The survey to check: the plot's survey plan when the field team plotted it from one in Geohub (recomputed here
    with the registry's own engine, closure rule and ground control), otherwise the boundary as drawn."""
    plan = plan_of(props or {})
    if plan:
        if plan["method"] == "traverse":
            e, n = plan["start"]
            return CaptureIn(method="traverse", epsg=plan["grid"], start={"beacon": "", "easting": e, "northing": n},
                             legs=[{"beacon": "", "bearing": f"{int(d)}°{int(m)}'{s}\"", "distance_m": L} for d, m, s, L in plan["legs"]])
        return CaptureIn(method="coordinates", epsg=plan["grid"], points=[{"x": x, "y": y} for x, y in plan["points"]])
    pts = ring(geometry)
    if len(pts) > 1 and pts[0] == pts[-1]:
        pts = pts[:-1]
    return CaptureIn(method="coordinates", epsg=4326, points=[{"x": x, "y": y} for x, y in pts])


async def _imports(conn, user, ids: list[str]) -> dict:
    cur = await conn.execute("SELECT i.feature_id, i.feature_version, i.parcel_id, p.pin, p.status, i.claim, n.number AS claim_number, "
                             "  n.status AS claim_status FROM enum_imports i JOIN parcels p ON p.id = i.parcel_id "
                             "LEFT JOIN instruments n ON n.id = i.instrument_id WHERE i.org_id = %s AND i.feature_id = ANY(%s)",
                             (user["org_id"], [UUID(x) for x in ids]))
    return {str(r["feature_id"]): r for r in await cur.fetchall()}


@router.get("/sources/{sid}/features", summary="The form's features from Geohub, and which are in the register")
async def features(sid: UUID, request: Request, status: str = Query("approved", pattern="^(approved|submitted|all)$"), after: int = 0,
                   user=Depends(need()), conn=Depends(get_conn)):
    s = await _source(conn, user, sid)
    params = {"shape": "area", "after": after, "limit": 300} | ({} if status == "all" else {"status": status})
    page = await geohub(request, f"forms/{s['form_id']}/features", params)
    done = await _imports(conn, user, [f["id"] for f in page["features"]])
    out = []
    for f in page["features"]:
        imp = done.get(f["id"])
        out.append({"id": f["id"], "seq": f["seq"], "status": f["status"], "version": f["version"], "geometry": f["geometry"],
                    "created_by_name": f["created_by_name"], "created_at": f["created_at"], "reviewed_by_name": f["reviewed_by_name"],
                    "mapped": mapped(s, f["properties"]), "properties": f["properties"],
                    "located_by": "plan" if plan_of(f["properties"]) else ("gps" if f["properties"].get("gps_src") == "gps" else "map"),
                    "imported": {k: imp[k] for k in ("parcel_id", "pin", "status", "claim_number", "claim_status")} | {"has_claim": bool(imp["claim"])}
                    if imp else None, "changed_since": bool(imp and imp["feature_version"] != f["version"])})
    return {"features": out, "next": page["next"]}


class Pick(BaseModel):
    feature_ids: list[UUID] = Field(min_length=1, max_length=300)
    lodge_claims: bool = False


@router.post("/sources/{sid}/check", summary="Check features as surveys, without registering them")
async def check_features(sid: UUID, body: Pick, request: Request, user=Depends(need("officer")), conn=Depends(get_conn)):
    s = await _source(conn, user, sid)
    out = []
    for fid in body.feature_ids:
        try:
            f = await geohub(request, f"features/{fid}")
            c = await check(conn, user, capture(f["geometry"], f["properties"]))
            out.append({"id": str(fid), "ok": c["ok"], "problems": c["problems"], "warnings": c["warnings"], "area_sqm": c["area_sqm"],
                        "closure": c["closure"], "correction": c["correction"], "method": c["method"],
                        "geometry": c["geometry"], "mapped": mapped(s, f["properties"])})
        except Problem as e:
            out.append({"id": str(fid), "ok": False, "problems": [e.detail], "warnings": []})
    return out


def _claim(m: dict) -> dict | None:
    if not m["claimant_name"]:
        return None
    kind = KIND_OF.get(m["claimant_kind"].lower(), "person")
    id_no, id_type = (m["claimant_rc"], "RC") if kind == "company" and m["claimant_rc"] else (m["claimant_id_no"], "NIN" if m["claimant_id_no"] else "")
    return {"name": m["claimant_name"], "kind": kind, "phone": m["claimant_phone"], "id_no": id_no, "id_type": id_type if id_no else "",
            "dispute": m["dispute_note"] or ("reported" if m["dispute"] else "") if m["dispute"] else ""}


async def _lodge_claim(conn, user, s, parcel_id, claim) -> dict:
    body = LodgeIn(kind="grant", title_kind=s["defaults"].get("title_kind") or "customary_ro",
                   holders=[{"party": {"kind": claim.get("kind", "person"), "name": claim["name"], "phone": claim["phone"], "id_type": claim["id_type"],
                                       "id_no": claim["id_no"]}, "share": "1/1"}],
                   details=f"First registration from enumeration ({s['project_name']} / {s['form_name']}).")
    return await lodge(parcel_id, body, user, conn)


@router.post("/sources/{sid}/import", summary="Register features as parcels (each is checked first)")
async def import_features(sid: UUID, body: Pick, request: Request, user=Depends(need("officer", write=True)), conn=Depends(get_conn)):
    _plan(user)
    s = await _source(conn, user, sid)
    st = await org_settings(conn, user)
    pending = steps(st, "parcel") >= 1 and user["role"] != "registrar"
    done = await _imports(conn, user, [str(x) for x in body.feature_ids])
    results = []
    for fid in body.feature_ids:
        if str(fid) in done:
            results.append({"id": str(fid), "ok": False, "problems": [f"Already registered as {done[str(fid)]['pin']}."], "pin": done[str(fid)]["pin"]})
            continue
        try:
            async with conn.transaction():                    # one feature's failure leaves the others
                f = await geohub(request, f"features/{fid}")
                if f["status"] != "approved":
                    raise Problem(422, f"It is {f['status']} in Geohub: only approved features are registered.", code="not_approved")
                c = await check(conn, user, capture(f["geometry"], f["properties"]))
                if not c["ok"]:
                    raise Problem(422, " ".join(c["problems"]), code="not_registrable")
                m = mapped(s, f["properties"])
                when = (f.get("created_at") or "")[:10]
                note = f"Enumerated in Geohub ({s['project_name']} / {s['form_name']}) by {f['created_by_name'] or 'a field officer'}" \
                       + (f" on {when}" if when else "") + "." + (f"\n{m['tenure']}" if m["tenure"] else "") \
                       + (f"\n{m['notes']}" if m["notes"] else "")
                pid, pin = await insert_parcel(conn, user, c["geometry"]["coordinates"][0], c["area_sqm"], c["perimeter_m"], c["beacons"],
                                               status="pending" if pending else "active", method=c["method"], source_epsg=c["epsg"],
                                               closure_error_m=(c["closure"] or {}).get("misclosure_m"), closure_ratio=(c["closure"] or {}).get("ratio"),
                                               correction=c["correction"],
                                               land_use=m["land_use"][:60], address=m["full_address"][:300], locality=m["locality"][:120], notes=note[:4000],
                                               survey_plan_no=s["defaults"].get("survey_plan_no", ""), surveyor=s["defaults"].get("surveyor", ""))
                claim = _claim(m)
                await conn.execute("INSERT INTO enum_imports (org_id, feature_id, source_id, feature_version, parcel_id, claim, imported_by_name) "
                                   "VALUES (%s, %s, %s, %s, %s, %s, %s)",
                                   (user["org_id"], fid, sid, f["version"], pid, Jsonb(claim) if claim else None, user["name"]))
                await audit(conn, user, "parcel.create", "parcel", pid, pin=pin, area_sqm=c["area_sqm"], method="enumeration",
                            pending=True if pending else None)
                r = {"id": str(fid), "ok": True, "pin": pin, "parcel_id": str(pid), "status": "pending" if pending else "active"}
            if body.lodge_claims and claim and not pending:
                r["claim"] = await _try_claim(conn, user, s, pid, fid, claim)
            results.append(r)
        except Problem as e:
            results.append({"id": str(fid), "ok": False, "problems": e.extra.get("problems") or [e.detail]})
    return results


async def _try_claim(conn, user, s, pid, fid, claim) -> dict:
    if claim.get("dispute"):
        return {"ok": False, "problems": [f"The field team reported a dispute ({claim['dispute']}). Resolve it, then lodge the grant from the parcel."]}
    try:
        async with conn.transaction():
            ins = await _lodge_claim(conn, user, s, pid, claim)
            await conn.execute("UPDATE enum_imports SET instrument_id = %s WHERE org_id = %s AND feature_id = %s", (ins["id"], user["org_id"], fid))
            return {"ok": True, "number": ins["number"], "status": ins["status"]}
    except Problem as e:
        return {"ok": False, "problems": e.extra.get("problems") or [e.detail]}


@router.post("/sources/{sid}/claims", summary="Lodge the enumerated claims as grants, for parcels registered and not yet titled")
async def lodge_claims(sid: UUID, user=Depends(need("officer", write=True)), conn=Depends(get_conn)):
    s = await _source(conn, user, sid)
    cur = await conn.execute("SELECT i.feature_id, i.parcel_id, i.claim, p.pin FROM enum_imports i JOIN parcels p ON p.id = i.parcel_id "
                             "WHERE i.source_id = %s AND i.claim IS NOT NULL AND i.instrument_id IS NULL AND p.status = 'active' "
                             "AND NOT EXISTS (SELECT 1 FROM titles t WHERE t.parcel_id = p.id AND t.status = 'current') ORDER BY p.pin", (sid,))
    out = []
    for r in await cur.fetchall():
        out.append({"pin": r["pin"], **await _try_claim(conn, user, s, r["parcel_id"], r["feature_id"], r["claim"])})
    return out
