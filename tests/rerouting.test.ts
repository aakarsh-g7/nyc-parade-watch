import test from "node:test";
import assert from "node:assert/strict";
import { assessRoute, rankRoutes, replacementFor } from "../lib/trip/policy.ts";
import { nycDateInput, parseNycDateInput } from "../lib/trip/time.ts";
import type { Disruption, DisruptionSnapshot, Itinerary, Leg, TripLimits } from "../lib/trip/types.ts";

const start = Date.parse("2026-11-26T09:54:00-05:00");
const limits: TripLimits = { mode: "all", priority: "fastest", arriveBy: start + 75 * 60_000, maxWalkMinutes: 10 };
const leg: Leg = {
  mode: "subway", line: "S", lineId: "GS", fromComplex: "Times Sq", instruction: "Take the shuttle",
  fromStop: "901", toStop: "902", startsAt: start, endsAt: start + 120_000, seconds: 120,
  path: [[-73.99, 40.75], [-73.98, 40.75]],
};
const original: Itinerary = {
  id: "shuttle", pattern: "shuttle", legs: [leg], path: leg.path, departsAt: start, arrivesAt: leg.endsAt,
  walkSeconds: 120, transfers: 0, fare: null, fareClass: "single-subway", mode: "transit",
};
const alternate: Itinerary = {
  ...original, id: "7", pattern: "7", arrivesAt: start + 240_000,
  legs: [{ ...leg, line: "7", lineId: "7", fromStop: "725", toStop: "723", endsAt: start + 240_000 }],
};
const suspension: Disruption = {
  id: "shuttle-suspension", source: "subway", title: "Shuttle suspended", detail: "",
  type: "suspension", windows: [{ start, end: start + 240_000 }],
  selectors: [{ mode: "subway", lineId: "GS" }], href: "https://www.mta.info/",
};
const street: Disruption = {
  id: "street-closure", source: "city", title: "Street closed", detail: "", type: "street",
  windows: [{ start, end: start + 240_000 }], path: leg.path, href: "https://www.nyc.gov/",
};
const snapshot: DisruptionSnapshot = {
  alerts: [suspension],
  feeds: [
    { source: "city", status: "scheduled", href: "", checkedAt: null, updatedAt: null },
    { source: "subway", status: "fresh", href: "", checkedAt: start, updatedAt: start },
  ],
};
const context = { optedIn: true, atCheckpoint: true, confirmedImpact: true, inPaidArea: true };

test("selects the 7 when a confirmed shuttle suspension affects a paid transfer", () => {
  const choices = rankRoutes([original, alternate], snapshot.alerts, limits);
  assert.equal(choices[0].route.id, "7");
  assert.equal(replacementFor(original, choices, snapshot, context)?.apply, true);
});

test("a switch needs consent, a checkpoint and a confirmed alert", () => {
  const choices = rankRoutes([alternate], snapshot.alerts, limits);
  for (const toggle of ["optedIn", "atCheckpoint", "confirmedImpact"] as const) {
    assert.equal(replacementFor(original, choices, snapshot, { ...context, [toggle]: false })?.apply, false);
  }
});

test("holds a switch when freshness, arrival, walking or fare checks fail", () => {
  const stale: DisruptionSnapshot = {
    ...snapshot,
    feeds: snapshot.feeds.map((feed) => feed.source === "subway" ? { ...feed, status: "stale" } : feed),
  };
  assert.equal(replacementFor(original, rankRoutes([alternate], [], limits), stale, context)?.apply, false);
  const late = { ...limits, arriveBy: start + 180_000 };
  const longWalk = { ...alternate, walkSeconds: 900 };
  const paidEntry = { ...alternate, legs: [{ ...alternate.legs[0], fromComplex: "Different station" }] };
  const unknownFare = { ...alternate, fareClass: null };
  for (const [route, goal] of [[alternate, late], [longWalk, limits], [paidEntry, limits], [unknownFare, limits]] as const) {
    assert.equal(replacementFor(original, rankRoutes([route], [], goal), snapshot, context)?.apply, false);
  }
});

test("ignores expired alerts, completed legs and street closures at subway level", () => {
  assert.equal(assessRoute(original, [street]).length, 0);
  assert.equal(assessRoute(original, [suspension], 1).length, 0);
  const expired = { ...suspension, windows: [{ start: null, end: start }] };
  assert.equal(assessRoute(original, [expired]).length, 0);
  const future = { ...suspension, windows: [{ start: leg.endsAt + 1, end: null }] };
  assert.equal(assessRoute(original, [future]).length, 0);
});

test("a bus on a closed segment is blocked while a crossing remains an advisory", () => {
  const bus = { ...original, legs: [{ ...leg, mode: "bus" as const }] };
  assert.equal(assessRoute(bus, [street])[0]?.level, "block");
  const crossing = { ...street, path: [[-73.985, 40.744], [-73.985, 40.756]] as const };
  assert.equal(assessRoute(bus, [{ ...crossing, path: [...crossing.path] }])[0]?.level, "advisory");
  const onFoot = { ...original, legs: [{ ...leg, mode: "walk" as const }] };
  assert.equal(assessRoute(onFoot, [street])[0]?.level, "advisory");
});

test("checks the exact stop and treats uncertain directions as advisory", () => {
  const service: Disruption = { ...suspension, type: "stop", selectors: [{ mode: "subway", lineId: "GS", stopId: "902" }] };
  assert.equal(assessRoute(original, [service])[0]?.level, "block");
  assert.equal(assessRoute(alternate, [service]).length, 0);
  const limited: Disruption = { ...service, selectors: [{ mode: "subway", lineId: "GS", stopId: "902", direction: "southbound" }] };
  assert.equal(assessRoute(original, [limited])[0]?.level, "advisory");
});

test("parses parade times in New York and rejects nonexistent DST wall times", () => {
  assert.equal(parseNycDateInput("2026-11-26T09:54"), start);
  assert.equal(nycDateInput(start), "2026-11-26T09:54");
  assert.equal(parseNycDateInput("2026-03-08T02:30"), null);
});
