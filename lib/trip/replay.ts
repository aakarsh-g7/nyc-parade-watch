import { cityClosures, cityFeed } from "./city";
import { paradeMorning } from "./time";
import type { Disruption, DisruptionSnapshot, Itinerary, Leg, Place, Point } from "./types";

export const replayOrigin: Place = { label: "West 79th St & Broadway", point: [-73.97991, 40.78384] };
export const replayDestination: Place = { label: "Grand Central Terminal", point: [-73.97722, 40.75273] };
export const timesSquare: Place = { label: "Times Square–42 St", point: [-73.98771, 40.75568] };
export const replayDeadline = Date.parse("2026-11-26T10:15:00-05:00");
export const replayTransferTime = paradeMorning + 12 * 60_000;

export const replaySuspension: Disruption = {
  id: "replay-shuttle-suspension",
  source: "replay",
  title: "42nd Street Shuttle suspended",
  detail: "Replay alert. The 7 train is running between Times Square and Grand Central.",
  type: "suspension",
  selectors: [{ mode: "subway", lineId: "GS" }],
  windows: [{ start: replayTransferTime, end: null }],
  href: "#replay-controls",
  updatedAt: replayTransferTime,
};

const originPoint = replayOrigin.point!;
const transferPoint = timesSquare.point!;
const destinationPoint = replayDestination.point!;

function train(
  line: string, from: string, to: string, path: Point[], startsAt: number, rideMinutes: number,
  fromStop: string, toStop: string, color: string,
): Leg {
  return {
    mode: "subway", line, lineId: line === "S" ? "GS" : line, color, from, to, path,
    startsAt, endsAt: startsAt + rideMinutes * 60_000, seconds: rideMinutes * 60,
    instruction: "Take the " + line + " to " + to, fromStop, toStop,
  };
}

function walk(path: Point[], start: number, length: number, instruction: string): Leg {
  return { mode: "walk", path, startsAt: start, endsAt: start + 60_000 * length, seconds: 60 * length, instruction };
}

export function replayRoutes(fromTransfer: boolean, now: number): Itinerary[] {
  const transit: Itinerary[] = ["S", "7"].map((line) => {
    const useShuttle = line === "S";
    const board = (fromTransfer ? now : replayTransferTime) + (useShuttle ? 2 : 4) * 60_000;
    const shuttlePath: Point[] = useShuttle
      ? [transferPoint, [-73.98562, 40.75544], [-73.98196, 40.75388], [-73.97994, 40.75302], destinationPoint]
      : [transferPoint, [-73.98587, 40.75499], [-73.98353, 40.75400], [-73.97918, 40.75216], destinationPoint];
    const crosstown = train(line, timesSquare.label, "Grand Central–42 St", shuttlePath,
      board, useShuttle ? 2 : 3, useShuttle ? "901" : "725", useShuttle ? "902" : "723", useShuttle ? "#66727a" : "#7b3f97");
    crosstown.fromComplex = "Times Square";
    const entry: Point = [-73.98020, 40.78364];
    const approach = walk([originPoint, entry], paradeMorning, 2, "Walk to the 79 St subway entrance");
    const subway = train("1", "79 St", timesSquare.label,
      [entry, [-73.98217, 40.77886], [-73.98369, 40.77357], [-73.98592, 40.76558], transferPoint],
      paradeMorning + 4 * 60_000, 8, "120", "127", "#d82f43");
    const exit = walk([destinationPoint, [-73.97773, 40.75281]], crosstown.endsAt, 1, "Walk to Grand Central Terminal");
    const legs = fromTransfer ? [crosstown, exit] : [approach, subway, crosstown, exit];
    return {
      id: "replay-" + line + "-" + (fromTransfer ? "transfer" : "full"),
      pattern: fromTransfer ? "transfer-" + line : "full-" + line,
      mode: "transit",
      legs, path: legs.flatMap(({ path }) => path),
      departsAt: fromTransfer ? now : paradeMorning,
      arrivesAt: exit.endsAt,
      walkSeconds: fromTransfer ? 60 : 180,
      transfers: fromTransfer ? 0 : 1,
      fare: null,
      fareClass: "single-subway",
    };
  });
  const walkPath: Point[] = fromTransfer
    ? [transferPoint, [-73.98527, 40.75466], [-73.98148, 40.75308], destinationPoint]
    : [originPoint, [-73.98261, 40.77539], [-73.98301, 40.76783], [-73.98144, 40.7681],
      [-73.97694, 40.76588], [-73.97991, 40.75478], destinationPoint];
  const walking = walk(walkPath, now, fromTransfer ? 14 : 42, "Walk to Grand Central Terminal");
  return [...transit, {
    id: "replay-walk", pattern: "replay-walk", mode: "walk", legs: [walking], path: walkPath,
    departsAt: now, arrivesAt: walking.endsAt, walkSeconds: walking.seconds, transfers: 0, fare: null, fareClass: "free",
  }];
}

export function replaySnapshot(disrupted: boolean, now: number): DisruptionSnapshot {
  return {
    alerts: disrupted ? [replaySuspension, ...cityClosures] : cityClosures,
    feeds: [
      cityFeed,
      { source: "subway", status: "replay", checkedAt: now, updatedAt: now, href: "#replay-controls" },
      { source: "bus", status: "replay", checkedAt: now, updatedAt: now, href: "#replay-controls" },
    ],
  };
}
