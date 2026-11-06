import { useState } from "react";
import { Button } from "./ui";

/**
 * A registrar's way to close a traverse to its starting point, as CAD's "close" does: the plan's last leg is replaced by
 * the line back to the start. The error is not spread or found, so it needs a reason, which is kept with the parcel.
 */
export default function CloseToStart({ busy, onClose, compact }: { busy?: boolean; onClose: (reason: string) => void; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  if (!open) return <Button small variant="ghost" onClick={() => setOpen(true)}>Close to the starting point…</Button>;
  const ok = reason.trim().length >= 10;
  return (
    <div className="close-start stack" role="group" aria-label="Close to the starting point">
      {!compact && <p className="ge-small" style={{ margin: 0 }}>
        The last leg is replaced by the line back to the starting point, as CAD's <em>close</em> does. All of the error goes into that leg,
        so do this only when you know the last leg is the wrong one (from the surveyor, or the beacons on the ground). The plan's own figures,
        the leg used instead, your name and the reason are kept with the parcel.</p>}
      <label className="ge-small" htmlFor="close-why">Why (kept with the parcel)</label>
      <textarea id="close-why" rows={2} value={reason} onChange={(e) => setReason(e.target.value)}
        placeholder="For example: confirmed with the surveyor that the last leg is misprinted" />
      <div className="actions">
        <Button small variant="primary" busy={busy} disabled={!ok} onClick={() => onClose(reason.trim())}>Close it and check again</Button>
        <Button small variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
        {!ok && <span className="ge-muted ge-small">Give a reason of a few words.</span>}
      </div>
    </div>
  );
}
