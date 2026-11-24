import { env } from "cloudflare:workers";

type RuntimeEnv = {
  GOOGLE_MAPS_DEMO_KEY?: string;
  GOOGLE_MAPS_SERVER_KEY?: string;
  GOOGLE_MAPS_BROWSER_KEY?: string;
};

export function mapsConfig() {
  const bindings = env as RuntimeEnv;
  const demo = bindings.GOOGLE_MAPS_DEMO_KEY ?? process.env.GOOGLE_MAPS_DEMO_KEY ?? "";
  return {
    serverKey: bindings.GOOGLE_MAPS_SERVER_KEY ?? process.env.GOOGLE_MAPS_SERVER_KEY ?? demo,
    browserKey: bindings.GOOGLE_MAPS_BROWSER_KEY ?? process.env.GOOGLE_MAPS_BROWSER_KEY ?? demo,
  };
}

export const noStore = { "Cache-Control": "no-store" };
