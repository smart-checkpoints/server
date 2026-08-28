/**
 * The one place the console names anything outside itself.
 *
 * These values are the console's copy of `web/src/lib/site.ts`. The ecosystem
 * has one name, one domain and one documentation site, and every surface
 * spells them the same way.
 */
const org = "https://github.com/smart-checkpoints";

export const site = {
  name: "Smart Checkpoints",
  surface: "Console",
  tagline:
    "Average speed enforcement that measures the road, not the moment.",
  description:
    "Operate a Smart Checkpoints deployment: the checkpoint graph, the edges under enforcement, and the violations coming off them.",

  url: "https://smartcheckpoints.xyz",
  docs: "https://docs.smartcheckpoints.xyz",
  github: org,
  license: "MIT",
  copyrightHolder: "Smart Checkpoints",
} as const;

/** Deep links into the documentation site. The console never re-documents. */
export const docsLinks = {
  home: site.docs,
  quickstart: `${site.docs}/quickstart`,
  graphModel: `${site.docs}/concepts/graph-model`,
  enforcement: `${site.docs}/concepts/enforcement`,
  distanceDrivers: `${site.docs}/concepts/distance-drivers`,
  restApi: `${site.docs}/reference/rest-api`,
  realtime: `${site.docs}/reference/realtime`,
  driverProtocol: `${site.docs}/reference/driver-protocol`,
  dataModel: `${site.docs}/reference/data-model`,
  console: `${site.docs}/reference/console`,
} as const;

export type NavLink = {
  label: string;
  href: string;
  external?: boolean;
};

/** Header navigation. Console surfaces first, outbound links last. */
export const navLinks: NavLink[] = [
  { label: "Projects", href: "/" },
  { label: "Admin", href: "/admin" },
  { label: "Docs", href: docsLinks.home, external: true },
  { label: "GitHub", href: `${org}/server`, external: true },
];

export type FooterColumn = {
  title: string;
  links: NavLink[];
};

export const footerColumns: FooterColumn[] = [
  {
    title: "Console",
    links: [
      { label: "Projects", href: "/" },
      { label: "Admin", href: "/admin" },
    ],
  },
  {
    title: "Documentation",
    links: [
      { label: "Introduction", href: docsLinks.home, external: true },
      { label: "Quickstart", href: docsLinks.quickstart, external: true },
      { label: "The console", href: docsLinks.console, external: true },
      { label: "REST API", href: docsLinks.restApi, external: true },
    ],
  },
  {
    title: "Interfaces",
    links: [
      { label: "Realtime events", href: docsLinks.realtime, external: true },
      { label: "Driver protocol", href: docsLinks.driverProtocol, external: true },
      { label: "Data model", href: docsLinks.dataModel, external: true },
      { label: "Distance drivers", href: docsLinks.distanceDrivers, external: true },
    ],
  },
  {
    title: "Project",
    links: [
      { label: "Website", href: site.url, external: true },
      { label: "GitHub organisation", href: org, external: true },
      { label: "Issues", href: `${org}/server/issues`, external: true },
      { label: "License", href: `${org}/server`, external: true },
    ],
  },
];
