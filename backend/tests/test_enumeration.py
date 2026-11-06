import uuid

from conftest import HUB

ORG4 = str(uuid.uuid4())
FULL = ["parcels", "titles", "transactions", "public_lookup", "workflows", "dxf_import"]
PROJECT, FORM, POINTS = str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())
FIELDS = [{"id": "plot_no", "label": "Plot number", "type": "text"}, {"id": "occupant", "label": "Occupant", "type": "text"},
          {"id": "phone", "label": "Phone", "type": "text"}, {"id": "nin", "label": "NIN", "type": "text"},
          {"id": "use", "label": "Use", "type": "choice", "choices": ["Residential", "Farm"]}, {"id": "remarks", "label": "Remarks", "type": "text"}]


def square(lon, lat, d=0.0003):
    return {"type": "Polygon", "coordinates": [[[lon, lat], [lon + d, lat], [lon + d, lat + d], [lon, lat + d], [lon, lat]]]}


def feature(seq, geometry, status="approved", **props):
    fid = str(uuid.uuid4())
    HUB.features[fid] = {"id": fid, "form_id": FORM, "seq": seq, "status": status, "version": 2, "form_version": 1, "geometry": geometry,
                         "properties": props, "review_note": None, "reviewed_at": "2026-11-01T10:00:00Z", "created_at": "2026-10-30T09:00:00Z",
                         "updated_at": "2026-11-01T10:00:00Z", "created_by_name": "Garba Enumerator", "reviewed_by_name": "Hauwa Lead"}
    return fid


def test_enumeration_from_geohub(client, person):
    base = {"org_id": ORG4, "org": "Bwari Area Council Lands", "features": FULL}
    reg, off = person(role="owner", name="Registrar Ruth", **base), person(role="member", name="Officer Obi", **base)
    HUB.projects = [{"id": PROJECT, "name": "Bwari enumeration 2026", "description": "", "role": "admin", "forms": [
        {"id": FORM, "name": "Plots", "geometry_type": "area", "version": 1, "features": 4, "approved": 3, "fields": FIELDS},
        {"id": POINTS, "name": "Beacons", "geometry_type": "point", "version": 1, "features": 0, "approved": 0, "fields": []}]}]
    a = feature(1, square(7.40, 9.20), plot_no="12", occupant="Aisha Bako", phone="0803 111 2222", nin="11112222333", use="Residential",
                remarks="Fenced")
    b = feature(2, square(7.4003, 9.20), plot_no="13", occupant="Yakubu Gana", use="Farm")
    c = feature(3, square(7.40015, 9.20015), plot_no="14", occupant="Overlapping Claim")         # overlaps both
    d = feature(4, square(7.41, 9.21), status="submitted", plot_no="15")
    m = feature(5, {"type": "MultiPolygon", "coordinates": [square(7.42, 9.2)["coordinates"], square(7.43, 9.2)["coordinates"]]}, plot_no="16")

    forms = off.get("/enumeration/geohub").json()
    assert [f["name"] for f in forms[0]["forms"]] == ["Plots"]                     # area forms only
    assert off.post("/enumeration/sources", json={"project_id": PROJECT, "form_id": FORM}).status_code == 403
    fm = {"plot_no": "plot_no", "claimant_name": "occupant", "claimant_phone": "phone", "claimant_id_no": "nin", "land_use": "use", "notes": "remarks"}
    assert reg.post("/enumeration/sources", json={"project_id": PROJECT, "form_id": POINTS}).status_code == 422
    assert reg.post("/enumeration/sources", json={"project_id": PROJECT, "form_id": FORM, "field_map": {"plot_no": "nope"}}).status_code == 422
    r = reg.post("/enumeration/sources", json={"project_id": PROJECT, "form_id": FORM, "field_map": fm,
                                               "defaults": {"locality": "Bwari", "title_kind": "customary_ro", "survey_plan_no": "BW/ENUM/2026"}})
    assert r.status_code == 201, r.text
    s = r.json()
    assert s["form_name"] == "Plots" and s["project_name"] == "Bwari enumeration 2026" and s["imported"] == 0
    assert reg.post("/enumeration/sources", json={"project_id": PROJECT, "form_id": FORM}).status_code == 409

    page = off.get(f"/enumeration/sources/{s['id']}/features").json()
    assert [f["id"] for f in page["features"]] == [a, b, c, m]                       # approved only
    first = page["features"][0]
    assert first["mapped"]["full_address"] == "Plot 12" and first["mapped"]["claimant_name"] == "Aisha Bako" and first["mapped"]["locality"] == "Bwari"
    assert first["imported"] is None

    checks = off.post(f"/enumeration/sources/{s['id']}/check", json={"feature_ids": [a, m]}).json()
    assert checks[0]["ok"] and 900 < checks[0]["area_sqm"] < 1200
    assert not checks[1]["ok"] and "2 separate areas" in checks[1]["problems"][0]

    # register: a and b go in; c overlaps them; d is not approved; m is two areas
    res = off.post(f"/enumeration/sources/{s['id']}/import", json={"feature_ids": [a, b, c, d, m], "lodge_claims": True}).json()
    by = {x["id"]: x for x in res}
    assert by[a]["ok"] and by[b]["ok"] and by[a]["status"] == "active"
    assert by[a]["claim"]["ok"] and by[a]["claim"]["status"] == "lodged"
    assert not by[c]["ok"] and "overlaps" in by[c]["problems"][0]
    assert not by[d]["ok"] and "submitted in Geohub" in by[d]["problems"][0]
    assert not by[m]["ok"]
    p = off.get(f"/parcels/{by[a]['parcel_id']}").json()
    assert p["address"] == "Plot 12" and p["locality"] == "Bwari" and p["land_use"] == "residential" and p["survey_plan_no"] == "BW/ENUM/2026"
    assert "Enumerated in Geohub (Bwari enumeration 2026 / Plots) by Garba Enumerator on 2026-10-30.\nFenced" == p["notes"]
    # the claim waits for a registrar as a grant to the occupant
    ins = reg.get("/instruments").json()
    claim = next(i for i in ins if i["pin"] == by[a]["pin"])
    assert claim["kind"] == "grant" and claim["data"]["title_kind"] == "customary_ro" and claim["data"]["holders"][0]["party"]["id_no"] == "11112222333"
    reg.post(f"/instruments/{claim['id']}/register", json={})
    assert reg.get(f"/parcels/{by[a]['parcel_id']}/register").json()["holders"][0]["name"] == "Aisha Bako"

    # never twice
    again = off.post(f"/enumeration/sources/{s['id']}/import", json={"feature_ids": [a]}).json()
    assert not again[0]["ok"] and by[a]["pin"] in again[0]["problems"][0]
    page = off.get(f"/enumeration/sources/{s['id']}/features").json()
    marks = {f["id"]: f["imported"] for f in page["features"]}
    assert marks[a]["pin"] == by[a]["pin"] and marks[a]["claim_status"] == "registered" and marks[b]["has_claim"] and marks[c] is None
    assert reg.delete(f"/enumeration/sources/{s['id']}").status_code == 409

    # with approval for new parcels, officers' imports wait, and their claims are lodged once approved
    reg.put("/settings/workflow", json={"steps": {"parcel": 1}})
    e = feature(6, square(7.44, 9.2), plot_no="20", occupant="Ladi Musa")
    r = off.post(f"/enumeration/sources/{s['id']}/import", json={"feature_ids": [e], "lodge_claims": True}).json()[0]
    assert r["status"] == "pending" and "claim" not in r
    reg.post(f"/parcels/{r['parcel_id']}/approve", json={})
    lodged = off.post(f"/enumeration/sources/{s['id']}/claims").json()
    assert by[b]["claim"]["ok"] and [x["pin"] for x in lodged if x["ok"]] == [r["pin"]]
    reg.put("/settings/workflow", json={"steps": {"parcel": 0}})


def test_plans(client, person):
    std = {"org_id": str(uuid.uuid4()), "features": ["parcels", "titles", "transactions", "public_lookup"]}
    owner = person(role="owner", **std)
    assert owner.put("/settings/workflow", json={"steps": {"transfer": 2}}).json()["code"] == "no_feature"
    assert owner.get("/settings/workflow").json()["transfer"] == 1
    assert owner.post("/parcels/import/dxf", json={"content": "x"}).json()["code"] == "no_feature"


def test_a_form_from_geohubs_land_template_needs_no_mapping(client, person):
    org = str(uuid.uuid4())
    reg = person(role="owner", name="Registrar Tola", org_id=org, features=FULL)
    tform, tproject = str(uuid.uuid4()), str(uuid.uuid4())
    fields = [{"id": i, "label": i, "type": "text"} for i in ("plot_no", "address", "locality", "land_use", "occupant_kind", "occupant_name",
                                                                "occupant_phone", "occupant_nin", "occupant_rc", "acquired", "acquired_year",
                                                                "documents", "dispute", "dispute_note", "remarks")]
    HUB.projects = [{"id": tproject, "name": "Kuje plots", "description": "", "role": "owner", "forms": [
        {"id": tform, "name": "Plot enumeration", "geometry_type": "area", "version": 1, "features": 2, "approved": 2, "fields": fields,
         "template": "land_enumeration"}]}]
    s = reg.post("/enumeration/sources", json={"project_id": tproject, "form_id": tform}).json()
    assert s["field_map"]["claimant_name"] == "occupant_name" and s["field_map"]["notes"] == "remarks"

    def feat(seq, lon, **props):
        fid = str(uuid.uuid4())
        HUB.features[fid] = {"id": fid, "form_id": tform, "seq": seq, "status": "approved", "version": 1, "form_version": 1,
                             "geometry": square(lon, 8.9), "properties": props, "review_note": None, "reviewed_at": None,
                             "created_at": "2026-11-02T08:00:00Z", "updated_at": None, "created_by_name": "Uche", "reviewed_by_name": "Ada"}
        return fid
    a = feat(1, 7.20, plot_no="4", land_use="Commercial", occupant_kind="Company", occupant_name="Kuje Traders Ltd", occupant_rc="RC123456",
             acquired="Purchase", acquired_year=2019.0, documents=["Survey plan", "Deed of assignment"], dispute=False, remarks="Shop front")
    b = feat(2, 7.21, plot_no="5", land_use="Residential", occupant_kind="Person", occupant_name="Bala Kuje", occupant_nin="22233344455",
             dispute=True, dispute_note="A cousin claims half")
    res = {r["id"]: r for r in reg.post(f"/enumeration/sources/{s['id']}/import", json={"feature_ids": [a, b], "lodge_claims": True}).json()}
    assert res[a]["claim"]["ok"] and not res[b]["claim"]["ok"] and "dispute" in res[b]["claim"]["problems"][0]
    pa = reg.get(f"/parcels/{res[a]['parcel_id']}").json()
    assert pa["land_use"] == "commercial" and pa["address"] == "Plot 4"
    assert "Acquired by purchase in 2019. Documents held: Survey plan, Deed of assignment.\nShop front" in pa["notes"]
    pb = reg.get(f"/parcels/{res[b]['parcel_id']}").json()
    assert "Disputed: A cousin claims half." in pb["notes"]
    grant = next(i for i in reg.get("/instruments").json() if i["pin"] == res[a]["pin"])
    party = grant["data"]["holders"][0]["party"]
    assert party["kind"] == "company" and party["id_type"] == "RC" and party["id_no"] == "RC123456"
    # the disputed claim stays out of "lodge claims waiting" too
    assert all(not x["ok"] for x in reg.post(f"/enumeration/sources/{s['id']}/claims").json())

def test_plots_plotted_from_their_survey_plan_are_recomputed_here(client, person):
    import json
    org = str(uuid.uuid4())
    reg = person(role="owner", name="Registrar Plan", org_id=org, features=FULL)
    form, project = str(uuid.uuid4()), str(uuid.uuid4())
    HUB.projects = [{"id": project, "name": "Plans", "description": "", "role": "owner", "forms": [
        {"id": form, "name": "Plot enumeration", "geometry_type": "area", "version": 1, "features": 2, "approved": 2,
         "fields": [{"id": "plot_no", "label": "Plot number", "type": "text"}], "template": "land_enumeration"}]}]
    s = reg.post("/enumeration/sources", json={"project_id": project, "form_id": form}).json()

    def feat(seq, plan, geometry):
        fid = str(uuid.uuid4())
        HUB.features[fid] = {"id": fid, "form_id": form, "seq": seq, "status": "approved", "version": 1, "form_version": 1, "geometry": geometry,
                             "properties": {"plot_no": str(seq), "gps_src": "plan", "plan_json": json.dumps(plan)}, "review_note": None,
                             "reviewed_at": None, "created_at": "2026-11-06T08:00:00Z", "updated_at": None, "created_by_name": "Uche", "reviewed_by_name": None}
        return fid
    legs = [[89, 59, 50, 30.0], [180, 0, 10, 20.01], [270, 0, 0, 30.0], [0, 0, 0, 20.0]]
    plan = {"v": 1, "grid": 26332, "method": "traverse", "start": [334000, 995000], "legs": legs, "ratio": 11628, "misclosure_m": 0.009}
    # the polygon the phone sent is elsewhere: the plan decides
    a = feat(1, plan, square(7.0, 9.0))
    bad = feat(2, {**plan, "start": [334100, 995000], "legs": [[90, 0, 0, 30], [180, 0, 0, 20], [270, 0, 0, 30], [0, 0, 0, 12]]}, square(7.1, 9.0))
    rows = {f["id"]: f for f in reg.get(f"/enumeration/sources/{s['id']}/features").json()["features"]}
    assert rows[a]["located_by"] == "plan"
    chk = {c["id"]: c for c in reg.post(f"/enumeration/sources/{s['id']}/check", json={"feature_ids": [a, bad]}).json()}
    assert chk[a]["ok"] and chk[a]["method"] == "traverse" and chk[a]["closure"]["ratio"] > 10000 and 595 < chk[a]["area_sqm"] < 605
    assert not chk[bad]["ok"] and "does not close" in " ".join(chk[bad]["problems"])
    res = {r["id"]: r for r in reg.post(f"/enumeration/sources/{s['id']}/import", json={"feature_ids": [a, bad]}).json()}
    assert res[a]["ok"] and not res[bad]["ok"]
    p = reg.get(f"/parcels/{res[a]['parcel_id']}").json()
    assert p["method"] == "traverse" and p["source_epsg"] == 26332 and p["closure_ratio"] > 10000
    assert abs(p["lon"] - 7.4898) < 0.002 and abs(p["lat"] - 9.0001) < 0.002          # where the plan puts it, not where the phone drew it
    assert p["beacons"][0]["easting"] == 334000.0
    # a registrar can close the bad one to its start, saying why: kept with the parcel
    why = "Field team confirmed beacon PL04; plan misprinted."
    res = {r["id"]: r for r in reg.post(f"/enumeration/sources/{s['id']}/import", json={"feature_ids": [bad], "close": {bad: why}}).json()}
    assert res[bad]["ok"], res[bad]
    q = reg.get(f"/parcels/{res[bad]['parcel_id']}").json()
    assert q["closed_to_start"]["reason"] == why and q["closed_to_start"]["leg"] == 4 and q["closed_to_start"]["distance_m"] == 20.0
