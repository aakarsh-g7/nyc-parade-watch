import { findPlaces, MapsError } from "../../../lib/trip/google";
import { mapsConfig, noStore } from "../../../lib/trip/server-config";

export async function POST(request: Request) {
  const data = await request.json().catch(() => null) as { input?: unknown } | null;
  const text = typeof data?.input === "string" ? data.input.trim() : "";
  if (text.length < 3 || text.length > 180) return Response.json({ suggestions: [] }, { headers: noStore });
  try {
    const suggestions = await findPlaces(text, mapsConfig().serverKey);
    return Response.json({ suggestions }, { headers: noStore });
  } catch (error) {
    const message = error instanceof MapsError ? error.message : "Place search is temporarily unavailable.";
    return Response.json({ message }, { status: error instanceof MapsError ? error.httpStatus : 502, headers: noStore });
  }
}
