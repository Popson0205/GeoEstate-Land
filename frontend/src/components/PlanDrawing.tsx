import type { Beacon } from "../lib/types";

/**
 * A surveyor's plan of a parcel: the boundary with each beacon marked and named, and every leg labelled with its
 * whole-circle bearing and distance — the way a hand-drawn survey plan reads. Drawn from the beacon coordinates,
 * preferring the projected easting/northing (planar); for lat/lon-only parcels it uses a local tangent plane, which
 * is accurate enough for the short distances of a single parcel. North is up.
 */

type P = { name: string; x: number; y: number };

/** Beacons as planar metres (x = easting/east, y = northing/north). */
function planar(beacons: Beacon[]): P[] {
  const projected = beacons.every((b) => b.easting != null && b.northing != null);
  if (projected) return beacons.map((b) => ({ name: b.name, x: b.easting as number, y: b.northing as number }));
  const lat0 = (beacons.reduce((s, b) => s + b.lat, 0) / beacons.length) * (Math.PI / 180);
  const mPerLon = 111320 * Math.cos(lat0), mPerLat = 110540;
  const lon0 = beacons[0].lon, la0 = beacons[0].lat;
  return beacons.map((b) => ({ name: b.name, x: (b.lon - lon0) * mPerLon, y: (b.lat - la0) * mPerLat }));
}

/** Whole-circle bearing (clockwise from north) as D°MM′. */
function bearing(dx: number, dy: number): string {
  let deg = (Math.atan2(dx, dy) * 180) / Math.PI;
  if (deg < 0) deg += 360;
  let d = Math.floor(deg);
  let m = Math.round((deg - d) * 60);
  if (m === 60) { m = 0; d = (d + 1) % 360; }
  return `${d}°${String(m).padStart(2, "0")}′`;
}

export default function PlanDrawing({ beacons, className }: { beacons: Beacon[]; className?: string }) {
  if (!beacons || beacons.length < 3) return null;
  const pts = planar(beacons);

  // Fit the parcel into a fixed drawing box, north up (screen y grows downward, so flip).
  const W = 560, H = 420, PAD = 64;
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const spanX = Math.max(maxX - minX, 1e-6), spanY = Math.max(maxY - minY, 1e-6);
  const scale = Math.min((W - 2 * PAD) / spanX, (H - 2 * PAD) / spanY);
  const offX = (W - spanX * scale) / 2, offY = (H - spanY * scale) / 2;
  const sx = (x: number) => offX + (x - minX) * scale;
  const sy = (y: number) => H - (offY + (y - minY) * scale);
  const S = pts.map((p) => ({ name: p.name, sx: sx(p.x), sy: sy(p.y), x: p.x, y: p.y }));

  const ring = S.map((p) => `${p.sx.toFixed(1)},${p.sy.toFixed(1)}`).join(" ");
  const cx = S.reduce((s, p) => s + p.sx, 0) / S.length, cy = S.reduce((s, p) => s + p.sy, 0) / S.length;

  const legs = S.map((a, i) => {
    const b = S[(i + 1) % S.length], w = pts[i], w2 = pts[(i + 1) % S.length];
    const dist = `${Math.hypot(w2.x - w.x, w2.y - w.y).toFixed(2)} m`;
    const brg = bearing(w2.x - w.x, w2.y - w.y);
    // Labels sit at the leg's midpoint, rotated along the leg and kept upright. The distance goes just inside the
    // boundary, the bearing just outside — the way a survey plan reads.
    const mx = (a.sx + b.sx) / 2, my = (a.sy + b.sy) / 2;
    let ang = (Math.atan2(b.sy - a.sy, b.sx - a.sx) * 180) / Math.PI;
    if (ang > 90 || ang < -90) ang += 180;
    const nx = -(b.sy - a.sy), ny = b.sx - a.sx, nl = Math.hypot(nx, ny) || 1, ux = nx / nl, uy = ny / nl;
    const out = (mx - cx) * ux + (my - cy) * uy >= 0 ? 1 : -1;   // +1 points away from the centre
    return { key: i, ang, brg, dist,
      bx: mx + ux * 13 * out, by: my + uy * 13 * out,            // bearing: outside
      dx: mx - ux * 12 * out, dy: my - uy * 12 * out };          // distance: inside
  });

  return (
    <svg className={className} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Survey plan of the parcel"
      xmlns="http://www.w3.org/2000/svg" style={{ width: "100%", height: "auto", maxWidth: W }}>
      <polygon points={ring} fill="rgba(47,138,52,0.08)" stroke="#1b2b5e" strokeWidth={1.6} strokeLinejoin="round" />
      {legs.map((l) => (
        <g key={l.key} fill="#1b2b5e" fontFamily="system-ui, sans-serif" fontSize={10.5}>
          <text x={l.dx} y={l.dy} transform={`rotate(${l.ang.toFixed(1)} ${l.dx} ${l.dy})`} textAnchor="middle" dominantBaseline="middle">{l.dist}</text>
          <text x={l.bx} y={l.by} transform={`rotate(${l.ang.toFixed(1)} ${l.bx} ${l.by})`} textAnchor="middle" dominantBaseline="middle">{l.brg}</text>
        </g>
      ))}
      {S.map((p, i) => (
        <g key={i}>
          <circle cx={p.sx} cy={p.sy} r={3.5} fill="#b42318" stroke="#fff" strokeWidth={1} />
          <text x={p.sx + (p.sx >= cx ? 8 : -8)} y={p.sy + (p.sy >= cy ? 14 : -8)} textAnchor={p.sx >= cx ? "start" : "end"}
            fontSize={12} fontWeight={600} fill="#111" fontFamily="system-ui, sans-serif">{p.name}</text>
        </g>
      ))}
      {/* North arrow */}
      <g transform={`translate(${W - 30} 30)`}>
        <line x1={0} y1={14} x2={0} y2={-12} stroke="#1b2b5e" strokeWidth={1.4} />
        <polygon points="0,-16 4,-8 -4,-8" fill="#1b2b5e" />
        <text x={0} y={26} textAnchor="middle" fontSize={11} fontWeight={700} fill="#1b2b5e" fontFamily="system-ui, sans-serif">N</text>
      </g>
    </svg>
  );
}
