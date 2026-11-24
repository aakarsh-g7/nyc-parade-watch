"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cityClosures, cityFeed, mtaSource } from "./city";
import { assessRoute, rankRoutes, replacementFor } from "./policy";
import {
  replayDeadline, replayDestination, replayOrigin, replayRoutes, replaySnapshot, replayTransferTime, timesSquare,
} from "./replay";
import { formatClock, nycDateInput, paradeMorning, parseNycDateInput } from "./time";
import {
  defaultPreferences, type DisruptionSnapshot, type EvaluatedRoute, type Itinerary,
  type Place, type Preferences, type TripIntent, type TripLimits,
} from "./types";

export type Surface = "replay" | "live";
type Config = { browserKey: string; liveReady: boolean };
type RouteResult = { routes: Itinerary[]; partial: boolean };
export type Trip = {
  id: number;
  route: Itinerary;
  intent: TripIntent;
  position: Place;
  stepIndex: number;
  walkingSpent: number;
  inPaidArea: boolean;
  atCheckpoint: boolean;
  optedIn: boolean;
  paused: boolean;
};
type Offer = { route: EvaluatedRoute; prompt: string; cause: string };
type Change = { oldTrip: Trip; cause: string; time: number; automatic: boolean; from: number; to: number; line: string };

const tabHidden = () => document.visibilityState === "hidden";
const storageKey = "nyc-parade-walk-transit-preferences";
const liveFallback: DisruptionSnapshot = {
  alerts: cityClosures,
  feeds: [
    cityFeed,
    { source: "subway", status: "unavailable", checkedAt: null, updatedAt: null, href: mtaSource },
    { source: "bus", status: "unavailable", checkedAt: null, updatedAt: null, href: mtaSource },
  ],
};

function preferenceFromStorage(): Preferences {
  try {
    const value = JSON.parse(window.localStorage.getItem(storageKey) ?? "null") as Preferences | null;
    if (!value) return defaultPreferences;
    return {
      priority: ["fastest", "less-walking", "fewer-transfers"].includes(value.priority) ? value.priority : "fastest",
      mode: ["all", "transit", "walk"].includes(value.mode) ? value.mode : "all",
      maxWalkMinutes: Number.isInteger(value.maxWalkMinutes) && value.maxWalkMinutes! > 0 && value.maxWalkMinutes! <= 240
        ? value.maxWalkMinutes : null,
    };
  } catch {
    return defaultPreferences;
  }
}

export async function requestJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...options, cache: "no-store" });
  const data = await response.json().catch(() => null) as (T & { message?: string }) | null;
  if (!response.ok || !data) throw new Error(data?.message ?? "Temporarily unavailable. Try again in a moment.");
  return data as T;
}

export function post<T>(url: string, data: object, signal?: AbortSignal) {
  return requestJson<T>(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data), signal });
}

function remaining(route: Itinerary, stepIndex: number): Itinerary {
  const legs = route.legs.slice(stepIndex);
  const rides = legs.filter(({ mode }) => mode !== "walk");
  return {
    ...route,
    legs,
    path: legs.flatMap(({ path }) => path),
    walkSeconds: legs.filter(({ mode }) => mode === "walk").reduce((sum, leg) => sum + leg.seconds, 0),
    transfers: Math.max(0, rides.length - 1),
  };
}

function candidateLimits(trip: Trip): TripLimits {
  const limits = trip.intent.limits;
  return { ...limits, maxWalkMinutes: limits.maxWalkMinutes === null ? null :
    Math.max(0, limits.maxWalkMinutes - trip.walkingSpent / 60) };
}

function reasonForLine(route: Itinerary) {
  const leg = route.legs.find(({ mode }) => mode !== "walk");
  return leg?.line ? (leg.mode === "bus" ? leg.line + " bus" : leg.line + " train") : "walking";
}

export function useTripWatch() {
  const [mode, setMode] = useState<Surface>("replay");
  const [config, setConfig] = useState<Config | null>(null);
  const [origin, setOrigin] = useState<Place>(replayOrigin);
  const [destination, setDestination] = useState<Place>(replayDestination);
  const [timing, setTiming] = useState<"now" | "arrive">("arrive");
  const [arrival, setArrival] = useState(nycDateInput(replayDeadline));
  const [preferences, setPreferences] = useState<Preferences>(defaultPreferences);
  const [snapshot, setSnapshot] = useState<DisruptionSnapshot>(() => replaySnapshot(false, paradeMorning));
  const [routes, setRoutes] = useState<Itinerary[]>([]);
  const [intent, setIntent] = useState<TripIntent | null>(null);
  const [preferredRoute, setPreferredRoute] = useState("");
  const [auto, setAuto] = useState(false);
  const [trip, setTrip] = useState<Trip | null>(null);
  const [offer, setOffer] = useState<Offer | null>(null);
  const [change, setChange] = useState<Change | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [watchBusy, setWatchBusy] = useState(false);
  const [finished, setFinished] = useState(false);
  const [clock, setClock] = useState(paradeMorning);
  const [disrupted, setDisrupted] = useState(false);
  const tripRef = useRef<Trip | null>(null);
  const modeRef = useRef<Surface>("replay");
  const snapshotRef = useRef(snapshot);
  const planRequest = useRef(0);
  const activeCounter = useRef(0);
  const monitorRequest = useRef<number | null>(null);
  const seen = useRef(new Set<string>());
  const lastEtaCheck = useRef(0);

  const updateTrip = useCallback((value: Trip | null) => {
    tripRef.current = value;
    setTrip(value);
  }, []);

  const updateSnapshot = useCallback((value: DisruptionSnapshot) => {
    snapshotRef.current = value;
    setSnapshot(value);
  }, []);

  useEffect(() => {
    setPreferences(preferenceFromStorage());
    void requestJson<Config>("/api/config").then(setConfig).catch(() => setConfig({ browserKey: "", liveReady: false }));
  }, []);

  function rememberPreferences(next: Preferences) {
    setPreferences(next);
    try { window.localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* local preferences are optional */ }
  }

  const evaluated = useMemo(() => intent ? rankRoutes(routes, snapshot.alerts, intent.limits) : [], [routes, snapshot, intent]);
  const selected = evaluated.find(({ route }) => route.id === preferredRoute) ?? evaluated[0];
  const activeImpact = useMemo(() => trip ? assessRoute(trip.route, snapshot.alerts, trip.stepIndex) : [], [trip, snapshot]);

  function clearWork() {
    ++planRequest.current;
    ++activeCounter.current;
    monitorRequest.current = null;
    updateTrip(null);
    setIntent(null);
    setRoutes([]);
    setPreferredRoute("");
    setOffer(null);
    setChange(null);
    setNotice("");
    setError("");
    setBusy(false);
    setWatchBusy(false);
    setFinished(false);
    setAuto(false);
    seen.current.clear();
    if (modeRef.current === "replay") {
      setDisrupted(false);
      setClock(paradeMorning);
      updateSnapshot(replaySnapshot(false, paradeMorning));
    }
  }

  function selectMode(next: Surface) {
    if (modeRef.current === next) return;
    modeRef.current = next;
    clearWork();
    setMode(next);
    setDisrupted(false);
    setOrigin(next === "replay" ? replayOrigin : { label: "" });
    setDestination(next === "replay" ? replayDestination : { label: "" });
    setTiming(next === "replay" ? "arrive" : "now");
    setArrival(nycDateInput(replayDeadline));
    setClock(next === "replay" ? paradeMorning : Date.now());
    updateSnapshot(next === "replay" ? replaySnapshot(false, paradeMorning) : liveFallback);
  }

  const refreshLive = useCallback(async () => {
    try {
      return await requestJson<DisruptionSnapshot>("/api/disruptions");
    } catch {
      const previous = snapshotRef.current;
      return {
        ...previous,
        feeds: previous.feeds.map((feed) => feed.source === "city" ? feed : {
          ...feed, status: feed.updatedAt ? "stale" as const : "unavailable" as const, checkedAt: Date.now(),
        }),
      };
    }
  }, []);

  async function plan() {
    if (busy) return;
    setError("");
    setNotice("");
    if (!origin.label.trim() || !destination.label.trim()) return setError("Enter both an origin and a destination.");
    if (origin.label.trim().toLowerCase() === destination.label.trim().toLowerCase()) {
      return setError("Choose a different destination from your origin.");
    }
    if (mode === "live" && !config?.liveReady) return setError("Set up a Google Maps key for Live mode, or try Parade Replay.");
    const deadline = timing === "arrive" ? parseNycDateInput(arrival) : null;
    const now = mode === "replay" ? paradeMorning : Date.now();
    if (timing === "arrive" && (deadline === null || deadline <= now)) return setError("Choose a future arrival time in New York.");
    const nextIntent = { origin, destination, limits: { ...preferences, arriveBy: deadline } };
    const revision = ++planRequest.current;
    setBusy(true);
    try {
      const [result, freshSnapshot] = mode === "replay"
        ? [{ routes: replayRoutes(false, now), partial: false }, replaySnapshot(false, now)] as const
        : await Promise.all([post<RouteResult>("/api/routes", nextIntent), refreshLive()]);
      if (revision !== planRequest.current) return;
      const eligible = result.routes.filter((route) => preferences.mode === "all" || preferences.mode === route.mode);
      updateSnapshot(freshSnapshot);
      if (!eligible.length) {
        setError("No eligible walking or MTA routes were returned. Try another time or nearby stop.");
        return;
      }
      setIntent(nextIntent);
      setRoutes(eligible);
      setPreferredRoute("");
      setFinished(false);
      if (result.partial) setNotice("Google Maps returned some route options. You can refresh to check the rest.");
    } catch (cause) {
      if (revision === planRequest.current) setError(cause instanceof Error ? cause.message : "Could not find routes.");
    } finally {
      if (revision === planRequest.current) setBusy(false);
    }
  }

  function start() {
    if (!selected || !intent || selected.impacts.some(({ level }) => level === "block")) return;
    if (intent.limits.arriveBy !== null && intent.limits.arriveBy <= (mode === "replay" ? clock : Date.now())) {
      setError("Your arrival goal has passed. Update the trip time.");
      return;
    }
    seen.current.clear();
    lastEtaCheck.current = Date.now();
    updateTrip({
      id: ++activeCounter.current,
      route: selected.route,
      intent,
      position: intent.origin,
      stepIndex: 0,
      walkingSpent: 0,
      inPaidArea: false,
      atCheckpoint: true,
      optedIn: auto,
      paused: false,
    });
    setOffer(null);
    setChange(null);
    setNotice("");
    setError("");
    setFinished(false);
  }

  const apply = useCallback((oldTrip: Trip, replacement: Itinerary, cause: string, automatic: boolean, now: number) => {
    if (tripRef.current !== oldTrip) return;
    updateTrip({ ...oldTrip, route: replacement, stepIndex: 0, atCheckpoint: true });
    setChange({
      oldTrip, cause, time: now, automatic, from: oldTrip.route.arrivesAt, to: replacement.arrivesAt,
      line: reasonForLine(replacement),
    });
    setOffer(null);
    setNotice("");
  }, [updateTrip]);

  const reconsider = useCallback(async (
    fresh: DisruptionSnapshot,
    now: number,
    refreshEta = false,
  ) => {
    const current = tripRef.current;
    if (!current || current.paused || monitorRequest.current !== null) return;
    const recentImpacts = assessRoute(current.route, fresh.alerts, current.stepIndex);
    const blocking = recentImpacts.find(({ level }) => level === "block");
    const issue = blocking ?? recentImpacts[0];
    if (!current.atCheckpoint) {
      if (issue) setNotice("Service has changed. Review your route when you reach the next stop.");
      return;
    }
    const issueKey = issue ? [current.route.pattern, current.stepIndex, issue.alert.id, issue.alert.updatedAt ?? 0,
      fresh.feeds.map((feed) => feed.status).join(",")].join("|") : "";
    const newIssue = !!issueKey && !seen.current.has(issueKey);
    if (!newIssue && !refreshEta) return;
    monitorRequest.current = current.id;
    lastEtaCheck.current = Date.now();
    setWatchBusy(true);
    try {
      const limits = candidateLimits(current);
      const recalculation = modeRef.current === "replay"
        ? { routes: replayRoutes(current.position.label === timesSquare.label, now), partial: false }
        : await post<RouteResult>("/api/routes", {
          origin: current.position, destination: current.intent.destination,
          limits: { ...limits,
            maxWalkMinutes: limits.maxWalkMinutes === null ? null : Math.max(1, Math.ceil(limits.maxWalkMinutes)),
            arriveBy: limits.arriveBy !== null && limits.arriveBy > now ? limits.arriveBy : null },
        });
      if (tripRef.current !== current || tabHidden()) return;
      const candidates = rankRoutes(recalculation.routes, fresh.alerts, limits);
      const outstanding = remaining(current.route, current.stepIndex);
      const currentLines = outstanding.legs.filter(({ mode }) => mode !== "walk").map(({ lineId }) => lineId).join(",");
      const same = candidates.find(({ route }) => {
        if (route.pattern === current.route.pattern) return true;
        const lines = route.legs.filter(({ mode }) => mode !== "walk").map(({ lineId }) => lineId).join(",");
        return current.stepIndex > 0 && Boolean(lines) && lines === currentLines;
      });
      const comparable = candidates.filter((item) => item !== same);
      const missesGoal = limits.arriveBy !== null && (same?.route.arrivesAt ?? current.route.arrivesAt) > limits.arriveBy;
      if (issueKey) seen.current.add(issueKey);
      if (!newIssue && !missesGoal) {
        if (same && !same.impacts.some(({ level }) => level === "block")) {
          const elapsed = current.route.legs.slice(0, current.stepIndex);
          const route = elapsed.length ? {
            ...current.route,
            arrivesAt: same.route.arrivesAt,
            walkSeconds: current.walkingSpent + same.route.walkSeconds,
            legs: [...elapsed, ...same.route.legs],
            path: [...elapsed.flatMap(({ path }) => path), ...same.route.path],
          } : same.route;
          updateTrip({ ...current, route });
        }
        setNotice("");
        return;
      }
      const decision = replacementFor(outstanding, comparable, fresh, {
        optedIn: current.optedIn, atCheckpoint: current.atCheckpoint, confirmedImpact: Boolean(blocking),
        inPaidArea: current.inPaidArea,
      });
      const cause = issue?.alert.title ?? "Arrival estimate moved past your goal";
      if (!decision) {
        setOffer(null);
        setNotice("A disruption affects this trip. No eligible replacement was returned.");
      } else if (decision.apply && snapshotRef.current === fresh) {
        apply(current, decision.candidate.route, cause, true, now);
      } else {
        setOffer({ route: decision.candidate, prompt: decision.reason, cause });
        setNotice("");
      }
    } catch (cause) {
      if (tripRef.current === current) {
        setNotice(cause instanceof Error ? cause.message : "Route refresh is temporarily unavailable.");
      }
    } finally {
      if (monitorRequest.current === current.id) {
        monitorRequest.current = null;
        setWatchBusy(false);
      }
    }
  }, [apply, updateTrip]);

  useEffect(() => {
    if (mode !== "live") return;
    let stopped = false;
    let refreshing = false;
    async function check() {
      if (stopped || refreshing || tabHidden()) return;
      refreshing = true;
      try {
        const current = await refreshLive();
        if (stopped || modeRef.current !== "live" || tabHidden()) return;
        updateSnapshot(current);
        const now = Date.now();
        setClock(now);
        await reconsider(current, now, now - lastEtaCheck.current >= 120_000);
      } finally {
        refreshing = false;
      }
    }
    void check();
    const interval = window.setInterval(() => void check(), 30_000);
    document.addEventListener("visibilitychange", check);
    return () => {
      stopped = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", check);
    };
  }, [mode, reconsider, refreshLive, updateSnapshot]);

  function setAutomatic(value: boolean) {
    setAuto(value);
    const current = tripRef.current;
    if (!current) return;
    updateTrip({ ...current, optedIn: value });
    seen.current.clear();
    if (mode === "replay" && disrupted) void reconsider(snapshotRef.current, clock);
  }

  function boardOrAdvance() {
    const current = tripRef.current;
    if (!current) return;
    if (current.atCheckpoint) {
      updateTrip({ ...current, atCheckpoint: false });
      return;
    }
    const leg = current.route.legs[current.stepIndex];
    const nextIndex = current.stepIndex + 1;
    const next = current.route.legs[nextIndex];
    if (!next) {
      updateTrip(null);
      setOffer(null);
      setFinished(true);
      return;
    }
    const nextPoint = leg.path.at(-1) ?? next.path[0];
    const nextName = leg.to ?? next.from ?? "Current stop";
    updateTrip({
      ...current, stepIndex: nextIndex, atCheckpoint: true,
      position: { label: nextName, point: nextPoint },
      walkingSpent: current.walkingSpent + (leg.mode === "walk" ? leg.seconds : 0),
      inPaidArea: leg.mode === "subway" && next.mode === "subway",
    });
    setOffer(null);
    if (mode === "live") void reconsider(snapshotRef.current, Date.now());
  }

  function reachReplayTransfer() {
    const current = tripRef.current;
    if (!current || mode !== "replay" || current.paused) return;
    const stepIndex = current.route.legs.findIndex((leg) => leg.from === timesSquare.label);
    if (stepIndex < 0) return;
    setClock(replayTransferTime);
    updateSnapshot(replaySnapshot(disrupted, replayTransferTime));
    updateTrip({
      ...current, position: timesSquare, stepIndex, walkingSpent: 120, inPaidArea: true, atCheckpoint: true,
    });
    setNotice("");
  }

  function simulateDisruption() {
    const current = tripRef.current;
    if (mode !== "replay" || !current?.atCheckpoint || current.paused || disrupted || current.position.label !== timesSquare.label) return;
    const fresh = replaySnapshot(true, replayTransferTime);
    setDisrupted(true);
    setClock(replayTransferTime);
    updateSnapshot(fresh);
    void reconsider(fresh, replayTransferTime);
  }

  function togglePause() {
    const current = tripRef.current;
    if (!current) return;
    updateTrip({ ...current, paused: !current.paused });
    if (current.paused) void reconsider(snapshotRef.current, mode === "replay" ? clock : Date.now(), true);
  }

  function acceptOffer() {
    if (!offer || !tripRef.current?.atCheckpoint) return;
    if (assessRoute(offer.route.route, snapshotRef.current.alerts).some(({ level }) => level === "block")) {
      setOffer(null);
      setNotice("Service changed again. Refresh for a new route.");
      return;
    }
    apply(tripRef.current, offer.route.route, offer.cause, false, mode === "replay" ? clock : Date.now());
  }

  function undo() {
    const current = tripRef.current;
    if (!change || !current || current.id !== change.oldTrip.id || current.stepIndex !== 0 || !current.atCheckpoint) return;
    updateTrip({ ...change.oldTrip, optedIn: false });
    setAuto(false);
    setChange(null);
    setNotice("Previous route restored. Automatic changes are paused for this trip.");
    const [option] = rankRoutes([current.route], snapshotRef.current.alerts, candidateLimits(change.oldTrip));
    setOffer(option ? { route: option, prompt: "Alternate route available", cause: change.cause } : null);
  }

  function requestLocation() {
    if (!navigator.geolocation) return setError("Location is unavailable here. Enter an origin to continue.");
    setError("");
    navigator.geolocation.getCurrentPosition(({ coords }) => {
      if (modeRef.current !== "live") return;
      setOrigin({ label: "Current location", point: [coords.longitude, coords.latitude] });
    }, () => {
      if (modeRef.current === "live") setError("Location access is unavailable. Enter an origin to continue.");
    }, {
      enableHighAccuracy: false, maximumAge: 30_000, timeout: 8_000,
    });
  }

  function loadExample() {
    setOrigin({ label: replayOrigin.label });
    setDestination({ label: replayDestination.label });
    setError("");
  }

  function prepareDraft(data: unknown) {
    if (!data || typeof data !== "object") return { status: "invalid_input" };
    const draft = data as { origin?: unknown; destination?: unknown; arriveBy?: unknown };
    if (typeof draft.origin !== "string" || typeof draft.destination !== "string" ||
      !draft.origin.trim() || !draft.destination.trim() || draft.origin.length > 180 || draft.destination.length > 180) {
      return { status: "invalid_input" };
    }
    const arrivalTime = typeof draft.arriveBy === "string" ? parseNycDateInput(draft.arriveBy) : null;
    if (draft.arriveBy !== undefined && (arrivalTime === null || arrivalTime <= Date.now())) return { status: "invalid_arrival_time" };
    if (tripRef.current) return { status: "trip_in_progress" };
    selectMode("live");
    clearWork();
    setOrigin({ label: draft.origin.trim() });
    setDestination({ label: draft.destination.trim() });
    setTiming(arrivalTime === null ? "now" : "arrive");
    if (arrivalTime !== null) setArrival(nycDateInput(arrivalTime));
    setNotice("Trip draft ready. Review the details to find routes.");
    return { status: "draft_ready", requiresRiderReview: true };
  }

  return {
    mode, config, snapshot, origin, destination, timing, arrival, preferences, evaluated, selected, intent,
    trip, auto, offer, change, notice, error, busy, watchBusy, finished, clock, disrupted, activeImpact,
    selectMode, setOrigin, setDestination, setTiming, setArrival, rememberPreferences, selectRoute: setPreferredRoute,
    plan, start, setAutomatic, boardOrAdvance, reachReplayTransfer, simulateDisruption, togglePause, acceptOffer, undo,
    requestLocation, loadExample, prepareDraft,
    clearWork,
    refresh: () => void reconsider(snapshotRef.current, mode === "replay" ? clock : Date.now(), true),
    nextLeg: trip?.route.legs[trip.stepIndex],
    arrivalText: (route: Itinerary) => formatClock(route.arrivesAt),
  };
}
