import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import {
  type CardCatalogItem,
  type CardCondition,
  type CardFinish,
  cardCatalog,
  fromCatalogFinish,
  type SkuPriceCacheItem,
  skuPriceCache,
  toCatalogFinish,
} from "@/db/schema";
import type { RoutingCardInput } from "@/lib/routing/types";
import type { ParsedCsvRow, ScannerFormat } from "./parser";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyPgDatabase = PgDatabase<any, any, any>;

export type CatalogMatchStrategy =
  | "scryfall_id"
  | "tcgplayer_etched_id"
  | "tcgplayer_id"
  | "set_collector"
  | "set_collector_normalized";

export interface SetCollectorCandidate {
  readonly setCode: string;
  readonly collectorNumber: string;
  readonly isNormalizedFallback: boolean;
}

export interface ResolvedCsvRow {
  readonly parsedRow: ParsedCsvRow;
  readonly card: CardCatalogItem;
  readonly effectiveFinish: CardFinish;
  readonly matchedBy: CatalogMatchStrategy;
  readonly finishListedInCatalog: boolean;
}

export type UnresolvedRowReason = "missing_identifiers" | "catalog_not_found";

export interface UnresolvedCsvRowDiagnostic {
  readonly rowNumber: number;
  readonly reason: UnresolvedRowReason;
  readonly attemptedStrategies: string[];
  readonly parsedRow: ParsedCsvRow;
}

export interface CatalogResolutionResult {
  readonly resolved: ResolvedCsvRow[];
  readonly unresolved: UnresolvedCsvRowDiagnostic[];
  readonly stats: {
    readonly totalInputRows: number;
    readonly resolvedRows: number;
    readonly unresolvedRows: number;
    readonly totalResolvedCards: number;
  };
}

export interface CatalogLookupProvider {
  findByScryfallIds(ids: readonly string[]): Promise<CardCatalogItem[]>;
  findByTcgplayerIds(ids: readonly number[]): Promise<CardCatalogItem[]>;
  findBySetAndCollectorPairs(
    pairs: ReadonlyArray<{ setCode: string; collectorNumber: string }>,
  ): Promise<CardCatalogItem[]>;
}

const ID_BATCH_SIZE = 500;
const PAIR_BATCH_SIZE = 200;

function chunkArray<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function makeSetCollectorKey(setCode: string, collectorNumber: string): string {
  return `${setCode.toLowerCase()}\u0000${collectorNumber}`;
}

/**
 * Generates ordered `(LOWER(set_code), collector_number)` lookup candidates,
 * handling Dragon Shield / scanner quirks (`"117/280" -> "117"`, leading zero
 * `"045" -> "45"`, and promo `'p'` prefix `"pmh2" -> "mh2"` when direct lookup
 * misses).
 */
export function buildSetCollectorCandidates(
  rawSetCode: string | null,
  rawCollectorNumber: string | null,
  _format?: ScannerFormat,
): SetCollectorCandidate[] {
  if (!rawSetCode || !rawCollectorNumber) {
    return [];
  }

  const baseSet = rawSetCode.trim().toLowerCase();
  const baseCn = rawCollectorNumber.trim();
  if (!baseSet || !baseCn) {
    return [];
  }

  const collectorVariants: Array<{ value: string; normalized: boolean }> = [
    { value: baseCn, normalized: false },
  ];

  // Strip "/total" suffix (e.g. "117/302" -> "117")
  const slashIdx = baseCn.indexOf("/");
  const slashStripped =
    slashIdx > 0 ? baseCn.slice(0, slashIdx).trim() : baseCn;
  if (slashStripped && slashStripped !== baseCn) {
    collectorVariants.push({ value: slashStripped, normalized: true });
  }

  // Strip leading zeros on numeric collector numbers (e.g. "045" -> "45", "007a" -> "7a")
  for (const variant of [...collectorVariants]) {
    const zeroStripped = variant.value.replace(/^0+(?=\d)/, "");
    if (
      zeroStripped &&
      zeroStripped !== variant.value &&
      !collectorVariants.some((v) => v.value === zeroStripped)
    ) {
      collectorVariants.push({ value: zeroStripped, normalized: true });
    }
  }

  // Lowercase collector-number suffixes (e.g. "117A" -> "117a", "7A" -> "7a") while preserving exact B-tree index lookup
  for (const variant of [...collectorVariants]) {
    const lowered = variant.value.toLowerCase();
    if (
      lowered !== variant.value &&
      !collectorVariants.some((v) => v.value === lowered)
    ) {
      collectorVariants.push({ value: lowered, normalized: true });
    }
  }

  const setVariants: Array<{ value: string; normalized: boolean }> = [
    { value: baseSet, normalized: false },
  ];

  // Dragon Shield promo prefix fallback: 'pXXX' / 'pXXXX' -> 'XXX' / 'XXXX' (e.g. 'pmh2' -> 'mh2')
  if ((baseSet.length === 4 || baseSet.length === 5) && baseSet.startsWith("p")) {
    setVariants.push({ value: baseSet.slice(1), normalized: true });
  }

  const seen = new Set<string>();
  const candidates: SetCollectorCandidate[] = [];

  for (const setVar of setVariants) {
    for (const cnVar of collectorVariants) {
      const key = makeSetCollectorKey(setVar.value, cnVar.value);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      candidates.push({
        setCode: setVar.value,
        collectorNumber: cnVar.value,
        isNormalizedFallback: setVar.normalized || cnVar.normalized,
      });
    }
  }

  return candidates;
}

export function createDrizzleCatalogLookup(
  db: AnyPgDatabase,
): CatalogLookupProvider {
  return {
    async findByScryfallIds(ids) {
      if (ids.length === 0) {
        return [];
      }
      // Normalize to lowercase UUID text — Postgres/PGlite uuid compares
      // case-insensitively, but callers/CSV paths may pass mixed case.
      const normalized = [
        ...new Set(
          ids
            .map((id) => id.trim().toLowerCase())
            .filter((id) => id.length > 0),
        ),
      ];
      if (normalized.length === 0) {
        return [];
      }
      const results: CardCatalogItem[] = [];
      for (const batch of chunkArray(normalized, ID_BATCH_SIZE)) {
        const found = (await db
          .select()
          .from(cardCatalog)
          .where(inArray(cardCatalog.scryfallId, batch))) as CardCatalogItem[];
        results.push(...found);
      }
      return results;
    },

    async findByTcgplayerIds(ids) {
      if (ids.length === 0) {
        return [];
      }
      const byScryfall = new Map<string, CardCatalogItem>();
      for (const batch of chunkArray(ids, ID_BATCH_SIZE)) {
        const found = (await db
          .select()
          .from(cardCatalog)
          .where(
            or(
              inArray(cardCatalog.tcgplayerId, batch),
              inArray(cardCatalog.tcgplayerEtchedId, batch),
            ),
          )) as CardCatalogItem[];
        for (const row of found) {
          byScryfall.set(row.scryfallId.toLowerCase(), row);
        }
      }
      return [...byScryfall.values()];
    },

    async findBySetAndCollectorPairs(pairs) {
      if (pairs.length === 0) {
        return [];
      }
      const byScryfall = new Map<string, CardCatalogItem>();
      for (const batch of chunkArray(pairs, PAIR_BATCH_SIZE)) {
        const predicates = batch.map((pair) =>
          and(
            sql`LOWER(${cardCatalog.setCode}) = ${pair.setCode.toLowerCase()}`,
            eq(cardCatalog.collectorNumber, pair.collectorNumber),
          ),
        );
        const whereClause =
          predicates.length === 1 ? predicates[0]! : or(...predicates);
        const found = (await db
          .select()
          .from(cardCatalog)
          .where(whereClause)) as CardCatalogItem[];
        for (const row of found) {
          byScryfall.set(row.scryfallId.toLowerCase(), row);
        }
      }
      return [...byScryfall.values()];
    },
  };
}

export function createInMemoryCatalogLookup(
  catalogRows: readonly CardCatalogItem[],
): CatalogLookupProvider {
  const byScryfall = new Map<string, CardCatalogItem>();
  const byTcgId = new Map<number, CardCatalogItem[]>();
  const bySetCollector = new Map<string, CardCatalogItem>();

  for (const row of catalogRows) {
    byScryfall.set(row.scryfallId.toLowerCase(), row);
    if (row.tcgplayerId !== null) {
      const list = byTcgId.get(row.tcgplayerId) ?? [];
      list.push(row);
      byTcgId.set(row.tcgplayerId, list);
    }
    if (
      row.tcgplayerEtchedId !== null &&
      row.tcgplayerEtchedId !== row.tcgplayerId
    ) {
      const list = byTcgId.get(row.tcgplayerEtchedId) ?? [];
      list.push(row);
      byTcgId.set(row.tcgplayerEtchedId, list);
    }
    const key = makeSetCollectorKey(row.setCode, row.collectorNumber);
    if (!bySetCollector.has(key)) {
      bySetCollector.set(key, row);
    }
  }

  return {
    async findByScryfallIds(ids) {
      const out: CardCatalogItem[] = [];
      for (const id of ids) {
        const hit = byScryfall.get(id.toLowerCase());
        if (hit) out.push(hit);
      }
      return out;
    },
    async findByTcgplayerIds(ids) {
      const seen = new Map<string, CardCatalogItem>();
      for (const id of ids) {
        for (const hit of byTcgId.get(id) ?? []) {
          seen.set(hit.scryfallId.toLowerCase(), hit);
        }
      }
      return [...seen.values()];
    },
    async findBySetAndCollectorPairs(pairs) {
      const seen = new Map<string, CardCatalogItem>();
      for (const pair of pairs) {
        const hit = bySetCollector.get(
          makeSetCollectorKey(pair.setCode, pair.collectorNumber),
        );
        if (hit) {
          seen.set(hit.scryfallId.toLowerCase(), hit);
        }
      }
      return [...seen.values()];
    },
  };
}

function resolveEffectiveCatalogFinish(
  requestedFinish: CardFinish,
  catalogFinishes: readonly string[],
): CardFinish {
  if (
    catalogFinishes.length === 0 ||
    catalogFinishes.includes(toCatalogFinish(requestedFinish))
  ) {
    return requestedFinish;
  }
  if (requestedFinish === "foil" && catalogFinishes.includes("etched")) {
    return "etched";
  }
  if (catalogFinishes.length === 1) {
    return fromCatalogFinish(catalogFinishes[0]!);
  }
  return requestedFinish;
}
/**
 * Resolves parsed scanner CSV rows against `card_catalog` in batched stages:
 *   1. `scryfall_id`
 *   2. `tcgplayer_etched_id` / `tcgplayer_id`
 *   3. `(LOWER(set_code), collector_number)` (+ normalized Dragon Shield fallbacks)
 */
export async function resolveParsedCsvRows(
  rows: readonly ParsedCsvRow[],
  dbOrProvider: AnyPgDatabase | CatalogLookupProvider,
): Promise<CatalogResolutionResult> {
  const provider: CatalogLookupProvider =
    "findByScryfallIds" in dbOrProvider
      ? dbOrProvider
      : createDrizzleCatalogLookup(dbOrProvider);

  const matched = new Map<
    number,
    {
      card: CardCatalogItem;
      strategy: CatalogMatchStrategy;
      effectiveFinish: CardFinish;
    }
  >();

  // Stage 1: Batch Scryfall UUID lookup
  const uniqueScryfallIds = [
    ...new Set(
      rows
        .map((r) => r.scryfallId)
        .filter((id): id is string => id !== null),
    ),
  ];

  if (uniqueScryfallIds.length > 0) {
    const scryfallCards = await provider.findByScryfallIds(uniqueScryfallIds);
    const byScryfall = new Map(
      scryfallCards.map((c) => [c.scryfallId.toLowerCase(), c]),
    );

    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i]!;
      if (!row.scryfallId) continue;
      const hit = byScryfall.get(row.scryfallId.toLowerCase());
      if (hit) {
        matched.set(i, {
          card: hit,
          strategy: "scryfall_id",
          effectiveFinish: row.finish,
        });
      }
    }
  }

  // Stage 2: Batch TCGplayer Product ID (`tcgplayer_id` / `tcgplayer_etched_id`) lookup
  const pendingTcgIds = [
    ...new Set(
      rows
        .filter((_, idx) => !matched.has(idx))
        .map((r) => r.tcgplayerProductId)
        .filter((id): id is number => id !== null),
    ),
  ];

  if (pendingTcgIds.length > 0) {
    const tcgCards = await provider.findByTcgplayerIds(pendingTcgIds);
    const byStandardTcg = new Map<number, CardCatalogItem>();
    const byEtchedTcg = new Map<number, CardCatalogItem>();

    for (const card of tcgCards) {
      if (card.tcgplayerId !== null && !byStandardTcg.has(card.tcgplayerId)) {
        byStandardTcg.set(card.tcgplayerId, card);
      }
      if (
        card.tcgplayerEtchedId !== null &&
        !byEtchedTcg.has(card.tcgplayerEtchedId)
      ) {
        byEtchedTcg.set(card.tcgplayerEtchedId, card);
      }
    }

    for (let i = 0; i < rows.length; i += 1) {
      if (matched.has(i)) continue;
      const row = rows[i]!;
      if (row.tcgplayerProductId === null) continue;

      if (row.finish === "etched") {
        const etchedHit = byEtchedTcg.get(row.tcgplayerProductId);
        if (etchedHit) {
          matched.set(i, {
            card: etchedHit,
            strategy: "tcgplayer_etched_id",
            effectiveFinish: "etched",
          });
          continue;
        }
        const fallbackHit = byStandardTcg.get(row.tcgplayerProductId);
        if (fallbackHit) {
          matched.set(i, {
            card: fallbackHit,
            strategy: "tcgplayer_id",
            effectiveFinish: "etched",
          });
          continue;
        }
      } else {
        const standardHit = byStandardTcg.get(row.tcgplayerProductId);
        if (standardHit) {
          matched.set(i, {
            card: standardHit,
            strategy: "tcgplayer_id",
            effectiveFinish: row.finish,
          });
          continue;
        }
        const etchedOnlyHit = byEtchedTcg.get(row.tcgplayerProductId);
        if (etchedOnlyHit) {
          matched.set(i, {
            card: etchedOnlyHit,
            strategy: "tcgplayer_etched_id",
            effectiveFinish: "etched",
          });
          continue;
        }
      }
    }
  }

  // Stage 3: Batch `(LOWER(set_code), collector_number)` lookup (+ normalized fallbacks)
  const rowCandidates = new Map<number, SetCollectorCandidate[]>();
  const uniquePairsMap = new Map<
    string,
    { setCode: string; collectorNumber: string }
  >();

  for (let i = 0; i < rows.length; i += 1) {
    if (matched.has(i)) continue;
    const row = rows[i]!;
    const candidates = buildSetCollectorCandidates(
      row.setCode,
      row.collectorNumber,
      row.format,
    );
    if (candidates.length === 0) continue;
    rowCandidates.set(i, candidates);
    for (const cand of candidates) {
      const key = makeSetCollectorKey(cand.setCode, cand.collectorNumber);
      if (!uniquePairsMap.has(key)) {
        uniquePairsMap.set(key, {
          setCode: cand.setCode,
          collectorNumber: cand.collectorNumber,
        });
      }
    }
  }

  if (uniquePairsMap.size > 0) {
    const pairCards = await provider.findBySetAndCollectorPairs([
      ...uniquePairsMap.values(),
    ]);
    const bySetCollector = new Map<string, CardCatalogItem>();
    for (const card of pairCards) {
      const key = makeSetCollectorKey(card.setCode, card.collectorNumber);
      if (!bySetCollector.has(key)) {
        bySetCollector.set(key, card);
      }
    }

    for (const [rowIdx, candidates] of rowCandidates.entries()) {
      const row = rows[rowIdx]!;
      for (const cand of candidates) {
        const hit = bySetCollector.get(
          makeSetCollectorKey(cand.setCode, cand.collectorNumber),
        );
        if (hit) {
          matched.set(rowIdx, {
            card: hit,
            strategy: cand.isNormalizedFallback
              ? "set_collector_normalized"
              : "set_collector",
            effectiveFinish: row.finish,
          });
          break;
        }
      }
    }
  }

  const resolved: ResolvedCsvRow[] = [];
  const unresolved: UnresolvedCsvRowDiagnostic[] = [];
  let totalResolvedCards = 0;

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]!;
    const matchInfo = matched.get(i);
    if (matchInfo) {
      const coercedFinish = resolveEffectiveCatalogFinish(
        matchInfo.effectiveFinish,
        matchInfo.card.finishes,
      );
      const catalogFinish = toCatalogFinish(coercedFinish);
      resolved.push({
        parsedRow: row,
        card: matchInfo.card,
        effectiveFinish: coercedFinish,
        matchedBy: matchInfo.strategy,
        finishListedInCatalog: matchInfo.card.finishes.includes(catalogFinish),
      });
      totalResolvedCards += row.quantity;
      continue;
    }

    const attemptedStrategies: string[] = [];
    if (row.scryfallId) {
      attemptedStrategies.push(`scryfall_id:${row.scryfallId}`);
    }
    if (row.tcgplayerProductId !== null) {
      attemptedStrategies.push(`tcgplayer_id:${row.tcgplayerProductId}`);
    }
    for (const cand of rowCandidates.get(i) ?? []) {
      attemptedStrategies.push(
        `set_collector:${cand.setCode}#${cand.collectorNumber}`,
      );
    }

    unresolved.push({
      rowNumber: row.rowNumber,
      reason:
        attemptedStrategies.length === 0
          ? "missing_identifiers"
          : "catalog_not_found",
      attemptedStrategies,
      parsedRow: row,
    });
  }

  return {
    resolved,
    unresolved,
    stats: {
      totalInputRows: rows.length,
      resolvedRows: resolved.length,
      unresolvedRows: unresolved.length,
      totalResolvedCards,
    },
  };
}

export function makeSkuPriceCacheKey(
  scryfallId: string,
  finish: CardFinish,
  condition: CardCondition,
): string {
  return `${scryfallId.toLowerCase()}|${finish}|${condition}`;
}

/**
 * Batch-fetches fresh (`expires_at > now`) `sku_price_cache` entries for a list
 * of resolved CSV items from PostgreSQL / PGlite.
 */
export async function fetchFreshSkuPriceCacheMap(
  db: AnyPgDatabase,
  resolvedRows: readonly ResolvedCsvRow[],
  now: Date = new Date(),
): Promise<Map<string, SkuPriceCacheItem>> {
  const map = new Map<string, SkuPriceCacheItem>();
  if (resolvedRows.length === 0) {
    return map;
  }

  const uniqueScryfallIds = [
    ...new Set(resolvedRows.map((r) => r.card.scryfallId)),
  ];

  for (const batch of chunkArray(uniqueScryfallIds, ID_BATCH_SIZE)) {
    const cachedRows = (await db
      .select()
      .from(skuPriceCache)
      .where(
        and(
          inArray(skuPriceCache.scryfallId, batch),
          sql`${skuPriceCache.expiresAt} > ${now.toISOString()}::timestamptz`,
        ),
      )) as SkuPriceCacheItem[];

    for (const entry of cachedRows) {
      map.set(
        makeSkuPriceCacheKey(entry.scryfallId, entry.finish, entry.condition),
        entry,
      );
    }
  }

  return map;
}

export function resolvedRowsToRoutingInputs(
  resolvedRows: readonly ResolvedCsvRow[],
  skuCacheByKey?: ReadonlyMap<string, SkuPriceCacheItem>,
): RoutingCardInput[] {
  return resolvedRows.map((resolved) => {
    const key = makeSkuPriceCacheKey(
      resolved.card.scryfallId,
      resolved.effectiveFinish,
      resolved.parsedRow.condition,
    );
    return {
      card: resolved.card,
      finish: resolved.effectiveFinish,
      condition: resolved.parsedRow.condition,
      quantity: resolved.parsedRow.quantity,
      language: resolved.parsedRow.language,
      isAltered: resolved.parsedRow.isAltered,
      isMisprint: resolved.parsedRow.isMisprint,
      skuPriceCache: skuCacheByKey?.get(key) ?? null,
    };
  });
}
