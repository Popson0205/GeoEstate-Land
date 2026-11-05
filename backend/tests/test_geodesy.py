import pytest

from app import geodesy
from app.errors import Problem

LAGOS = (538700.0, 730000.0)          # Minna / UTM 31N, near Ikeja


def test_bearings_in_every_way_surveyors_write_them():
    assert geodesy.parse_bearing("123.5") == 123.5
    assert geodesy.parse_bearing(90) == 90
    assert geodesy.parse_bearing("123°30'") == pytest.approx(123.5)
    assert geodesy.parse_bearing("123°30'36\"") == pytest.approx(123.51)
    assert geodesy.parse_bearing("123 30 36") == pytest.approx(123.51)
    assert geodesy.parse_bearing("123-30-36") == pytest.approx(123.51)
    for bad in ("361", "12°75'", "north", "-5"):
        with pytest.raises(Problem):
            geodesy.parse_bearing(bad)
    assert geodesy.dms(123.51) == "123°30'36\""


def test_a_square_closes_exactly_and_lands_in_lagos():
    t = geodesy.traverse(LAGOS, [(0, 100), (90, 100), (180, 100), (270, 100)], 5000)
    assert t.ratio is None and t.misclosure_m < 1e-6 and len(t.points) == 4 and not t.adjusted
    b = geodesy.boundary(geodesy.to_wgs84(t.points, 26331))
    lon, lat = b.ring[0]
    assert 3.3 < lon < 3.4 and 6.55 < lat < 6.65 and not b.problems
    assert 9990 < b.area_sqm < 10020 and 399 < b.perimeter_m < 401         # grid metres vs metres on the ground


def test_a_small_misclosure_is_spread_by_the_bowditch_rule():
    t = geodesy.traverse(LAGOS, [(0, 100), (90, 100), (180, 100.05), (270, 100)], 5000)
    assert t.ratio == 8000 and t.adjusted and abs(t.misclosure_n + 0.05) < 1e-6        # it ended 5 cm south of the start
    # each point moves north in proportion to the distance walked to it: the first beacon by 0.05 × 100 / 400.05
    assert abs(t.points[1][1] - (LAGOS[1] + 100 + 0.05 * 100 / 400.05)) < 1e-6
    assert abs(t.points[3][1] - (LAGOS[1] - 0.05 + 0.05 * 300.05 / 400.05)) < 1e-6
    bad = geodesy.traverse(LAGOS, [(0, 100), (90, 100), (180, 101), (270, 100)], 5000)
    assert bad.ratio == 401 and not bad.adjusted


def test_shapes_that_are_not_parcels():
    bow = geodesy.to_wgs84([(538700, 730000), (538800, 730100), (538800, 730000), (538700, 730100)], 26331)
    assert any("crosses itself" in p for p in geodesy.boundary(bow).problems)
    line = geodesy.to_wgs84([(538700, 730000), (538750, 730000), (538800, 730000)], 26331)
    assert any("no area" in p for p in geodesy.boundary(line).problems)
    far = geodesy.boundary([(30.0, 6.5), (30.001, 6.5), (30.001, 6.501)])
    assert any("outside Nigeria" in p for p in far.problems)
    with pytest.raises(Problem):
        geodesy.traverse(LAGOS, [(0, 100), (90, 100)], 5000)
