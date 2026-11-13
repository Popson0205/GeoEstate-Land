from urllib.parse import parse_qs, urlsplit

from app import identity
from conftest import HUB, ORG

START = {"easting": 538700, "northing": 730000, "beacon": "SC/LA 1001"}
SQUARE = [{"bearing": "0", "distance_m": 100, "beacon": "SC/LA 1002"}, {"bearing": "90°00'00\"", "distance_m": 100, "beacon": "SC/LA 1003"},
          {"bearing": "180", "distance_m": 100.02, "beacon": "SC/LA 1004"}, {"bearing": "270", "distance_m": 100}]


def test_signing_in_through_geohub(client):
    r = client.get("/auth/sign-in", params={"next": "/parcels/new"}, follow_redirects=False)
    assert r.status_code == 303
    q = parse_qs(urlsplit(r.headers["location"]).query)
    assert r.headers["location"].startswith("http://geohub.test/id/authorize") and q["client_id"] == ["land"]
    assert q["redirect_uri"] == ["http://land.test/auth/callback"] and len(q["code_challenge"][0]) == 43
    HUB.codes["c1"] = HUB.claims(role="member", name="Bisi Officer")
    client.cookies.set("land_state", q["state"][0]); client.cookies.set("land_pkce", "v"); client.cookies.set("land_next", "/parcels/new")
    back = client.get("/auth/callback", params={"code": "c1", "state": q["state"][0]}, follow_redirects=False)
    assert back.status_code == 303 and back.headers["location"] == "http://land.test/parcels/new"
    assert identity.AT in back.cookies and identity.RT in back.cookies
    client.cookies.clear(); client.cookies.set(identity.AT, back.cookies[identity.AT])
    me = client.get("/me").json()
    assert me["name"] == "Bisi Officer" and me["role"] == "officer" and me["can_write"] and me["org_id"] == ORG
    bad = client.get("/auth/callback", params={"code": "c1", "state": "other"}, follow_redirects=False)
    assert "did not start here" in bad.headers["location"].replace("+", " ").replace("%20", " ")
    client.cookies.clear()
    assert client.get("/me").status_code == 401


def test_registering_parcels(client, person):
    reg = person(role="owner")
    s = reg.get("/settings").json()
    assert s["default_epsg"] == 26331 and s["pin_prefix"] == "GE" and s["closure_ratio"] == 5000
    assert reg.put("/settings", json={"default_epsg": 26331, "pin_prefix": "lag", "closure_ratio": 5000, "overlap_tolerance_sqm": 1}).json()["pin_prefix"] == "LAG"
    off = person(role="member", name="Bisi Officer")

    c = off.post("/parcels/check", json={"method": "traverse", "start": START, "legs": SQUARE}).json()
    assert c["ok"] and c["closure"]["ratio"] == 20000 and c["closure"]["adjusted"] and 9990 < c["area_sqm"] < 10030
    assert [b["name"] for b in c["beacons"]] == ["SC/LA 1001", "SC/LA 1002", "SC/LA 1003", "SC/LA 1004"]
    assert c["legs"][1]["bearing_dms"] == "90°00'00\"" and c["geometry"]["type"] == "Polygon"

    r = off.post("/parcels", json={"method": "traverse", "start": START, "legs": SQUARE, "address": "12 Allen Avenue",
                                   "locality": "Ikeja", "land_use": "residential", "survey_plan_no": "LS/D/1234", "surveyor": "Surv. T. Ade"})
    assert r.status_code == 201, r.text
    p1 = r.json()
    assert p1["pin"] == "LAG-000001" and p1["method"] == "traverse" and len(p1["beacons"]) == 4 and p1["created_by_name"] == "Bisi Officer"

    # the same land again overlaps it, and is refused
    again = off.post("/parcels", json={"method": "traverse", "start": {"easting": 538750, "northing": 730050}, "legs": SQUARE})
    assert again.status_code == 422 and "overlaps LAG-000001" in again.json()["detail"] and again.json()["check"]["overlaps"][0]["pin"] == "LAG-000001"
    # the neighbour to the east shares a boundary: fine
    east = off.post("/parcels", json={"method": "coordinates", "points": [
        {"x": 538800, "y": 730000, "beacon": "SC/LA 1004"}, {"x": 538800, "y": 730100}, {"x": 538880, "y": 730100}, {"x": 538880, "y": 730000}],
        "address": "14 Allen Avenue"})
    assert east.status_code == 201, east.text
    p2 = east.json()
    assert p2["pin"] == "LAG-000002" and p2["method"] == "coordinates"
    assert [n["pin"] for n in off.get(f"/parcels/{p1['id']}").json()["neighbours"]] == ["LAG-000002"]

    # GPS coordinates in longitude and latitude
    gps = off.post("/parcels/check", json={"method": "coordinates", "epsg": 4326, "points": [
        {"x": 3.36, "y": 6.61}, {"x": 3.3605, "y": 6.61}, {"x": 3.3605, "y": 6.6105}, {"x": 3.36, "y": 6.6105}]}).json()
    assert gps["ok"] and gps["beacons"][0]["easting"] is None and 3000 < gps["area_sqm"] < 3200
    # a traverse that does not close
    open_ = off.post("/parcels/check", json={"method": "traverse", "start": START, "legs": [{**l, "distance_m": 103} if i == 2 else l for i, l in enumerate(SQUARE)]}).json()
    assert not open_["ok"] and "does not close" in open_["problems"][0]

    # the register, the map, a parcel's page
    found = off.get("/parcels", params={"q": "Allen"}).json()
    assert {x["pin"] for x in found} == {"LAG-000001", "LAG-000002"}
    assert [x["pin"] for x in off.get("/parcels", params={"q": "LS/D/1234"}).json()] == ["LAG-000001"]
    fc = off.get("/parcels.geojson").json()
    assert len(fc["features"]) == 2 and fc["bbox"][0] < 3.37
    assert off.get("/parcels.geojson", params={"bbox": "10,10,11,11"}).json()["features"] == []
    upd = off.patch(f"/parcels/{p1['id']}", json={"address": "12A Allen Avenue"}).json()
    assert upd["address"] == "12A Allen Avenue" and upd["history"][0]["action"] == "parcel.update"

    # roles, and only registrars retire parcels
    viewer = person(role="viewer")
    assert viewer.get(f"/parcels/{p1['id']}").status_code == 200
    assert viewer.post("/parcels/check", json={"method": "traverse", "start": START, "legs": SQUARE}).status_code == 403
    assert off.post(f"/parcels/{p2['id']}/retire", json={"reason": "Merged"}).status_code == 403
    ret = reg.post(f"/parcels/{p2['id']}/retire", json={"reason": "Replaced by a resurvey"}).json()
    assert ret["status"] == "retired"
    assert [x["pin"] for x in off.get("/parcels").json()] == ["LAG-000001"]
    # its land is free again
    assert off.post("/parcels/check", json={"method": "coordinates", "points": [
        {"x": 538810, "y": 730010}, {"x": 538810, "y": 730090}, {"x": 538870, "y": 730090}, {"x": 538870, "y": 730010}]}).json()["ok"]

    home = reg.get("/home").json()
    assert home["active"] == 1 and home["retired"] == 1 and home["latest"][0]["pin"] == "LAG-000002"
    acts = [e["action"] for e in reg.get("/audit").json()]
    assert {"parcel.create", "parcel.retire", "settings.update", "parcel.update"} <= set(acts)
    assert off.get("/audit").status_code == 403


def test_licence_plan_and_safety(client, person):
    other_org = "00000000-0000-4000-8000-000000000001"
    expired = person(role="owner", status="expired", org_id=other_org, org="Ogun Estates")
    assert expired.get("/parcels").status_code == 200
    r = expired.post("/parcels/check", json={"method": "traverse", "start": START, "legs": SQUARE})
    assert r.status_code == 200                                  # checking changes nothing
    r = expired.post("/parcels", json={"method": "traverse", "start": START, "legs": SQUARE})
    assert r.status_code == 403 and r.json()["code"] == "licence_expired"
    assert person(status="suspended").get("/parcels").status_code == 403

    capped = person(role="owner", org_id="00000000-0000-4000-8000-000000000002", org="Small Estate", limits={"parcels": 1})
    assert capped.post("/parcels", json={"method": "traverse", "start": START, "legs": SQUARE}).status_code == 201
    far = {"easting": 540700, "northing": 731000}
    r = capped.post("/parcels", json={"method": "traverse", "start": far, "legs": SQUARE})
    assert r.status_code == 402 and r.json()["code"] == "plan_limit"
    nofeat = person(role="owner", org_id="00000000-0000-4000-8000-000000000003", features=["reports"])
    assert nofeat.post("/parcels", json={"method": "traverse", "start": START, "legs": SQUARE}).json()["code"] == "no_feature"

    # each organization sees only its own fabric
    assert all(p["pin"] != "LAG-000001" for p in capped.get("/parcels").json())
    # a change sent without the app's header (another site's form) is refused
    p = person(role="owner")
    p.c.cookies.set(identity.AT, p.cookies[identity.AT])
    assert client.post("/parcels/check", json={"method": "traverse", "start": START, "legs": SQUARE}).status_code == 403


def test_refreshing_and_losing_the_product(client, person):
    p = person(role="member")
    p.cookies[identity.AT] = HUB.token(p.claims, minutes=-1)              # the access token has run out
    r = p.get("/me")
    assert r.status_code == 200 and identity.AT in r.cookies                # refreshed with Geohub
    HUB.no_product_on_refresh = True
    p.cookies[identity.AT] = HUB.token(p.claims, minutes=-1)
    r = p.get("/me")
    assert r.status_code == 401 and r.json()["code"] == "no_product"
    HUB.no_product_on_refresh = False
    assert p.get("/apps").status_code == 401
    q = person(role="member")
    assert [a["product"] for a in q.get("/apps").json()] == ["hub", "land"]


def test_another_app_reads_the_fabric_with_an_exchanged_token(client, person):
    """PolyGIS shows the parcels as a layer: it calls with a Land Registry access token from Geohub's token exchange,
    sees what the person may see, and cannot change anything."""
    off = person(role="member", name="Fabric Reader")
    r = off.post("/parcels", json={"method": "traverse", "start": {"easting": 540700, "northing": 732000}, "legs": SQUARE, "locality": "Ikeja",
                                   "land_use": "commercial"})
    assert r.status_code == 201, r.text
    token = HUB.token({**HUB.claims(role="member", name="Fabric Reader"), "act": {"sub": "gis"}})
    client.cookies.clear()
    fc = client.get("/parcels.geojson", headers={"Authorization": f"Bearer {token}"})
    assert fc.status_code == 200, fc.text
    mine = next(f for f in fc.json()["features"] if f["properties"]["pin"] == r.json()["pin"])
    assert mine["properties"]["locality"] == "Ikeja" and mine["properties"]["land_use"] == "commercial" and "title_no" in mine["properties"]
    assert client.post("/parcels/check", json={}, headers={"Authorization": f"Bearer {token}", "X-GeoEstate": "1"}).status_code == 403
    assert client.get("/parcels.geojson", headers={"Authorization": "Bearer junk"}).status_code == 401
    other = HUB.token(HUB.claims(role="owner", org_id="00000000-0000-4000-8000-000000000044", name="Elsewhere"))
    assert all(f["properties"]["pin"] != r.json()["pin"] for f in client.get("/parcels.geojson", headers={"Authorization": f"Bearer {other}"}).json()["features"])
