import { api, jsonResponse } from "../../../../../server/api.ts";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const checkpointId = new URL(request.url).searchParams.get("checkpointId");
  return jsonResponse(() => api().debrief(id, checkpointId));
}
