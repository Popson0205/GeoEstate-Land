# GeoEstate Land Registry

The parcel fabric and register for land agencies, estates and surveyors: part of the GeoEstate platform, beside Geohub,
LandCheck and FarmScan. One sign-in (GeoEstate ID, through Geohub), one licence system, one look.

**What it does now (part 1)**

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

Coming next: titles and land records with a public lookup; DXF import, ground-control correction, split and merge, and
approval workflows; enumeration forms in Geohub that feed the register.

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
