-- Titles and land records. The register of each parcel is built from instruments (a grant, a transfer, a mortgage, a
-- caveat…): an officer lodges one, a registrar registers or rejects it, and only a registered instrument changes the
-- register. Nothing is overwritten: a proprietor or an encumbrance ends by the instrument that ended it, so the whole
-- history of every parcel stays readable.

ALTER TABLE settings
  ADD COLUMN org_slug text NOT NULL DEFAULT '',
  ADD COLUMN title_prefix text NOT NULL DEFAULT 'TR' CHECK (title_prefix ~ '^[A-Z0-9/]{1,12}$'),
  ADD COLUMN title_next int NOT NULL DEFAULT 1,
  ADD COLUMN instrument_next int NOT NULL DEFAULT 1,
  -- what anyone can see at the public lookup: off, the parcel and whether it is titled or encumbered, or also the proprietors
  ADD COLUMN public_lookup text NOT NULL DEFAULT 'off' CHECK (public_lookup IN ('off','basic','holders'));
CREATE INDEX settings_slug_idx ON settings (org_slug);

-- People, companies, governments and communities that hold land or have rights over it.
CREATE TABLE parties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  kind text NOT NULL DEFAULT 'person' CHECK (kind IN ('person','company','government','community','trustees')),
  name text NOT NULL,
  id_type text NOT NULL DEFAULT '',      -- NIN, RC (CAC), passport, …
  id_no text NOT NULL DEFAULT '',
  phone text NOT NULL DEFAULT '',
  email text NOT NULL DEFAULT '',
  address text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX parties_org_idx ON parties (org_id, lower(name));
CREATE UNIQUE INDEX parties_id_no_idx ON parties (org_id, id_type, id_no) WHERE id_no <> '';

CREATE TABLE instruments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  number text NOT NULL,                   -- INS/2026/000123
  parcel_id uuid NOT NULL REFERENCES parcels,
  kind text NOT NULL CHECK (kind IN ('grant','transfer','mortgage','caveat','lease','discharge','revocation')),
  status text NOT NULL DEFAULT 'lodged' CHECK (status IN ('lodged','registered','rejected','withdrawn')),
  data jsonb NOT NULL,                    -- what the instrument says (proprietors, amounts, terms…), as lodged
  instrument_date date,                   -- the date on the deed
  reference text NOT NULL DEFAULT '',     -- e.g. Governor's consent number, court order number
  consideration_ngn numeric(16,2),
  lodged_by text NOT NULL, lodged_by_name text NOT NULL, lodged_at timestamptz NOT NULL DEFAULT now(),
  decided_by text, decided_by_name text, decided_at timestamptz, decision_note text NOT NULL DEFAULT '',
  UNIQUE (org_id, number)
);
CREATE INDEX instruments_parcel_idx ON instruments (parcel_id, lodged_at DESC);
CREATE INDEX instruments_queue_idx ON instruments (org_id, status, lodged_at);

-- The title to a parcel (one current title per parcel): a statutory or customary right of occupancy, a lease…
CREATE TABLE titles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  parcel_id uuid NOT NULL REFERENCES parcels,
  title_no text NOT NULL,
  kind text NOT NULL,                     -- statutory_ro, customary_ro, lease, freehold, allocation
  status text NOT NULL DEFAULT 'current' CHECK (status IN ('current','revoked')),
  purpose text NOT NULL DEFAULT '',
  term_years int,
  starts_on date,
  ends_on date,
  ground_rent_ngn numeric(14,2),
  granted_by uuid NOT NULL REFERENCES instruments,
  ended_by uuid REFERENCES instruments,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, title_no)
);
CREATE UNIQUE INDEX titles_current_idx ON titles (parcel_id) WHERE status = 'current';

-- Who holds the title, and in what share, from the instrument that made them proprietors to the one that ended it.
CREATE TABLE holdings (
  id bigserial PRIMARY KEY,
  title_id uuid NOT NULL REFERENCES titles,
  party_id uuid NOT NULL REFERENCES parties,
  share text NOT NULL DEFAULT '1/1',
  from_instrument uuid NOT NULL REFERENCES instruments,
  to_instrument uuid REFERENCES instruments
);
CREATE INDEX holdings_title_idx ON holdings (title_id) WHERE to_instrument IS NULL;
CREATE INDEX holdings_party_idx ON holdings (party_id);

-- Mortgages, caveats and leases on a title, until discharged (or the title ends).
CREATE TABLE encumbrances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title_id uuid NOT NULL REFERENCES titles,
  kind text NOT NULL CHECK (kind IN ('mortgage','caveat','lease')),
  party_id uuid REFERENCES parties,       -- the mortgagee, the caveator, the lessee
  amount_ngn numeric(16,2),
  term_years int,
  details text NOT NULL DEFAULT '',
  from_instrument uuid NOT NULL REFERENCES instruments,
  to_instrument uuid REFERENCES instruments
);
CREATE INDEX encumbrances_title_idx ON encumbrances (title_id) WHERE to_instrument IS NULL;
