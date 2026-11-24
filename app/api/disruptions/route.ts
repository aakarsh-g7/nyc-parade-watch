import { getDisruptions } from "../../../lib/trip/mta";
import { noStore } from "../../../lib/trip/server-config";

export async function GET() {
  return Response.json(await getDisruptions(), { headers: noStore });
}
