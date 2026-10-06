import { FeedbackError, listFeedbackHistory, parseFeedbackUpdate, saveFeedback, undoFeedback } from "@/lib/feedback-store";
import { getDatabase } from "@/lib/server/database";
import { readSettings } from "@/lib/server/settings";

export const runtime = "nodejs";

function failure(error: unknown) {
  if (error instanceof FeedbackError) return Response.json({ error: error.message }, { status: error.status });
  if (error instanceof SyntaxError) return Response.json({ error: "The feedback request could not be read." }, { status: 400 });
  return Response.json({ error: "Feedback is unavailable. Reload Monitor and try again." }, { status: 500 });
}

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    return Response.json(listFeedbackHistory(getDatabase(), {
      ...(params.has("limit") ? { limit: Number(params.get("limit")) } : {}),
      ...(params.has("before") ? { before: Number(params.get("before")) } : {}),
    }), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return failure(error); }
}

export async function POST(request: Request) {
  try {
    const input = parseFeedbackUpdate(await request.json());
    const settings = await readSettings();
    return Response.json({ storyId: input.storyId, feedback: saveFeedback(getDatabase(), input, settings.industry.keywords) });
  } catch (error) { return failure(error); }
}

export async function PATCH(request: Request) {
  try {
    const input = await request.json();
    return Response.json(undoFeedback(getDatabase(), input?.eventId));
  } catch (error) { return failure(error); }
}
