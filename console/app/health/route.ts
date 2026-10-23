import { env } from "cloudflare:workers";
import { handle } from "@/lib/fleet/handler.mjs";
export const dynamic = "force-dynamic";
export const GET = (request: Request) => handle(request, env);
