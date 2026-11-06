-- A traverse a registrar closed to its starting point (as CAD "close" does): the plan's last leg was replaced by the
-- leg that returns to the start. Kept with the parcel: the plan's own figures, the leg used instead, who, and why.
ALTER TABLE parcels ADD COLUMN IF NOT EXISTS closed_to_start jsonb;
