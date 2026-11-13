import { api, jsonResponse } from "../../../../../../server/api.ts";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string; checkpointId: string }> }) {
  const { id, checkpointId } = await context.params;
  return jsonResponse(() => api().checkpoint(id, checkpointId));
}
