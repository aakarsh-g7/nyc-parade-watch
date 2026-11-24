import { pathsFollow, pathsTouch } from "./geo.ts";
import type {
  Disruption, DisruptionSnapshot, EvaluatedRoute, Impact, Itinerary, Leg, TimeWindow, TripLimits,
} from "./types.ts";

export function overlaps(window: TimeWindow, start: number, end: number) {
  return start < (window.end ?? Infinity) && end >= (window.start ?? -Infinity);
}

function legImpact(alert: Disruption, leg: Leg): Impact["level"] | null {
  if (!alert.windows.some((window) => overlaps(window, leg.startsAt, leg.endsAt))) return null;
  if (alert.type === "street") {
    if (leg.mode === "subway" || !alert.path || !pathsTouch(leg.path, alert.path)) return null;
    return leg.mode === "bus" && pathsFollow(leg.path, alert.path) ? "block" : "advisory";
  }
  const matching = alert.selectors?.filter((selector) => selector.mode === leg.mode && selector.lineId === leg.lineId) ?? [];
  if (!matching.length) return null;
  const sameStop = matching.some(({ stopId }) => stopId && [leg.fromStop, leg.toStop].includes(stopId));
  const wholeLine = matching.some(({ stopId, direction }) => !stopId && !direction);
  const permittedDirection = matching.some(({ stopId, direction }) =>
    stopId && [leg.fromStop, leg.toStop].includes(stopId) &&
      (!direction || leg.headsign?.toLowerCase() === direction.toLowerCase()),
  );
  if (alert.type === "suspension" && wholeLine) return "block";
  if (alert.type === "stop" && permittedDirection) return "block";
  return wholeLine || sameStop || matching.some(({ stopId }) => !stopId) ? "advisory" : null;
}

export function assessRoute(route: Itinerary, alerts: Disruption[], remainingFrom = 0): Impact[] {
  const remaining = route.legs.slice(remainingFrom);
  return alerts.flatMap<Impact>((alert) => {
    const levels = remaining.map((leg) => legImpact(alert, leg));
    if (levels.includes("block")) return [{ alert, level: "block" as const }];
    if (levels.includes("advisory")) return [{ alert, level: "advisory" as const }];
    return [];
  });
}

export function tradeoffsFor(route: Itinerary, limits: TripLimits): string[] {
  const reasons: string[] = [];
  if (limits.mode !== "all" && route.mode !== limits.mode) reasons.push("Different travel mode");
  if (limits.maxWalkMinutes !== null && route.walkSeconds > limits.maxWalkMinutes * 60) reasons.push("Over your walking limit");
  if (limits.arriveBy !== null && route.arrivesAt > limits.arriveBy) reasons.push("After your arrival goal");
  return reasons;
}

const blockers = (item: EvaluatedRoute) => item.impacts.filter(({ level }) => level === "block").length;

export function rankRoutes(routes: Itinerary[], alerts: Disruption[], limits: TripLimits): EvaluatedRoute[] {
  return routes.map((route) => ({
    route,
    impacts: assessRoute(route, alerts),
    tradeoffs: tradeoffsFor(route, limits),
  })).sort((a, b) =>
    blockers(a) - blockers(b) ||
    a.tradeoffs.length - b.tradeoffs.length ||
    (limits.priority === "less-walking" ? a.route.walkSeconds - b.route.walkSeconds : 0) ||
    (limits.priority === "fewer-transfers" ? a.route.transfers - b.route.transfers : 0) ||
    a.route.arrivesAt - b.route.arrivesAt ||
    a.impacts.length - b.impacts.length,
  );
}

export function sameOrLowerFare(before: Itinerary, after: Itinerary) {
  if (after.fareClass === "free") return true;
  if (before.fare && after.fare && before.fare.currency === after.fare.currency) {
    return after.fare.micros <= before.fare.micros;
  }
  return before.fareClass === "single-subway" && after.fareClass === "single-subway";
}

export function feedsPermitSwitch(snapshot: DisruptionSnapshot, ...routes: Itinerary[]) {
  return routes.flatMap((route) => route.legs).every(({ mode }) => {
    const feed = snapshot.feeds.find((item) => item.source === mode);
    return mode === "walk" || feed?.status === "fresh" || feed?.status === "replay";
  }) && snapshot.feeds.some(({ source, status }) => source === "city" && status === "scheduled");
}

export function replacementFor(
  current: Itinerary,
  candidates: EvaluatedRoute[],
  snapshot: DisruptionSnapshot,
  context: { optedIn: boolean; atCheckpoint: boolean; confirmedImpact: boolean; inPaidArea?: boolean },
): { candidate: EvaluatedRoute; apply: boolean; reason: string } | null {
  const candidate = candidates.find((item) => item.route.pattern !== current.pattern && blockers(item) === 0);
  if (!candidate) return null;
  if (!context.optedIn) return { candidate, apply: false, reason: "Review the route change" };
  if (!context.atCheckpoint) return { candidate, apply: false, reason: "Review at your next stop" };
  if (!context.confirmedImpact) return { candidate, apply: false, reason: "Review the possible impact" };
  if (!feedsPermitSwitch(snapshot, current, candidate.route)) {
    return { candidate, apply: false, reason: "Waiting for fresh service data" };
  }
  if (candidate.tradeoffs.length) return { candidate, apply: false, reason: candidate.tradeoffs.join(" · ") };
  const oldStep = current.legs[0];
  const newStep = candidate.route.legs[0];
  const sameStation = oldStep?.mode === "subway" && newStep?.mode === "subway" &&
    !!oldStep.fromComplex && oldStep.fromComplex === newStep.fromComplex;
  if (!sameOrLowerFare(current, candidate.route) ||
      (context.inPaidArea && candidate.route.mode !== "walk" && !sameStation)) {
    return { candidate, apply: false, reason: "Review the fare before switching" };
  }
  return { candidate, apply: true, reason: "Your preferences and arrival goal still fit." };
}
