-- GeoEstate Land Registry: the parcel fabric. Every row belongs to one organization (a land bureau, an estate, a
-- survey firm), by its Geohub organization id; people come from GeoEstate ID, so there is no users table here.

-- Each organization's settings: its survey grid, how parcel numbers (PINs) are made, how strict closure is.
CREATE TABLE settings (
  org_id uuid PRIMARY KEY,
  org_name text NOT NULL DEFAULT '',
  default_epsg int NOT NULL DEFAULT 26331,
  pin_prefix text NOT NULL DEFAULT 'GE' CHECK (pin_prefix ~ '^[A-Z0-9]{1,8}$'),
  pin_next int NOT NULL DEFAULT 1,
  closure_ratio int NOT NULL DEFAULT 5000,             -- a traverse must close to better than 1 in this many
  overlap_tolerance_sqm numeric(10,2) NOT NULL DEFAULT 1.0,   -- slivers below this are reported, not refused
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE parcels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  pin text NOT NULL,
  geom geometry(Polygon, 4326) NOT NULL,
  area_sqm numeric(14,2) NOT NULL,
  perimeter_m numeric(12,2) NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  land_use text NOT NULL DEFAULT '' ,                 -- residential, commercial, agricultural, …
  address text NOT NULL DEFAULT '',
  locality text NOT NULL DEFAULT '',                  -- town, LGA, layout or estate
  notes text NOT NULL DEFAULT '',
  -- how it was captured
  method text NOT NULL CHECK (method IN ('traverse','coordinates')),
  source_epsg int NOT NULL,
  closure_error_m numeric(10,3),
  closure_ratio int,
  survey_plan_no text NOT NULL DEFAULT '',
  surveyor text NOT NULL DEFAULT '',
  survey_date date,
  retired_reason text,
  created_by text NOT NULL,                           -- the person's GeoEstate ID (sub) and name
  created_by_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, pin)
);
CREATE INDEX parcels_geom_idx ON parcels USING gist (geom);
CREATE INDEX parcels_org_idx ON parcels (org_id, status, created_at DESC);

-- The beacons (corner pillars) in order around the boundary, in the grid they were surveyed in and in WGS84.
CREATE TABLE beacons (
  parcel_id uuid NOT NULL REFERENCES parcels ON DELETE CASCADE,
  seq int NOT NULL,
  name text NOT NULL DEFAULT '',
  easting numeric(14,3),
  northing numeric(14,3),
  lon double precision NOT NULL,
  lat double precision NOT NULL,
  PRIMARY KEY (parcel_id, seq)
);

CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  org_id uuid NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  actor_id text,
  actor_name text,
  action text NOT NULL,
  target_type text,
  target_id text,
  details jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_log_org_idx ON audit_log (org_id, id DESC);
