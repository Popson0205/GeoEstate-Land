"""A real plan whose figures do not close (Ofosu, Ondo State): the check says which leg to look at."""
import uuid

PLAN = [("33°12'", 15.06), ("113°48'", 31.49), ("200°09'", 15.25), ("293°06'", 35.06)]   # PL01 → PL02 → PL03 → PL04 → PL01
START = {"easting": 736803.212, "northing": 748198.618}


def body(legs, area=None):
    return {"method": "traverse", "epsg": 26331, "start": START, "legs": [{"bearing": b, "distance_m": d} for b, d in legs],
            **({"plan_area_sqm": area} if area else {})}


def test_the_leg_that_is_off_is_found_from_the_plans_area(client, person):
    off = person(role="member", org_id=str(uuid.uuid4()))
    c = off.post("/parcels/check", json=body(PLAN)).json()
    assert not c["ok"] and "1 in 120" in c["problems"][0] and "Give the area printed on the plan" in c["problems"][1]
    c = off.post("/parcels/check", json=body(PLAN, 499.489)).json()
    s = c["closure"]["suspect"]
    assert s["leg"] == 4 and s["bearing_dms"].startswith("294°23'") and s["distance_m"] == 34.92
    assert "Leg 4 is the one to check" in c["problems"][1]
    # with leg 4 as the area says, it closes, and the area agrees with the plan's
    fixed = off.post("/parcels/check", json=body(PLAN[:3] + [(s["bearing_dms"], 34.92)], 499.489)).json()
    assert fixed["ok"] and abs(fixed["area_sqm"] - 499.5) < 1 and not fixed["warnings"]
    # an area that does not match the figures is pointed out
    other = off.post("/parcels/check", json=body(PLAN[:3] + [(s["bearing_dms"], 34.92)], 520)).json()
    assert any("The plan gives 520.00 m²" in w for w in other["warnings"])


def test_a_registrar_can_close_a_traverse_to_its_start_with_a_reason(client, person):
    org = str(uuid.uuid4())
    reg = person(role="owner", org_id=org)
    officer = person(role="member", org_id=org)
    assert reg.get("/me").json()["role"] == "registrar" and officer.get("/me").json()["role"] != "registrar"
    close = {"close_to_start": True, "close_reason": "Confirmed with the surveyor: PL04 to PL01 misprinted."}
    # an officer cannot, and a registrar must say why
    c = officer.post("/parcels/check", json=body(PLAN) | close).json()
    assert not c["ok"] and any("Only a registrar" in p for p in c["problems"])
    c = reg.post("/parcels/check", json=body(PLAN) | {"close_to_start": True}).json()
    assert not c["ok"] and any("Say why" in p for p in c["problems"])
    # it closes, the last leg replaced; the plan's own misclosure is kept
    c = reg.post("/parcels/check", json=body(PLAN, 499.489) | close).json()
    assert c["ok"], c["problems"]
    cl = c["closure"]["closed"]
    assert cl["leg"] == 4 and cl["bearing_dms"].startswith("294°23'") and cl["distance_m"] == 34.92 and cl["plan_ratio"] == 120
    assert c["closure"]["ratio"] == 120 and abs(c["area_sqm"] - 499.5) < 1 and any("Closed to the starting point" in w for w in c["warnings"])
    p = reg.post("/parcels", json=body(PLAN, 499.489) | close).json()
    assert p["closed_to_start"]["reason"].startswith("Confirmed") and p["closed_to_start"]["plan_bearing_dms"] == "293°06'00\""
    assert p["closure_ratio"] == 120 and any(h["action"] == "parcel.create" and h["details"].get("closed_to_start") for h in p["history"])


def test_closing_to_the_start_is_refused_when_another_leg_is_wrong(client, person):
    reg = person(role="owner", org_id=str(uuid.uuid4()))
    # leg 2 misread by a degree: the plan's area (from the true figures) points to leg 2, not the last leg
    true = [("33°12'", 15.06), ("113°48'", 31.49), ("200°09'", 15.25), ("294°23'34\"", 34.92)]
    true_area = 499.489                               # the plane (grid) area of the true figures, as a plan prints it
    misread = [true[0], ("114°48'", 31.49), true[2], true[3]]
    c = reg.post("/parcels/check", json=body(misread, true_area) | {"close_to_start": True, "close_reason": "Surveyor says close it."}).json()
    assert not c["ok"] and any("points to leg 2" in p for p in c["problems"])
