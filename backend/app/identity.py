"""Who is signed in, through GeoEstate ID (Geohub). Land Registry has no accounts of its own.

The access token (15 minutes) and refresh token (30 days) are kept in http-only cookies; when the access token runs
out, the next request refreshes both, which also checks with Geohub that the person still has Land Registry.

Roles come from the person's role in their Geohub organization:
  registrar = owner or admin: everything, including settings and retiring parcels
  officer   = member: captures and edits parcels
  viewer    = collector or viewer, and GeoEstate staff: reads only
An expired licence is read-only and a suspended one closed, as in Geohub."""
import secrets

from fastapi import Depends, Request, Response

from .config import settings
from .errors import Problem
from .geoestate_id import GeoEstateID, GeoEstateIDError

AT, RT = "land_at", "land_rt"
ROLE_OF = {"owner": "registrar", "admin": "registrar", "member": "officer", "collector": "viewer", "viewer": "viewer"}
RANK = {"viewer": 0, "officer": 1, "registrar": 2}
# Tests swap this for one that talks to a stand-in Geohub.
gid: GeoEstateID | None = None


def client() -> GeoEstateID:
    global gid
    if gid is None:
        gid = GeoEstateID(geohub=settings.geohub_url, api=settings.geohub_api, client_id=settings.id_client,
                          client_secret=settings.id_secret or None)
    return gid


def callback_url() -> str:
    return f"{settings.app_url}{settings.api_prefix}/auth/callback"


def keep(response: Response, tokens: dict) -> None:
    opts = {"httponly": True, "secure": settings.cookie_secure, "samesite": "lax", "path": "/"}
    response.set_cookie(AT, tokens["access_token"], max_age=tokens["expires_in"], **opts)
    response.set_cookie(RT, tokens["refresh_token"], max_age=30 * 86400, **opts)


def forget(response: Response) -> None:
    for k in (AT, RT):
        response.delete_cookie(k, path="/")


def new_state() -> tuple[str, str]:
    return secrets.token_urlsafe(48), secrets.token_urlsafe(24)


def person(claims: dict) -> dict:
    p = claims.get("product") or {}
    org = claims.get("org") or {}
    if claims.get("staff_role") and not p:
        role = "viewer"                                     # GeoEstate staff helping a customer: read only
    else:
        role = ROLE_OF.get(org.get("role", ""), "viewer")
    status = p.get("status")
    return {"id": claims["sub"], "name": claims["name"], "email": claims["email"], "org_id": org.get("id"),
            "org_name": org.get("name"), "org_slug": org.get("slug"), "org_role": org.get("role"), "role": role, "staff_role": claims.get("staff_role"),
            "product": p or None, "licence": status, "features": p.get("features", []), "limits": p.get("limits", {}),
            "can_write": status in ("demo", "active", "grace"), "claims": claims}


async def current_user(request: Request, response: Response) -> dict:
    at, rt = request.cookies.get(AT), request.cookies.get(RT)
    g = client()
    claims = None
    if at:
        try:
            claims = g.verify(at)
        except GeoEstateIDError:
            claims = None
    if claims is None and rt:
        try:
            tokens = g.refresh(rt)
        except GeoEstateIDError as e:
            forget(response)
            raise Problem(401, str(e) if e.code == "no_product" else "Your sign-in has ended. Sign in again.",
                          code=e.code if e.code == "no_product" else "unauthenticated")
        keep(response, tokens)
        at = tokens["access_token"]
        claims = g.verify(at)
    if claims is None:
        raise Problem(401, "Sign in to continue.", code="unauthenticated")
    u = person(claims)
    if not u["org_id"] and not u["staff_role"]:
        raise Problem(403, "Land Registry is for organizations.", code="no_org")
    if u["licence"] == "suspended":
        raise Problem(403, f"{u['org_name']}'s Land Registry access is suspended. Contact GeoEstate NIG Limited to restore it.",
                      code="licence_suspended")
    request.state.at = at
    return u


def need(role: str = "viewer", write: bool = False):
    """A signed-in person with at least this role; `write` also needs a licence that allows changes."""
    async def dep(user=Depends(current_user)) -> dict:
        if RANK[user["role"]] < RANK[role]:
            words = {"officer": "Only registrars and officers can do this.", "registrar": "Only registrars can do this."}
            raise Problem(403, words.get(role, "You cannot do this."), code="forbidden")
        if write and not user["can_write"]:
            raise Problem(403, f"{user['org_name']}'s Land Registry subscription has ended, so it is read-only: you can view and "
                               "export but not add or change anything. Renew with GeoEstate NIG Limited.", code="licence_expired")
        if not user["org_id"]:
            raise Problem(403, "Open Land Registry from your organization's account.", code="no_org")
        return user
    return dep
