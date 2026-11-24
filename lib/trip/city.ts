import geometry from "./data/closures.json";
import type { Disruption, FeedHealth, Point } from "./types";

export const citySource = "https://www.nyc.gov/assets/cecm/downloads/pdf/thanksgiving-standard-street-closures-2026.pdf";
export const mtaSource = "https://www.mta.info/planned-service-changes";
export const lionSource = "https://data.cityofnewyork.us/City-Government/LION/2v4z-66xt";
export const paradePath = geometry.paradePath as unknown as Point[];

export const cityFeed: FeedHealth = {
  source: "city",
  status: "scheduled",
  updatedAt: null,
  checkedAt: null,
  href: citySource,
};

export const cityClosures: Disruption[] = geometry.closures.map(({ id, title, detail, start, end, path }) => ({
  id: "city-" + id,
  source: "city",
  title,
  detail,
  type: "street",
  windows: [{ start: Date.parse(start), end: Date.parse(end) }],
  path: path as unknown as Point[],
  href: citySource,
}));
