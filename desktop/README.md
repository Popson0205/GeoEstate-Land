# Land Registry Desktop

GeoEstate Land Registry as installed Windows software — version 1. This is a thin native shell (Electron) around the
hosted Land Registry web app: it opens the live site in its own app window, so **sign-in (GeoEstate ID) and the whole
backend work exactly as in the browser**, and adds desktop touches:

- A real application window, menu, and taskbar/Start-menu entry.
- A **`.landreg` file association** — double-click a register pack in Windows and it opens in the app.
- External links (documentation, other sites) open in the system browser.

It needs an internet connection; it talks to the hosted Land Registry.

## Which server it connects to

By default it connects to the production URL set in `main.js` (`DEFAULT_URL`, `https://land.geoestate.ng`). You can
override it without rebuilding:

- set the `LANDREGISTRY_URL` environment variable, or
- create `config.json` in the app's user-data folder (`%APPDATA%/Land Registry/config.json`):

  ```json
  { "url": "https://your-land-registry-host" }
  ```

For a self-hosted / on-prem deployment, point either of these at your own server.

## Code signing

The build **signs the installer automatically** when a signing certificate is configured — no code change needed.
Add the right secrets to the repository and the next build is signed; add nothing and it builds unsigned (SmartScreen
warns on first run, "More info → Run anyway"). Three routes are supported — **Azure Trusted Signing** (recommended,
EV-level trust in CI), a **.pfx certificate file**, or an **EV hardware token** (signed locally). Full step-by-step
setup, including which certificate GeoEstate should buy, is in **[SIGNING.md](SIGNING.md)**.

## Build the installer

### In GitHub Actions (automatic)

The **Desktop (Windows installer)** workflow builds the `.exe` on a Windows runner.

- **Automatically on every push to `main`** — uploaded as a run artifact and published to a rolling
  **`desktop-latest`** pre-release, so the newest build is always one click away under **Releases → Land Registry
  Desktop (latest)**.
- On **desktop pull requests** it builds too (without publishing), to catch build breaks before merge.
- Push a tag like `desktop-v1.0.0` to attach the installer to that version's own Release.
- Or run it by hand from the **Actions** tab (**Run workflow**).

### Locally on Windows

```bash
cd desktop
npm ci
npm run dist        # writes release/Land Registry Setup <version>.exe
```

`npm start` runs the app without packaging (handy while developing).

## Notes

- The app bar/icon reuses the shared GeoEstate mark as a placeholder; drop a Land Registry `icon.ico` / `icon.png`
  into `assets/` to rebrand.
- Double-click-to-open a `.landreg` file needs matching support in the web app on the server it connects to.
