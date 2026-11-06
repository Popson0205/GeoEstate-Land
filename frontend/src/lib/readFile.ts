/** A chosen file's text (DXF is text). */
export function readText(file: File): Promise<string> {
  if (typeof file.text === "function") return file.text();
  return new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = () => bad(r.error); r.readAsText(file); });
}
export const MAX_DXF = 15_000_000;
