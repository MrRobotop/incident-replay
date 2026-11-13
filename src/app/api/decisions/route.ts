import { api, jsonResponse } from "../../../server/api.ts";

export const dynamic = "force-dynamic";

export function POST(request: Request) {
  return jsonResponse(() => api().decide(request));
}
