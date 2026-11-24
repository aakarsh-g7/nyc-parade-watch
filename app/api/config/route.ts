import { mapsConfig, noStore } from "../../../lib/trip/server-config";

export function GET() {
  const { browserKey, serverKey } = mapsConfig();
  return Response.json({ browserKey, liveReady: Boolean(serverKey) }, { headers: noStore });
}
