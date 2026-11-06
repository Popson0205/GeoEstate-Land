import io
import uuid

import ezdxf

ORG3 = str(uuid.uuid4())
ALL = ["parcels", "titles", "transactions", "public_lookup"]


def team(person):
    base = {"org_id": ORG3, "org": "Abuja Layouts Bureau", "features": ALL}
    return (person(role="owner", name="Registrar Ada", **base), person(role="admin", name="Registrar Bello", **base),
            person(role="member", name="Officer Chika", **base))


def square(e, n, w=40, h=50):
    return {"method": "coordinates", "epsg": 26332, "points": [{"x": e, "y": n, "beacon": "A"}, {"x": e, "y": n + h, "beacon": "B"},
                                                               {"x": e + w, "y": n + h, "beacon": "C"}, {"x": e + w, "y": n, "beacon": "D"}]}


def test_workflow_and_approvals(client, person):
    ada, bello, chika = team(person)
    w = ada.put("/settings/workflow", json={"steps": {"parcel": 1, "transfer": 2, "mortgage": 0}}).json()
    assert w["parcel"] == 1 and w["transfer"] == 2 and w["mortgage"] == 0 and w["grant"] == 1 and w["subdivision"] == 1
    assert ada.put("/settings/workflow", json={"steps": {"parcel": 2}}).status_code == 422
    assert chika.put("/settings/workflow", json={"steps": {"parcel": 0}}).status_code == 403

    # an officer's new parcel waits for a registrar, and holds its ground meanwhile
    r = chika.post("/parcels", json={**square(400000, 1000000), "address": "Plot 1"})
    p = r.json()
    assert r.status_code == 201 and p["status"] == "pending"
    again = chika.post("/parcels", json=square(400010, 1000010))
    assert again.status_code == 422 and p["pin"] in again.json()["detail"]
    assert [x["pin"] for x in chika.get("/parcels", params={"status": "pending"}).json()] == [p["pin"]]
    assert chika.post(f"/parcels/{p['id']}/approve", json={}).status_code == 403
    ok = ada.post(f"/parcels/{p['id']}/approve", json={"note": "Plan checked."}).json()
    assert ok["status"] == "active" and ok["decided_by_name"] == "Registrar Ada"
    p2 = chika.post("/parcels", json=square(400100, 1000000)).json()
    assert ada.post(f"/parcels/{p2['id']}/reject", json={"note": ""}).status_code == 422
    assert ada.post(f"/parcels/{p2['id']}/reject", json={"note": "Wrong grid."}).json()["status"] == "rejected"
    assert ada.post("/parcels", json=square(400200, 1000000)).json()["status"] == "active"      # a registrar's own: no wait

    pid = p["id"]
    ada.post(f"/parcels/{pid}/instruments", json={"kind": "grant", "title_kind": "statutory_ro", "register_now": True,
                                                  "holders": [{"party": {"name": "Musa Danladi"}}]})
    # no approval for a mortgage here: an officer's lodging registers it
    m = chika.post(f"/parcels/{pid}/instruments", json={"kind": "mortgage", "party": {"name": "Access Bank"}, "amount_ngn": 2e6}).json()
    assert m["status"] == "registered" and m["decided_by_name"] == "Officer Chika"
    # two registrars for a transfer, neither the one who lodged it
    t = chika.post(f"/parcels/{pid}/instruments", json={"kind": "transfer", "holders": [{"party": {"name": "Zainab Musa"}}]}).json()
    one = ada.post(f"/instruments/{t['id']}/register", json={"note": "Consent seen."}).json()
    assert one["status"] == "lodged" and [a["by_name"] for a in one["approvals"]] == ["Registrar Ada"] and one["steps"] == 2
    assert ada.post(f"/instruments/{t['id']}/register", json={}).status_code == 409
    two = bello.post(f"/instruments/{t['id']}/register", json={}).json()
    assert two["status"] == "registered" and len(two["approvals"]) == 2
    own = ada.post(f"/parcels/{pid}/instruments", json={"kind": "transfer", "register_now": True, "holders": [{"party": {"name": "Ada Lovelace"}}]}).json()
    assert own["status"] == "lodged" and "two registrars" in own["warnings"][-1]
    assert ada.post(f"/instruments/{own['id']}/register", json={}).json()["code"] == "own_lodging"
    bello.post(f"/instruments/{own['id']}/withdraw")


def test_subdivision_and_amalgamation(client, person):
    ada, bello, chika = team(person)
    ada.put("/settings/workflow", json={"steps": {"parcel": 0, "subdivision": 1, "amalgamation": 1, "mortgage": 1, "grant": 1}})
    p = ada.post("/parcels", json={**square(401000, 1000000), "address": "Plot 9", "locality": "Kubwa", "land_use": "residential"}).json()
    ada.post(f"/parcels/{p['id']}/instruments", json={"kind": "grant", "title_kind": "statutory_ro", "term_years": 99, "starts_on": "2020-01-01",
                                                      "ground_rent_ngn": 30000, "register_now": True,
                                                      "holders": [{"party": {"name": "Ifeoma Nwosu"}, "share": "1/1"}]})
    ada.post(f"/parcels/{p['id']}/instruments", json={"kind": "mortgage", "party": {"name": "First Bank"}, "amount_ngn": 9e6, "register_now": True})
    # a line that does not cross the parcel divides nothing
    bad = chika.post(f"/parcels/{p['id']}/instruments", json={"kind": "subdivision", "cut_epsg": 26332, "cut": [[401010, 999990], [401010, 1000020]]})
    assert bad.status_code == 422 and bad.json()["code"] == "not_divided"
    sub = chika.post(f"/parcels/{p['id']}/instruments", json={"kind": "subdivision", "cut_epsg": 26332,
                                                             "cut": [[401020, 999990], [401020, 1000060]]})
    assert sub.status_code == 201, sub.text
    s = sub.json()
    assert len(s["data"]["pieces"]) == 2 and all(990 < x["area_sqm"] < 1010 for x in s["data"]["pieces"])
    assert any("new title" in w for w in s["warnings"])
    # while it waits, nothing else can be lodged that changes this parcel's land
    done = ada.post(f"/instruments/{s['id']}/register", json={}).json()
    assert done["status"] == "registered"
    kids = done["data"]["children"]
    assert len(kids) == 2
    old = ada.get(f"/parcels/{p['id']}").json()
    assert old["status"] == "retired" and "Subdivided into" in old["retired_reason"] and [c["pin"] for c in old["children"]] == sorted(k["pin"] for k in kids)
    k1 = ada.get(f"/parcels/{kids[0]['id']}").json()
    assert k1["parents"][0]["pin"] == p["pin"] and k1["address"].startswith("Plot 9 (part 1 of 2") and k1["locality"] == "Kubwa"
    names = [b["name"] for b in k1["beacons"]]
    assert "N1" in names and len({"A", "B", "C", "D"} & set(names)) == 2
    reg1 = ada.get(f"/parcels/{kids[0]['id']}/register").json()
    assert [h["name"] for h in reg1["holders"]] == ["Ifeoma Nwosu"] and [e["party_name"] for e in reg1["encumbrances"]] == ["First Bank"]
    assert reg1["title"]["term_years"] == 99 and reg1["title"]["ends_on"] == "2119-01-01" and float(reg1["title"]["ground_rent_ngn"]) == 15000
    oldreg = ada.get(f"/parcels/{p['id']}/register").json()
    assert oldreg["title"] is None and oldreg["past_titles"][0]["status"] == "superseded"

    # amalgamate the two halves again: one parcel, one title, the mortgage once
    far = ada.post("/parcels", json=square(402000, 1000000)).json()
    nope = chika.post(f"/parcels/{kids[0]['id']}/instruments", json={"kind": "amalgamation", "parcels": [far["id"]]})
    assert nope.status_code == 422 and nope.json()["code"] == "not_adjacent"
    am = chika.post(f"/parcels/{kids[0]['id']}/instruments", json={"kind": "amalgamation", "parcels": [kids[1]["id"]]}).json()
    assert 1990 < am["data"]["area_sqm"] < 2010 and am["summary"].startswith(f"With {kids[1]['pin']}")
    # a lodged change on a parcel stops a second one
    assert chika.post(f"/parcels/{kids[1]['id']}/instruments", json={"kind": "subdivision", "cut_epsg": 26332,
                                                                     "cut": [[401030, 999990], [401030, 1000060]]}).status_code == 422
    done = ada.post(f"/instruments/{am['id']}/register", json={}).json()
    merged = done["data"]["children"][0]
    reg = ada.get(f"/parcels/{merged['id']}/register").json()
    assert len(reg["encumbrances"]) == 1 and float(reg["title"]["ground_rent_ngn"]) == 30000
    m = ada.get(f"/parcels/{merged['id']}").json()
    assert sorted(x["pin"] for x in m["parents"]) == sorted(k["pin"] for k in kids) and len(m["beacons"]) == 4


def _dxf() -> str:
    doc = ezdxf.new("R2010")
    msp = doc.modelspace()
    for i, e in enumerate((403000, 403030, 403060)):
        pts = [(e, 1000000), (e, 1000040), (e + 30, 1000040), (e + 30, 1000000)]
        msp.add_lwpolyline(pts, close=True, dxfattribs={"layer": "PLOTS"})
        msp.add_text(f"PLOT {i + 1}", dxfattribs={"insert": (e + 12, 1000020), "height": 2})
    msp.add_text("PB 501", dxfattribs={"insert": (403000.5, 1000000.5), "height": 1})
    msp.add_lwpolyline([(403000, 999990), (403090, 999990)], dxfattribs={"layer": "ROAD"})      # an open line is not a parcel
    out = io.StringIO()
    doc.write(out)
    return out.getvalue()


def test_dxf_import(client, person):
    _, _, chika = team(person)
    r = chika.post("/parcels/import/dxf", json={"filename": "layout.dxf", "content": _dxf()})
    assert r.status_code == 200, r.text
    d = r.json()
    assert len(d["shapes"]) == 3 and d["layers"] == ["PLOTS"]
    first = d["shapes"][0]
    assert first["label"] == "PLOT 1" and first["area_plan"] == 1200 and first["points"][0] == {"x": 403000, "y": 1000000, "beacon": "PB 501"}
    # each shape goes through the ordinary check
    c = chika.post("/parcels/check", json={"method": "coordinates", "epsg": 26332, "points": first["points"]}).json()
    assert c["ok"] and 1195 < c["area_sqm"] < 1205
    assert chika.post("/parcels/import/dxf", json={"content": "not a drawing"}).json()["code"] == "bad_dxf"


def test_ground_control_correction(client, person):
    ada, _, chika = team(person)
    pts = [("GCP1", 404000, 1000000), ("GCP2", 405000, 1000000), ("GCP3", 404500, 1001000)]
    assert ada.put("/settings/corrections", json={"epsg": 26332, "method": "shift"}).json()["code"] == "too_few_control"
    for name, e, n in pts:
        r = ada.post("/control", json={"epsg": 26332, "name": name, "plan_e": e, "plan_n": n, "true_e": e + 3.0, "true_n": n - 2.0})
        assert r.status_code == 201, r.text
    assert ada.post("/control", json={"epsg": 26332, "name": "GCP1", "plan_e": 1, "plan_n": 1, "true_e": 1, "true_n": 1}).status_code == 409
    assert chika.post("/control", json={"epsg": 26332, "name": "X", "plan_e": 1, "plan_n": 1, "true_e": 1, "true_n": 1}).status_code == 403
    c = ada.get("/control", params={"epsg": 26332}).json()
    assert len(c["points"]) == 3 and c["fits"]["shift"]["shift_e"] == 3.0 and c["fits"]["helmert"]["rms_m"] < 0.001 and c["method"] == "off"
    before = chika.post("/parcels/check", json=square(404400, 1000400)).json()
    assert before["correction"] is None
    assert ada.put("/settings/corrections", json={"epsg": 26332, "method": "shift"}).json()["method"] == "shift"
    after = chika.post("/parcels/check", json=square(404400, 1000400)).json()
    assert after["correction"]["method"] == "shift" and after["correction"]["shift_n"] == -2.0
    assert after["beacons"][0]["easting"] == 404400                    # the plan's own figures are kept
    assert abs(after["beacons"][0]["lon"] - before["beacons"][0]["lon"]) > 1e-5    # ... and the ground position moves
    p = chika.post("/parcels", json=square(404400, 1000400)).json()
    assert p["correction"]["method"] == "shift"
    ada.put("/settings/corrections", json={"epsg": 26332, "method": "off"})
    cid = c["points"][0]["id"]
    assert len(ada.delete(f"/control/{cid}").json()["points"]) == 2
