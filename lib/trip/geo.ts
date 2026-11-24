import type { Point } from "./types.ts";

export function distanceMeters(a: Point, b: Point) {
  const lat = (a[1] + b[1]) * Math.PI / 360;
  const east = (a[0] - b[0]) * 111_320 * Math.cos(lat);
  const north = (a[1] - b[1]) * 110_540;
  return Math.hypot(east, north);
}

export function pointToSegmentMeters(point: Point, a: Point, b: Point) {
  const factor = Math.cos(point[1] * Math.PI / 180);
  const east = (b[0] - a[0]) * factor;
  const north = b[1] - a[1];
  const length = east * east + north * north;
  if (length === 0) return distanceMeters(point, a);
  const fraction = Math.max(0, Math.min(1,
    (((point[0] - a[0]) * factor * east) + ((point[1] - a[1]) * north)) / length,
  ));
  return distanceMeters(point, [a[0] + fraction * (b[0] - a[0]), a[1] + fraction * north]);
}

const cross = (a: Point, b: Point, c: Point) =>
  (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

export function pathsTouch(path: Point[], street: Point[]) {
  return path.slice(1).some((b, i) => street.slice(1).some((d, j) => {
    const a = path[i];
    const c = street[j];
    const within = (axis: 0 | 1) =>
      Math.max(a[axis], b[axis]) + 0.00017 >= Math.min(c[axis], d[axis]) &&
      Math.max(c[axis], d[axis]) + 0.00017 >= Math.min(a[axis], b[axis]);
    if (!within(0) || !within(1)) return false;
    return (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) ||
      Math.min(pointToSegmentMeters(a, c, d), pointToSegmentMeters(b, c, d),
        pointToSegmentMeters(c, a, b), pointToSegmentMeters(d, a, b)) <= 12;
  }));
}

export function decodePolyline(value: string): Point[] {
  const points: Point[] = [];
  let index = 0;
  let latitude = 0;
  let longitude = 0;

  function nextDelta() {
    let code: number;
    let result = 0;
    let shift = 0;
    do {
      if (index >= value.length || shift > 25) throw new Error("Invalid route geometry");
      code = value.charCodeAt(index++) - 63;
      if (code < 0 || code > 63) throw new Error("Invalid route geometry");
      result |= (code & 31) << shift;
      shift += 5;
    } while (code >= 32);
    return result & 1 ? ~(result >> 1) : result >> 1;
  }

  while (index < value.length) {
    latitude += nextDelta();
    longitude += nextDelta();
    points.push([longitude / 100_000, latitude / 100_000]);
  }
  return points;
}

export function pathsFollow(path: Point[], street: Point[]) {
  return path.slice(1).some((b, i) => {
    const a = path[i];
    if (distanceMeters(a, b) < 20) return false;
    const samples: Point[] = [0.25, 0.5, 0.75].map((t) => [
      a[0] + (b[0] - a[0]) * t,
      a[1] + (b[1] - a[1]) * t,
    ]);
    const near = samples.filter((sample) =>
      street.slice(1).some((d, index) => pointToSegmentMeters(sample, street[index], d) <= 10));
    return near.length === 3;
  });
}
