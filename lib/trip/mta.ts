import { cityClosures, cityFeed, mtaSource } from "./city";
import { serviceLine } from "./stations";
import type { Disruption, DisruptionSnapshot, FeedHealth, Source, TimeWindow } from "./types";

type MtaMode = "subway" | "bus";
type Translation = { text?: string; language?: string };
type Translated = { translation?: Translation[] };
type Mercury = { updated_at?: number | string; alert_type?: string };
type Selector = { route_id?: string; stop_id?: string; direction_id?: string | number };
type MtaFeed = {
  header?: { timestamp?: number | string };
  entity?: {
    id?: string;
    alert?: {
      active_period?: { start?: number | string; end?: number | string }[];
      informed_entity?: Selector[];
      header_text?: Translated;
      description_text?: Translated;
      "transit_realtime.mercury_alert"?: Mercury;
    };
  }[];
};

const urls: Record<MtaMode, string> = {
  subway: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Fsubway-alerts.json",
  bus: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Fbus-alerts.json",
};
const snapshots = new Map<MtaMode, { updatedAt: number; alerts: Disruption[] }>();
const requests = new Map<MtaMode, Promise<{ alerts: Disruption[]; health: FeedHealth }>>();
const results = new Map<MtaMode, { alerts: Disruption[]; health: FeedHealth; expires: number }>();
const pollMs = 30_000;
const staleAfterMs = 5 * 60_000;

function secondsToMilliseconds(value?: number | string) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : null;
}

function english(value?: Translated) {
  return value?.translation?.find(({ language }) => language === "en")?.text?.trim() ?? "";
}

function cleanStop(stop?: string) {
  return stop?.trim().toUpperCase().replace(/^([A-Z]?\d{2,3})[NS]$/, "$1");
}

function classifyAlert(category: string, title: string, selectors: NonNullable<Disruption["selectors"]>) {
  if (/(suspension|no scheduled service)/i.test(category) &&
      selectors.every(({ stopId, direction }) => !stopId && !direction) &&
      /\b(no .{0,25}service|both directions|suspended)\b/i.test(title) &&
      !/\bbetween\b|\bbound\b|\bfrom .+ to\b|\bat\b|\bnear\b/i.test(title)) return "suspension";
  if (/(stops skipped|stop(s)? closed|station(s)? closed|stop(s)? moved)/i.test(category) &&
      selectors.some(({ stopId }) => stopId) && !/\bsome\b/i.test(title)) return "stop";
  return "advisory";
}

export function parseMta(feed: MtaFeed, mode: MtaMode) {
  const updatedAt = secondsToMilliseconds(feed.header?.timestamp);
  if (!updatedAt || !Array.isArray(feed.entity)) throw new Error("Invalid alert feed");
  const alerts = feed.entity.flatMap(({ id, alert }): Disruption[] => {
    const title = english(alert?.header_text).slice(0, 300);
    if (!id || !alert || !title) return [];
    const category = alert["transit_realtime.mercury_alert"]?.alert_type ?? "Service alert";
    const isBothWays = /\bboth directions\b/i.test(title);
    const selectors = (alert.informed_entity ?? []).flatMap((selector) => {
      if (!selector.route_id) return [];
      const stopId = cleanStop(selector.stop_id);
      const direction = !isBothWays && (
        selector.direction_id !== undefined || /\b(?:north|south|uptown|downtown)[ -]?bound\b|\bbound\b/i.test(title) ||
        (mode === "subway" && /^[A-Z]?\d{2,3}[NS]$/.test(selector.stop_id ?? ""))
      ) ? "direction-specific" : undefined;
      return [{ mode, lineId: serviceLine(selector.route_id, mode, title), stopId, direction }];
    });
    if (!selectors.length) return [];
    const windows: TimeWindow[] = (alert.active_period ?? []).map(({ start, end }) => ({
      start: secondsToMilliseconds(start),
      end: secondsToMilliseconds(end),
    })).filter(({ start, end }) => start === null || end === null || start < end);
    return [{
      id: mode + "-" + id,
      source: mode,
      title,
      detail: english(alert.description_text).slice(0, 700) || category,
      type: classifyAlert(category, title, selectors),
      windows: windows.length ? windows : [{ start: null, end: null }],
      selectors,
      href: mtaSource,
      updatedAt: secondsToMilliseconds(alert["transit_realtime.mercury_alert"]?.updated_at) ?? updatedAt,
    }];
  });
  return { updatedAt, alerts };
}

async function fetchMode(mode: MtaMode) {
  const checkedAt = Date.now();
  let reachable = false;
  try {
    const response = await fetch(urls[mode], { signal: AbortSignal.timeout(5_000), cache: "no-store" });
    if (response.ok) {
      const parsed = parseMta(await response.json() as MtaFeed, mode);
      const last = snapshots.get(mode);
      if (!last || parsed.updatedAt >= last.updatedAt) snapshots.set(mode, parsed);
      reachable = true;
    }
  } catch {
    // The last public snapshot stays visible with its original timestamp.
  }
  const cached = snapshots.get(mode);
  const fresh = !!cached && reachable && checkedAt - cached.updatedAt <= staleAfterMs &&
    cached.updatedAt - checkedAt <= 60_000;
  const health: FeedHealth = {
    source: mode as Source,
    status: fresh ? "fresh" : cached ? "stale" : "unavailable",
    checkedAt,
    updatedAt: cached?.updatedAt ?? null,
    href: mtaSource,
  };
  const alerts = cached?.alerts ?? [];
  results.set(mode, { alerts, health, expires: checkedAt + pollMs });
  return { alerts, health };
}

function getMode(mode: MtaMode) {
  const cached = results.get(mode);
  if (cached && cached.expires > Date.now()) return Promise.resolve(cached);
  const ongoing = requests.get(mode);
  if (ongoing) return ongoing;
  const request = fetchMode(mode).finally(() => requests.delete(mode));
  requests.set(mode, request);
  return request;
}

export async function getDisruptions(): Promise<DisruptionSnapshot> {
  const [subway, bus] = await Promise.all([getMode("subway"), getMode("bus")]);
  return {
    alerts: [...cityClosures, ...subway.alerts, ...bus.alerts],
    feeds: [cityFeed, subway.health, bus.health],
  };
}
