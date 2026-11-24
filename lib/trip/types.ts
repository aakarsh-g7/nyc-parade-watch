export type Point = readonly [longitude: number, latitude: number];
export type LegMode = "walk" | "subway" | "bus";
export type TravelMode = "all" | "transit" | "walk";
export type Priority = "fastest" | "less-walking" | "fewer-transfers";
export type Source = "city" | "subway" | "bus" | "replay";

export type Place = {
  label: string;
  placeId?: string;
  point?: Point;
};

export type Preferences = {
  mode: TravelMode;
  priority: Priority;
  maxWalkMinutes: number | null;
};

export type TripLimits = Preferences & {
  arriveBy: number | null;
};

export type TripIntent = {
  origin: Place;
  destination: Place;
  limits: TripLimits;
};

export type Leg = {
  mode: LegMode;
  line?: string;
  lineId?: string;
  headsign?: string;
  color?: string;
  instruction: string;
  from?: string;
  to?: string;
  fromStop?: string;
  toStop?: string;
  fromComplex?: string;
  toComplex?: string;
  startsAt: number;
  endsAt: number;
  seconds: number;
  path: Point[];
};

export type Itinerary = {
  id: string;
  pattern: string;
  legs: Leg[];
  path: Point[];
  departsAt: number;
  arrivesAt: number;
  walkSeconds: number;
  transfers: number;
  fare: { micros: number; currency: string } | null;
  fareClass: "free" | "single-subway" | null;
  mode: "walk" | "transit";
};

export type TimeWindow = {
  start: number | null;
  end: number | null;
};

export type Disruption = {
  id: string;
  source: Source;
  title: string;
  detail: string;
  type: "street" | "suspension" | "stop" | "advisory";
  windows: TimeWindow[];
  selectors?: { mode: "subway" | "bus"; lineId: string; stopId?: string; direction?: string }[];
  path?: Point[];
  href: string;
  updatedAt?: number;
};

export type FeedHealth = {
  source: Source;
  status: "fresh" | "stale" | "unavailable" | "scheduled" | "replay";
  checkedAt: number | null;
  updatedAt: number | null;
  href: string;
};

export type DisruptionSnapshot = {
  alerts: Disruption[];
  feeds: FeedHealth[];
};

export type Impact = {
  alert: Disruption;
  level: "block" | "advisory";
};

export type EvaluatedRoute = {
  route: Itinerary;
  impacts: Impact[];
  tradeoffs: string[];
};

export const defaultPreferences: Preferences = {
  mode: "all",
  priority: "fastest",
  maxWalkMinutes: null,
};
