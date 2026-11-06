# GeoEstate Land Registry

The parcel fabric and register for land agencies, estates and surveyors: part of the GeoEstate platform, beside Geohub,
LandCheck and FarmScan. One sign-in (GeoEstate ID, through Geohub), one licence system, one look.

**The parcel fabric (part 1)**

- **Capture a parcel from a survey**: a bearing-and-distance traverse from a starting beacon, or beacon coordinates, on the
  grid the plan uses (Minna / UTM 31N and 32N, the old Nigeria belts, WGS 84 UTM, or GPS). Rows can be pasted from a
  spreadsheet or typed from the survey plan.
- **Check it before it goes in**: misclosure and closure ratio (1 in N) against the registry's rule, Bowditch adjustment,
  true area and perimeter, a boundary that crosses itself or falls outside Nigeria, and overlaps with every registered parcel
  (slivers under the registry's tolerance are let through with a warning).
- **Register it**: a PIN (`KLA-000123`), its beacons kept with grid and geographic coordinates, its survey plan, surveyor and use.
- **The register**: search by PIN, address, locality, survey plan or surveyor; a map of the fabric; each parcel's page with its
  beacons, neighbours and history; retiring a parcel (it leaves the fabric, its record stays); the organization's settings; an
  activity log.

**Titles and land records (part 2)**

- **Instruments**: a grant of title, transfer, mortgage, caveat, lease, discharge or revocation is lodged against a parcel by an
  officer and registered (or rejected, with the reason) by a registrar; registrars can lodge and register at once. Each is
  checked when lodged and again when registered: one current title per parcel, shares that add up to 1, a caveat stops a
  transfer, a mortgage goes along with it, a discharge must name something still on the title.
- **The register of each parcel**: its title (C of O, customary right, lease, freehold, allocation; term, ground rent),
  proprietors and their shares, and encumbrances. Nothing is overwritten: every proprietor and encumbrance keeps the instrument
  that began it and the one that ended it.
- **Parties**: people, companies, governments, communities and trustees, found again by name or ID number (NIN, CAC RC), each
  with the land they hold, held, or have rights over. The register can be searched by proprietor or title number.
- **A register extract** to print or save as PDF, and an **instruments day book** (waiting, registered, rejected, withdrawn).
- **A public lookup** at `/lookup/<organization>`, off until a registrar turns it on: anyone can check a PIN or title number
  and see whether it is titled, encumbered or has dealings waiting, and optionally who the proprietors are. No ID numbers,
  amounts or contacts are shown, and it is limited to 30 lookups a minute from one address.

Licence features (from the organization's Land Registry plan in Geohub): `parcels`, `titles` (grants and revocations),
`transactions` (transfers, mortgages, caveats, leases, discharges) and `public_lookup`.

**Workflows, drawings, ground control, subdivision (part 3)**

- **Each organization's workflow**: for a new parcel and for every kind of instrument, a registrar chooses whether it takes
  effect when lodged, needs one registrar, or needs two different registrars (neither of them whoever lodged it). A parcel
  waiting for approval holds its ground (nothing may overlap it) but takes no title until approved.
- **DXF drawings**: a surveyor's DXF gives one parcel's boundary (closed polylines, with the beacon numbers written by the
  corners), or a **whole layout** at once: every plot is read, checked and registered with its plot number as its address.
- **Ground control**: control points whose true positions are known (e.g. by GNSS), against where the old plans put them,
  per survey grid; the registry chooses a shift, a similarity (Helmert) or an affine correction, sees each one's residuals,
  and from then on every survey on that grid is corrected (the plan's own figures are kept beside the corrected position).
- **Subdivision and amalgamation** as instruments: a cut line drawn on the map (or given on the survey grid) divides a
  parcel; neighbours that share a boundary become one. New PINs, beacons kept or numbered N1, N2…, the old parcels retired
  with their lineage; titled land carries its proprietors, terms (ground rent apportioned by area) and encumbrances to
  the new titles.

**Enumeration from Geohub (part 4)**

- A registrar connects a Geohub form that maps areas and says which question holds the plot number, address, locality,
  land use, notes, and the occupant's name, phone and NIN (guessed from the questions to start with), with defaults.
- Officers see the form's plots as Geohub has them (approved by a supervisor in Geohub's review), check them like any
  survey, and register them: each becomes a parcel through the organization's workflow, linked to its Geohub feature so
  it is never brought in twice (and flagged if it changes in Geohub afterwards).
- Each occupant, as enumerated, is kept as a claim and can be lodged as a grant (a customary right of occupancy unless the
  source says otherwise) for a registrar to decide: systematic first registration. Claims for parcels that waited for
  approval are lodged later with "Lodge claims waiting".
- Geohub is read as the signed-in person through GeoEstate ID (`/id/data` in Geohub), so only forms they could open in
  Geohub are offered.

Plans: survey plan (DXF) import and choosing the workflow are part of Land Registry Advanced (`dxf_import`, `workflows`);
on Standard the workflow is fixed (one registrar per instrument, no approval for new parcels).

## Who can do what

People sign in with their Geohub account; Land Registry has no accounts of its own. Their role comes from their Geohub organization:

| Geohub role | In Land Registry | Can |
|---|---|---|
| Owner, Admin | Registrar | everything, including settings and retiring parcels |
| Member | Officer | capture, check and register parcels; edit details |
| Collector, Viewer, GeoEstate staff | Viewer | read the register and the map |

The organization needs a Land Registry licence in Geohub (Admin → the organization → Products, or from an invoice in the CRM).
Demo, active and grace licences can change things; an expired one is read-only; a suspended one is closed.

## Running it

It shares Geohub's PostgreSQL (with PostGIS) and keeps its tables in the `land` schema, created on start.

| Variable | |
|---|---|
| `DATABASE_URL` | Geohub's database |
| `APP_URL` | where people open Land Registry, e.g. `https://land.geoestate.ng` |
| `GEOHUB_URL`, `GEOHUB_API` | Geohub's address and its API (`…/api`) |
| `ID_CLIENT`, `ID_SECRET` | this app's GeoEstate ID client (`land`) and its secret |
| `PLATFORM_KEY` | optional: a long random key shared with LandCheck, which asks `/platform/title-status` what the published registries (public lookup on) hold at a place. The same value goes in LandCheck's `LAND_PLATFORM_KEY` |

In **Geohub's** variables:

```
ID_CLIENTS=[{"id":"land","redirect_uris":["https://land.geoestate.ng/api/auth/callback"],"secret":"<the same ID_SECRET>"}]
PRODUCT_URLS=land=https://land.geoestate.ng
```

On Railway, add a service from this repo; the Dockerfile builds the web app and the API into one image (API under `/api`).

## Developing

```
# API (needs PostgreSQL with PostGIS)
cd backend && pip install -r requirements-dev.txt
cp .env.test.example .env.test && python -m pytest -q
API_PREFIX=/api DATABASE_URL=… GEOHUB_URL=… GEOHUB_API=… ID_SECRET=… APP_URL=http://localhost:5175 uvicorn app.main:app --port 8011

# web app on :5175, reaching the API through /api
cd frontend && npm install && npm run dev
npm test
```
