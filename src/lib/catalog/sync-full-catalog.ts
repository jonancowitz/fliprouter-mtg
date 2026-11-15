import fs from "node:fs";
import { PassThrough, Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import zlib from "node:zlib";
import { sql } from "drizzle-orm";
import ignore from "stream-json/filters/ignore.js";
import pick from "stream-json/filters/pick.js";
import jsonlParser from "stream-json/jsonl/parser.js";
import streamArray from "stream-json/streamers/stream-array.js";
import streamObject from "stream-json/streamers/stream-object.js";
import unbzip2Stream from "unbzip2-stream";
import { buildDemoSkuPriceCacheSeeds } from "@/db/demo-cards";
import type { Database } from "@/db/index";
import { cardCatalog, skuPriceCache } from "@/db/schema";
import {
  divRoundHalfUp,
  formatCentsToUsd,
  mulCentsByRatioHalfUp,
} from "@/lib/routing/money";

export const DEFAULT_SYNC_BATCH_SIZE = 500;
export const SCRYFALL_BULK_METADATA_URL =
  "https://api.scryfall.com/bulk-data/default-cards";
export const MTGJSON_IDENTIFIERS_URL =
  "https://mtgjson.com/api/v5/AllIdentifiers.json.bz2";
export const MTGJSON_PRICES_TODAY_URL =
  "https://mtgjson.com/api/v5/AllPricesToday.json.bz2";
export const MANAPOOL_SINGLES_URL =
  "https://manapool.com/api/v1/prices/singles";
export const DEFAULT_SYNC_USER_AGENT =
  "FlipRouterMTG/0.1 (+https://github.com/jonancowitz/fliprouter-mtg)";

const MAX_NUMERIC_10_2_CENTS = 9_999_999_999n;
const UUID_CANONICAL_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const IDENTIFIERS_HEAVY_FIELD_FILTER =
  /^[^.]+\.(?:foreignData|rulings|legalities|purchaseUrls|leadershipSkills|relatedCards|sourceProducts)(?:\.|$)/;

export type SyncStageKey =
  | "scryfall"
  | "identifiers"
  | "prices"
  | "manapool"
  | "finalize";

export interface ScryfallCatalogRecord {
  scryfallId: string;
  oracleId: string;
  tcgplayerId: number | null;
  tcgplayerEtchedId: number | null;
  cardkingdomId: number | null;
  cardkingdomFoilId: number | null;
  name: string;
  setCode: string;
  setName: string;
  collectorNumber: string;
  rarity: string;
  finishes: string[];
  imageUri: string | null;
  tcgMarketNm: string | null;
  tcgMarketFoil: string | null;
  tcgMarketEtched: string | null;
}

export interface IdentifierMappingRecord {
  scryfallId: string;
  mtgjsonUuid: string;
  tcgplayerId: number | null;
  tcgplayerEtchedId: number | null;
  cardkingdomId: number | null;
  cardkingdomFoilId: number | null;
}

export interface PriceUpdateRecord {
  mtgjsonUuid: string;
  tcgMarketNm: string | null;
  tcgLowNm: string | null;
  tcgMarketFoil: string | null;
  tcgLowFoil: string | null;
  tcgMarketEtched: string | null;
  tcgLowEtched: string | null;
  manapoolLowNm: string | null;
  manapoolLowFoil: string | null;
  manapoolLowEtched: string | null;
  ckBuylistCashNm: string | null;
  ckBuylistCreditNm: string | null;
  ckBuylistCashFoil: string | null;
  ckBuylistCreditFoil: string | null;
  ckBuylistCashEtched: string | null;
  ckBuylistCreditEtched: string | null;
}

export interface ManaPoolSingleRecord {
  scryfallId: string;
  tcgplayerId: number | null;
  manapoolLowNm: string | null;
  manapoolLowFoil: string | null;
  manapoolLowEtched: string | null;
}

export interface CatalogSyncStats {
  scryfallSeen: number;
  scryfallUpserted: number;
  scryfallBatches: number;
  identifiersSeen: number;
  identifiersMapped: number;
  identifiersBatches: number;
  dailyPricesReset: number;
  pricesSeen: number;
  pricesUpdated: number;
  pricesBatches: number;
  manapoolSeen: number;
  manapoolSupplemented: number;
  manapoolBatches: number;
  manapoolFallbackFailed: boolean;
  manapoolWarning: string | null;
  skuCachePruned: number;
  finalCatalogCount: number;
  durationMs: number;
}

export interface CatalogSyncProgressEvent {
  stageNumber: 1 | 2 | 3 | 4;
  stageKey: SyncStageKey;
  stageLabel: string;
  rowsSeen: number;
  rowsWritten: number;
  batchesCompleted: number;
  stats: Readonly<CatalogSyncStats>;
}

export interface SyncFullCatalogOptions {
  scryfallSource?: string;
  scryfallMetadataUrl?: string;
  identifiersSource?: string | null;
  pricesSource?: string | null;
  manapoolSource?: string | null;
  skipScryfall?: boolean;
  skipIdentifiers?: boolean;
  skipPrices?: boolean;
  skipManapool?: boolean;
  strictManapool?: boolean;
  skipPruneSkuCache?: boolean;
  ensureDemoSkuCache?: boolean;
  batchSize?: number;
  limit?: number;
  userAgent?: string;
  fetchImpl?: typeof fetch;
  onProgress?: (event: CatalogSyncProgressEvent) => void;
}

export function normalizeSyncUuid(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase();
  if (!UUID_CANONICAL_REGEX.test(trimmed)) return null;
  return trimmed;
}

export function parseSyncOptionalInt(raw: unknown): number | null {
  if (raw === null || raw === undefined || typeof raw === "boolean") {
    return null;
  }
  if (typeof raw === "number") {
    return Number.isSafeInteger(raw) && raw >= 0 ? raw : null;
  }
  if (typeof raw === "string") {
    const stripped = raw.trim();
    if (/^\d+$/.test(stripped)) {
      const parsed = Number.parseInt(stripped, 10);
      return Number.isSafeInteger(parsed) ? parsed : null;
    }
  }
  return null;
}

function expandScientificDecimal(rawStr: string): string | null {
  const match = /^([+-]?)(\d+)(?:\.(\d*))?[eE]([+-]?\d+)$/.exec(rawStr);
  if (!match) return rawStr;
  const sign = match[1] ?? "";
  const intPart = match[2] ?? "0";
  const fracPart = match[3] ?? "";
  const exp = Number.parseInt(match[4] ?? "0", 10);
  if (!Number.isFinite(exp) || Math.abs(exp) > 30) {
    return null;
  }
  const digits = `${intPart}${fracPart}`;
  const decimalPos = intPart.length + exp;
  if (decimalPos <= 0) {
    return `${sign}0.${"0".repeat(-decimalPos)}${digits}`;
  }
  if (decimalPos >= digits.length) {
    return `${sign}${digits}${"0".repeat(decimalPos - digits.length)}`;
  }
  return `${sign}${digits.slice(0, decimalPos)}.${digits.slice(decimalPos)}`;
}

/**
 * Converts a raw JSON USD value (string or number) into an exact 2-decimal USD
 * string using half-up integer-cent quantization without float rounding drift,
 * rejecting negatives and values exceeding `NUMERIC(10, 2)` (`99999999.99`).
 */
export function parseJsonUsdToCents(raw: unknown): bigint | null {
  if (raw === null || raw === undefined || typeof raw === "boolean") {
    return null;
  }
  let text: string;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw < 0) return null;
    text = String(raw);
  } else if (typeof raw === "string") {
    text = raw.trim();
    if (text === "") return null;
  } else {
    return null;
  }

  const expanded = expandScientificDecimal(text);
  if (expanded === null) return null;
  if (expanded.startsWith("-")) return null;
  const unsigned = expanded.startsWith("+") ? expanded.slice(1) : expanded;

  if (!/^(?:\d+\.?\d*|\.\d+)$/.test(unsigned)) {
    return null;
  }

  const [wholeRaw = "0", fracRaw = ""] = unsigned.split(".");
  const wholeDigits = wholeRaw === "" ? "0" : wholeRaw;
  if (wholeDigits.replace(/^0+/, "").length > 10) {
    return null;
  }

  const paddedFrac = `${fracRaw}000`;
  const thousandths =
    BigInt(wholeDigits) * 1000n + BigInt(paddedFrac.slice(0, 3));
  const cents = divRoundHalfUp(thousandths, 10n);

  if (cents < 0n || cents > MAX_NUMERIC_10_2_CENTS) {
    return null;
  }
  return cents;
}

export function parseJsonUsdToString(raw: unknown): string | null {
  const cents = parseJsonUsdToCents(raw);
  return cents !== null ? formatCentsToUsd(cents) : null;
}

/**
 * Converts integer cents (e.g. Mana Pool `price_cents_nm`) into exact 2-decimal USD.
 */
export function parseCentsToUsdString(raw: unknown): string | null {
  if (raw === null || raw === undefined || typeof raw === "boolean") {
    return null;
  }
  let cents: bigint;
  if (typeof raw === "number") {
    if (!Number.isSafeInteger(raw) || raw < 0) return null;
    cents = BigInt(raw);
  } else if (typeof raw === "string" && /^\d+$/.test(raw.trim())) {
    cents = BigInt(raw.trim());
  } else {
    return null;
  }

  if (cents < 0n || cents > MAX_NUMERIC_10_2_CENTS) {
    return null;
  }
  return formatCentsToUsd(cents);
}

export function computeCkCreditUsd(
  cashUsd: string | null,
  explicitCreditUsd: string | null = null,
): string | null {
  if (explicitCreditUsd !== null) {
    const explicitCents = parseJsonUsdToCents(explicitCreditUsd);
    return explicitCents !== null ? formatCentsToUsd(explicitCents) : null;
  }
  if (cashUsd === null) {
    return null;
  }
  const cashCents = parseJsonUsdToCents(cashUsd);
  if (cashCents === null) {
    return null;
  }
  const creditCents = mulCentsByRatioHalfUp(cashCents, 130n, 100n);
  if (creditCents > MAX_NUMERIC_10_2_CENTS) {
    return null;
  }
  return formatCentsToUsd(creditCents);
}

function isPlainRecord(val: unknown): val is Record<string, unknown> {
  return val !== null && typeof val === "object" && !Array.isArray(val);
}

function resolveScryfallImageUri(card: Record<string, unknown>): string | null {
  if (isPlainRecord(card.image_uris)) {
    const uri =
      card.image_uris.normal ?? card.image_uris.large ?? card.image_uris.small;
    if (typeof uri === "string" && uri.length > 0) {
      return uri;
    }
  }
  if (Array.isArray(card.card_faces)) {
    for (const face of card.card_faces) {
      if (isPlainRecord(face) && isPlainRecord(face.image_uris)) {
        const uri =
          face.image_uris.normal ??
          face.image_uris.large ??
          face.image_uris.small;
        if (typeof uri === "string" && uri.length > 0) {
          return uri;
        }
      }
    }
  }
  return null;
}

function resolveScryfallOracleId(card: Record<string, unknown>): string | null {
  const direct = normalizeSyncUuid(card.oracle_id);
  if (direct) return direct;
  if (Array.isArray(card.card_faces)) {
    for (const face of card.card_faces) {
      if (isPlainRecord(face)) {
        const faceOracle = normalizeSyncUuid(face.oracle_id);
        if (faceOracle) return faceOracle;
      }
    }
  }
  return null;
}

export function normalizeScryfallCard(
  rawCard: unknown,
): ScryfallCatalogRecord | null {
  if (!isPlainRecord(rawCard)) return null;

  if (
    Array.isArray(rawCard.games) &&
    rawCard.games.length > 0 &&
    !rawCard.games.includes("paper")
  ) {
    return null;
  }

  const scryfallId = normalizeSyncUuid(rawCard.id);
  const oracleId = resolveScryfallOracleId(rawCard);
  const name = rawCard.name;
  const setCode = rawCard.set;
  const setName = rawCard.set_name;
  const collectorNumber = rawCard.collector_number;
  const rarity = rawCard.rarity;

  if (
    !scryfallId ||
    !oracleId ||
    typeof name !== "string" ||
    name.length === 0 ||
    typeof setCode !== "string" ||
    setCode.length === 0 ||
    typeof setName !== "string" ||
    setName.length === 0 ||
    typeof collectorNumber !== "string" ||
    collectorNumber.length === 0 ||
    typeof rarity !== "string" ||
    rarity.length === 0
  ) {
    return null;
  }

  let finishes: string[] = ["nonfoil"];
  if (Array.isArray(rawCard.finishes) && rawCard.finishes.length > 0) {
    const valid = rawCard.finishes.filter(
      (f): f is string => typeof f === "string" && f.length > 0,
    );
    if (valid.length > 0) {
      finishes = valid;
    }
  }

  const prices = isPlainRecord(rawCard.prices) ? rawCard.prices : {};

  return {
    scryfallId,
    oracleId,
    tcgplayerId: parseSyncOptionalInt(rawCard.tcgplayer_id),
    tcgplayerEtchedId: parseSyncOptionalInt(rawCard.tcgplayer_etched_id),
    cardkingdomId: parseSyncOptionalInt(rawCard.cardkingdom_id),
    cardkingdomFoilId: parseSyncOptionalInt(rawCard.cardkingdom_foil_id),
    name,
    setCode: setCode.toLowerCase().slice(0, 16),
    setName,
    collectorNumber: collectorNumber.slice(0, 32),
    rarity: rarity.toLowerCase().slice(0, 16),
    finishes,
    imageUri: resolveScryfallImageUri(rawCard),
    tcgMarketNm: parseJsonUsdToString(prices.usd),
    tcgMarketFoil: parseJsonUsdToString(prices.usd_foil),
    tcgMarketEtched: parseJsonUsdToString(prices.usd_etched),
  };
}

export function extractIdentifierMapping(
  mtgjsonUuidRaw: string,
  cardObj: unknown,
): IdentifierMappingRecord | null {
  if (!isPlainRecord(cardObj)) return null;

  const side = cardObj.side;
  if (side !== undefined && side !== null && side !== "a") {
    return null;
  }

  if (
    Array.isArray(cardObj.availability) &&
    cardObj.availability.length > 0 &&
    !cardObj.availability.includes("paper")
  ) {
    return null;
  }

  const mtgjsonUuid = normalizeSyncUuid(mtgjsonUuidRaw);
  const identifiers = cardObj.identifiers;
  if (!mtgjsonUuid || !isPlainRecord(identifiers)) {
    return null;
  }

  const scryfallId = normalizeSyncUuid(identifiers.scryfallId);
  if (!scryfallId) {
    return null;
  }

  return {
    scryfallId,
    mtgjsonUuid,
    tcgplayerId: parseSyncOptionalInt(identifiers.tcgplayerProductId),
    tcgplayerEtchedId: parseSyncOptionalInt(
      identifiers.tcgplayerEtchedProductId,
    ),
    cardkingdomId: parseSyncOptionalInt(identifiers.cardKingdomId),
    cardkingdomFoilId: parseSyncOptionalInt(identifiers.cardKingdomFoilId),
  };
}

export function latestSeriesPriceUsd(series: unknown): string | null {
  if (!isPlainRecord(series)) return null;
  let latestDate: string | null = null;
  for (const key of Object.keys(series)) {
    if (latestDate === null || key > latestDate) {
      latestDate = key;
    }
  }
  if (latestDate === null) return null;
  return parseJsonUsdToString(series[latestDate]);
}

export function extractPriceUpdate(
  mtgjsonUuidRaw: string,
  payload: unknown,
): PriceUpdateRecord | null {
  const mtgjsonUuid = normalizeSyncUuid(mtgjsonUuidRaw);
  if (!mtgjsonUuid || !isPlainRecord(payload)) {
    return null;
  }

  const paper = payload.paper;
  if (!isPlainRecord(paper)) {
    return null;
  }

  const tcgplayer = isPlainRecord(paper.tcgplayer) ? paper.tcgplayer : {};
  const tcgRetail = isPlainRecord(tcgplayer.retail) ? tcgplayer.retail : {};
  const tcgRetailLow = isPlainRecord(tcgplayer.retail_low)
    ? tcgplayer.retail_low
    : {};

  const manapool = isPlainRecord(paper.manapool) ? paper.manapool : {};
  const manapoolRetail = isPlainRecord(manapool.retail) ? manapool.retail : {};

  const cardkingdom = isPlainRecord(paper.cardkingdom) ? paper.cardkingdom : {};
  const ckBuylist = isPlainRecord(cardkingdom.buylist)
    ? cardkingdom.buylist
    : {};
  const ckBuylistCredit = isPlainRecord(cardkingdom.buylist_credit)
    ? cardkingdom.buylist_credit
    : {};

  const ckCashNm = latestSeriesPriceUsd(ckBuylist.normal);
  const ckCashFoil = latestSeriesPriceUsd(ckBuylist.foil);
  const ckCashEtched = latestSeriesPriceUsd(ckBuylist.etched);

  const explicitCreditNm = latestSeriesPriceUsd(ckBuylistCredit.normal);
  const explicitCreditFoil = latestSeriesPriceUsd(ckBuylistCredit.foil);
  const explicitCreditEtched = latestSeriesPriceUsd(ckBuylistCredit.etched);

  const record: PriceUpdateRecord = {
    mtgjsonUuid,
    tcgMarketNm: latestSeriesPriceUsd(tcgRetail.normal),
    tcgLowNm: latestSeriesPriceUsd(tcgRetailLow.normal),
    tcgMarketFoil: latestSeriesPriceUsd(tcgRetail.foil),
    tcgLowFoil: latestSeriesPriceUsd(tcgRetailLow.foil),
    tcgMarketEtched: latestSeriesPriceUsd(tcgRetail.etched),
    tcgLowEtched: latestSeriesPriceUsd(tcgRetailLow.etched),
    manapoolLowNm: latestSeriesPriceUsd(manapoolRetail.normal),
    manapoolLowFoil: latestSeriesPriceUsd(manapoolRetail.foil),
    manapoolLowEtched: latestSeriesPriceUsd(manapoolRetail.etched),
    ckBuylistCashNm: ckCashNm,
    ckBuylistCreditNm: computeCkCreditUsd(ckCashNm, explicitCreditNm),
    ckBuylistCashFoil: ckCashFoil,
    ckBuylistCreditFoil: computeCkCreditUsd(ckCashFoil, explicitCreditFoil),
    ckBuylistCashEtched: ckCashEtched,
    ckBuylistCreditEtched: computeCkCreditUsd(
      ckCashEtched,
      explicitCreditEtched,
    ),
  };

  const hasAny =
    record.tcgMarketNm !== null ||
    record.tcgLowNm !== null ||
    record.tcgMarketFoil !== null ||
    record.tcgLowFoil !== null ||
    record.tcgMarketEtched !== null ||
    record.tcgLowEtched !== null ||
    record.manapoolLowNm !== null ||
    record.manapoolLowFoil !== null ||
    record.manapoolLowEtched !== null ||
    record.ckBuylistCashNm !== null ||
    record.ckBuylistCreditNm !== null ||
    record.ckBuylistCashFoil !== null ||
    record.ckBuylistCreditFoil !== null ||
    record.ckBuylistCashEtched !== null ||
    record.ckBuylistCreditEtched !== null;

  return hasAny ? record : null;
}

function positiveCentsUsdOrNull(raw: unknown): string | null {
  const usd = parseCentsToUsdString(raw);
  if (usd === null || usd === "0.00") {
    return null;
  }
  return usd;
}

export function extractManapoolSingle(
  entry: unknown,
): ManaPoolSingleRecord | null {
  if (!isPlainRecord(entry)) return null;

  let scryfallId = normalizeSyncUuid(entry.scryfall_id);
  if (!scryfallId && Array.isArray(entry.scryfall_ids)) {
    for (const candidate of entry.scryfall_ids) {
      scryfallId = normalizeSyncUuid(candidate);
      if (scryfallId) break;
    }
  }
  if (!scryfallId) return null;

  // Strictly read Near Mint cents (`price_cents_nm*`); never fall back to non-NM floor prices
  const manapoolLowNm = positiveCentsUsdOrNull(entry.price_cents_nm);
  const manapoolLowFoil = positiveCentsUsdOrNull(entry.price_cents_nm_foil);
  const manapoolLowEtched = positiveCentsUsdOrNull(entry.price_cents_nm_etched);

  if (
    manapoolLowNm === null &&
    manapoolLowFoil === null &&
    manapoolLowEtched === null
  ) {
    return null;
  }

  return {
    scryfallId,
    tcgplayerId: parseSyncOptionalInt(entry.tcgplayer_product_id),
    manapoolLowNm,
    manapoolLowFoil,
    manapoolLowEtched,
  };
}

function pipeChain(source: Readable, ...stages: NodeJS.ReadWriteStream[]): Readable {
  let current: NodeJS.ReadableStream = source;
  const allStreams: Array<NodeJS.ReadableStream | NodeJS.ReadWriteStream> = [
    source,
    ...stages,
  ];
  const terminal = stages[stages.length - 1] as unknown as Readable;

  for (const stage of stages) {
    current.on("error", (err) => {
      if (!("destroyed" in stage && stage.destroyed)) {
        if ("destroy" in stage && typeof stage.destroy === "function") {
          stage.destroy(err);
        }
      }
    });
    current = current.pipe(stage);
  }

  terminal.on("close", () => {
    for (const s of allStreams) {
      if ("destroy" in s && typeof s.destroy === "function") {
        s.destroy();
      }
    }
  });

  return terminal;
}

async function peekStreamPrefix(
  stream: Readable,
  minBytes: number,
): Promise<{ prefix: Buffer; replayStream: Readable }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const cleanup = () => {
      stream.removeListener("data", onData);
      stream.removeListener("end", onEnd);
      stream.removeListener("error", onError);
    };

    const finish = (eof: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      stream.pause();

      const prefix = Buffer.concat(chunks, total);
      const replay = new PassThrough();
      stream.on("error", (err) => replay.destroy(err));
      replay.on("close", () => {
        if (!stream.destroyed) {
          stream.destroy();
        }
      });

      if (prefix.length > 0) {
        replay.write(prefix);
      }
      if (eof) {
        replay.end();
      } else {
        stream.pipe(replay);
        stream.resume();
      }

      resolve({ prefix, replayStream: replay });
    };

    const onData = (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(buf);
      total += buf.length;
      if (total >= minBytes) {
        finish(false);
      }
    };

    const onEnd = () => {
      finish(true);
    };

    const onError = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("error", onError);
  });
}

async function openDecompressedStream(
  source: string,
  options: { userAgent: string; fetchImpl: typeof fetch },
): Promise<Readable> {
  let rawStream: Readable;

  if (source.startsWith("http://") || source.startsWith("https://")) {
    const response = await options.fetchImpl(source, {
      headers: {
        "User-Agent": options.userAgent,
        Accept: "application/json, application/octet-stream, */*",
      },
      redirect: "follow",
    });
    if (!response.ok) {
      throw new Error(
        `Upstream HTTP ${response.status} ${response.statusText} fetching ${source}`,
      );
    }
    if (!response.body) {
      throw new Error(`Empty response body fetching ${source}`);
    }
    rawStream = Readable.fromWeb(response.body as unknown as WebReadableStream);
  } else {
    if (!fs.existsSync(source)) {
      throw new Error(`Local sync source file not found: ${source}`);
    }
    rawStream = fs.createReadStream(source, { highWaterMark: 64 * 1024 });
  }

  const { prefix, replayStream } = await peekStreamPrefix(rawStream, 4);

  // Gzip magic bytes: 1f 8b
  if (prefix.length >= 2 && prefix[0] === 0x1f && prefix[1] === 0x8b) {
    return pipeChain(replayStream, zlib.createGunzip());
  }

  // BZip2 magic bytes: "BZh" (42 5a 68)
  if (
    prefix.length >= 3 &&
    prefix[0] === 0x42 &&
    prefix[1] === 0x5a &&
    prefix[2] === 0x68
  ) {
    return pipeChain(replayStream, unbzip2Stream());
  }

  return replayStream;
}

export async function fetchScryfallBulkDownloadUri(options: {
  metadataUrl?: string;
  userAgent?: string;
  fetchImpl?: typeof fetch;
} = {}): Promise<string> {
  const fetchFn = options.fetchImpl ?? fetch;
  const metadataUrl = options.metadataUrl ?? SCRYFALL_BULK_METADATA_URL;
  const userAgent =
    options.userAgent ??
    process.env.SCRYFALL_USER_AGENT ??
    DEFAULT_SYNC_USER_AGENT;

  const response = await fetchFn(metadataUrl, {
    headers: {
      "User-Agent": userAgent,
      Accept: "application/json",
    },
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch Scryfall bulk metadata (${response.status} ${response.statusText}).`,
    );
  }

  const payload = (await response.json()) as Record<string, unknown>;
  const uri = payload.download_uri ?? payload.jsonl_download_uri;
  if (typeof uri !== "string" || uri.trim() === "") {
    throw new Error(
      "Scryfall bulk metadata response missing download_uri / jsonl_download_uri.",
    );
  }
  return uri;
}

function formatPgTextArrayLiteral(values: readonly string[]): string {
  const escaped = values.map((val) => {
    const clean = val.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `"${clean}"`;
  });
  return `{${escaped.join(",")}}`;
}

function extractAffectedRowCount(res: unknown): number {
  if (!res || typeof res !== "object") return 0;
  const candidate = res as {
    count?: unknown;
    rowCount?: unknown;
    affectedRows?: unknown;
  };
  for (const v of [candidate.affectedRows, candidate.rowCount, candidate.count]) {
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
      return v;
    }
  }
  return 0;
}

export async function upsertScryfallBatch(
  db: Database,
  batch: readonly ScryfallCatalogRecord[],
): Promise<number> {
  if (batch.length === 0) return 0;

  const dedupedMap = new Map<string, ScryfallCatalogRecord>();
  for (const rec of batch) {
    dedupedMap.set(rec.scryfallId, rec);
  }
  const rows = [...dedupedMap.values()];

  const valueTuples = rows.map(
    (r) => sql`(
      ${r.scryfallId}::uuid,
      ${r.oracleId}::uuid,
      ${r.tcgplayerId}::integer,
      ${r.tcgplayerEtchedId}::integer,
      ${r.cardkingdomId}::integer,
      ${r.cardkingdomFoilId}::integer,
      ${r.name}::text,
      ${r.setCode}::varchar(16),
      ${r.setName}::text,
      ${r.collectorNumber}::varchar(32),
      ${r.rarity}::varchar(16),
      ${formatPgTextArrayLiteral(r.finishes)}::text[],
      ${r.imageUri}::text,
      ${r.tcgMarketNm}::numeric(10, 2),
      ${r.tcgMarketFoil}::numeric(10, 2),
      ${r.tcgMarketEtched}::numeric(10, 2),
      NOW()
    )`,
  );

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      INSERT INTO card_catalog (
        scryfall_id,
        oracle_id,
        tcgplayer_id,
        tcgplayer_etched_id,
        cardkingdom_id,
        cardkingdom_foil_id,
        name,
        set_code,
        set_name,
        collector_number,
        rarity,
        finishes,
        image_uri,
        tcg_market_nm,
        tcg_market_foil,
        tcg_market_etched,
        updated_at
      )
      VALUES ${sql.join(valueTuples, sql`, `)}
      ON CONFLICT (scryfall_id) DO UPDATE SET
        oracle_id = EXCLUDED.oracle_id,
        tcgplayer_id = COALESCE(EXCLUDED.tcgplayer_id, card_catalog.tcgplayer_id),
        tcgplayer_etched_id = COALESCE(EXCLUDED.tcgplayer_etched_id, card_catalog.tcgplayer_etched_id),
        cardkingdom_id = COALESCE(EXCLUDED.cardkingdom_id, card_catalog.cardkingdom_id),
        cardkingdom_foil_id = COALESCE(EXCLUDED.cardkingdom_foil_id, card_catalog.cardkingdom_foil_id),
        name = EXCLUDED.name,
        set_code = EXCLUDED.set_code,
        set_name = EXCLUDED.set_name,
        collector_number = EXCLUDED.collector_number,
        rarity = EXCLUDED.rarity,
        finishes = EXCLUDED.finishes,
        image_uri = COALESCE(EXCLUDED.image_uri, card_catalog.image_uri),
        tcg_market_nm = COALESCE(EXCLUDED.tcg_market_nm, card_catalog.tcg_market_nm),
        tcg_market_foil = COALESCE(EXCLUDED.tcg_market_foil, card_catalog.tcg_market_foil),
        tcg_market_etched = COALESCE(EXCLUDED.tcg_market_etched, card_catalog.tcg_market_etched),
        updated_at = NOW();
    `);
  });

  return rows.length;
}

export async function updateIdentifierBatch(
  db: Database,
  batch: readonly IdentifierMappingRecord[],
): Promise<number> {
  if (batch.length === 0) return 0;

  const byScryfall = new Map<string, IdentifierMappingRecord>();
  const seenMtgjson = new Set<string>();
  for (const rec of batch) {
    if (seenMtgjson.has(rec.mtgjsonUuid)) continue;
    seenMtgjson.add(rec.mtgjsonUuid);
    byScryfall.set(rec.scryfallId, rec);
  }
  const rows = [...byScryfall.values()];
  if (rows.length === 0) return 0;

  const valueTuples = rows.map(
    (r) => sql`(
      ${r.scryfallId}::uuid,
      ${r.mtgjsonUuid}::uuid,
      ${r.tcgplayerId}::integer,
      ${r.tcgplayerEtchedId}::integer,
      ${r.cardkingdomId}::integer,
      ${r.cardkingdomFoilId}::integer
    )`,
  );

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      UPDATE card_catalog AS c
      SET
        mtgjson_uuid = CASE
          WHEN EXISTS (
            SELECT 1
            FROM card_catalog existing
            WHERE existing.mtgjson_uuid = v.mtgjson_uuid
              AND existing.scryfall_id <> c.scryfall_id
          ) THEN c.mtgjson_uuid
          ELSE v.mtgjson_uuid
        END,
        tcgplayer_id = COALESCE(v.tcgplayer_id, c.tcgplayer_id),
        tcgplayer_etched_id = COALESCE(v.tcgplayer_etched_id, c.tcgplayer_etched_id),
        cardkingdom_id = COALESCE(v.cardkingdom_id, c.cardkingdom_id),
        cardkingdom_foil_id = COALESCE(v.cardkingdom_foil_id, c.cardkingdom_foil_id),
        updated_at = NOW()
      FROM (
        VALUES ${sql.join(valueTuples, sql`, `)}
      ) AS v(
        scryfall_id,
        mtgjson_uuid,
        tcgplayer_id,
        tcgplayer_etched_id,
        cardkingdom_id,
        cardkingdom_foil_id
      )
      WHERE c.scryfall_id = v.scryfall_id;
    `);
  });

  return rows.length;
}

export async function resetDailyVendorPrices(
  db: Database,
  chunkSize = 5000,
): Promise<number> {
  let totalReset = 0;
  // Reset in bounded ctid batches so PGlite WASM never holds 110k+ MVCC row versions in one transaction
  while (true) {
    const rows = (await db.execute(sql`
      WITH target AS (
        SELECT ctid
        FROM card_catalog
        WHERE tcg_low_nm IS NOT NULL
           OR tcg_low_foil IS NOT NULL
           OR tcg_low_etched IS NOT NULL
           OR manapool_low_nm IS NOT NULL
           OR manapool_low_foil IS NOT NULL
           OR manapool_low_etched IS NOT NULL
           OR ck_buylist_cash_nm IS NOT NULL
           OR ck_buylist_credit_nm IS NOT NULL
           OR ck_buylist_cash_foil IS NOT NULL
           OR ck_buylist_credit_foil IS NOT NULL
           OR ck_buylist_cash_etched IS NOT NULL
           OR ck_buylist_credit_etched IS NOT NULL
        LIMIT ${chunkSize}
      ),
      updated AS (
        UPDATE card_catalog AS c
        SET
          tcg_low_nm = NULL,
          tcg_low_foil = NULL,
          tcg_low_etched = NULL,
          manapool_low_nm = NULL,
          manapool_low_foil = NULL,
          manapool_low_etched = NULL,
          ck_buylist_cash_nm = NULL,
          ck_buylist_credit_nm = NULL,
          ck_buylist_cash_foil = NULL,
          ck_buylist_credit_foil = NULL,
          ck_buylist_cash_etched = NULL,
          ck_buylist_credit_etched = NULL,
          updated_at = NOW()
        FROM target
        WHERE c.ctid = target.ctid
        RETURNING 1
      )
      SELECT CAST(COUNT(*) AS INTEGER) AS reset_count FROM updated;
    `)) as unknown as { rows?: Array<{ reset_count?: number }> } | Array<{ reset_count?: number }>;

    const recordList = Array.isArray(rows) ? rows : (rows.rows ?? []);
    const batchCount = Number(recordList[0]?.reset_count ?? 0);
    totalReset += batchCount;
    if (batchCount < chunkSize) {
      break;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return totalReset;
}

export async function updatePriceBatch(
  db: Database,
  batch: readonly PriceUpdateRecord[],
): Promise<number> {
  if (batch.length === 0) return 0;

  const deduped = new Map<string, PriceUpdateRecord>();
  for (const rec of batch) {
    deduped.set(rec.mtgjsonUuid, rec);
  }
  const rows = [...deduped.values()];

  const valueTuples = rows.map(
    (r) => sql`(
      ${r.mtgjsonUuid}::uuid,
      ${r.tcgMarketNm}::numeric(10, 2),
      ${r.tcgLowNm}::numeric(10, 2),
      ${r.tcgMarketFoil}::numeric(10, 2),
      ${r.tcgLowFoil}::numeric(10, 2),
      ${r.tcgMarketEtched}::numeric(10, 2),
      ${r.tcgLowEtched}::numeric(10, 2),
      ${r.manapoolLowNm}::numeric(10, 2),
      ${r.manapoolLowFoil}::numeric(10, 2),
      ${r.manapoolLowEtched}::numeric(10, 2),
      ${r.ckBuylistCashNm}::numeric(10, 2),
      ${r.ckBuylistCreditNm}::numeric(10, 2),
      ${r.ckBuylistCashFoil}::numeric(10, 2),
      ${r.ckBuylistCreditFoil}::numeric(10, 2),
      ${r.ckBuylistCashEtched}::numeric(10, 2),
      ${r.ckBuylistCreditEtched}::numeric(10, 2)
    )`,
  );

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      UPDATE card_catalog AS c
      SET
        tcg_market_nm = COALESCE(v.tcg_market_nm, c.tcg_market_nm),
        tcg_low_nm = v.tcg_low_nm,
        tcg_market_foil = COALESCE(v.tcg_market_foil, c.tcg_market_foil),
        tcg_low_foil = v.tcg_low_foil,
        tcg_market_etched = COALESCE(v.tcg_market_etched, c.tcg_market_etched),
        tcg_low_etched = v.tcg_low_etched,
        manapool_low_nm = v.manapool_low_nm,
        manapool_low_foil = v.manapool_low_foil,
        manapool_low_etched = v.manapool_low_etched,
        ck_buylist_cash_nm = v.ck_buylist_cash_nm,
        ck_buylist_credit_nm = v.ck_buylist_credit_nm,
        ck_buylist_cash_foil = v.ck_buylist_cash_foil,
        ck_buylist_credit_foil = v.ck_buylist_credit_foil,
        ck_buylist_cash_etched = v.ck_buylist_cash_etched,
        ck_buylist_credit_etched = v.ck_buylist_credit_etched,
        updated_at = NOW()
      FROM (
        VALUES ${sql.join(valueTuples, sql`, `)}
      ) AS v(
        mtgjson_uuid,
        tcg_market_nm,
        tcg_low_nm,
        tcg_market_foil,
        tcg_low_foil,
        tcg_market_etched,
        tcg_low_etched,
        manapool_low_nm,
        manapool_low_foil,
        manapool_low_etched,
        ck_buylist_cash_nm,
        ck_buylist_credit_nm,
        ck_buylist_cash_foil,
        ck_buylist_credit_foil,
        ck_buylist_cash_etched,
        ck_buylist_credit_etched
      )
      WHERE c.mtgjson_uuid = v.mtgjson_uuid;
    `);
  });

  return rows.length;
}

export async function supplementManapoolBatch(
  db: Database,
  batch: readonly ManaPoolSingleRecord[],
  options: { overwrite?: boolean } = {},
): Promise<number> {
  if (batch.length === 0) return 0;

  const deduped = new Map<string, ManaPoolSingleRecord>();
  for (const rec of batch) {
    deduped.set(rec.scryfallId, rec);
  }
  const rows = [...deduped.values()];

  const valueTuples = rows.map(
    (r) => sql`(
      ${r.scryfallId}::uuid,
      ${r.tcgplayerId}::integer,
      ${r.manapoolLowNm}::numeric(10, 2),
      ${r.manapoolLowFoil}::numeric(10, 2),
      ${r.manapoolLowEtched}::numeric(10, 2)
    )`,
  );

  await db.transaction(async (tx) => {
    if (options.overwrite) {
      await tx.execute(sql`
        UPDATE card_catalog AS c
        SET
          tcgplayer_id = COALESCE(c.tcgplayer_id, v.tcgplayer_id),
          manapool_low_nm = v.manapool_low_nm,
          manapool_low_foil = v.manapool_low_foil,
          manapool_low_etched = v.manapool_low_etched,
          updated_at = NOW()
        FROM (
          VALUES ${sql.join(valueTuples, sql`, `)}
        ) AS v(
          scryfall_id,
          tcgplayer_id,
          manapool_low_nm,
          manapool_low_foil,
          manapool_low_etched
        )
        WHERE c.scryfall_id = v.scryfall_id
          AND (
            (c.tcgplayer_id IS NULL AND v.tcgplayer_id IS NOT NULL)
            OR c.manapool_low_nm IS DISTINCT FROM v.manapool_low_nm
            OR c.manapool_low_foil IS DISTINCT FROM v.manapool_low_foil
            OR c.manapool_low_etched IS DISTINCT FROM v.manapool_low_etched
          );
      `);
    } else {
      await tx.execute(sql`
        UPDATE card_catalog AS c
        SET
          tcgplayer_id = COALESCE(c.tcgplayer_id, v.tcgplayer_id),
          manapool_low_nm = COALESCE(c.manapool_low_nm, v.manapool_low_nm),
          manapool_low_foil = COALESCE(c.manapool_low_foil, v.manapool_low_foil),
          manapool_low_etched = COALESCE(c.manapool_low_etched, v.manapool_low_etched),
          updated_at = NOW()
        FROM (
          VALUES ${sql.join(valueTuples, sql`, `)}
        ) AS v(
          scryfall_id,
          tcgplayer_id,
          manapool_low_nm,
          manapool_low_foil,
          manapool_low_etched
        )
        WHERE c.scryfall_id = v.scryfall_id
          AND (
            (c.tcgplayer_id IS NULL AND v.tcgplayer_id IS NOT NULL)
            OR (c.manapool_low_nm IS NULL AND v.manapool_low_nm IS NOT NULL)
            OR (c.manapool_low_foil IS NULL AND v.manapool_low_foil IS NOT NULL)
            OR (c.manapool_low_etched IS NULL AND v.manapool_low_etched IS NOT NULL)
          );
      `);
    }
  });

  return rows.length;
}

export async function pruneExpiredSkuCache(db: Database): Promise<number> {
  const res = await db.execute(sql`
    DELETE FROM sku_price_cache
    WHERE expires_at <= NOW();
  `);
  return extractAffectedRowCount(res);
}

async function cleanupLegacySyntheticDemoRowsAndRefreshCache(
  db: Database,
  ensureDemoSkuCache: boolean,
): Promise<void> {
  // Remove any unreferenced legacy synthetic `100000xx-4000-8000-a000-...` rows from pre-Step-5 databases
  await db.execute(sql`
    DELETE FROM card_catalog
    WHERE scryfall_id::text LIKE '100000%-4000-8000-a000-%'
      AND NOT EXISTS (
        SELECT 1 FROM lot_items li WHERE li.scryfall_id = card_catalog.scryfall_id
      );
  `);

  if (!ensureDemoSkuCache) return;

  const skuSeeds = buildDemoSkuPriceCacheSeeds(new Date());
  for (const seed of skuSeeds) {
    const existingCard = await db
      .select({ scryfallId: cardCatalog.scryfallId })
      .from(cardCatalog)
      .where(sql`${cardCatalog.scryfallId} = ${seed.scryfallId}::uuid`);
    if (existingCard.length === 0) continue;

    await db
      .insert(skuPriceCache)
      .values(seed)
      .onConflictDoUpdate({
        target: [
          skuPriceCache.scryfallId,
          skuPriceCache.finish,
          skuPriceCache.condition,
        ],
        set: {
          retailLowUsd: seed.retailLowUsd,
          retailMarketUsd: seed.retailMarketUsd,
          buylistCashUsd: seed.buylistCashUsd,
          buylistCreditUsd: seed.buylistCreditUsd,
          source: seed.source,
          fetchedAt: seed.fetchedAt,
          expiresAt: seed.expiresAt,
        },
      });
  }
}

/**
 * Constant-memory Node.js / TypeScript 4-stage full MTG catalog sync pipeline
 * matching `scripts/sync_catalog.py` & `.cursor/rules/400-data-sync-cron.mdc`
 * across Scryfall `default_cards`, MTGJSON `AllIdentifiers.json.bz2`,
 * MTGJSON `AllPricesToday.json.bz2`, and Mana Pool public singles.
 */
export async function syncFullCatalog(
  db: Database,
  options: SyncFullCatalogOptions = {},
): Promise<CatalogSyncStats> {
  const startedMs = Date.now();
  const batchSize = options.batchSize ?? DEFAULT_SYNC_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize <= 0 || batchSize > 2000) {
    throw new RangeError(
      "batchSize must be an integer between 1 and 2000 (500 recommended for PGlite/Postgres parameter limits).",
    );
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const userAgent =
    options.userAgent ??
    process.env.SCRYFALL_USER_AGENT ??
    DEFAULT_SYNC_USER_AGENT;
  const limit = options.limit;

  const stats: CatalogSyncStats = {
    scryfallSeen: 0,
    scryfallUpserted: 0,
    scryfallBatches: 0,
    identifiersSeen: 0,
    identifiersMapped: 0,
    identifiersBatches: 0,
    dailyPricesReset: 0,
    pricesSeen: 0,
    pricesUpdated: 0,
    pricesBatches: 0,
    manapoolSeen: 0,
    manapoolSupplemented: 0,
    manapoolBatches: 0,
    manapoolFallbackFailed: false,
    manapoolWarning: null,
    skuCachePruned: 0,
    finalCatalogCount: 0,
    durationMs: 0,
  };

  const emitProgress = (
    stageNumber: 1 | 2 | 3 | 4,
    stageKey: SyncStageKey,
    stageLabel: string,
    rowsSeen: number,
    rowsWritten: number,
    batchesCompleted: number,
  ) => {
    options.onProgress?.({
      stageNumber,
      stageKey,
      stageLabel,
      rowsSeen,
      rowsWritten,
      batchesCompleted,
      stats: { ...stats, durationMs: Date.now() - startedMs },
    });
  };

  // --- Stage 1: Scryfall default_cards ---
  if (!options.skipScryfall) {
    emitProgress(
      1,
      "scryfall",
      "Stage 1/4: Resolving Scryfall default_cards bulk feed...",
      0,
      0,
      0,
    );
    const resolvedScryfallSource =
      options.scryfallSource ??
      (await fetchScryfallBulkDownloadUri({
        metadataUrl: options.scryfallMetadataUrl,
        userAgent,
        fetchImpl,
      }));

    const decompressed = await openDecompressedStream(resolvedScryfallSource, {
      userAgent,
      fetchImpl,
    });
    const { prefix, replayStream } = await peekStreamPrefix(decompressed, 64);
    const trimmedHead = prefix.toString("utf8").trimStart();
    const itemStream = trimmedHead.startsWith("[")
      ? pipeChain(replayStream, streamArray.withParserAsStream())
      : pipeChain(replayStream, jsonlParser.asStream());

    let pendingBatch: ScryfallCatalogRecord[] = [];
    for await (const rawChunk of itemStream) {
      const cardObj = (rawChunk as { value?: unknown }).value;
      stats.scryfallSeen += 1;
      const normalized = normalizeScryfallCard(cardObj);
      if (normalized) {
        pendingBatch.push(normalized);
        if (pendingBatch.length >= batchSize) {
          stats.scryfallUpserted += await upsertScryfallBatch(db, pendingBatch);
          stats.scryfallBatches += 1;
          pendingBatch = [];
          emitProgress(
            1,
            "scryfall",
            "Stage 1/4: Streaming & upserting Scryfall default_cards...",
            stats.scryfallSeen,
            stats.scryfallUpserted,
            stats.scryfallBatches,
          );
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }
      if (stats.scryfallSeen % 2000 === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      if (limit !== undefined && stats.scryfallSeen >= limit) {
        itemStream.destroy();
        break;
      }
    }

    if (pendingBatch.length > 0) {
      stats.scryfallUpserted += await upsertScryfallBatch(db, pendingBatch);
      stats.scryfallBatches += 1;
    }
    emitProgress(
      1,
      "scryfall",
      "Stage 1/4 complete: Scryfall default_cards indexed.",
      stats.scryfallSeen,
      stats.scryfallUpserted,
      stats.scryfallBatches,
    );
  }

  // --- Stage 2: MTGJSON AllIdentifiers.json.bz2 ---
  const identifiersSource =
    options.identifiersSource === undefined
      ? MTGJSON_IDENTIFIERS_URL
      : options.identifiersSource;

  if (!options.skipIdentifiers && identifiersSource !== null) {
    emitProgress(
      2,
      "identifiers",
      "Stage 2/4: Streaming MTGJSON AllIdentifiers.json.bz2...",
      0,
      0,
      0,
    );
    const decompressed = await openDecompressedStream(identifiersSource, {
      userAgent,
      fetchImpl,
    });
    const objectStream = pipeChain(
      decompressed,
      pick.withParserAsStream({ filter: "data" }),
      ignore.asStream({ filter: IDENTIFIERS_HEAVY_FIELD_FILTER }),
      streamObject.asStream(),
    );

    let pendingBatch: IdentifierMappingRecord[] = [];
    for await (const rawEntry of objectStream) {
      const { key, value } = rawEntry as { key: string; value: unknown };
      stats.identifiersSeen += 1;
      const mapping = extractIdentifierMapping(key, value);
      if (mapping) {
        pendingBatch.push(mapping);
        if (pendingBatch.length >= batchSize) {
          stats.identifiersMapped += await updateIdentifierBatch(
            db,
            pendingBatch,
          );
          stats.identifiersBatches += 1;
          pendingBatch = [];
          emitProgress(
            2,
            "identifiers",
            "Stage 2/4: Mapping Scryfall <-> MTGJSON & CK/TCG IDs...",
            stats.identifiersSeen,
            stats.identifiersMapped,
            stats.identifiersBatches,
          );
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }
      if (stats.identifiersSeen % 1000 === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      if (limit !== undefined && stats.identifiersSeen >= limit) {
        objectStream.destroy();
        break;
      }
    }

    if (pendingBatch.length > 0) {
      stats.identifiersMapped += await updateIdentifierBatch(db, pendingBatch);
      stats.identifiersBatches += 1;
    }
    emitProgress(
      2,
      "identifiers",
      "Stage 2/4 complete: MTGJSON identifiers mapped.",
      stats.identifiersSeen,
      stats.identifiersMapped,
      stats.identifiersBatches,
    );
  }

  // --- Stage 3: MTGJSON AllPricesToday.json.bz2 ---
  const pricesSource =
    options.pricesSource === undefined
      ? MTGJSON_PRICES_TODAY_URL
      : options.pricesSource;

  if (!options.skipPrices && pricesSource !== null) {
    emitProgress(
      3,
      "prices",
      "Stage 3/4: Streaming MTGJSON AllPricesToday.json.bz2...",
      0,
      0,
      0,
    );
    const decompressed = await openDecompressedStream(pricesSource, {
      userAgent,
      fetchImpl,
    });
    const { prefix, replayStream } = await peekStreamPrefix(decompressed, 8);
    if (limit === undefined && prefix.length > 0) {
      stats.dailyPricesReset = await resetDailyVendorPrices(db);
    }

    const objectStream = pipeChain(
      replayStream,
      pick.withParserAsStream({ filter: "data" }),
      streamObject.asStream(),
    );

    let pendingBatch: PriceUpdateRecord[] = [];
    for await (const rawEntry of objectStream) {
      const { key, value } = rawEntry as { key: string; value: unknown };
      stats.pricesSeen += 1;
      const update = extractPriceUpdate(key, value);
      if (update) {
        pendingBatch.push(update);
        if (pendingBatch.length >= batchSize) {
          stats.pricesUpdated += await updatePriceBatch(db, pendingBatch);
          stats.pricesBatches += 1;
          pendingBatch = [];
          emitProgress(
            3,
            "prices",
            "Stage 3/4: Applying daily TCGplayer, Card Kingdom & Mana Pool prices...",
            stats.pricesSeen,
            stats.pricesUpdated,
            stats.pricesBatches,
          );
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }
      if (stats.pricesSeen % 1500 === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      if (limit !== undefined && stats.pricesSeen >= limit) {
        objectStream.destroy();
        break;
      }
    }

    if (pendingBatch.length > 0) {
      stats.pricesUpdated += await updatePriceBatch(db, pendingBatch);
      stats.pricesBatches += 1;
    }
    emitProgress(
      3,
      "prices",
      "Stage 3/4 complete: MTGJSON daily vendor quotes updated.",
      stats.pricesSeen,
      stats.pricesUpdated,
      stats.pricesBatches,
    );
  }

  // --- Stage 4: Mana Pool Public Singles Supplement ---
  const manapoolSource =
    options.manapoolSource === undefined
      ? MANAPOOL_SINGLES_URL
      : options.manapoolSource;

  if (!options.skipManapool && manapoolSource !== null) {
    emitProgress(
      4,
      "manapool",
      "Stage 4/4: Streaming Mana Pool public Near Mint singles feed...",
      0,
      0,
      0,
    );
    try {
      const decompressed = await openDecompressedStream(manapoolSource, {
        userAgent,
        fetchImpl,
      });
      const arrayStream = pipeChain(
        decompressed,
        pick.withParserAsStream({ filter: "data" }),
        streamArray.asStream(),
      );

      let pendingBatch: ManaPoolSingleRecord[] = [];
      for await (const rawEntry of arrayStream) {
        const entryObj = (rawEntry as { value?: unknown }).value;
        stats.manapoolSeen += 1;
        const single = extractManapoolSingle(entryObj);
        if (single) {
          pendingBatch.push(single);
          if (pendingBatch.length >= batchSize) {
            stats.manapoolSupplemented += await supplementManapoolBatch(
              db,
              pendingBatch,
              { overwrite: Boolean(options.skipPrices) },
            );
            stats.manapoolBatches += 1;
            pendingBatch = [];
            emitProgress(
              4,
              "manapool",
              "Stage 4/4: Supplementing Mana Pool NM singles quotes...",
              stats.manapoolSeen,
              stats.manapoolSupplemented,
              stats.manapoolBatches,
            );
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
        }
        if (stats.manapoolSeen % 1500 === 0) {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        if (limit !== undefined && stats.manapoolSeen >= limit) {
          arrayStream.destroy();
          break;
        }
      }

      if (pendingBatch.length > 0) {
        stats.manapoolSupplemented += await supplementManapoolBatch(
          db,
          pendingBatch,
          { overwrite: Boolean(options.skipPrices) },
        );
        stats.manapoolBatches += 1;
      }
    } catch (err) {
      stats.manapoolFallbackFailed = true;
      stats.manapoolWarning =
        err instanceof Error ? err.message : String(err);
      if (options.strictManapool) {
        throw err;
      }
    }
  }

  // --- Finalize: Prune expired SKU cache, clean legacy synthetic demo rows, & ANALYZE ---
  if (!options.skipPruneSkuCache) {
    stats.skuCachePruned = await pruneExpiredSkuCache(db);
  }

  await cleanupLegacySyntheticDemoRowsAndRefreshCache(
    db,
    options.ensureDemoSkuCache ?? (limit === undefined),
  );

  await db.execute(sql`ANALYZE card_catalog;`);

  const countRows = await db
    .select({ count: sql<number>`CAST(COUNT(*) AS INTEGER)` })
    .from(cardCatalog);
  stats.finalCatalogCount = Number(countRows[0]?.count ?? 0);

  stats.durationMs = Date.now() - startedMs;
  emitProgress(
    4,
    "finalize",
    `Sync complete (${stats.finalCatalogCount.toLocaleString("en-US")} printings indexed).`,
    stats.manapoolSeen,
    stats.manapoolSupplemented,
    stats.manapoolBatches,
  );

  return stats;
}
