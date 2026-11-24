import { z } from "zod";
import { findRoutes, inNyc, MapsError } from "../../../lib/trip/google";
import { mapsConfig, noStore } from "../../../lib/trip/server-config";

const place = z.object({
  label: z.string().trim().min(1).max(180),
  placeId: z.string().regex(/^[A-Za-z0-9_-]+$/).max(250).optional(),
  point: z.tuple([z.number(), z.number()]).optional().refine((value) => !value || inNyc(value), "Choose a location in NYC"),
});
const intent = z.object({
  origin: place,
  destination: place,
  limits: z.object({
    mode: z.enum(["all", "transit", "walk"]),
    priority: z.enum(["fastest", "less-walking", "fewer-transfers"]),
    maxWalkMinutes: z.number().int().min(1).max(240).nullable(),
    arriveBy: z.number().int().nullable(),
  }),
});

export async function POST(request: Request) {
  const parsed = intent.safeParse(await request.json().catch(() => null));
  const now = Date.now();
  if (!parsed.success) {
    return Response.json({ message: "Check the NYC origin, destination, and trip preferences." }, { status: 400, headers: noStore });
  }
  const { arriveBy } = parsed.data.limits;
  if (arriveBy !== null && (arriveBy <= now || arriveBy > now + 100 * 86_400_000)) {
    return Response.json({ message: "Choose an arrival time within the next 100 days." }, { status: 400, headers: noStore });
  }
  try {
    return Response.json(await findRoutes(parsed.data, mapsConfig().serverKey), { headers: noStore });
  } catch (error) {
    const message = error instanceof MapsError ? error.message : "Routing is temporarily unavailable.";
    return Response.json({ message }, { status: error instanceof MapsError ? error.httpStatus : 502, headers: noStore });
  }
}
