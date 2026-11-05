"""Titles and land records: the register of each parcel, built from instruments.

An officer lodges an instrument against a parcel (a grant of title, a transfer, a mortgage, a caveat, a lease, a
discharge or a revocation); a registrar registers it, which changes the register, or rejects it with a reason. Each
is checked twice: when lodged, and again when registered, since the register may have moved on in between.

  grant       the parcel's first title (statutory or customary right of occupancy, lease, freehold, allocation),
              with its proprietors and their shares
  transfer    new proprietors in place of the old (an assignment); a caveat stops it, a mortgage goes along with it
  mortgage    a charge in favour of a lender, until discharged
  caveat      a warning that someone claims an interest, until discharged (withdrawn or vacated); stops transfers
  lease       a lease out of the title, until discharged (surrendered or expired)
  discharge   ends one mortgage, caveat or lease
  revocation  ends the title (and everything on it); the parcel can then be granted again
"""
from datetime import date
from fractions import Fraction
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field, field_validator

from shapely.geometry import shape

from .. import fabric, geodesy
from ..audit import audit
from ..db import get_conn
from ..errors import Problem
from ..identity import need
from .parcels import insert_parcel, org_settings, steps

router = APIRouter(tags=["titles and land records"])

KINDS = ("grant", "transfer", "mortgage", "caveat", "lease", "discharge", "revocation", "subdivision", "amalgamation")
FABRIC = ("subdivision", "amalgamation")
KIND_NAME = {"grant": "Grant of title", "transfer": "Transfer", "mortgage": "Mortgage", "caveat": "Caveat", "lease": "Lease",
             "discharge": "Discharge", "revocation": "Revocation", "subdivision": "Subdivision", "amalgamation": "Amalgamation"}
TITLE_KINDS = {"statutory_ro": "Statutory right of occupancy (C of O)", "customary_ro": "Customary right of occupancy",
               "lease": "Leasehold", "freehold": "Freehold", "allocation": "Allocation (letter of allocation)"}
PARTY_KINDS = ("person", "company", "government", "community", "trustees")


# ---------- what an instrument carries ----------
class PartyIn(BaseModel):
    """An existing party by id, or a new one by name (and ideally an ID number: NIN, CAC RC…)."""
    id: UUID | None = None
    kind: Literal["person", "company", "government", "community", "trustees"] = "person"
    name: str = Field("", max_length=200)
    id_type: str = Field("", max_length=30)
    id_no: str = Field("", max_length=60)
    phone: str = Field("", max_length=40)
    email: str = Field("", max_length=200, pattern=r"^$|^[^@\s]+@[^@\s]+\.[^@\s]+$")
    address: str = Field("", max_length=300)


class HolderIn(BaseModel):
    party: PartyIn
    share: str = Field("1/1", pattern=r"^\s*\d{1,6}\s*/\s*\d{1,6}\s*$", description="A fraction, e.g. 1/2")


class LodgeIn(BaseModel):
    kind: Literal["grant", "transfer", "mortgage", "caveat", "lease", "discharge", "revocation", "subdivision", "amalgamation"]
    instrument_date: date | None = None
    reference: str = Field("", max_length=120, description="Consent, gazette or court order number")
    consideration_ngn: float | None = Field(None, ge=0, le=1e14)
    details: str = Field("", max_length=4000)
    # grant
    title_kind: Literal["statutory_ro", "customary_ro", "lease", "freehold", "allocation"] | None = None
    title_no: str = Field("", max_length=60, description="Leave empty to number it from the registry's series")
    purpose: str = Field("", max_length=60)
    term_years: int | None = Field(None, ge=1, le=999)
    starts_on: date | None = None
    ground_rent_ngn: float | None = Field(None, ge=0, le=1e12)
    # grant, transfer
    holders: list[HolderIn] = Field(default_factory=list, max_length=50)
    # mortgage, caveat, lease
    party: PartyIn | None = None
    amount_ngn: float | None = Field(None, ge=0, le=1e14)
    # discharge
    encumbrance_id: UUID | None = None
    # subdivision: the cut line, in longitude/latitude (drawn on the map) or on a survey grid
    cut: list[tuple[float, float]] = Field(default_factory=list, max_length=200)
    cut_epsg: int | None = Field(None, description="The grid the cut line's points are on; longitude/latitude when left out")
    # amalgamation: the neighbours merged with this parcel
    parcels: list[UUID] = Field(default_factory=list, max_length=50)
    register_now: bool = Field(False, description="Registrars: lodge and register at once")

    @field_validator("title_no")
    @classmethod
    def _strip(cls, v: str) -> str:
        return v.strip()


def _share(s: str) -> Fraction:
    a, b = (int(x) for x in s.replace(" ", "").split("/"))
    if b == 0 or a == 0 or a > b:
        raise Problem(422, f"\"{s}\" is not a share: write a fraction such as 1/2.", code="validation", fields={"holders": ["bad share"]})
    return Fraction(a, b)


async def _party_name(conn, user, p: PartyIn) -> dict:
    """The party as the instrument records it: an existing one (checked) or a new one (to be created on registration)."""
    if p.id:
        cur = await conn.execute("SELECT id, kind, name, id_type, id_no FROM parties WHERE id = %s AND org_id = %s", (p.id, user["org_id"]))
        row = await cur.fetchone()
        if not row:
            raise Problem(422, "That party is not in this registry.", code="validation", fields={"party": ["not found"]})
        return {"id": str(row["id"]), "kind": row["kind"], "name": row["name"], "id_type": row["id_type"], "id_no": row["id_no"]}
    if len(p.name.strip()) < 2:
        raise Problem(422, "Give each party's full name.", code="validation", fields={"party": ["name missing"]})
    d = p.model_dump(exclude={"id"})
    return {k: (v.strip() if isinstance(v, str) else v) for k, v in d.items()}


async def _make_party(conn, user, p: dict) -> UUID:
    if p.get("id"):
        return UUID(p["id"])
    if p.get("id_no"):
        cur = await conn.execute("SELECT id FROM parties WHERE org_id = %s AND id_type = %s AND id_no = %s",
                                 (user["org_id"], p["id_type"], p["id_no"]))
        row = await cur.fetchone()
        if row:
            return row["id"]
    cur = await conn.execute("INSERT INTO parties (org_id, kind, name, id_type, id_no, phone, email, address) "
                             "VALUES (%s, %s, %s, %s, %s, %s, %s, %s) RETURNING id",
                             (user["org_id"], p["kind"], p["name"], p["id_type"], p["id_no"], p["phone"], p["email"], p["address"]))
    return (await cur.fetchone())["id"]


# ---------- the register of a parcel ----------
async def _parcel(conn, user, parcel_id) -> dict:
    cur = await conn.execute("SELECT id, pin, status, area_sqm, land_use, locality, address FROM parcels WHERE id = %s AND org_id = %s",
                             (parcel_id, user["org_id"]))
    p = await cur.fetchone()
    if not p:
        raise Problem(404, "Parcel not found.", code="not_found")
    return p


async def current(conn, parcel_id) -> dict:
    """The parcel's register today: its title, proprietors and encumbrances."""
    cur = await conn.execute("SELECT t.*, i.number AS granted_by_number FROM titles t JOIN instruments i ON i.id = t.granted_by "
                             "WHERE t.parcel_id = %s AND t.status = 'current'", (parcel_id,))
    t = await cur.fetchone()
    if not t:
        return {"title": None, "holders": [], "encumbrances": []}
    t["kind_name"] = TITLE_KINDS.get(t["kind"], t["kind"])
    cur = await conn.execute("SELECT h.share, p.id, p.kind, p.name, p.id_type, p.id_no, i.number AS since_number, i.decided_at AS since "
                             "FROM holdings h JOIN parties p ON p.id = h.party_id JOIN instruments i ON i.id = h.from_instrument "
                             "WHERE h.title_id = %s AND h.to_instrument IS NULL ORDER BY h.id", (t["id"],))
    holders = await cur.fetchall()
    cur = await conn.execute("SELECT e.id, e.kind, e.amount_ngn, e.term_years, e.details, p.id AS party_id, p.name AS party_name, "
                             "  i.number AS instrument_number, i.decided_at AS since "
                             "FROM encumbrances e LEFT JOIN parties p ON p.id = e.party_id JOIN instruments i ON i.id = e.from_instrument "
                             "WHERE e.title_id = %s AND e.to_instrument IS NULL ORDER BY i.decided_at", (t["id"],))
    return {"title": t, "holders": holders, "encumbrances": await cur.fetchall()}


INSTRUMENT_SQL = ("SELECT i.id, i.number, i.parcel_id, p.pin, i.kind, i.status, i.data, i.instrument_date, i.reference, i.consideration_ngn, "
                  "  i.lodged_by_name, i.lodged_at, i.decided_by_name, i.decided_at, i.decision_note, i.lodged_by "
                  "FROM instruments i JOIN parcels p ON p.id = i.parcel_id ")


def _out(i: dict) -> dict:
    i = dict(i)
    i["kind_name"] = KIND_NAME[i["kind"]]
    i["summary"] = summary(i["kind"], i["data"])
    return i


def summary(kind: str, d: dict) -> str:
    names = lambda hs: ", ".join(f"{h['party']['name']}" + (f" ({h['share']})" if h["share"] != "1/1" else "") for h in hs)  # noqa: E731
    if kind == "grant":
        return f"{TITLE_KINDS.get(d.get('title_kind'), 'Title')} to {names(d.get('holders', []))}"
    if kind == "transfer":
        return f"To {names(d.get('holders', []))}"
    if kind in ("mortgage", "caveat", "lease"):
        who = (d.get("party") or {}).get("name", "")
        extra = f" for ₦{d['amount_ngn']:,.2f}" if d.get("amount_ngn") else ""
        return {"mortgage": f"In favour of {who}{extra}", "caveat": f"By {who}", "lease": f"To {who}" + (f" for {d['term_years']} years" if d.get("term_years") else "")}[kind]
    if kind == "discharge":
        return f"Ends {d.get('encumbrance_label', 'an encumbrance')}"
    if kind == "subdivision":
        return f"Into {len(d.get('pieces', []))} parcels: " + ", ".join(f"{p['area_sqm']:,.0f} m²" for p in d.get("pieces", []))
    if kind == "amalgamation":
        return "With " + ", ".join(d.get("pins", [])[1:]) + f" into one parcel of {d.get('area_sqm', 0):,.0f} m²"
    return d.get("details") or "Ends the title"


@router.get("/parcels/{parcel_id}/register", summary="A parcel's register: title, proprietors, encumbrances and instruments")
async def parcel_register(parcel_id: UUID, user=Depends(need()), conn=Depends(get_conn)):
    p = await _parcel(conn, user, parcel_id)
    reg = await current(conn, parcel_id)
    cur = await conn.execute(INSTRUMENT_SQL + "WHERE i.parcel_id = %s ORDER BY i.lodged_at DESC", (parcel_id,))
    cur2 = await conn.execute("SELECT t.title_no, t.kind, t.status, t.created_at, e.number AS ended_by_number, e.decided_at AS ended_at "
                              "FROM titles t LEFT JOIN instruments e ON e.id = t.ended_by WHERE t.parcel_id = %s AND t.status <> 'current' "
                              "ORDER BY t.created_at DESC", (parcel_id,))
    return {"parcel": p, **reg, "instruments": [_out(i) for i in await cur.fetchall()], "past_titles": await cur2.fetchall()}


# ---------- checking an instrument against the register ----------
async def assess(conn, user, parcel: dict, kind: str, d: dict, ignore: UUID | None = None) -> tuple[list[str], list[str]]:
    """What stops this instrument being registered now, and what the registrar should know."""
    problems, warnings = [], []
    reg = await current(conn, parcel["id"])
    t = reg["title"]
    if parcel["status"] != "active" and kind != "revocation":
        problems.append(f"{parcel['pin']} is {parcel['status']}.")
    if kind in FABRIC:
        return await assess_fabric(conn, user, parcel, kind, d, ignore, problems, warnings)
    if kind == "grant":
        if t:
            problems.append(f"{parcel['pin']} already has title {t['title_no']}. Revoke it first, or lodge a transfer.")
        if d.get("title_no"):
            cur = await conn.execute("SELECT 1 FROM titles WHERE org_id = %s AND title_no = %s", (user["org_id"], d["title_no"]))
            if await cur.fetchone():
                problems.append(f"Title number {d['title_no']} is already used.")
    elif not t:
        problems.append(f"{parcel['pin']} has no title yet: a grant comes first.")
    if t:
        caveats = [e for e in reg["encumbrances"] if e["kind"] == "caveat"]
        mortgages = [e for e in reg["encumbrances"] if e["kind"] == "mortgage"]
        if kind == "transfer":
            if caveats:
                problems.append("A caveat by " + ", ".join(c["party_name"] or "someone" for c in caveats)
                                + " stops transfers until it is discharged.")
            if mortgages:
                warnings.append("The title is mortgaged to " + ", ".join(m["party_name"] or "a lender" for m in mortgages)
                                + ": the mortgage stays on it after the transfer.")
            old = {h["id"] for h in reg["holders"]}
            new = {h["party"].get("id") for h in d.get("holders", [])}
            if new and None not in new and {str(x) for x in old} == new:
                problems.append("The new proprietors are the same as the present ones.")
        if kind == "discharge":
            e = next((e for e in reg["encumbrances"] if str(e["id"]) == str(d.get("encumbrance_id"))), None)
            if not e:
                problems.append("That mortgage, caveat or lease is not on the title (it may already be discharged).")
    if kind in ("grant", "transfer"):
        hs = d.get("holders", [])
        if not hs:
            problems.append("Name at least one proprietor.")
        else:
            total = sum((_share(h["share"]) for h in hs), Fraction(0))
            if total != 1:
                problems.append(f"The proprietors' shares add up to {total}, not 1.")
    cur = await conn.execute("SELECT number, kind FROM instruments WHERE parcel_id = %s AND status = 'lodged' AND (%s::uuid IS NULL OR id <> %s::uuid) "
                             "ORDER BY lodged_at", (parcel["id"], ignore, ignore))
    pending = await cur.fetchall()
    if pending:
        warnings.append("Also lodged and waiting: " + ", ".join(f"{p['number']} ({KIND_NAME[p['kind']].lower()})" for p in pending) + ".")
    return problems, warnings


def _need_feature(user, kind):
    f = "titles" if kind in ("grant", "revocation") else "parcels" if kind in FABRIC else "transactions"
    if user["features"] and f not in user["features"]:
        what = {"titles": "titles.", "parcels": "changes to the parcel fabric.", "transactions": "dealings in land (transfers, mortgages, caveats, leases)."}
        raise Problem(403, "Your organization's Land Registry plan does not include " + what[f], code="no_feature")


# ---------- lodging, registering, rejecting ----------
@router.post("/parcels/{parcel_id}/instruments", status_code=201, summary="Lodge an instrument against a parcel")
async def lodge(parcel_id: UUID, body: LodgeIn, user=Depends(need("officer", write=True)), conn=Depends(get_conn)):
    _need_feature(user, body.kind)
    await org_settings(conn, user)
    parcel = await _parcel(conn, user, parcel_id)
    k = body.kind
    d: dict = {"details": body.details.strip()}
    if k == "grant":
        if not body.title_kind:
            raise Problem(422, "Choose the kind of title.", code="validation", fields={"title_kind": ["missing"]})
        d |= {"title_kind": body.title_kind, "title_no": body.title_no, "purpose": body.purpose.strip(), "term_years": body.term_years,
              "starts_on": body.starts_on.isoformat() if body.starts_on else None, "ground_rent_ngn": body.ground_rent_ngn}
    if k in ("grant", "transfer"):
        d["holders"] = [{"party": await _party_name(conn, user, h.party), "share": h.share.replace(" ", "")} for h in body.holders]
        ids = [h["party"].get("id") for h in d["holders"] if h["party"].get("id")]
        if len(ids) != len(set(ids)):
            raise Problem(422, "The same party is named twice.", code="validation", fields={"holders": ["duplicate"]})
    if k in ("mortgage", "caveat", "lease"):
        if not body.party:
            who = {"mortgage": "the lender (mortgagee)", "caveat": "who lodges the caveat", "lease": "the lessee"}[k]
            raise Problem(422, f"Name {who}.", code="validation", fields={"party": ["missing"]})
        if k == "mortgage" and not body.amount_ngn:
            raise Problem(422, "Give the amount the mortgage secures.", code="validation", fields={"amount_ngn": ["missing"]})
        if k == "caveat" and len(body.details.strip()) < 5:
            raise Problem(422, "Give the grounds of the caveat: the interest claimed.", code="validation", fields={"details": ["missing"]})
        d |= {"party": await _party_name(conn, user, body.party), "amount_ngn": body.amount_ngn, "term_years": body.term_years}
    if k == "discharge":
        if not body.encumbrance_id:
            raise Problem(422, "Choose what is discharged.", code="validation", fields={"encumbrance_id": ["missing"]})
        cur = await conn.execute("SELECT e.kind, p.name FROM encumbrances e LEFT JOIN parties p ON p.id = e.party_id "
                                 "JOIN titles t ON t.id = e.title_id WHERE e.id = %s AND t.parcel_id = %s", (body.encumbrance_id, parcel_id))
        e = await cur.fetchone()
        d |= {"encumbrance_id": str(body.encumbrance_id),
              "encumbrance_label": f"the {e['kind']}" + (f" of {e['name']}" if e and e["name"] else "") if e else "an encumbrance"}
    if k == "subdivision":
        cut = body.cut
        if body.cut_epsg and body.cut_epsg != 4326:
            if body.cut_epsg not in geodesy.GRIDS:
                raise Problem(422, "Choose one of the survey grids listed.", code="validation", fields={"cut_epsg": ["unknown grid"]})
            cut = geodesy.to_wgs84(cut, body.cut_epsg)
        geom = await parcel_shape(conn, parcel_id)
        d |= {"cut": [[round(x, 9), round(y, 9)] for x, y in cut],
              "pieces": [{"area_sqm": fabric.describe(pc)["area_sqm"]} for pc in fabric.pieces(geom, cut)]}
    if k == "amalgamation":
        ids = [parcel_id] + [x for x in dict.fromkeys(body.parcels) if x != parcel_id]
        if len(ids) < 2:
            raise Problem(422, "Choose the neighbouring parcels to merge with this one.", code="validation", fields={"parcels": ["missing"]})
        cur = await conn.execute("SELECT id, pin FROM parcels WHERE org_id = %s AND id = ANY(%s)", (user["org_id"], ids))
        found = {r["id"]: r["pin"] for r in await cur.fetchall()}
        if len(found) != len(ids):
            raise Problem(422, "One of those parcels is not in this registry.", code="validation", fields={"parcels": ["not found"]})
        merged = fabric.union([await parcel_shape(conn, x) for x in ids])
        d |= {"parcel_ids": [str(x) for x in ids], "pins": [found[x] for x in ids], "area_sqm": fabric.describe(merged)["area_sqm"]}
    if k == "revocation" and len(body.details.strip()) < 5:
        raise Problem(422, "Give the reason for the revocation.", code="validation", fields={"details": ["missing"]})
    problems, warnings = await assess(conn, user, parcel, k, d)
    if problems:
        raise Problem(422, " ".join(problems), code="not_registrable", problems=problems, warnings=warnings)
    if body.register_now and user["role"] != "registrar":
        raise Problem(403, "Only registrars can register an instrument.", code="forbidden")
    need_n = steps(await org_settings(conn, user), k)
    cur = await conn.execute("UPDATE settings SET instrument_next = instrument_next + 1 WHERE org_id = %s RETURNING instrument_next - 1 AS n",
                             (user["org_id"],))
    number = f"INS/{date.today().year}/{(await cur.fetchone())['n']:06d}"
    cur = await conn.execute(
        "INSERT INTO instruments (org_id, number, parcel_id, kind, data, instrument_date, reference, consideration_ngn, lodged_by, lodged_by_name) "
        "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING id",
        (user["org_id"], number, parcel_id, k, Jsonb(d), body.instrument_date, body.reference.strip(), body.consideration_ngn, user["id"], user["name"]))
    iid = (await cur.fetchone())["id"]
    await audit(conn, user, "instrument.lodge", "parcel", parcel_id, pin=parcel["pin"], number=number, kind=k)
    if need_n == 0 or (body.register_now and need_n == 1):
        return await _register(conn, user, iid, "", auto=need_n == 0)
    if body.register_now:
        warnings.append("This organization's workflow has two registrars approve it, neither of them whoever lodged it: it is waiting for them.")
    return {**await _instrument(conn, user, iid), "warnings": warnings}


async def _instrument(conn, user, iid) -> dict:
    cur = await conn.execute(INSTRUMENT_SQL + "WHERE i.id = %s AND i.org_id = %s", (iid, user["org_id"]))
    i = await cur.fetchone()
    if not i:
        raise Problem(404, "Instrument not found.", code="not_found")
    out = _out(i)
    cur = await conn.execute("SELECT by_id, by_name, at, note FROM approvals WHERE target_type = 'instrument' AND target_id = %s ORDER BY at", (iid,))
    out["approvals"] = await cur.fetchall()
    out["steps"] = steps(await org_settings(conn, user), i["kind"])
    return out


@router.get("/instruments", summary="Instruments, the lodged ones waiting first")
async def list_instruments(status: str = Query("lodged", pattern="^(lodged|registered|rejected|withdrawn|all)$"),
                           user=Depends(need()), conn=Depends(get_conn)):
    where = "i.org_id = %s" + ("" if status == "all" else " AND i.status = %s")
    params = (user["org_id"],) if status == "all" else (user["org_id"], status)
    order = "i.lodged_at" if status == "lodged" else "COALESCE(i.decided_at, i.lodged_at) DESC"
    cur = await conn.execute(INSTRUMENT_SQL + f"WHERE {where} ORDER BY {order} LIMIT 300", params)
    return [_out(i) for i in await cur.fetchall()]


@router.get("/instruments/{iid}", summary="An instrument, and whether it can be registered now")
async def get_instrument(iid: UUID, user=Depends(need()), conn=Depends(get_conn)):
    i = await _instrument(conn, user, iid)
    if i["status"] == "lodged":
        parcel = await _parcel(conn, user, i["parcel_id"])
        i["problems"], i["warnings"] = await assess(conn, user, parcel, i["kind"], i["data"], ignore=iid)
    return i


class Decision(BaseModel):
    note: str = Field("", max_length=2000)


async def _register(conn, user, iid, note: str, auto: bool = False) -> dict:
    cur = await conn.execute("SELECT * FROM instruments WHERE id = %s AND org_id = %s FOR UPDATE", (iid, user["org_id"]))
    ins = await cur.fetchone()
    if not ins:
        raise Problem(404, "Instrument not found.", code="not_found")
    if ins["status"] != "lodged":
        raise Problem(409, f"{ins['number']} is already {ins['status']}.", code="decided")
    _need_feature(user, ins["kind"])
    await conn.execute("SELECT 1 FROM parcels WHERE id = %s FOR UPDATE", (ins["parcel_id"],))   # one dealing at a time per parcel
    parcel = await _parcel(conn, user, ins["parcel_id"])
    d, k = ins["data"], ins["kind"]
    problems, _ = await assess(conn, user, parcel, k, d, ignore=iid)
    if problems:
        raise Problem(422, " ".join(problems), code="not_registrable", problems=problems)
    need_n = steps(await org_settings(conn, user), k)
    if not auto:
        if need_n >= 2 and ins["lodged_by"] == user["id"]:
            raise Problem(403, "Whoever lodged it cannot also approve it: this organization's workflow has two other registrars do that.",
                          code="own_lodging")
        cur = await conn.execute("INSERT INTO approvals (target_type, target_id, by_id, by_name, note) VALUES ('instrument', %s, %s, %s, %s) "
                                 "ON CONFLICT DO NOTHING RETURNING id", (iid, user["id"], user["name"], note.strip()))
        if not await cur.fetchone():
            raise Problem(409, f"You have already approved {ins['number']}: it needs another registrar.", code="already_approved")
        cur = await conn.execute("SELECT count(*) AS n FROM approvals WHERE target_type = 'instrument' AND target_id = %s", (iid,))
        if (await cur.fetchone())["n"] < need_n:
            await audit(conn, user, "instrument.approve", "parcel", parcel["id"], pin=parcel["pin"], number=ins["number"], kind=k)
            return await _instrument(conn, user, iid)
    reg = await current(conn, parcel["id"])
    t = reg["title"]
    if k == "grant":
        title_no = d.get("title_no")
        if not title_no:
            cur = await conn.execute("UPDATE settings SET title_next = title_next + 1 WHERE org_id = %s RETURNING title_prefix, title_next - 1 AS n",
                                     (user["org_id"],))
            s = await cur.fetchone()
            title_no = f"{s['title_prefix']}/{s['n']:06d}"
        starts = date.fromisoformat(d["starts_on"]) if d.get("starts_on") else None
        ends = starts.replace(year=starts.year + d["term_years"]) if starts and d.get("term_years") else None
        cur = await conn.execute("INSERT INTO titles (org_id, parcel_id, title_no, kind, purpose, term_years, starts_on, ends_on, ground_rent_ngn, granted_by) "
                                 "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING id",
                                 (user["org_id"], parcel["id"], title_no, d["title_kind"], d.get("purpose", ""), d.get("term_years"),
                                  starts, ends, d.get("ground_rent_ngn"), iid))
        tid = (await cur.fetchone())["id"]
        d = {**d, "title_no": title_no}
        await conn.execute("UPDATE instruments SET data = %s WHERE id = %s", (Jsonb(d), iid))
        for h in d["holders"]:
            await conn.execute("INSERT INTO holdings (title_id, party_id, share, from_instrument) VALUES (%s, %s, %s, %s)",
                               (tid, await _make_party(conn, user, h["party"]), h["share"], iid))
    elif k == "transfer":
        await conn.execute("UPDATE holdings SET to_instrument = %s WHERE title_id = %s AND to_instrument IS NULL", (iid, t["id"]))
        for h in d["holders"]:
            await conn.execute("INSERT INTO holdings (title_id, party_id, share, from_instrument) VALUES (%s, %s, %s, %s)",
                               (t["id"], await _make_party(conn, user, h["party"]), h["share"], iid))
    elif k in ("mortgage", "caveat", "lease"):
        await conn.execute("INSERT INTO encumbrances (title_id, kind, party_id, amount_ngn, term_years, details, from_instrument) "
                           "VALUES (%s, %s, %s, %s, %s, %s, %s)",
                           (t["id"], k, await _make_party(conn, user, d["party"]), d.get("amount_ngn"), d.get("term_years"),
                            d.get("details", ""), iid))
    elif k == "discharge":
        await conn.execute("UPDATE encumbrances SET to_instrument = %s WHERE id = %s AND to_instrument IS NULL", (iid, d["encumbrance_id"]))
    elif k in FABRIC:
        await apply_fabric(conn, user, ins, parcel, k, d)
    elif k == "revocation":
        await conn.execute("UPDATE titles SET status = 'revoked', ended_by = %s WHERE id = %s", (iid, t["id"]))
        await conn.execute("UPDATE holdings SET to_instrument = %s WHERE title_id = %s AND to_instrument IS NULL", (iid, t["id"]))
        await conn.execute("UPDATE encumbrances SET to_instrument = %s WHERE title_id = %s AND to_instrument IS NULL", (iid, t["id"]))
    await conn.execute("UPDATE instruments SET status = 'registered', decided_by = %s, decided_by_name = %s, decided_at = now(), "
                       "decision_note = %s WHERE id = %s", (user["id"], user["name"], note.strip(), iid))
    await audit(conn, user, "instrument.register", "parcel", parcel["id"], pin=parcel["pin"], number=ins["number"], kind=k)
    return await _instrument(conn, user, iid)


@router.post("/instruments/{iid}/register", summary="Register a lodged instrument (registrars): the register changes")
async def register(iid: UUID, body: Decision, user=Depends(need("registrar", write=True)), conn=Depends(get_conn)):
    return await _register(conn, user, iid, body.note)


@router.post("/instruments/{iid}/reject", summary="Reject a lodged instrument, with the reason (registrars)")
async def reject(iid: UUID, body: Decision, user=Depends(need("registrar", write=True)), conn=Depends(get_conn)):
    if len(body.note.strip()) < 3:
        raise Problem(422, "Say why it is rejected: the person who lodged it will see this.", code="validation", fields={"note": ["missing"]})
    return await _decide(conn, user, iid, "rejected", body.note)


@router.post("/instruments/{iid}/withdraw", summary="Withdraw a lodged instrument (whoever lodged it, or a registrar)")
async def withdraw(iid: UUID, user=Depends(need("officer", write=True)), conn=Depends(get_conn)):
    i = await _instrument(conn, user, iid)
    if i["lodged_by"] != user["id"] and user["role"] != "registrar":
        raise Problem(403, "Only whoever lodged it, or a registrar, can withdraw it.", code="forbidden")
    return await _decide(conn, user, iid, "withdrawn", "")


async def _decide(conn, user, iid, status: str, note: str) -> dict:
    cur = await conn.execute("UPDATE instruments SET status = %s, decided_by = %s, decided_by_name = %s, decided_at = now(), decision_note = %s "
                             "WHERE id = %s AND org_id = %s AND status = 'lodged' RETURNING number, kind, parcel_id",
                             (status, user["id"], user["name"], note.strip(), iid, user["org_id"]))
    row = await cur.fetchone()
    if not row:
        i = await _instrument(conn, user, iid)
        raise Problem(409, f"{i['number']} is already {i['status']}.", code="decided")
    cur = await conn.execute("SELECT pin FROM parcels WHERE id = %s", (row["parcel_id"],))
    await audit(conn, user, f"instrument.{'reject' if status == 'rejected' else 'withdraw'}", "parcel", row["parcel_id"],
                pin=(await cur.fetchone())["pin"], number=row["number"], kind=row["kind"], note=note.strip() or None)
    return await _instrument(conn, user, iid)


# ---------- parties ----------
@router.get("/parties", summary="Find parties by name or ID number")
async def find_parties(q: str = Query("", max_length=100), user=Depends(need()), conn=Depends(get_conn)):
    cur = await conn.execute(
        "SELECT p.id, p.kind, p.name, p.id_type, p.id_no, p.phone, "
        "  (SELECT count(*) FROM holdings h JOIN titles t ON t.id = h.title_id WHERE h.party_id = p.id AND h.to_instrument IS NULL) AS holdings "
        "FROM parties p WHERE p.org_id = %s AND (%s = '' OR p.name ILIKE %s OR p.id_no ILIKE %s) ORDER BY lower(p.name) LIMIT 30",
        (user["org_id"], q.strip(), f"%{q.strip()}%", f"{q.strip()}%"))
    return await cur.fetchall()


@router.get("/parties/{party_id}", summary="A party, and the land they hold or have held")
async def get_party(party_id: UUID, user=Depends(need()), conn=Depends(get_conn)):
    cur = await conn.execute("SELECT * FROM parties WHERE id = %s AND org_id = %s", (party_id, user["org_id"]))
    p = await cur.fetchone()
    if not p:
        raise Problem(404, "Party not found.", code="not_found")
    cur = await conn.execute(
        "SELECT pc.id AS parcel_id, pc.pin, pc.address, pc.locality, t.title_no, h.share, f.number AS from_number, f.decided_at AS since, "
        "  e.number AS to_number, e.decided_at AS until "
        "FROM holdings h JOIN titles t ON t.id = h.title_id JOIN parcels pc ON pc.id = t.parcel_id "
        "JOIN instruments f ON f.id = h.from_instrument LEFT JOIN instruments e ON e.id = h.to_instrument "
        "WHERE h.party_id = %s ORDER BY h.to_instrument IS NOT NULL, f.decided_at DESC", (party_id,))
    p["holdings"] = await cur.fetchall()
    cur = await conn.execute(
        "SELECT pc.id AS parcel_id, pc.pin, e.kind, e.amount_ngn, e.to_instrument IS NULL AS active "
        "FROM encumbrances e JOIN titles t ON t.id = e.title_id JOIN parcels pc ON pc.id = t.parcel_id WHERE e.party_id = %s", (party_id,))
    p["interests"] = await cur.fetchall()
    return p


@router.get("/register/kinds", summary="The kinds of title, instrument and party")
async def kinds(user=Depends(need())):
    return {"titles": TITLE_KINDS, "instruments": KIND_NAME, "parties": list(PARTY_KINDS)}



# ---------- subdivision and amalgamation ----------
async def parcel_shape(conn, parcel_id):
    cur = await conn.execute("SELECT ST_AsGeoJSON(geom, 10) AS g FROM parcels WHERE id = %s", (parcel_id,))
    import json
    return shape(json.loads((await cur.fetchone())["g"]))


async def assess_fabric(conn, user, parcel, kind, d, ignore, problems, warnings):
    ids = [UUID(x) for x in d.get("parcel_ids", [])] or [parcel["id"]]
    cur = await conn.execute("SELECT id, pin, status FROM parcels WHERE id = ANY(%s)", (ids,))
    rows = await cur.fetchall()
    for r in rows:
        if r["status"] != "active" and r["id"] != parcel["id"]:
            problems.append(f"{r['pin']} is {r['status']}.")
    cur = await conn.execute("SELECT i.number, p.pin FROM instruments i JOIN parcels p ON p.id = i.parcel_id "
                             "WHERE i.status = 'lodged' AND (%s::uuid IS NULL OR i.id <> %s::uuid) "
                             "AND (i.parcel_id = ANY(%s) OR i.data->'parcel_ids' ?| %s)", (ignore, ignore, ids, [str(x) for x in ids]))
    for r in await cur.fetchall():
        problems.append(f"{r['number']} is lodged against {r['pin']} and waiting: decide it first.")
    regs = [await current(conn, x) for x in ids]
    titled = [r for r in regs if r["title"]]
    if kind == "amalgamation" and titled:
        if len(titled) != len(regs):
            problems.append("Some of these parcels are titled and some are not: grant or revoke titles first so they match.")
        else:
            owners = {frozenset((str(h["id"]), h["share"]) for h in r["holders"]) for r in regs}
            if len(owners) > 1:
                problems.append("The parcels have different proprietors: transfer them to the same proprietors first.")
            if len({r["title"]["kind"] for r in regs}) > 1:
                problems.append("The parcels hold different kinds of title.")
    if titled and not problems:
        warnings.append("Titled land: each new parcel gets a new title with the same proprietors, terms and encumbrances; "
                        + ("the old title ends." if kind == "subdivision" else "the old titles end."))
    return problems, warnings


async def apply_fabric(conn, user, ins, parcel, kind, d):
    """Make the new parcels, carry the titles across, and retire the old parcels."""
    ids = [UUID(x) for x in d.get("parcel_ids", [])] or [parcel["id"]]
    cur = await conn.execute("SELECT * FROM parcels WHERE id = ANY(%s) ORDER BY array_position(%s, id)", (ids, ids))
    parents = await cur.fetchall()
    first = parents[0]
    cur = await conn.execute("SELECT b.name, b.lon, b.lat FROM beacons b WHERE b.parcel_id = ANY(%s)", (ids,))
    known = await cur.fetchall()
    if kind == "subdivision":
        shapes = fabric.pieces(await parcel_shape(conn, first["id"]), [tuple(x) for x in d["cut"]])
    else:
        shapes = [fabric.union([await parcel_shape(conn, x) for x in ids])]
    regs = [await current(conn, x) for x in ids]
    children = []
    for i, poly in enumerate(shapes):
        g = fabric.describe(poly)
        part = f" (part {i + 1} of {len(shapes)} of {first['pin']})" if kind == "subdivision" else ""
        pid, pin = await insert_parcel(conn, user, g["ring"], g["area_sqm"], g["perimeter_m"], fabric.beacons(poly, known, first["source_epsg"]),
                                       method="coordinates", source_epsg=first["source_epsg"], land_use=first["land_use"],
                                       address=(first["address"] + part).strip(), locality=first["locality"],
                                       survey_plan_no=first["survey_plan_no"], surveyor=first["surveyor"], survey_date=first["survey_date"],
                                       notes=f"{KIND_NAME[kind]} {ins['number']} of " + ", ".join(p["pin"] for p in parents) + ".")
        children.append((pid, pin, g["area_sqm"]))
        for par in parents:
            await conn.execute("INSERT INTO lineage (parent_id, child_id, instrument_id) VALUES (%s, %s, %s)", (par["id"], pid, ins["id"]))
    # titles: the new parcels take the old title's terms, proprietors and encumbrances
    titled = [r for r in regs if r["title"]]
    if titled:
        t0 = titled[0]["title"]
        rents = [sum(float(r["title"]["ground_rent_ngn"] or 0) for r in titled)] if kind == "amalgamation" else \
            fabric.apportion(float(t0["ground_rent_ngn"]) if t0["ground_rent_ngn"] is not None else None, [c[2] for c in children])
        encs = {(e["kind"], str(e["party_id"]), str(e["amount_ngn"]), e["details"]): e for r in titled for e in r["encumbrances"]}
        for (pid, pin, _), rent in zip(children, rents):
            cur = await conn.execute("UPDATE settings SET title_next = title_next + 1 WHERE org_id = %s RETURNING title_prefix, title_next - 1 AS n",
                                     (user["org_id"],))
            sx = await cur.fetchone()
            cur = await conn.execute(
                "INSERT INTO titles (org_id, parcel_id, title_no, kind, purpose, term_years, starts_on, ends_on, ground_rent_ngn, granted_by) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING id",
                (user["org_id"], pid, f"{sx['title_prefix']}/{sx['n']:06d}", t0["kind"], t0["purpose"], t0["term_years"], t0["starts_on"],
                 t0["ends_on"], rent if rent else None, ins["id"]))
            tid = (await cur.fetchone())["id"]
            for h in titled[0]["holders"]:
                await conn.execute("INSERT INTO holdings (title_id, party_id, share, from_instrument) VALUES (%s, %s, %s, %s)",
                                   (tid, h["id"], h["share"], ins["id"]))
            for e in encs.values():
                await conn.execute("INSERT INTO encumbrances (title_id, kind, party_id, amount_ngn, term_years, details, from_instrument) "
                                   "VALUES (%s, %s, %s, %s, %s, %s, %s)", (tid, e["kind"], e["party_id"], e["amount_ngn"], e["term_years"],
                                                                           e["details"], ins["id"]))
        for r in titled:
            await conn.execute("UPDATE titles SET status = 'superseded', ended_by = %s WHERE id = %s", (ins["id"], r["title"]["id"]))
            await conn.execute("UPDATE holdings SET to_instrument = %s WHERE title_id = %s AND to_instrument IS NULL", (ins["id"], r["title"]["id"]))
            await conn.execute("UPDATE encumbrances SET to_instrument = %s WHERE title_id = %s AND to_instrument IS NULL", (ins["id"], r["title"]["id"]))
    word = "Subdivided into " if kind == "subdivision" else "Amalgamated into "
    for par in parents:
        await conn.execute("UPDATE parcels SET status = 'retired', retired_reason = %s, updated_at = now() WHERE id = %s",
                           (word + ", ".join(c[1] for c in children) + f" by {ins['number']}", par["id"]))
    d = {**d, "children": [{"id": str(c[0]), "pin": c[1], "area_sqm": c[2]} for c in children]}
    await conn.execute("UPDATE instruments SET data = %s WHERE id = %s", (Jsonb(d), ins["id"]))
