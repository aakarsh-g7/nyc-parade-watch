"use client";

import {
  ArrowRight, ArrowUpRight, BusFront, CalendarDays, Check, ChevronDown, CircleAlert, Clock3, Footprints,
  LocateFixed, MapPin, Navigation, Pause, Play, Radio, RefreshCw, RotateCcw, Route, TrainFront,
} from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { TripMap } from "./trip-map";
import { citySource, mtaSource } from "../lib/trip/city";
import { overlaps } from "../lib/trip/policy";
import { replayDeadline, timesSquare } from "../lib/trip/replay";
import { formatClock, formatDay, minutes, nycDateInput } from "../lib/trip/time";
import { post, useTripWatch } from "../lib/trip/use-trip-watch";
import type { Disruption, FeedHealth, Impact, Itinerary, Leg, Place, Preferences } from "../lib/trip/types";

type Watch = ReturnType<typeof useTripWatch>;
type Registry = {
  registerTool: (tool: {
    name: string; description: string; inputSchema: object;
    annotations?: { readOnlyHint: boolean };
    execute: (input: unknown) => object | Promise<object>;
  }, options: { signal: AbortSignal }) => unknown;
};

const sourceName = { city: "NYC closure schedule", subway: "MTA subway", bus: "MTA bus", replay: "Parade replay" };
const sourceStatus = { scheduled: "Published", fresh: "Live", stale: "Stale", unavailable: "Unavailable", replay: "Simulated" };

function useBrowserTools(watch: Watch) {
  const current = useRef(watch);
  useEffect(() => { current.current = watch; });
  useEffect(() => {
    const registry = (document as Document & { modelContext?: Registry }).modelContext;
    if (!registry?.registerTool) return;
    const lifecycle = new AbortController();
    const options = { signal: lifecycle.signal };
    function register(tool: Parameters<Registry["registerTool"]>[0]) {
      try { void Promise.resolve(registry!.registerTool(tool, options)).catch(() => {}); } catch { /* browser support is optional */ }
    }
    register({
      name: "get_disruptions",
      description: "Read public NYC walking, subway and local bus disruptions shown by Parade Trip Watch.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
      execute: () => {
        const { snapshot, clock, mode } = current.current;
        return {
          mode, feeds: snapshot.feeds,
          disruptions: snapshot.alerts.filter((alert) => alert.windows.some((window) => overlaps(window, clock, clock + 36 * 3_600_000)))
            .slice(0, 10).map(({ id, title, detail, source, windows, href }) => ({ id, title, detail, source, windows, href })),
        };
      },
    });
    register({
      name: "prepare_trip_draft",
      annotations: { readOnlyHint: false },
      description: "Prefill a NYC trip for the rider to review. The draft uses named origins and destinations.",
      inputSchema: {
        type: "object", additionalProperties: false, required: ["origin", "destination"],
        properties: {
          origin: { type: "string", minLength: 1, maxLength: 180 },
          destination: { type: "string", minLength: 1, maxLength: 180 },
          arriveBy: { type: "string", description: "Optional New York local time in YYYY-MM-DDTHH:mm format." },
        },
      },
      execute: (input) => current.current.prepareDraft(input),
    });
    return () => lifecycle.abort();
  }, []);
}

function PlaceField({ kind, value, update, live }: {
  kind: "origin" | "destination"; value: Place; update: (value: Place) => void; live: boolean;
}) {
  const id = useId();
  const [results, setResults] = useState<Place[]>([]);
  const [focus, setFocus] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const [status, setStatus] = useState("");
  const label = kind === "origin" ? "From" : "To";

  useEffect(() => {
    const query = value.label.trim();
    if (!live || !focus || value.placeId || value.point || query.length < 3) {
      setResults([]);
      setStatus("");
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void post<{ suggestions: Place[] }>("/api/places", { input: query }, controller.signal)
        .then(({ suggestions }) => {
          if (!controller.signal.aborted) {
            setResults(suggestions);
            setHighlight(-1);
            setStatus(suggestions.length ? "" : "Enter the full address to search.");
          }
        })
        .catch(() => { if (!controller.signal.aborted) setStatus("Try entering a full NYC address."); });
    }, 350);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [focus, live, value]);

  function select(place: Place) {
    update(place);
    setResults([]);
    setHighlight(-1);
    setStatus("");
  }

  const expanded = focus && results.length > 0;
  function onKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      setResults([]);
      return;
    }
    if (!expanded) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setHighlight((active) => active < 0 && delta < 0 ? results.length - 1 : (active + delta + results.length) % results.length);
    }
    if (event.key === "Enter" && highlight >= 0) {
      event.preventDefault();
      select(results[highlight]);
    }
  }

  return (
    <div className="place-field">
      <label htmlFor={id} className="field-label">{label}</label>
      <div className="place-input">
        <span className={kind === "origin" ? "place-icon from-icon" : "place-icon to-icon"}>
          {kind === "origin" ? <span /> : <MapPin size={16} strokeWidth={2.4} />}
        </span>
        <input id={id} value={value.label} readOnly={!live} autoComplete="off" maxLength={180}
          placeholder={kind === "origin" ? "Enter an NYC origin" : "Enter an NYC destination"}
          role={live ? "combobox" : undefined} aria-expanded={live ? expanded : undefined}
          aria-controls={live && expanded ? id + "-list" : undefined}
          aria-autocomplete={live ? "list" : undefined}
          aria-activedescendant={expanded && highlight >= 0 ? id + "-option-" + highlight : undefined}
          onChange={(event) => { setResults([]); update({ label: event.target.value }); }}
          onFocus={() => setFocus(true)} onBlur={() => setFocus(false)} onKeyDown={onKey} />
      </div>
      {expanded && <div className="places-menu">
        <ul role="listbox" id={id + "-list"} aria-label={label + " suggestions"}>
          {results.map((place, index) => <li key={place.placeId} role="option" id={id + "-option-" + index}
            aria-selected={highlight === index} onPointerDown={(event) => event.preventDefault()}
            onClick={() => select(place)}><MapPin size={14} />{place.label}</li>)}
        </ul>
        <span className="places-credit">Google Maps</span>
      </div>}
      {focus && status && <span className="field-hint" role="status">{status}</span>}
    </div>
  );
}

function preferencesSummary(preferences: Preferences) {
  return preferences.priority === "less-walking" ? "Less walking" :
    preferences.priority === "fewer-transfers" ? "Fewer transfers" : "Fastest route";
}

function Planner({ watch }: { watch: Watch }) {
  function submit(event: FormEvent) {
    event.preventDefault();
    void watch.plan();
  }
  const live = watch.mode === "live";
  return (
    <section className="panel planner" aria-labelledby="planner-title">
      <div className="panel-head">
        <span className="panel-icon"><Navigation size={18} /></span>
        <div><h2 id="planner-title">Plan a trip</h2><p>Walking, subway and local bus</p></div>
      </div>
      {live ? <button type="button" className="text-button example-button" onClick={watch.loadExample}>Use an example trip <ArrowRight size={14} /></button> :
        <div className="replay-context"><Play size={14} /> Sample trip to Grand Central</div>}
      <form onSubmit={submit}>
        <div className="planner-fields">
          <PlaceField kind="origin" live={live} value={watch.origin} update={watch.setOrigin} />
          {live && <button className="text-button locate" type="button" onClick={watch.requestLocation}><LocateFixed size={15} /> Use my location</button>}
          <PlaceField kind="destination" live={live} value={watch.destination} update={watch.setDestination} />
          <fieldset className="time-field">
            <legend className="field-label">When</legend>
            <div className="segmented time-buttons">
              <button type="button" aria-pressed={watch.timing === "now"} onClick={() => watch.setTiming("now")}>Leave now</button>
              <button type="button" aria-pressed={watch.timing === "arrive"} onClick={() => watch.setTiming("arrive")}>Arrive by</button>
            </div>
            {watch.timing === "arrive" && <>
              <label className="sr-only" htmlFor="arrival-time">Arrival date and time in New York</label>
              <input className="date-input" type="datetime-local" id="arrival-time" value={watch.arrival}
                onChange={(event) => watch.setArrival(event.target.value)} />
              <small className="field-hint">New York time</small>
              {live && replayDeadline > Date.now() && <button type="button" className="text-button parade-time"
                onClick={() => watch.setArrival(nycDateInput(replayDeadline))}>Set parade morning</button>}
            </>}
          </fieldset>
        </div>
        <details className="preferences">
          <summary><span>Trip preferences <small>{preferencesSummary(watch.preferences)}</small></span><ChevronDown size={17} /></summary>
          <div className="preferences-fields">
            <label>Travel mode <select value={watch.preferences.mode}
              onChange={(event) => watch.rememberPreferences({ ...watch.preferences, mode: event.target.value as Preferences["mode"] })}>
              <option value="all">Walking and transit</option><option value="transit">Transit with walking connections</option>
              <option value="walk">Walking only</option></select>
            </label>
            <label>Prioritize <select value={watch.preferences.priority}
              onChange={(event) => watch.rememberPreferences({ ...watch.preferences, priority: event.target.value as Preferences["priority"] })}>
              <option value="fastest">Fastest route</option><option value="less-walking">Less walking</option>
              <option value="fewer-transfers">Fewer transfers</option></select>
            </label>
            <label>Maximum walking time (minutes) <input type="number" min={1} max={240} step={1}
              value={watch.preferences.maxWalkMinutes ?? ""} placeholder="Any"
              onChange={(event) => {
                const entered = event.target.valueAsNumber;
                watch.rememberPreferences({ ...watch.preferences, maxWalkMinutes:
                  Number.isFinite(entered) ? Math.min(240, Math.max(1, Math.floor(entered))) : null });
              }} /></label>
          </div>
        </details>
        {watch.error && <p className="feedback error" role="alert"><CircleAlert size={16} />{watch.error}</p>}
        {watch.notice && <p className="feedback" role="status">{watch.notice}</p>}
        <button type="submit" className="button primary full" disabled={watch.busy}>
          {watch.busy ? "Finding routes…" : "Find routes"} {watch.busy ? <RefreshCw size={18} className="spin" /> : <ArrowRight size={18} />}
        </button>
      </form>
    </section>
  );
}

function LineTag({ leg }: { leg: Leg }) {
  if (leg.mode === "walk") return <span className="line-tag line-walk" aria-label="Walking"><Footprints size={14} /></span>;
  return <span className={leg.mode === "bus" ? "line-tag line-bus" : "line-tag"} style={{ backgroundColor: leg.color ?? "#1f5788" }}
    aria-label={leg.mode === "bus" ? (leg.line ?? "") + " bus" : (leg.line ?? "") + " train"}>{leg.line ?? "MTA"}</span>;
}

function LineStrip({ route }: { route: Itinerary }) {
  return <div className="line-strip">{route.legs.slice(0, 8).map((leg, index) => <span className="strip-piece" key={index}>
    {index > 0 && <ArrowRight size={11} aria-hidden="true" />}<LineTag leg={leg} />
  </span>)}</div>;
}

function RouteStats({ route, from }: { route: Itinerary; from?: number }) {
  return <div className="route-stats">
    <span><Clock3 size={14} /> {minutes((route.arrivesAt - (from ?? route.departsAt)) / 1_000)} min</span>
    <span><Footprints size={14} /> {minutes(route.walkSeconds)} min walk</span>
    <span><TrainFront size={14} /> {route.transfers} {route.transfers === 1 ? "transfer" : "transfers"}</span>
  </div>;
}

function AutoConsent({ checked, set }: { checked: boolean; set: (value: boolean) => void }) {
  return <label className="auto-consent"><input type="checkbox" checked={checked} onChange={(event) => set(event.target.checked)} />
    <span><strong>Allow automatic rerouting</strong><small>Switch at a stop when a new route fits your limits.</small></span>
  </label>;
}

function Itineraries({ watch }: { watch: Watch }) {
  if (!watch.selected || !watch.intent) return null;
  const { route, impacts, tradeoffs } = watch.selected;
  const blocked = impacts.some(({ level }) => level === "block");
  return <section className="panel itinerary-panel" aria-labelledby="itinerary-title">
    <div className="panel-head">
      <span className="panel-icon"><Route size={18} /></span>
      <div><h2 id="itinerary-title">Your routes</h2><p>{watch.intent.origin.label} to {watch.intent.destination.label}</p></div>
      <button className="text-button panel-action" onClick={watch.clearWork} type="button">Edit</button>
    </div>
    <div className="route-card">
      <div className="route-card-head"><span>Arrives at</span><strong>{formatClock(route.arrivesAt)}</strong></div>
      <LineStrip route={route} />
      <RouteStats route={route} />
      {tradeoffs.length > 0 && <p className="inline-warning">{tradeoffs.join(" · ")}</p>}
      {impacts[0] && <p className="inline-warning">{impacts[0].alert.title} · {impacts[0].alert.detail}</p>}
    </div>
    {watch.evaluated.length > 1 && <details className="alternatives"><summary>Compare {watch.evaluated.length} routes <ChevronDown size={16} /></summary>
      <div className="alternative-list">{watch.evaluated.map((item) => <button type="button" key={item.route.id}
        aria-pressed={item.route.id === route.id} onClick={() => watch.selectRoute(item.route.id)}>
        <LineStrip route={item.route} /><span>{formatClock(item.route.arrivesAt)}</span>
        {item.impacts.some(({ level }) => level === "block") && <small>Disrupted</small>}
      </button>)}</div>
    </details>}
    <AutoConsent checked={watch.auto} set={watch.setAutomatic} />
    {watch.error && <p className="feedback error" role="alert"><CircleAlert size={16} />{watch.error}</p>}
    {watch.notice && <p className="feedback" role="status">{watch.notice}</p>}
    <button className="button primary full" type="button" onClick={watch.start} disabled={blocked}>
      <Radio size={17} /> {blocked ? "Choose an available route" : "Watch this trip"} <ArrowRight size={17} />
    </button>
  </section>;
}

function Steps({ route, index }: { route: Itinerary; index: number }) {
  return <ol className="steps">
    {route.legs.map((leg, i) => <li className={i === index ? "current-step" : i < index ? "done-step" : ""} key={i}
      aria-current={i === index ? "step" : undefined}>
      <LineTag leg={leg} /><div><strong>{leg.mode === "walk" ? leg.instruction : leg.from + " → " + leg.to}</strong>
        <small>{leg.mode === "walk" ? minutes(leg.seconds) + " min walk" : formatClock(leg.startsAt) + " · " + minutes(leg.seconds) + " min ride"}</small></div>
      {i < index && <Check size={16} className="step-check" />}
    </li>)}
  </ol>;
}

function Monitor({ watch }: { watch: Watch }) {
  const trip = watch.trip;
  if (!trip) return null;
  const next = watch.nextLeg;
  const atTransfer = trip.position.label === timesSquare.label;
  const canReplayTransfer = watch.mode === "replay" && !atTransfer && trip.route.legs.some(({ from }) => from === timesSquare.label);
  const canUndo = watch.change && trip.atCheckpoint && trip.stepIndex === 0;
  const blockedNext = !!next && trip.atCheckpoint && watch.activeImpact.some(({ level }) => level === "block");
  const action = next ? trip.atCheckpoint ? next.mode === "walk" ? "Start walking" : "Board " + next.line : "I’ve reached the next stop" : "Finish trip";

  return <section className="panel itinerary-panel monitor" aria-labelledby="monitor-title">
    <div className="panel-head">
      <span className="panel-icon"><Radio size={18} /></span>
      <div><h2 id="monitor-title">Trip watch</h2><p>{trip.intent.destination.label}</p></div>
      <button className="text-button panel-action" onClick={watch.clearWork} type="button">End</button>
    </div>
    <div className="watch-status"><span className={trip.paused ? "status-dot muted-dot" : "status-dot"} />
      {trip.paused ? "Monitoring paused" : watch.watchBusy ? "Checking route options" : "Monitoring this trip"}
      <button className="text-button" type="button" onClick={watch.togglePause}>
        {trip.paused ? <Play size={14} /> : <Pause size={14} />}{trip.paused ? "Resume" : "Pause"}
      </button>
    </div>
    {watch.change && <div className="change-banner" role="status">
      <div className="change-icon"><Check size={17} /></div>
      <div><strong>{watch.change.automatic ? "Switched to the " : "Route updated to "} {watch.change.line}</strong>
        <p>{watch.change.cause}. Arrives at {formatClock(watch.change.to)}.</p></div>
      {canUndo && <button className="text-button" type="button" onClick={watch.undo}><RotateCcw size={14} /> Undo</button>}
    </div>}
    {watch.offer && <div className="offer-banner" role="status">
      <strong>{watch.offer.prompt}</strong>
      <p>{watch.offer.cause}. This route arrives at {formatClock(watch.offer.route.route.arrivesAt)}.</p>
      <LineStrip route={watch.offer.route.route} />
      <button className="button secondary" type="button" onClick={watch.acceptOffer} disabled={!trip.atCheckpoint || trip.paused}>
        Use alternate route <ArrowRight size={15} />
      </button>
    </div>}
    {!watch.change && watch.activeImpact.length > 0 && <p className="inline-warning impact-warning">
      <CircleAlert size={16} /> {watch.activeImpact[0].alert.title}
    </p>}
    <div className="route-card compact-route">
      <div className="route-card-head"><span>Arrives at</span><strong>{formatClock(trip.route.arrivesAt)}</strong></div>
      <LineStrip route={trip.route} />
    </div>
    <Steps route={trip.route} index={trip.stepIndex} />
    {watch.notice && <p className="feedback" role="status">{watch.notice}</p>}
    {watch.mode === "replay" && <div className="replay-controls" id="replay-controls">
      <div><span className="status-dot amber-dot" /><strong>Replay controls</strong></div>
      {canReplayTransfer && <button className="button secondary full" type="button" onClick={watch.reachReplayTransfer}
        disabled={trip.paused}>I’m at Times Square <ArrowRight size={16} /></button>}
      {atTransfer && <button className="button secondary alert-button full" type="button" onClick={watch.simulateDisruption}
        disabled={watch.disrupted || trip.paused || !trip.atCheckpoint}>
        <CircleAlert size={16} /> {watch.disrupted ? "Shuttle suspension simulated" : "Simulate shuttle suspension"}
      </button>}
    </div>}
    <AutoConsent checked={trip.optedIn} set={watch.setAutomatic} />
    <button className="button primary full" type="button" onClick={watch.boardOrAdvance} disabled={trip.paused || blockedNext}>{blockedNext ? "Route affected" : action} <ArrowRight size={17} /></button>
    {watch.mode === "live" && <button className="text-button manual-refresh" type="button" onClick={watch.refresh} disabled={watch.watchBusy || trip.paused}>
      <RefreshCw size={14} /> Refresh route
    </button>}
  </section>;
}

function windowLabel(alert: Disruption, now: number) {
  if (alert.source === "replay") return "Simulated at " + formatClock(now);
  const window = alert.windows.find((item) => overlaps(item, now, now)) ?? alert.windows.find(({ start }) => start !== null && start > now) ?? alert.windows[0];
  if (!window) return "Timing varies";
  if (window.start !== null && window.end !== null) {
    return formatDay(window.start) + " · " + formatClock(window.start) + " to " +
      (formatDay(window.start) === formatDay(window.end) ? "" : formatDay(window.end) + " · ") + formatClock(window.end);
  }
  return window.end !== null ? "Until " + formatClock(window.end) : "See agency update";
}

function SourceRow({ feed }: { feed: FeedHealth }) {
  return <a className="source-row" href={feed.href} target={feed.status === "replay" ? undefined : "_blank"} rel="noreferrer">
    <span><strong>{sourceName[feed.source]}</strong>{feed.status !== "replay" && <ArrowUpRight size={13} />}
      {feed.updatedAt && feed.status !== "replay" && <small>Updated {formatClock(feed.updatedAt)} ET</small>}</span>
    <span className={"feed-badge " + feed.status}><i />{sourceStatus[feed.status]}</span>
  </a>;
}

function Disruptions({ watch, related }: { watch: Watch; related: Impact[] }) {
  const [tab, setTab] = useState<"city" | "transit" | "trip">("city");
  const [more, setMore] = useState(false);
  const unique = new Map<string, Disruption>();
  if (tab === "trip") {
    for (const { alert } of related) unique.set(alert.id, alert);
  } else {
    for (const alert of watch.snapshot.alerts) {
      if (tab === "city" ? alert.source === "city" : alert.source !== "city" &&
        alert.windows.some((window) => overlaps(window, watch.clock, watch.clock + 24 * 3_600_000))) unique.set(alert.id, alert);
    }
  }
  const alerts = [...unique.values()];
  alerts.sort((a, b) => Number(b.source === "replay") - Number(a.source === "replay") ||
    Number(b.windows.some((window) => overlaps(window, watch.clock, watch.clock))) -
    Number(a.windows.some((window) => overlaps(window, watch.clock, watch.clock))));
  return <section className="disruptions-grid" aria-labelledby="disruptions-title">
    <div className="panel alerts-panel">
      <div className="section-head"><div><h2 id="disruptions-title">Disruptions</h2>
        <p>Parade closures and service changes</p></div>
        <div className="segmented alert-tabs" aria-label="Disruption filters">
          {([["city", "Streets"], ["transit", "Transit"], ["trip", "Your trip"]] as const).map(([value, label]) =>
            <button type="button" aria-pressed={tab === value} key={value}
              onClick={() => { setTab(value); setMore(false); }}>{label}</button>)}
        </div>
      </div>
      <div className="alert-list">
        {alerts.slice(0, more ? 20 : 3).map((alert) => <article className="alert-item" key={alert.id}>
          <span className={"alert-icon " + (alert.source === "city" ? "street-alert" : "")}>
            {alert.source === "city" ? <MapPin size={16} /> : alert.source === "bus" ? <BusFront size={16} /> : <TrainFront size={16} />}
          </span>
          <div><h3>{alert.title}</h3><p>{alert.detail}</p><small>{windowLabel(alert, watch.clock)}</small></div>
          {alert.source !== "replay" && <a href={alert.href} target="_blank" rel="noreferrer" aria-label={"Source for " + alert.title}><ArrowUpRight size={17} /></a>}
        </article>)}
        {alerts.length === 0 && <p className="alert-empty">{tab === "trip" ?
          "Pick a route to check which disruptions could affect it." : "There are no transit alerts to show for this time."}</p>}
      </div>
      {alerts.length > 3 && <button className="text-button show-alerts" type="button" onClick={() => setMore(!more)}>
        {more ? "Show fewer" : "Show more disruptions"} <ChevronDown size={16} />
      </button>}
    </div>
    <aside className="panel sources-panel" aria-labelledby="data-sources">
      <div className="section-head"><div><h2 id="data-sources">Sources</h2><p>{watch.mode === "live" ? "Agency updates and route data" : "City schedule and replay data"}</p></div></div>
      {watch.snapshot.feeds.map((feed) => <SourceRow key={feed.source} feed={feed} />)}
      <a className="text-button sources-link" href={mtaSource} target="_blank" rel="noreferrer">MTA planned service changes <ArrowUpRight size={14} /></a>
    </aside>
  </section>;
}

export function TripWatch() {
  const watch = useTripWatch();
  useBrowserTools(watch);
  const shownRoute = watch.trip?.route ?? watch.selected?.route;
  const related = watch.trip ? watch.activeImpact : watch.selected?.impacts ?? [];
  const closures = watch.snapshot.alerts.filter(({ source }) => source === "city");
  const eventClock = formatClock(watch.clock);
  return (
    <div className="site-shell">
      <a className="skip-link" href="#main">Skip to trip planner</a>
      <header className="topbar">
        <div className="topbar-inner">
          <a className="brand" href="/" aria-label="Parade Trip Watch home">
            <span className="brand-mark"><Route size={23} strokeWidth={2.2} /></span>
            <span><strong>Parade Trip Watch</strong><small>NEW YORK CITY</small></span>
          </a>
          <div className="segmented view-switch" aria-label="Data mode">
            <button aria-pressed={watch.mode === "live"} onClick={() => watch.selectMode("live")} type="button"><Radio size={16} /> Live</button>
            <button aria-pressed={watch.mode === "replay"} onClick={() => watch.selectMode("replay")} type="button"><Play size={15} /> Parade Replay</button>
          </div>
        </div>
      </header>
      <main id="main" className="page">
        <header className="intro">
          <div>
            <div className="eyebrow"><span /> MACY’S 100TH THANKSGIVING DAY PARADE</div>
            <h1>Get there on parade day.</h1>
            <p>Plan a walking or transit trip and adapt to closures and service changes.</p>
          </div>
          <div className="date-card"><span className="date-icon"><CalendarDays size={19} /></span>
            <span><strong>{watch.mode === "replay" ? "Nov 26 · " + eventClock : "November 25–26, 2026"}</strong>
              <small>{watch.mode === "replay" ? "Simulated New York time" : "Balloon inflation and parade"}</small></span>
          </div>
        </header>
        <div className="trip-layout">
          {watch.finished ? <section className="panel finish-panel"><span className="panel-icon"><Check size={20} /></span>
            <h2>Trip complete</h2><p>Trip monitoring has ended.</p><button type="button" className="button primary" onClick={watch.clearWork}>Plan another trip <ArrowRight size={16} /></button></section> :
            watch.trip ? <Monitor watch={watch} /> : watch.selected ? <Itineraries watch={watch} /> : <Planner watch={watch} />}
          <section className="panel map-card" aria-labelledby="map-title">
            <div className="map-head"><div><h2 id="map-title">Parade map</h2><p>Manhattan street closures and your route</p></div>
              <a className="text-button city-link" href={citySource} target="_blank" rel="noreferrer">City bulletin <ArrowUpRight size={15} /></a>
            </div>
            <TripMap mode={watch.mode} browserKey={watch.config?.browserKey ?? ""} route={shownRoute} closures={closures} time={watch.mode === "live" && shownRoute ? Math.max(watch.clock, shownRoute.departsAt) : watch.clock} />
            <div className="map-legend" aria-label="Map legend">
              <span><i className="legend-parade" /> Parade path</span><span><i className="legend-street" /> Street closure</span>
              {shownRoute && <span><i className="legend-trip" /> Your route</span>}
            </div>
          </section>
        </div>
        <Disruptions watch={watch} related={related} />
        <footer className="footer">
          <span>Walking, subway and local bus trips in NYC.</span>
          <details><summary>Trip privacy</summary><p>Trip details stay in this session. In Live mode, the app sends the selected places to Google Maps to find a route. Use current location only when you want to share it for routing.</p></details>
        </footer>
      </main>
    </div>
  );
}
