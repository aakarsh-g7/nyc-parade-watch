"use client";

import { LocateFixed, Minus, Plus } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { paradePath } from "../lib/trip/city";
import streetsData from "../lib/trip/data/streets.json";
import { overlaps } from "../lib/trip/policy";
import type { Disruption, Itinerary, Point } from "../lib/trip/types";
import type { Surface } from "../lib/trip/use-trip-watch";

type Camera = { zoom: number; x: number; y: number };
type MapProps = { mode: Surface; browserKey: string; route?: Itinerary; closures: Disruption[]; time: number };
type NativeMap = { fitBounds: (bounds: NativeBounds, padding: number) => void; getZoom: () => number | undefined; setZoom: (zoom: number) => void };
type NativeBounds = { extend: (location: Position) => void };
type NativeLine = { setMap: (map: NativeMap | null) => void };
type Position = { lng: number; lat: number };
type Maps = {
  Map: new (node: HTMLElement, options: Record<string, unknown>) => NativeMap;
  LatLngBounds: new () => NativeBounds;
  Polyline: new (options: Record<string, unknown>) => NativeLine;
  Circle: new (options: Record<string, unknown>) => NativeLine;
};
type MapWindow = Window & { google?: { maps: Maps }; gm_authFailure?: () => void; __paradeMapsLoaded?: () => void };

const center: Point = [-73.9803, 40.7663];
const initialCamera: Camera = { zoom: 1, x: 0, y: 0 };
const streets = streetsData as unknown as [number, Point[]][];
const riverShore: Point[] = [
  [-74.014, 40.736], [-74.009, 40.743], [-74.0065, 40.751], [-74.0026, 40.759],
  [-73.9977, 40.765], [-73.9931, 40.772], [-73.990, 40.7774], [-73.9825, 40.79],
  [-73.978, 40.800], [-73.956, 40.805], [-73.936, 40.79], [-73.941, 40.772],
  [-73.955, 40.763], [-73.963, 40.754], [-73.971, 40.746], [-73.977, 40.739],
  [-73.982, 40.733], [-73.989, 40.725], [-74.015, 40.727],
];
const park: Point[] = [
  [-73.98144, 40.7681], [-73.97324, 40.76432], [-73.94935, 40.79685], [-73.95785, 40.80059],
];
const reservoir: Point[] = [
  [-73.96710, 40.77662], [-73.96473, 40.77588], [-73.96076, 40.77932], [-73.95790, 40.78199],
  [-73.9580, 40.78522], [-73.96139, 40.78638], [-73.96590, 40.78394], [-73.96775, 40.77905],
];
const mapLabels: { text: string; point: Point; style: "area" | "place" | "water" }[] = [
  { text: "CENTRAL PARK", point: [-73.9692, 40.7810], style: "area" },
  { text: "UPPER WEST SIDE", point: [-73.9877, 40.7896], style: "area" },
  { text: "UPPER EAST SIDE", point: [-73.9532, 40.7778], style: "area" },
  { text: "HELL’S KITCHEN", point: [-73.9950, 40.7609], style: "area" },
  { text: "MIDTOWN", point: [-73.9694, 40.7528], style: "area" },
  { text: "CHELSEA", point: [-74.0045, 40.746], style: "area" },
  { text: "Hudson River", point: [-74.007, 40.7726], style: "water" },
  { text: "East River", point: [-73.9574, 40.7447], style: "water" },
  { text: "Columbus Circle", point: [-73.9843, 40.7701], style: "place" },
  { text: "Times Square", point: [-73.9903, 40.7552], style: "place" },
  { text: "Herald Square", point: [-73.9919, 40.7479], style: "place" },
  { text: "Grand Central", point: [-73.9735, 40.75125], style: "place" },
];
const position = ([lng, lat]: Point): Position => ({ lng, lat });

let mapsRequest: Promise<Maps> | null = null;
const authFailures = new Set<() => void>();

function loadGoogle(key: string) {
  const win = window as MapWindow;
  if (win.google?.maps?.Map) return Promise.resolve(win.google.maps);
  if (mapsRequest) return mapsRequest;
  mapsRequest = new Promise<Maps>((resolve, reject) => {
    const script = document.createElement("script");
    const timeout = window.setTimeout(() => reject(new Error("Google Maps timed out.")), 15_000);
    win.gm_authFailure = () => {
      for (const listener of authFailures) listener();
      reject(new Error("Google Maps could not authorize this map."));
    };
    win.__paradeMapsLoaded = () => {
      window.clearTimeout(timeout);
      if (win.google?.maps?.Map) resolve(win.google.maps);
      else reject(new Error("The Google map is unavailable."));
    };
    script.src = "https://maps.googleapis.com/maps/api/js?" + new URLSearchParams({
      key, v: "weekly", loading: "async", callback: "__paradeMapsLoaded",
    });
    script.async = true;
    script.referrerPolicy = "strict-origin-when-cross-origin";
    script.onerror = () => {
      window.clearTimeout(timeout);
      reject(new Error("The Google map is unavailable."));
    };
    document.head.appendChild(script);
  });
  return mapsRequest;
}

function drawReplay(canvas: HTMLCanvasElement, camera: Camera, active: Disruption[], route?: Itinerary) {
  const { width, height } = canvas.getBoundingClientRect();
  if (!width || !height) return;
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.scale(ratio, ratio);
  const scale = Math.min(width / 0.040, height / 0.041) * camera.zoom;
  const px = ([lng, lat]: Point): [number, number] => [
    width * 0.5 + (lng - center[0]) * 0.756 * scale + camera.x,
    height * 0.5 - (lat - center[1]) * scale + camera.y,
  ];
  function addLine(line: Point[]) {
    if (line.length < 2 || !ctx) return;
    ctx.moveTo(...px(line[0]));
    for (const point of line.slice(1)) ctx.lineTo(...px(point));
  }
  function fillShape(line: Point[], color: string) {
    if (!ctx) return;
    ctx.beginPath();
    addLine(line);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  }
  function stroke(line: Point[], color: string, weight: number, dash: number[] = []) {
    if (!ctx) return;
    ctx.beginPath();
    addLine(line);
    ctx.strokeStyle = color;
    ctx.lineWidth = weight;
    ctx.setLineDash(dash);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.fillStyle = "#d2e4e6";
  ctx.fillRect(0, 0, width, height);
  fillShape(riverShore, "#ecebe3");
  fillShape(park, "#ccdabc");
  fillShape(reservoir, "#bcd8da");

  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const roadType of [0, 1]) {
    ctx.beginPath();
    for (const [kind, path] of streets) if (kind === roadType) addLine(path);
    ctx.strokeStyle = roadType === 1 ? "#fffdf5" : "rgba(255,253,247,.86)";
    ctx.lineWidth = roadType === 1 ? 1.9 : 0.85;
    ctx.stroke();
  }

  const lighter = active.length > 0;
  stroke(paradePath, "rgba(255,249,227,.94)", 8);
  stroke(paradePath, "#bd611c", 3.9, [6, 5]);
  for (const item of active) {
    if (item.path) stroke(item.path, "rgba(193,75,54,.65)", 2.4);
  }
  if (route) {
    stroke(route.path, "#fafdf9", 10);
    stroke(route.path, "#00674f", 5);
    for (const [index, pin] of [route.path[0], route.path.at(-1)].entries()) {
      if (!pin) continue;
      ctx.beginPath();
      ctx.arc(...px(pin), index === 0 ? 6 : 7, 0, Math.PI * 2);
      ctx.fillStyle = index === 0 ? "#fcfffa" : "#00674f";
      ctx.fill();
      ctx.strokeStyle = index === 0 ? "#00674f" : "#fcfffa";
      ctx.lineWidth = 2.6;
      ctx.stroke();
    }
  } else {
    for (const point of [paradePath[0], paradePath.at(-1)]) {
      if (!point) continue;
      ctx.beginPath();
      ctx.arc(...px(point), 4.7, 0, Math.PI * 2);
      ctx.fillStyle = "#b75b17";
      ctx.fill();
      ctx.strokeStyle = "#fff9e9";
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const { text, point, style } of mapLabels) {
    const [x, y] = px(point);
    if (x < 35 || x > width - 35 || y < 20 || y > height - 20) continue;
    ctx.font = style === "area" ? "700 " + (width < 500 ? 8 : 10) + "px system-ui" :
      style === "water" ? "italic 12px system-ui" : "600 10px system-ui";
    ctx.fillStyle = style === "water" ? "#567a80" : style === "place" ? "#4d5d5b" : "#597061";
    if (style === "place") {
      ctx.lineWidth = 2.6;
      ctx.strokeStyle = lighter ? "#eeeee4" : "#f0f0e7";
      ctx.strokeText(text, x, y);
    }
    ctx.fillText(text, x, y);
  }
}

export function TripMap({ mode, browserKey, route, closures, time }: MapProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const live = useRef<HTMLDivElement>(null);
  const drag = useRef<{ clientX: number; clientY: number; camera: Camera } | null>(null);
  const [camera, setCamera] = useState(initialCamera);
  const [authError, setAuthError] = useState("");
  const [native, setNative] = useState<{ maps: Maps; map: NativeMap } | null>(null);
  const active = useMemo(() => closures.filter((alert) => alert.windows.some((window) => overlaps(window, time, time))), [closures, time]);

  useEffect(() => {
    if (mode !== "replay" || !canvas.current) return;
    const node = canvas.current;
    const paint = () => drawReplay(node, camera, active, route);
    const observer = new ResizeObserver(paint);
    observer.observe(node);
    paint();
    return () => observer.disconnect();
  }, [mode, camera, active, route]);

  useEffect(() => {
    setNative(null);
    setAuthError("");
    setCamera(initialCamera);
    if (mode !== "live" || !live.current || !browserKey) return;
    const target = live.current;
    let disposed = false;
    const authFailed = () => { if (!disposed) setAuthError("Google Maps couldn’t authorize this map."); };
    authFailures.add(authFailed);
    void loadGoogle(browserKey).then((maps) => {
      if (disposed) return;
      const map = new maps.Map(target, {
        center: position(center), zoom: 13, disableDefaultUI: true, gestureHandling: "cooperative",
        styles: [
          { featureType: "poi.business", stylers: [{ visibility: "off" }] },
          { featureType: "water", stylers: [{ color: "#ccdee2" }] },
          { featureType: "poi.park", elementType: "geometry", stylers: [{ color: "#d2e3cc" }] },
        ],
      });
      setNative({ map, maps });
    }).catch((cause: Error) => { if (!disposed) setAuthError(cause.message); });
    return () => { disposed = true; authFailures.delete(authFailed); };
  }, [mode, browserKey]);

  useEffect(() => {
    if (mode !== "live" || !native) return;
    const { map, maps } = native;
    const line = (path: Point[], strokeColor: string, strokeOpacity: number, strokeWeight: number, zIndex = 1) =>
      new maps.Polyline({ map, path: path.map(position), strokeColor, strokeOpacity, strokeWeight, zIndex });
    const layers: NativeLine[] = [line(paradePath, "#bc6322", 0.88, 4)];
    for (const item of active) {
      if (item.path?.length) layers.push(line(item.path, "#c34b36", 0.76, 3, 2));
    }
    if (route?.path.length) {
      layers.push(line(route.path, "#ffffff", 1, 9, 3), line(route.path, "#00674f", 1, 5, 4));
      for (const endpoint of [route.path[0], route.path.at(-1)!]) {
        layers.push(new maps.Circle({ map, center: position(endpoint), radius: 29, fillColor: "#00674f",
          fillOpacity: 1, strokeColor: "#ffffff", strokeWeight: 2, zIndex: 5 }));
      }
    }
    return () => { for (const layer of layers) layer.setMap(null); };
  }, [mode, native, active, route]);

  useEffect(() => { if (native) fit(); }, [native, route]);

  function fit() {
    if (!native) {
      setCamera(initialCamera);
      return;
    }
    const bounds = new native.maps.LatLngBounds();
    for (const point of route?.path.length ? route.path : paradePath) bounds.extend(position(point));
    native.map.fitBounds(bounds, 55);
  }

  function zoom(amount: number) {
    if (native) {
      native.map.setZoom((native.map.getZoom() ?? 13) + amount);
      return;
    }
    setCamera((current) => ({ ...current, zoom: Math.max(0.7, Math.min(3, current.zoom * (amount > 0 ? 1.22 : 0.82))) }));
  }

  function startDrag(event: PointerEvent<HTMLCanvasElement>) {
    if (event.pointerType === "touch" || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { clientX: event.clientX, clientY: event.clientY, camera };
  }

  function moveDrag(event: PointerEvent<HTMLCanvasElement>) {
    const original = drag.current;
    if (original) setCamera({
      ...original.camera,
      x: original.camera.x + event.clientX - original.clientX,
      y: original.camera.y + event.clientY - original.clientY,
    });
  }

  return (
    <div className="map-viewport">
      {mode === "replay" ? <canvas ref={canvas} className="map-canvas" role="img"
        aria-label={route ? "Parade replay map with the selected route through Manhattan" : "Parade replay map with street closures and the parade route"}
        onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={() => { drag.current = null; }}
        onPointerCancel={() => { drag.current = null; }} /> :
        <div ref={live} className="google-map" aria-label="Google map of NYC with parade closures and your route" />}
      {mode === "live" && (authError || !browserKey) && <div className="map-message" role="status">
        <strong>{authError || "Google Maps setup needed"}</strong>
        <span>{authError ? "Route details are available in the trip panel." : "Configure a Maps key or open Parade Replay."}</span>
      </div>}
      <div className="map-tag"><span className="map-north">↑</span><span>{mode === "replay" ? "Manhattan · replay map" : "NYC · Google Maps"}</span></div>
      <div className="map-controls" aria-label="Map controls">
        <button type="button" onClick={() => zoom(1)} aria-label="Zoom map in"><Plus size={17} /></button>
        <button type="button" onClick={() => zoom(-1)} aria-label="Zoom map out"><Minus size={17} /></button>
        <button type="button" onClick={fit} aria-label="Reset map view"><LocateFixed size={16} /></button>
      </div>
      {mode === "replay" && <span className="map-credit">Street data © NYC DCP</span>}
    </div>
  );
}
