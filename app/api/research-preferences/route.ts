import { assertPreferenceRevision, preferenceOverview, savePreferenceState, undoPreferenceState } from "@/lib/preference-store";
import { parsePreferenceProfile, PreferenceError } from "@/lib/research-preferences";
import { getDatabase } from "@/lib/server/database";
import { readSettings } from "@/lib/server/settings";
import { industryCacheScope } from "@/lib/collector-scopes";
import { comparePreferenceSelection } from "@/lib/server/preference-comparison";

export const runtime = "nodejs";
function failure(error: unknown) {
  if (error instanceof PreferenceError) return Response.json({ error: error.message }, { status: error.status });
  if (error instanceof SyntaxError) return Response.json({ error: "The preferences request could not be read." }, { status: 400 });
  return Response.json({ error: "Research preferences are unavailable. Reload and try again." }, { status: 500 });
}
export async function GET() {
  try {
    const settings = await readSettings();
    return Response.json(preferenceOverview(getDatabase(), settings.industry.keywords), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return failure(error); }
}
export async function PUT(request: Request) {
  try {
    const input = await request.json();
    const settings = await readSettings();
    savePreferenceState(getDatabase(), input?.profile, input?.expectedRevision, industryCacheScope(settings));
    return Response.json(preferenceOverview(getDatabase(), settings.industry.keywords));
  } catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  try {
    const input = await request.json();
    const settings = await readSettings();
    const database = getDatabase();
    if (input?.action === "compare") {
      assertPreferenceRevision(database, input.expectedRevision);
      return Response.json(comparePreferenceSelection(database, settings, parsePreferenceProfile(input.profile)));
    }
    if (input?.action === "reset") savePreferenceState(database, { enabled: false, rules: [] }, input.expectedRevision, industryCacheScope(settings));
    else if (input?.action === "undo") undoPreferenceState(database, input.expectedRevision);
    else throw new PreferenceError("Choose Compare, Reset or Undo.");
    return Response.json(preferenceOverview(database, settings.industry.keywords));
  } catch (error) { return failure(error); }
}
