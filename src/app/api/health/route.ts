import { api, jsonResponse } from "../../../server/api.ts";

export const dynamic = "force-dynamic";

export function GET() {
  return jsonResponse(() => api().health());
}
