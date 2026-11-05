-- Part 3: each organization's own workflow (how many registrars approve each kind of change), parcels that wait for
-- approval, subdivision and amalgamation as instruments, the parcels' lineage, and ground control for correcting old
-- survey grids.

-- How many registrars approve each kind of change: 0 = it takes effect when lodged, 1 = a registrar, 2 = two different
-- registrars (neither of them whoever lodged it). Kinds not listed take 1; "parcel" is a new parcel from the fabric.
ALTER TABLE settings ADD COLUMN workflow jsonb NOT NULL DEFAULT '{"parcel": 0}';
-- Per survey grid, how plans on it are corrected to the true ground: {"26332": "shift"} (off, shift, helmert, affine)
ALTER TABLE settings ADD COLUMN corrections jsonb NOT NULL DEFAULT '{}';

ALTER TABLE parcels DROP CONSTRAINT parcels_status_check;
ALTER TABLE parcels ADD CONSTRAINT parcels_status_check CHECK (status IN ('pending','active','retired','rejected'));
ALTER TABLE parcels ADD COLUMN decided_by_name text, ADD COLUMN decided_at timestamptz, ADD COLUMN decision_note text NOT NULL DEFAULT '',
  ADD COLUMN correction jsonb;                       -- how the survey was corrected to ground control, if it was

ALTER TABLE instruments DROP CONSTRAINT instruments_kind_check;
ALTER TABLE instruments ADD CONSTRAINT instruments_kind_check
  CHECK (kind IN ('grant','transfer','mortgage','caveat','lease','discharge','revocation','subdivision','amalgamation'));
ALTER TABLE titles DROP CONSTRAINT titles_status_check;
ALTER TABLE titles ADD CONSTRAINT titles_status_check CHECK (status IN ('current','revoked','superseded'));

CREATE TABLE approvals (
  id bigserial PRIMARY KEY,
  target_type text NOT NULL CHECK (target_type IN ('instrument','parcel')),
  target_id uuid NOT NULL,
  by_id text NOT NULL,
  by_name text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  note text NOT NULL DEFAULT '',
  UNIQUE (target_type, target_id, by_id)
);

-- Where a parcel came from: subdivided out of, or amalgamated from, others.
CREATE TABLE lineage (
  parent_id uuid NOT NULL REFERENCES parcels,
  child_id uuid NOT NULL REFERENCES parcels,
  instrument_id uuid NOT NULL REFERENCES instruments,
  PRIMARY KEY (parent_id, child_id)
);
CREATE INDEX lineage_child_idx ON lineage (child_id);

-- Ground control: points whose true position is known, and where old plans on a grid put them.
CREATE TABLE control_points (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  epsg int NOT NULL,
  name text NOT NULL,
  plan_e numeric(14,3) NOT NULL, plan_n numeric(14,3) NOT NULL,     -- as the plans have it
  true_e numeric(14,3) NOT NULL, true_n numeric(14,3) NOT NULL,     -- as observed (e.g. GNSS), on the same grid
  notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, epsg, name)
);
