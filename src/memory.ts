/**
 * Fields with no reliable automatic source, remembered per city between generations: the contract
 * number, and what the analyst changed in the suggested integrations. The second report of the same
 * city then comes out with one click and nothing retyped.
 *
 * Only the DIFFERENCE from the suggestion is stored (added / dropped), never the whole list: storing
 * the list would make a one-click generation "confirm" everything that was auto-detected, and a
 * detection fixed later would never leave the report.
 *
 * A local JSON file, written atomically (temp file + rename).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface RememberedFields {
  contract?: string;
  /** Added by the analyst — typed, or generic findings ticked. Come back next time. */
  integrationsAdded?: string[];
  /** Vendor suggestions the analyst removed. Don't come back. */
  integrationsDropped?: string[];
  updatedAt?: string;
}

type Store = Record<string, RememberedFields>;

export class CityMemory {
  constructor(private readonly path: string) {}

  private read(): Store {
    try {
      const j = JSON.parse(readFileSync(this.path, "utf-8")) as unknown;
      return j && typeof j === "object" && !Array.isArray(j) ? (j as Store) : {};
    } catch {
      return {};
    }
  }

  recall(cityId: string): RememberedFields {
    return this.read()[cityId] ?? {};
  }

  save(cityId: string, fields: RememberedFields): void {
    const store = this.read();
    store[cityId] = { ...store[cityId], ...fields, updatedAt: new Date().toISOString() };
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(store, null, 2), "utf-8");
    renameSync(tmp, this.path);
  }

  /**
   * After a download: remember the contract number and how the integrations list differs from what
   * was suggested. A suggestion put back by the analyst stops being "dropped".
   */
  rememberDownload(cityId: string, contract: string, integrations: string[], suggested: string[]): void {
    const before = this.recall(cityId);
    const dropped = new Set([...(before.integrationsDropped ?? []), ...suggested.filter((s) => !integrations.includes(s))]);
    for (const i of integrations) dropped.delete(i);
    this.save(cityId, {
      ...(contract ? { contract } : {}),
      integrationsAdded: integrations.filter((i) => !suggested.includes(i)),
      integrationsDropped: [...dropped],
    });
  }
}

/** Integrations for a new report: vendor suggestions minus the dropped ones, plus the added ones. */
export function mergeIntegrations(explicit: string[], memory: RememberedFields): string[] {
  const dropped = new Set(memory.integrationsDropped ?? []);
  return [...new Set([...explicit.filter((i) => !dropped.has(i)), ...(memory.integrationsAdded ?? [])])];
}
