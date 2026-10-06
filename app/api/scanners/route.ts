import { ScannerError, scannerProducers, type ScannerProducer } from "@/lib/scanner-contract";
import { importScannerRun, readScannerRun } from "@/lib/scanner-store";
import { getDatabase } from "@/lib/server/database";
import { readScannerExport, scannerOverview, saveScannerDirectory } from "@/lib/server/scanner-connectors";
export const runtime = "nodejs";
const MAX_BODY = 4_000_000;
function failure(error: unknown) {
  return Response.json({ error: error instanceof ScannerError ? error.message : error instanceof SyntaxError ? "The report is not valid JSON. No data was imported." : "Scanner reports are unavailable. Check the folder and completed run files." },
    { status: error instanceof ScannerError ? error.status : error instanceof SyntaxError ? 400 : 500 });
}
function producer(value: unknown): ScannerProducer {
  if (typeof value !== "string" || !Object.hasOwn(scannerProducers, value)) throw new ScannerError("Choose a supported scanner."); return value as ScannerProducer;
}
export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    if (params.has("producer")) {
      const source = producer(params.get("producer")), id = params.get("run") || undefined;
      const report = params.get("stored") === "1" && id ? readScannerRun(getDatabase(), source, id) : await readScannerExport(source, id);
      if (!report) throw new ScannerError("That imported run was not found.", 404);
      return Response.json(report, { headers: { "Cache-Control": "no-store" } });
    }
    return Response.json(await scannerOverview(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  try {
    if (Number(request.headers.get("content-length")) > MAX_BODY) throw new ScannerError("The import exceeds the 4 MB limit.", 413);
    const raw = await request.text();
    if (Buffer.byteLength(raw) > MAX_BODY) throw new ScannerError("The import exceeds the 4 MB limit.", 413);
    const input = JSON.parse(raw);
    const report = input?.action === "import-latest" ? await readScannerExport(producer(input.producer), input.runId) : input?.report;
    if (!report) throw new ScannerError("Choose a saved report or upload a version-1 scanner export.");
    return Response.json(importScannerRun(getDatabase(), report));
  } catch (error) { return failure(error); }
}
export async function PUT(request: Request) {
  try { const input = await request.json(); saveScannerDirectory(producer(input?.producer), input?.directory); return Response.json(await scannerOverview()); }
  catch (error) { return failure(error); }
}
