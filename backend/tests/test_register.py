import uuid

from conftest import HUB

ORG2 = str(uuid.uuid4())
LEGS = [{"bearing": "0", "distance_m": 50}, {"bearing": "90", "distance_m": 40}, {"bearing": "180", "distance_m": 50}, {"bearing": "270", "distance_m": 40}]


def staff(person, **kw):
    """A registrar and an officer of the Kabusa estate registry."""
    base = {"org_id": ORG2, "org": "Kabusa Estate Registry"}
    kw.setdefault("features", ["parcels", "titles", "transactions", "public_lookup"])
    return person(role="owner", name="Ngozi Registrar", **base, **kw), person(role="member", name="Tunde Officer", **base, **kw)


def parcel(who, e):
    r = who.post("/parcels", json={"method": "traverse", "epsg": 26332, "start": {"easting": e, "northing": 993000}, "legs": LEGS,
                                   "address": f"Plot {e % 1000}", "locality": "Kabusa"})
    assert r.status_code == 201, r.text
    return r.json()


AMAKA = {"party": {"name": "Amaka Obi", "id_type": "NIN", "id_no": "12345678901", "phone": "+234 803 000 0001"}, "share": "1/2"}
EMEKA = {"party": {"name": "Emeka Obi", "id_type": "NIN", "id_no": "12345678902"}, "share": "1/2"}


def test_grant_transfer_and_encumbrances(client, person):
    reg, off = staff(person)
    p = parcel(off, 331000)
    pid = p["id"]
    empty = off.get(f"/parcels/{pid}/register").json()
    assert empty["title"] is None and empty["instruments"] == []

    # a transfer before any title is refused, and so are shares that do not add up
    r = off.post(f"/parcels/{pid}/instruments", json={"kind": "transfer", "holders": [AMAKA]})
    assert r.status_code == 422 and "no title yet" in r.json()["detail"]
    r = off.post(f"/parcels/{pid}/instruments", json={"kind": "grant", "title_kind": "statutory_ro", "holders": [AMAKA]})
    assert r.status_code == 422 and "add up to 1/2" in r.json()["detail"]

    # an officer lodges the grant; it changes nothing until a registrar registers it
    r = off.post(f"/parcels/{pid}/instruments", json={"kind": "grant", "title_kind": "statutory_ro", "purpose": "residential", "term_years": 99,
                                                      "starts_on": "2026-01-01", "ground_rent_ngn": 25000, "holders": [AMAKA, EMEKA],
                                                      "reference": "FCT/LA/2026/77"})
    assert r.status_code == 201, r.text
    g = r.json()
    assert g["status"] == "lodged" and g["number"].startswith("INS/") and g["summary"].startswith("Statutory right of occupancy (C of O) to Amaka Obi (1/2)")
    assert off.get(f"/parcels/{pid}/register").json()["title"] is None
    assert [i["number"] for i in reg.get("/instruments").json()] == [g["number"]]
    assert off.post(f"/instruments/{g['id']}/register", json={}).status_code == 403          # officers cannot register
    done = reg.post(f"/instruments/{g['id']}/register", json={"note": "Consent seen."}).json()
    assert done["status"] == "registered" and done["decided_by_name"] == "Ngozi Registrar" and done["data"]["title_no"] == "TR/000001"
    rg = off.get(f"/parcels/{pid}/register").json()
    t = rg["title"]
    assert t["title_no"] == "TR/000001" and t["kind_name"].startswith("Statutory") and t["ends_on"] == "2125-01-01" and t["term_years"] == 99
    assert [(h["name"], h["share"]) for h in rg["holders"]] == [("Amaka Obi", "1/2"), ("Emeka Obi", "1/2")]
    assert reg.post(f"/instruments/{g['id']}/register", json={}).status_code == 409
    # a second grant is refused while the title stands
    r = off.post(f"/parcels/{pid}/instruments", json={"kind": "grant", "title_kind": "statutory_ro", "holders": [{**AMAKA, "share": "1/1"}]})
    assert r.status_code == 422 and "already has title TR/000001" in r.json()["detail"]

    # a mortgage, registered at once by the registrar
    bank = {"name": "Zenith Bank Plc", "kind": "company", "id_type": "RC", "id_no": "190380"}
    m = reg.post(f"/parcels/{pid}/instruments", json={"kind": "mortgage", "party": bank, "amount_ngn": 15000000, "register_now": True}).json()
    assert m["status"] == "registered" and m["summary"] == "In favour of Zenith Bank Plc for ₦15,000,000.00"
    # a caveat stops a transfer until discharged
    amaka_id = rg["holders"][0]["id"]
    c = reg.post(f"/parcels/{pid}/instruments", json={"kind": "caveat", "party": {"name": "Chidi Eze"}, "details": "Claims a purchaser's interest under an agreement of 2025.",
                                                     "register_now": True}).json()
    assert c["status"] == "registered"
    sale = {"kind": "transfer", "holders": [{"party": {"name": "Halima Bello", "id_type": "NIN", "id_no": "22223333444"}, "share": "1/1"}],
            "consideration_ngn": 48000000, "reference": "Governor's consent GC/2026/19"}
    r = off.post(f"/parcels/{pid}/instruments", json=sale)
    assert r.status_code == 422 and "caveat by Chidi Eze stops transfers" in r.json()["detail"]
    caveat_id = next(e["id"] for e in off.get(f"/parcels/{pid}/register").json()["encumbrances"] if e["kind"] == "caveat")
    d = off.post(f"/parcels/{pid}/instruments", json={"kind": "discharge", "encumbrance_id": caveat_id, "details": "Withdrawn by the caveator."}).json()
    assert d["summary"] == "Ends the caveat of Chidi Eze"
    # lodged in the meantime, a transfer is checked again at registration
    r = off.post(f"/parcels/{pid}/instruments", json=sale)
    assert r.status_code == 422                                   # the caveat is still on: the discharge is only lodged
    reg.post(f"/instruments/{d['id']}/register", json={})
    r = off.post(f"/parcels/{pid}/instruments", json=sale)
    assert r.status_code == 201 and "mortgage stays on it" in " ".join(r.json()["warnings"])
    tr = r.json()
    q = reg.get(f"/instruments/{tr['id']}").json()
    assert q["problems"] == [] and any("Zenith" in w for w in q["warnings"])
    reg.post(f"/instruments/{tr['id']}/register", json={})
    rg = off.get(f"/parcels/{pid}/register").json()
    assert [h["name"] for h in rg["holders"]] == ["Halima Bello"] and [e["kind"] for e in rg["encumbrances"]] == ["mortgage"]
    assert [i["status"] for i in rg["instruments"]] == ["registered"] * 5

    # the history stays: Amaka held it, and no longer does
    amaka = off.get(f"/parties/{amaka_id}").json()
    assert amaka["holdings"][0]["pin"] == p["pin"] and amaka["holdings"][0]["to_number"] == tr["number"]
    assert [x["name"] for x in off.get("/parties", params={"q": "obi"}).json()] == ["Amaka Obi", "Emeka Obi"]
    # the register finds the parcel by proprietor and title number
    assert [x["pin"] for x in off.get("/parcels", params={"q": "halima"}).json()] == [p["pin"]]
    assert off.get("/parcels", params={"q": "TR/000001"}).json()[0]["title_no"] == "TR/000001"
    # the same person (by NIN) is not made twice
    p2 = parcel(off, 331500)
    reg.post(f"/parcels/{p2['id']}/instruments", json={"kind": "grant", "title_kind": "customary_ro", "register_now": True,
                                                       "holders": [{"party": {"name": "Halima M. Bello", "id_type": "NIN", "id_no": "22223333444"}}]})
    halima = off.get("/parties", params={"q": "22223333444"}).json()
    assert len(halima) == 1 and halima[0]["holdings"] == 2

    # a titled parcel cannot be retired; revoking the title ends everything on it
    assert reg.post(f"/parcels/{pid}/retire", json={"reason": "merged"}).status_code == 409
    rv = reg.post(f"/parcels/{pid}/instruments", json={"kind": "revocation", "details": "Revoked for overriding public interest.",
                                                      "reference": "Gazette 44/2026", "register_now": True})
    assert rv.status_code == 201, rv.text
    rg = off.get(f"/parcels/{pid}/register").json()
    assert rg["title"] is None and rg["past_titles"][0]["title_no"] == "TR/000001" and rg["past_titles"][0]["ended_by_number"] == rv.json()["number"]
    assert reg.post(f"/parcels/{pid}/retire", json={"reason": "merged"}).status_code == 200


def test_rejecting_withdrawing_and_plans(client, person):
    reg, off = staff(person)
    p = parcel(off, 332000)
    g = off.post(f"/parcels/{p['id']}/instruments", json={"kind": "grant", "title_kind": "allocation", "holders": [{**AMAKA, "share": "1/1"}]}).json()
    assert reg.post(f"/instruments/{g['id']}/reject", json={"note": ""}).status_code == 422
    r = reg.post(f"/instruments/{g['id']}/reject", json={"note": "No allocation letter attached."}).json()
    assert r["status"] == "rejected" and r["decision_note"] == "No allocation letter attached."
    g2 = off.post(f"/parcels/{p['id']}/instruments", json={"kind": "grant", "title_kind": "allocation", "holders": [{**AMAKA, "share": "1/1"}]}).json()
    other = person(role="member", name="Someone Else", org_id=ORG2, features=[])
    assert other.post(f"/instruments/{g2['id']}/withdraw").status_code == 403
    assert off.post(f"/instruments/{g2['id']}/withdraw").json()["status"] == "withdrawn"
    # pending instruments block retiring
    off.post(f"/parcels/{p['id']}/instruments", json={"kind": "grant", "title_kind": "allocation", "holders": [{**AMAKA, "share": "1/1"}]})
    assert "lodged and waiting" in reg.post(f"/parcels/{p['id']}/retire", json={"reason": "x-y-z"}).json()["detail"]
    # a plan with titles but no dealings
    small = person(role="owner", org_id=ORG2, features=["parcels", "titles"])
    r = small.post(f"/parcels/{p['id']}/instruments", json={"kind": "caveat", "party": {"name": "X Y"}, "details": "a claim of some kind"})
    assert r.status_code == 403 and r.json()["code"] == "no_feature"
    # an expired licence reads but does not lodge; a viewer reads only
    assert person(role="owner", org_id=ORG2, status="expired").post(f"/parcels/{p['id']}/instruments", json={"kind": "revocation", "details": "abcdef"}).status_code == 403
    assert person(role="viewer", org_id=ORG2).get(f"/parcels/{p['id']}/register").status_code == 200
    # another organization cannot see it
    assert person(role="owner").get(f"/parcels/{p['id']}/register").status_code == 404


def test_public_lookup(client, person):
    reg, off = staff(person)
    p = parcel(off, 333000)
    reg.post(f"/parcels/{p['id']}/instruments", json={"kind": "grant", "title_kind": "statutory_ro", "title_no": "KB/CO/0099", "register_now": True,
                                                      "holders": [{"party": {"name": "Femi Ade", "id_no": "99", "id_type": "NIN"}}]})
    reg.post(f"/parcels/{p['id']}/instruments", json={"kind": "mortgage", "party": {"name": "GTBank"}, "amount_ngn": 5e6, "register_now": True})
    slug = HUB.claims()["org"]["slug"]
    client.cookies.clear()
    assert client.get(f"/public/{slug}").status_code == 404                     # off until the registry turns it on
    s = reg.get("/settings").json()
    assert s["public_lookup"] == "off" and s["public_allowed"] and s["org_slug"] == slug
    body = {k: s[k] for k in ("default_epsg", "pin_prefix", "closure_ratio", "overlap_tolerance_sqm")}
    assert reg.put("/settings", json={**body, "public_lookup": "basic", "title_prefix": "kb/co"}).json()["title_prefix"] == "KB/CO"
    client.cookies.clear()
    assert client.get(f"/public/{slug}").json() == {"name": "Kabusa Estate Registry", "shows_holders": False}
    r = client.get(f"/public/{slug}/lookup", params={"q": p["pin"].lower()}).json()
    assert r["title"]["title_no"] == "KB/CO/0099" and r["encumbrances"] == [{"kind": "mortgage", "count": 1}] and r["holders"] is None
    assert "amount_ngn" not in str(r) and "99" not in str(r.get("holders"))
    assert client.get(f"/public/{slug}/lookup", params={"q": "kb/co/0099"}).json()["pin"] == p["pin"]
    assert client.get(f"/public/{slug}/lookup", params={"q": "NOPE-1"}).status_code == 404
    reg.put("/settings", json={**body, "public_lookup": "holders"})
    client.cookies.clear()
    assert client.get(f"/public/{slug}/lookup", params={"q": p["pin"]}).json()["holders"] == [{"name": "Femi Ade", "share": "1/1"}]
    # a plan without the public lookup turns it off
    person(role="viewer", org_id=ORG2, features=["parcels"]).get("/settings")
    client.cookies.clear()
    assert client.get(f"/public/{slug}").status_code == 404
    # and the lookup is rate limited
    from app.routers import public
    public._seen.clear()
    reg.put("/settings", json={**body, "public_lookup": "basic"})
    client.cookies.clear()
    codes = [client.get(f"/public/{slug}/lookup", params={"q": p["pin"]}).status_code for _ in range(32)]
    assert codes[:30] == [200] * 30 and codes[30] == 429


def test_title_status_for_other_products(client, person):
    """LandCheck asks, with the platform key, what the published registries hold at a point."""
    from app.config import settings
    reg, off = staff(person)
    p = parcel(off, 336000)
    reg.post(f"/parcels/{p['id']}/instruments", json={"kind": "grant", "title_kind": "statutory_ro", "title_no": "KB/CO/0777", "register_now": True,
                                                      "holders": [{"party": {"name": "Ngozi Eze", "id_no": "55", "id_type": "NIN"}}]})
    reg.post(f"/parcels/{p['id']}/instruments", json={"kind": "mortgage", "party": {"name": "Zenith Bank"}, "amount_ngn": 2e6, "register_now": True})
    x = reg.get(f"/parcels/{p['id']}").json()
    s = reg.get("/settings").json()
    body = {k: s[k] for k in ("default_epsg", "pin_prefix", "closure_ratio", "overlap_tolerance_sqm")}
    q = {"lat": x["lat"], "lng": x["lon"]}
    client.cookies.clear()
    old, settings.platform_key = settings.platform_key, ""
    try:
        assert client.get("/platform/title-status", params=q).status_code == 503              # not set up
        settings.platform_key = "k" * 40
        assert client.get("/platform/title-status", params=q).status_code == 401
        assert client.get("/platform/title-status", params=q, headers={"X-Platform-Key": "wrong"}).status_code == 401
        key = {"X-Platform-Key": "k" * 40}
        reg.put("/settings", json={**body, "public_lookup": "off"})
        client.cookies.clear()
        r = client.get("/platform/title-status", params=q, headers=key).json()
        assert not any(a["pin"] == p["pin"] for a in r["at"])                                  # a registry that does not publish is not searched
        reg.put("/settings", json={**body, "public_lookup": "basic"})
        client.cookies.clear()
        r = client.get("/platform/title-status", params=q, headers=key).json()
        a = next(a for a in r["at"] if a["pin"] == p["pin"])
        assert a["title"]["title_no"] == "KB/CO/0777" and a["encumbrances"] == [{"kind": "mortgage", "count": 1}] and a["holders"] is None
        assert a["lookup_url"].endswith(f"/lookup/{s['org_slug']}?q={p['pin']}") and r["registries_searched"] >= 1 and "55" not in str(r) and "amount" not in str(r)
        # just off the parcel: it is near, not at
        r = client.get("/platform/title-status", params={"lat": x["lat"], "lng": x["lon"] + 0.0003}, headers=key).json()
        assert not any(a["pin"] == p["pin"] for a in r["at"]) and any(n["pin"] == p["pin"] and 0 < n["distance_m"] <= 50 for n in r["near"])
        reg.put("/settings", json={**body, "public_lookup": "holders"})
        client.cookies.clear()
        r = client.get("/platform/title-status", params=q, headers=key).json()
        assert next(a for a in r["at"] if a["pin"] == p["pin"])["holders"] == [{"name": "Ngozi Eze", "share": "1/1"}]
    finally:
        settings.platform_key = old
