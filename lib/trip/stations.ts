import data from "./data/stations.json";
import { distanceMeters } from "./geo";
import type { Point } from "./types";

type Station = [id: string, name: string, longitude: number, latitude: number, lines: string, complex: string];
const stations = data as Station[];

export function normalizeName(value = "") {
  return value.toLowerCase()
    .replace(/\b(\d+)(st|nd|rd|th)\b/g, "$1")
    .replace(/\b(street|avenue|square|road|place|boulevard)\b/g, (word) =>
      ({ street: "st", avenue: "av", square: "sq", road: "rd", place: "pl", boulevard: "blvd" })[word] ?? word)
    .replace(/\bav(e)\b/g, "av")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function serviceLine(label: string, mode: "bus" | "subway", stops = "") {
  const line = label.trim().toUpperCase().replace(/.*_/, "").replace(/\s+/g, "");
  if (mode === "bus") return line.replace(/(SBS|SELECTBUSSERVICE)$/, "");
  if (line === "S" && /grand central|times sq/i.test(stops)) return "GS";
  return line.replace(/[^A-Z0-9]/g, "");
}

export function stationFor(name: string | undefined, point: Point | undefined, line: string) {
  if (!name) return undefined;
  const key = normalizeName(name);
  const displayedLine = line === "GS" ? "S" : line.replace(/X$/, "");
  const eligible = stations.filter(([, , , , lines]) => lines.split(" ").includes(displayedLine));
  const matches = eligible.filter(([, label]) => normalizeName(label) === key);
  if (matches.length === 1 && (!point || distanceMeters(point, [matches[0][2], matches[0][3]]) < 400)) {
    return { id: matches[0][0], complex: matches[0][5] };
  }
  if (!point) return undefined;
  const nearby = eligible.map(([id, , lng, lat, , complex]) => ({
    id,
    complex,
    distance: distanceMeters(point, [lng, lat]),
  })).sort((a, b) => a.distance - b.distance);
  if (nearby[0]?.distance < 130 &&
    (nearby[1] === undefined || nearby[1].id === nearby[0].id || nearby[1].distance - nearby[0].distance > 35)) {
    return nearby[0];
  }
  return undefined;
}
