import { decodePolyline } from "./geo";
import { normalizeName, serviceLine, stationFor } from "./stations";
import type { Itinerary, Leg, Place, Point, TripIntent } from "./types";

type GoogleLocation = { latLng?: { latitude?: number; longitude?: number } };
type GoogleStop = { name?: string; location?: GoogleLocation };
type GoogleTransit = {
  headsign?: string;
  stopDetails?: {
    departureStop?: GoogleStop;
    arrivalStop?: GoogleStop;
    departureTime?: string;
    arrivalTime?: string;
  };
  transitLine?: {
    name?: string;
    nameShort?: string;
    color?: string;
    agencies?: { name?: string }[];
    vehicle?: { type?: string };
  };
};
type GoogleStep = {
  travelMode?: string;
  startLocation?: GoogleLocation;
  endLocation?: GoogleLocation;
  navigationInstruction?: { instructions?: string };
  staticDuration?: string;
  polyline?: { encodedPolyline?: string };
  transitDetails?: GoogleTransit;
};
type GoogleRoute = {
  duration?: string;
  polyline?: { encodedPolyline?: string };
  legs?: { steps?: GoogleStep[] }[];
  travelAdvisory?: { transitFare?: { currencyCode?: string; units?: string; nanos?: number } };
};

const mask = [
  "routes.duration", "routes.polyline.encodedPolyline", "routes.legs.steps.travelMode",
  "routes.legs.steps.staticDuration", "routes.legs.steps.polyline.encodedPolyline",
  "routes.legs.steps.startLocation", "routes.legs.steps.endLocation",
  "routes.legs.steps.navigationInstruction.instructions", "routes.legs.steps.transitDetails",
  "routes.travelAdvisory.transitFare",
].join(",");

const NYC_LOW = { latitude: 40.48, longitude: -74.27 };
const NYC_HIGH = { latitude: 40.94, longitude: -73.67 };
const walkMask = mask.replace(",routes.legs.steps.transitDetails,routes.travelAdvisory.transitFare", "");

export class MapsError extends Error {
  constructor(message: string, readonly httpStatus: number) { super(message); }
}

export function inNyc(point: Point) {
  return point[0] >= NYC_LOW.longitude && point[0] <= NYC_HIGH.longitude &&
    point[1] >= NYC_LOW.latitude && point[1] <= NYC_HIGH.latitude;
}

async function googleRequest<T>(url: string, key: string, body: object, fields: string): Promise<T> {
  if (!key) throw new MapsError("Set up a Google Maps key to use Live mode.", 503);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": fields },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(9_000),
      cache: "no-store",
    });
  } catch {
    throw new MapsError("Google Maps is taking too long. Try again or open Parade Replay.", 503);
  }
  if (response.status === 429) throw new MapsError("The Google Maps demo quota is busy. Parade Replay is available.", 429);
  if (response.status === 403 || response.status === 401) {
    throw new MapsError("Google Maps could not authorize this request. Check the key and enabled APIs.", 503);
  }
  if (!response.ok) throw new MapsError("Google Maps could not resolve this request. Check the trip details and try again.", 422);
  return response.json() as Promise<T>;
}

export async function findPlaces(text: string, key: string) {
  const result = await googleRequest<{
    suggestions?: { placePrediction?: { placeId?: string; text?: { text?: string } } }[];
  }>("https://places.googleapis.com/v1/places:autocomplete", key, {
    input: text,
    includedRegionCodes: ["us"],
    locationRestriction: { rectangle: { low: NYC_LOW, high: NYC_HIGH } },
  }, "suggestions.placePrediction.placeId,suggestions.placePrediction.text.text");
  return (result.suggestions ?? []).flatMap(({ placePrediction }) => {
    const id = placePrediction?.placeId;
    const label = placePrediction?.text?.text;
    return id && label ? [{ placeId: id, label }] : [];
  }).slice(0, 5);
}

function waypoint({ point, placeId, label }: Place) {
  if (point) return { location: { latLng: { latitude: point[1], longitude: point[0] } } };
  if (placeId) return { placeId };
  return { address: /\b(NYC|New York|Manhattan|Brooklyn|Queens|Bronx|Staten Island)\b/i.test(label) ? label : label + ", New York City" };
}

function getPoint(location?: GoogleLocation): Point | undefined {
  const { longitude, latitude } = location?.latLng ?? {};
  return longitude !== undefined && latitude !== undefined ? [longitude, latitude] : undefined;
}

function duration(value?: string) {
  return value && /^\d+(\.\d+)?s$/.test(value) ? Number(value.slice(0, -1)) : 0;
}

function pathFor(value?: string): Point[] {
  return value ? decodePolyline(value) : [];
}

function transitMode(transit: GoogleTransit): "subway" | "bus" | null {
  const line = transit.transitLine;
  const unit = line?.nameShort ?? line?.name ?? "";
  const agency = line?.agencies?.map(({ name }) => name ?? "").join(" ") ?? "";
  if (!/\bMTA\b|New York City Transit|Metropolitan Transportation Authority/i.test(agency)) return null;
  if (line?.vehicle?.type === "SUBWAY") return "subway";
  if (line?.vehicle?.type === "BUS" && !/^(BM|BXM|QM|SIM|X)\d/i.test(unit)) return "bus";
  return null;
}

function fareFor(route: GoogleRoute) {
  const fee = route.travelAdvisory?.transitFare;
  if (!fee?.currencyCode) return null;
  const micros = Number(fee.units ?? 0) * 1_000_000 + Math.round((fee.nanos ?? 0) / 1_000);
  return Number.isFinite(micros) && micros >= 0 ? { micros, currency: fee.currencyCode } : null;
}

function fingerprint(value: string) {
  let hash = 2166136261;
  for (const character of value) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(36);
}

function safePath(value?: string) {
  try { return pathFor(value); } catch { return []; }
}

export function normalizeRoute(route: GoogleRoute, now: number, arriveBy: number | null): Itinerary | null {
  const steps = route.legs?.flatMap(({ steps }) => steps ?? []) ?? [];
  if (!steps.length) return null;

  const rideIndex = steps.findIndex((step) => step.travelMode === "TRANSIT");
  const firstRide = rideIndex >= 0 ? steps[rideIndex].transitDetails : undefined;
  const firstDeparture = Date.parse(firstRide?.stopDetails?.departureTime ?? "");
  const beforeFirstRide = steps.slice(0, Math.max(0, rideIndex)).reduce((sum, step) => sum + duration(step.staticDuration), 0);
  const walkOnly = rideIndex < 0;
  const estimatedDuration = duration(route.duration) || steps.reduce((sum, step) => sum + duration(step.staticDuration), 0);
  const startEstimate = walkOnly
    ? (arriveBy ?? now + estimatedDuration * 1_000) - estimatedDuration * 1_000
    : firstDeparture - beforeFirstRide * 1_000;
  const departsAt = Number.isFinite(startEstimate) ? Math.max(now, startEstimate) : now;
  let cursor = departsAt;
  const legs: Leg[] = [];

  for (const step of steps) {
    const path = safePath(step.polyline?.encodedPolyline);
    const fromPoint = getPoint(step.startLocation);
    const toPoint = getPoint(step.endLocation);
    const seconds = duration(step.staticDuration);
    const transit = step.transitDetails;

    if (step.travelMode === "WALK") {
      const prior = legs.at(-1);
      const walkPath = path.length ? path : fromPoint && toPoint ? [fromPoint, toPoint] : [];
      if (prior?.mode === "walk") {
        prior.seconds += seconds;
        prior.endsAt += seconds * 1_000;
        prior.path.push(...walkPath);
      } else {
        legs.push({
          mode: "walk",
          instruction: step.navigationInstruction?.instructions || "Walk to the next stop",
          endsAt: cursor + seconds * 1_000,
          startsAt: cursor,
          seconds,
          path: walkPath,
        });
      }
      cursor += seconds * 1_000;
      continue;
    }
    if (step.travelMode !== "TRANSIT" || !transit) return null;
    const mode = transitMode(transit);
    if (!mode) return null;
    const from = transit.stopDetails?.departureStop?.name;
    const to = transit.stopDetails?.arrivalStop?.name;
    if (!from || !to) return null;
    const line = transit.transitLine?.nameShort ?? transit.transitLine?.name ?? "";
    const lineId = serviceLine(line, mode, from + " " + to);
    if (!lineId) return null;
    const start = Date.parse(transit.stopDetails?.departureTime ?? "");
    const end = Date.parse(transit.stopDetails?.arrivalTime ?? "");
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || start < cursor - 60_000) return null;
    const fromStation = mode === "subway" ? stationFor(from, getPoint(transit.stopDetails?.departureStop?.location) ?? fromPoint, lineId) : undefined;
    const toStation = mode === "subway" ? stationFor(to, getPoint(transit.stopDetails?.arrivalStop?.location) ?? toPoint, lineId) : undefined;
    const color = transit.transitLine?.color;
    legs.push({
      mode, line, lineId, from, to, color: color && /^#[a-fA-F0-9]{6}$/.test(color) ? color : undefined,
      headsign: transit.headsign,
      fromStop: fromStation?.id,
      toStop: toStation?.id,
      fromComplex: fromStation?.complex,
      toComplex: toStation?.complex,
      instruction: "Take the " + line + " to " + to,
      path, startsAt: start, endsAt: end, seconds: (end - start) / 1_000,
    });
    cursor = end;
  }

  if (!legs.length) return null;
  const path = safePath(route.polyline?.encodedPolyline);
  const geometry = path.length ? path : legs.flatMap((step) => step.path);
  const origin = geometry[0] ?? getPoint(steps[0].startLocation);
  const destination = geometry.at(-1) ?? getPoint(steps.at(-1)?.endLocation);
  if (!origin || !destination || !inNyc(origin) || !inNyc(destination)) return null;
  const rides = legs.filter((leg) => leg.mode !== "walk");
  const singleSubwayFare = rides.length > 0 && rides.every((leg, index) => leg.mode === "subway" &&
    (index === 0 || (!!leg.fromComplex && rides[index - 1].toComplex === leg.fromComplex)));
  const key = rides.length ? rides.map((leg) => [leg.mode, leg.lineId, normalizeName(leg.from), normalizeName(leg.to)].join(":")).join("/") :
    geometry.filter((_, index) => index % Math.max(1, Math.ceil(geometry.length / 9)) === 0)
      .map((point) => point.map((value) => value.toFixed(4)).join(",")).join("/");
  const pattern = fingerprint(key);
  return {
    id: pattern + "-" + departsAt,
    pattern, legs, path: geometry, departsAt, arrivesAt: Math.max(cursor, departsAt + 1_000),
    walkSeconds: legs.filter(({ mode }) => mode === "walk").reduce((sum, leg) => sum + leg.seconds, 0),
    transfers: Math.max(0, rides.length - 1),
    fareClass: walkOnly ? "free" : singleSubwayFare ? "single-subway" : null,
    fare: fareFor(route),
    mode: walkOnly ? "walk" : "transit",
  };
}

export async function findRoutes(intent: TripIntent, key: string) {
  const now = Date.now();
  const modes = intent.limits.mode === "all" ? ["TRANSIT", "WALK"] : [intent.limits.mode === "transit" ? "TRANSIT" : "WALK"];
  const requests = modes.map(async (travelMode) => {
    const isTransit = travelMode === "TRANSIT";
    const preference = intent.limits.priority === "less-walking" ? "LESS_WALKING" :
      intent.limits.priority === "fewer-transfers" ? "FEWER_TRANSFERS" : undefined;
    const timing = intent.limits.arriveBy === null
      ? { departureTime: new Date(now + 5_000).toISOString() }
      : { arrivalTime: new Date(intent.limits.arriveBy).toISOString() };
    const data = await googleRequest<{ routes?: GoogleRoute[] }>("https://routes.googleapis.com/directions/v2:computeRoutes", key, {
      origin: waypoint(intent.origin), destination: waypoint(intent.destination), travelMode,
      languageCode: "en-US", units: "IMPERIAL", computeAlternativeRoutes: true,
      ...(isTransit ? {
        ...timing,
        transitPreferences: { allowedTravelModes: ["SUBWAY", "BUS"], routingPreference: preference },
      } : {}),
    }, isTransit ? mask : walkMask);
    return (data.routes ?? []).flatMap((route) => {
      const parsed = normalizeRoute(route, now, intent.limits.arriveBy);
      return parsed && (isTransit ? parsed.mode === "transit" : parsed.mode === "walk") ? [parsed] : [];
    });
  });
  const results = await Promise.allSettled(requests);
  const routes = results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  if (!routes.length) {
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
  const seen = new Set<string>();
  return {
    routes: routes.filter(({ id }) => !seen.has(id) && !!seen.add(id)).slice(0, 10),
    partial: results.some((result) => result.status === "rejected"),
  };
}
