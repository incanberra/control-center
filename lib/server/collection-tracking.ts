import "server-only";
import { randomUUID } from "node:crypto";
import { summarizeCollection, type CollectionModule } from "@/lib/collection-status";
import { beginCollection, finishCollection } from "@/lib/collection-status-store";
import { getDatabase } from "./database";
declare global { var controlCenterCollectionSession: string | undefined; var controlCenterTrackedCollections: Map<CollectionModule, Promise<Response>> | undefined; }
export function collectionSession() { return globalThis.controlCenterCollectionSession ||= randomUUID(); }
export async function trackCollection(module: CollectionModule, work: () => Promise<Response>) {
  const active = globalThis.controlCenterTrackedCollections ||= new Map();
  if (active.has(module)) return (await active.get(module)!).clone();
  const run = (async () => {
    const db = getDatabase(), id = beginCollection(db, module, collectionSession());
    try {
      const response = await work();
      finishCollection(db, id, summarizeCollection(await response.clone().json(), response.ok)); return response;
    } catch (error) {
      finishCollection(db, id, { outcome: "failed", issues: ["Collection failed. Open this module for details; the previous saved results remain available."], pending: null, itemCount: 0 });
      throw error;
    }
  })();
  active.set(module, run);
  try { return (await run).clone(); } finally { if (active.get(module) === run) active.delete(module); }
}
