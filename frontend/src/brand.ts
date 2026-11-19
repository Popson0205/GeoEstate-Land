/** White-label branding, chosen at build time with VITE_BRAND (default "geoestate"). The same code ships as the
 *  GeoEstate product or, built with VITE_BRAND=osun, as part of the Osun State Land Information System — no fork.
 *  Colours live in brand.css keyed by [data-brand]; this holds the names, marks and metadata, applied at startup. */
export type Brand = {
  id: string;
  suite: string;
  suiteFull: string;
  product: string;
  vendor: string;
  logo: string;
  seal?: string;
  themeColor: string;
  poweredBy?: string;
};

const BRANDS: Record<string, Brand> = {
  geoestate: {
    id: "geoestate", suite: "GeoEstate", suiteFull: "GeoEstate", product: "Land Registry",
    vendor: "GeoEstate NIG Limited", logo: "/logo.png", themeColor: "#0b1830",
  },
  osun: {
    id: "osun", suite: "OSLIS", suiteFull: "Osun State Land Information System", product: "Land Registry",
    vendor: "GeoEstate NIG Limited", logo: "/brand/osun-icon.svg", seal: "/brand/osun-seal.png",
    themeColor: "#064E30", poweredBy: "GeoEstate",
  },
};

export const BRAND: Brand = BRANDS[import.meta.env.VITE_BRAND as string] ?? BRANDS.geoestate;

/** Apply the brand to the document: colour theme (via a data attribute brand.css keys off), title, favicon, theme-color. */
export function applyBrand(): void {
  const d = document.documentElement;
  d.dataset.brand = BRAND.id;
  document.title = BRAND.id === "geoestate" ? `${BRAND.product} · ${BRAND.suite}` : `${BRAND.product} · ${BRAND.suiteFull}`;
  const set = (sel: string, rel: string, href: string) => {
    let el = document.head.querySelector<HTMLLinkElement>(`link[rel="${sel}"]`);
    if (!el) { el = document.createElement("link"); el.rel = rel; document.head.appendChild(el); }
    el.href = href;
  };
  if (BRAND.id !== "geoestate") { set("icon", "icon", BRAND.logo); set("apple-touch-icon", "apple-touch-icon", BRAND.logo); }
  const tc = document.head.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (tc) tc.content = BRAND.themeColor;
}
