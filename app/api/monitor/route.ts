import { getDatabase } from "@/lib/server/database";
import { parseReviewUpdate, updateStoryReviews } from "@/lib/monitor-store";

export const runtime = "nodejs";

export async function PATCH(request: Request) {
  try {
    const update = parseReviewUpdate(await request.json());
    updateStoryReviews(getDatabase(), update);
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not save your review choices." }, { status: 400 });
  }
}
