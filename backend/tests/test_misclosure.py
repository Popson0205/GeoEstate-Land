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
