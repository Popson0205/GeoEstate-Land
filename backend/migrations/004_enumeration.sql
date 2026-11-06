-- Enumeration: parcels a field team mapped with a Geohub area form, brought into the register.

-- A Geohub form the registry takes parcels from, and which of its questions mean what.
CREATE TABLE enum_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  project_id uuid NOT NULL,                -- in Geohub
  project_name text NOT NULL,
  form_id uuid NOT NULL,                   -- in Geohub
  form_name text NOT NULL,
  -- {"plot_no": "<field id>", "address": …, "locality": …, "land_use": …, "notes": …, "claimant_name": …, "claimant_phone": …,
  --  "claimant_id_no": …}
  field_map jsonb NOT NULL DEFAULT '{}',
  -- {"locality": "Kabusa", "land_use": "residential", "title_kind": "customary_ro", "survey_plan_no": "…"}
  defaults jsonb NOT NULL DEFAULT '{}',
  created_by_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, form_id)
);

-- Each enumerated feature brought in: the parcel it became, and the claim (a grant to the occupant) when lodged.
CREATE TABLE enum_imports (
  org_id uuid NOT NULL,
  feature_id uuid NOT NULL,                -- in Geohub
  source_id uuid NOT NULL REFERENCES enum_sources ON DELETE CASCADE,
  feature_version int NOT NULL,
  parcel_id uuid NOT NULL REFERENCES parcels,
  claim jsonb,                             -- the claimant as enumerated, until a grant is lodged
  instrument_id uuid REFERENCES instruments,
  imported_by_name text NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, feature_id)
);
CREATE INDEX enum_imports_source_idx ON enum_imports (source_id);
