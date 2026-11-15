import type { CardCondition, CardFinish } from "@/db/schema";

export const SCANNER_FORMATS = [
  "manabox",
  "delver_lens",
  "tcgplayer_app",
  "dragon_shield",
] as const;
export type ScannerFormat = (typeof SCANNER_FORMATS)[number];

export class CsvParseError extends Error {
  readonly lineNumber?: number;

  constructor(message: string, lineNumber?: number) {
    super(message);
    this.name = "CsvParseError";
    this.lineNumber = lineNumber;
  }
}

export interface RawCsvRecord {
  readonly rowNumber: number;
  readonly values: string[];
}

export interface ParsedCsvMatrix {
  readonly headers: string[];
  readonly records: RawCsvRecord[];
}

export interface ParsedCsvRow {
  readonly rowNumber: number;
  readonly format: ScannerFormat;
  readonly cardName: string | null;
  readonly scryfallId: string | null;
  readonly tcgplayerProductId: number | null;
  readonly setCode: string | null;
  readonly setName: string | null;
  readonly collectorNumber: string | null;
  readonly finish: CardFinish;
  readonly condition: CardCondition;
  readonly language: string;
  readonly isAltered: boolean;
  readonly isMisprint: boolean;
  readonly quantity: number;
  readonly rawRow: Record<string, string>;
}

export interface SkippedCsvRow {
  readonly rowNumber: number;
  readonly reason: "zero_quantity" | "invalid_quantity" | "empty_row";
  readonly rawRow: Record<string, string>;
}

export interface ParseScannerCsvResult {
  readonly format: ScannerFormat;
  readonly headers: string[];
  readonly rows: ParsedCsvRow[];
  readonly skippedRows: SkippedCsvRow[];
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const LANGUAGE_LOOKUP: Readonly<Record<string, string>> = {
  en: "en",
  eng: "en",
  english: "en",
  "en-us": "en",
  "en-gb": "en",

  ja: "ja",
  jp: "ja",
  jpn: "ja",
  japanese: "ja",

  de: "de",
  ger: "de",
  deu: "de",
  german: "de",

  fr: "fr",
  fre: "fr",
  fra: "fr",
  french: "fr",

  it: "it",
  ita: "it",
  italian: "it",

  es: "es",
  spa: "es",
  spanish: "es",

  pt: "pt",
  por: "pt",
  portuguese: "pt",
  "portuguese (brazil)": "pt",
  "portuguese brazil": "pt",
  "brazilian portuguese": "pt",
  "pt-br": "pt",
  "pt_br": "pt",

  ko: "ko",
  kr: "ko",
  kor: "ko",
  korean: "ko",

  ru: "ru",
  rus: "ru",
  russian: "ru",

  zhs: "zhs",
  cs: "zhs",
  "zh-cn": "zhs",
  "zh_cn": "zhs",
  "zh-hans": "zhs",
  "s-chinese": "zhs",
  "chinese simplified": "zhs",
  "chinese (simplified)": "zhs",
  "chinese - simplified": "zhs",
  "simplified chinese": "zhs",

  zht: "zht",
  ct: "zht",
  "zh-tw": "zht",
  "zh_tw": "zht",
  "zh-hk": "zht",
  "zh-hant": "zht",
  "t-chinese": "zht",
  "chinese traditional": "zht",
  "chinese (traditional)": "zht",
  "chinese - traditional": "zht",
  "traditional chinese": "zht",

  ph: "ph",
  phyrexian: "ph",

  he: "he",
  heb: "he",
  hebrew: "he",

  la: "la",
  lat: "la",
  latin: "la",

  grc: "grc",
  "ancient greek": "grc",
  greek: "grc",

  ar: "ar",
  ara: "ar",
  arabic: "ar",

  sa: "sa",
  san: "sa",
  sanskrit: "sa",

  qya: "qya",
  quenya: "qya",
};

function normalizeHeaderKey(header: string): string {
  return header
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/**
 * RFC-4180 compliant CSV matrix parser supporting UTF-8 BOM, optional `sep=`
 * directive lines, quoted fields containing commas/newlines, `""` escaped
 * quotes, CRLF/LF/CR line endings, and blank trailing lines.
 */
export function parseCsvMatrix(csvInput: string): ParsedCsvMatrix {
  let text = csvInput.startsWith("\uFEFF") ? csvInput.slice(1) : csvInput;
  if (text.trim() === "") {
    throw new CsvParseError("CSV input is empty.");
  }

  let delimiter = ",";
  let lineOffset = 0;
  const sepMatch = /^sep=(.)(?:\r\n|\n|\r)/i.exec(text);
  if (sepMatch?.[1]) {
    delimiter = sepMatch[1];
    text = text.slice(sepMatch[0].length);
    lineOffset = 1;
  }

  const rawRows: RawCsvRecord[] = [];
  let currentFields: string[] = [];
  let currentField = "";
  let inQuotes = false;
  let fieldStartedWithQuote = false;
  let currentLine = 1 + lineOffset;
  let recordStartLine = currentLine;

  const pushCompletedRecord = () => {
    currentFields.push(currentField);
    const isCompletelyBlank =
      currentFields.length === 1 && currentFields[0]!.trim() === "";
    const allCellsEmpty = currentFields.every((cell) => cell.trim() === "");
    if (!isCompletelyBlank && !allCellsEmpty) {
      rawRows.push({
        rowNumber: recordStartLine,
        values: currentFields,
      });
    }
    currentFields = [];
    currentField = "";
    fieldStartedWithQuote = false;
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          currentField += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else if (ch === "\r") {
        if (text[i + 1] === "\n") {
          currentField += "\r\n";
          i += 1;
        } else {
          currentField += "\r";
        }
        currentLine += 1;
      } else if (ch === "\n") {
        currentField += "\n";
        currentLine += 1;
      } else {
        currentField += ch;
      }
      continue;
    }

    if (ch === '"' && currentField === "" && !fieldStartedWithQuote) {
      inQuotes = true;
      fieldStartedWithQuote = true;
      continue;
    }

    if (ch === delimiter) {
      currentFields.push(currentField);
      currentField = "";
      fieldStartedWithQuote = false;
      continue;
    }

    if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") {
        i += 1;
      }
      pushCompletedRecord();
      currentLine += 1;
      recordStartLine = currentLine;
      continue;
    }

    currentField += ch;
  }

  if (inQuotes) {
    throw new CsvParseError(
      `Unterminated quoted CSV field starting on row ${recordStartLine}.`,
      recordStartLine,
    );
  }

  if (currentFields.length > 0 || currentField !== "") {
    pushCompletedRecord();
  }

  if (rawRows.length === 0) {
    throw new CsvParseError("CSV input contains no header row.");
  }

  const headerRow = rawRows[0]!;
  const headers = headerRow.values.map((h) => h.trim());
  const records = rawRows.slice(1);

  return { headers, records };
}

/**
 * Auto-detects the MTG scanner source format by header column signature.
 */
export function detectScannerFormat(headers: readonly string[]): ScannerFormat {
  const normalized = new Set(headers.map(normalizeHeaderKey));

  // 1. ManaBox
  if (
    normalized.has("manabox id") ||
    (normalized.has("scryfall id") &&
      normalized.has("set code") &&
      normalized.has("collector number") &&
      (normalized.has("misprint") ||
        normalized.has("altered") ||
        normalized.has("purchase price currency")))
  ) {
    return "manabox";
  }

  // 2. Delver Lens
  if (
    normalized.has("edition code") ||
    (normalized.has("edition") &&
      (normalized.has("collector's number") ||
        normalized.has("collector number")))
  ) {
    return "delver_lens";
  }

  // 3. Dragon Shield
  if (
    (normalized.has("folder name") && normalized.has("card name")) ||
    (normalized.has("trade quantity") &&
      normalized.has("card name") &&
      normalized.has("printing"))
  ) {
    return "dragon_shield";
  }

  // 4. TCGplayer App
  if (
    normalized.has("product id") &&
    (normalized.has("simple name") ||
      normalized.has("sku") ||
      (normalized.has("printing") && normalized.has("card number")))
  ) {
    return "tcgplayer_app";
  }

  throw new CsvParseError(
    `Unable to auto-detect scanner format from CSV headers: [${headers.join(", ")}]`,
    1,
  );
}

/**
 * Normalizes finish labels across ManaBox, Delver Lens, TCGplayer App, and Dragon Shield
 * into `'normal' | 'foil' | 'etched'`.
 */
export function normalizeFinish(
  rawFinish: string | null | undefined,
  rawConditionFallback?: string | null,
): CardFinish {
  const primary = (rawFinish ?? "").trim().toLowerCase();
  const secondary = (rawConditionFallback ?? "").trim().toLowerCase();

  for (const candidate of [primary, secondary]) {
    if (!candidate) continue;
    if (candidate.includes("etched")) {
      return "etched";
    }
    if (
      candidate === "nonfoil" ||
      candidate === "non-foil" ||
      candidate === "normal" ||
      candidate === "false" ||
      candidate === "0" ||
      candidate === "no"
    ) {
      continue;
    }
    if (
      candidate === "foil" ||
      candidate === "true" ||
      candidate === "yes" ||
      candidate === "1" ||
      candidate === "x" ||
      candidate.includes("foil")
    ) {
      return "foil";
    }
  }

  return "normal";
}

/**
 * Normalizes scanner condition strings into `'NM' | 'LP' | 'MP' | 'HP' | 'DMG'`.
 */
export function normalizeCondition(
  rawCondition: string | null | undefined,
): CardCondition {
  if (!rawCondition) {
    return "NM";
  }

  const stripped = rawCondition
    .trim()
    .toLowerCase()
    .replace(/\bfoil\s*etched\b/g, "")
    .replace(/\betched\b/g, "")
    .replace(/\bfoil\b/g, "")
    .trim();

  if (stripped === "") {
    return "NM";
  }

  const token = stripped.replace(/[\s_-]+/g, "");

  switch (token) {
    case "nm":
    case "nearmint":
    case "mint":
    case "m":
    case "nmint":
      return "NM";

    case "lp":
    case "lightlyplayed":
    case "lightplayed":
    case "slightlyplayed":
    case "sp":
    case "excellent":
    case "ex":
      return "LP";

    case "mp":
    case "moderatelyplayed":
    case "moderateplayed":
    case "played":
    case "pl":
    case "verygood":
    case "vg":
      return "MP";

    case "hp":
    case "heavilyplayed":
    case "heavyplayed":
    case "poor":
    case "pr":
    case "good":
    case "g":
      return "HP";

    case "dmg":
    case "damaged":
    case "damage":
    case "d":
      return "DMG";

    default:
      return "NM";
  }
}

/**
 * Maps full scanner language labels and ISO variants case-insensitively to
 * short `<= 16` character Scryfall ISO language codes (`lot_items.language`).
 */
export function normalizeLanguage(
  rawLanguage: string | null | undefined,
): string {
  if (!rawLanguage) {
    return "en";
  }

  const cleaned = rawLanguage
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

  if (cleaned === "") {
    return "en";
  }

  const mapped = LANGUAGE_LOOKUP[cleaned];
  if (mapped) {
    return mapped;
  }

  const unpunctuated = cleaned.replace(/[()[\]]/g, "").replace(/\s+/g, " ").trim();
  const mappedUnpunctuated = LANGUAGE_LOOKUP[unpunctuated];
  if (mappedUnpunctuated) {
    return mappedUnpunctuated;
  }

  return cleaned.replace(/[^a-z0-9_-]/g, "").slice(0, 16) || "en";
}

export function normalizeBooleanFlag(
  rawValue: string | null | undefined,
): boolean {
  if (!rawValue) {
    return false;
  }
  const normalized = rawValue.trim().toLowerCase();
  return (
    normalized === "true" ||
    normalized === "1" ||
    normalized === "yes" ||
    normalized === "y" ||
    normalized === "altered" ||
    normalized === "misprint" ||
    normalized === "x"
  );
}

export function normalizeScryfallId(
  rawId: string | null | undefined,
): string | null {
  if (!rawId) {
    return null;
  }
  const trimmed = rawId.trim().toLowerCase();
  return UUID_REGEX.test(trimmed) ? trimmed : null;
}

export function normalizeTcgplayerProductId(
  rawProductId: string | null | undefined,
): number | null {
  if (!rawProductId) {
    return null;
  }
  const trimmed = rawProductId.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function normalizeSetCode(
  rawSetCode: string | null | undefined,
): string | null {
  if (!rawSetCode) {
    return null;
  }
  let cleaned = rawSetCode.trim().toLowerCase();
  if (cleaned === "") {
    return null;
  }
  // Dragon Shield / Windows exports sometimes encode 'con' (Conflux) as 'con_'
  if (cleaned === "con_") {
    cleaned = "con";
  }
  return cleaned.slice(0, 16);
}

export function normalizeCollectorNumber(
  rawCollectorNumber: string | null | undefined,
): string | null {
  if (!rawCollectorNumber) {
    return null;
  }
  const cleaned = rawCollectorNumber.trim().replace(/^#/, "").trim();
  if (cleaned === "") {
    return null;
  }
  return cleaned.slice(0, 32);
}

function getColumnValue(
  rowMap: ReadonlyMap<string, string>,
  ...candidateNames: string[]
): string | undefined {
  for (const name of candidateNames) {
    const val = rowMap.get(name);
    if (val !== undefined) {
      return val;
    }
  }
  return undefined;
}

/**
 * Parses and normalizes a scanner CSV export (`ManaBox`, `Delver Lens`,
 * `TCGplayer App`, or `Dragon Shield`) into canonical `ParsedCsvRow` items.
 */
export function parseScannerCsv(
  csvInput: string,
  options: { format?: ScannerFormat } = {},
): ParseScannerCsvResult {
  const { headers, records } = parseCsvMatrix(csvInput);
  const format = options.format ?? detectScannerFormat(headers);
  const normalizedHeaders = headers.map(normalizeHeaderKey);

  const rows: ParsedCsvRow[] = [];
  const skippedRows: SkippedCsvRow[] = [];

  for (const record of records) {
    const rawRow: Record<string, string> = {};
    const normalizedRowMap = new Map<string, string>();

    for (let idx = 0; idx < headers.length; idx += 1) {
      const headerLabel = headers[idx]!;
      const normKey = normalizedHeaders[idx]!;
      const cellValue = (record.values[idx] ?? "").trim();
      rawRow[headerLabel] = cellValue;
      if (!normalizedRowMap.has(normKey)) {
        normalizedRowMap.set(normKey, cellValue);
      }
    }

    const rawQuantity =
      getColumnValue(normalizedRowMap, "quantity", "qty", "add to quantity") ??
      "";
    if (rawQuantity === "" || !/^-?\d+$/.test(rawQuantity)) {
      skippedRows.push({
        rowNumber: record.rowNumber,
        reason: "invalid_quantity",
        rawRow,
      });
      continue;
    }

    const quantity = Number.parseInt(rawQuantity, 10);
    if (quantity === 0) {
      skippedRows.push({
        rowNumber: record.rowNumber,
        reason: "zero_quantity",
        rawRow,
      });
      continue;
    }
    if (!Number.isSafeInteger(quantity) || quantity < 0) {
      skippedRows.push({
        rowNumber: record.rowNumber,
        reason: "invalid_quantity",
        rawRow,
      });
      continue;
    }

    let cardName: string | null = null;
    let scryfallId: string | null = null;
    let tcgplayerProductId: number | null = null;
    let setCode: string | null = null;
    let setName: string | null = null;
    let collectorNumber: string | null = null;
    let finish: CardFinish = "normal";
    let condition: CardCondition = "NM";
    let language = "en";
    let isAltered = false;
    let isMisprint = false;

    if (format === "manabox") {
      cardName = getColumnValue(normalizedRowMap, "name") || null;
      scryfallId = normalizeScryfallId(
        getColumnValue(normalizedRowMap, "scryfall id"),
      );
      setCode = normalizeSetCode(getColumnValue(normalizedRowMap, "set code"));
      setName = getColumnValue(normalizedRowMap, "set name") || null;
      collectorNumber = normalizeCollectorNumber(
        getColumnValue(normalizedRowMap, "collector number"),
      );
      const rawCondition = getColumnValue(normalizedRowMap, "condition");
      finish = normalizeFinish(
        getColumnValue(normalizedRowMap, "foil"),
        rawCondition,
      );
      condition = normalizeCondition(rawCondition);
      language = normalizeLanguage(
        getColumnValue(normalizedRowMap, "language"),
      );
      isAltered = normalizeBooleanFlag(
        getColumnValue(normalizedRowMap, "altered"),
      );
      isMisprint = normalizeBooleanFlag(
        getColumnValue(normalizedRowMap, "misprint"),
      );
    } else if (format === "delver_lens") {
      cardName = getColumnValue(normalizedRowMap, "name") || null;
      scryfallId = normalizeScryfallId(
        getColumnValue(normalizedRowMap, "scryfall id"),
      );
      setCode = normalizeSetCode(
        getColumnValue(normalizedRowMap, "edition code", "set code"),
      );
      setName = getColumnValue(normalizedRowMap, "edition", "set name") || null;
      collectorNumber = normalizeCollectorNumber(
        getColumnValue(
          normalizedRowMap,
          "collector's number",
          "collector number",
        ),
      );
      const rawCondition = getColumnValue(normalizedRowMap, "condition");
      finish = normalizeFinish(
        getColumnValue(normalizedRowMap, "foil"),
        rawCondition,
      );
      condition = normalizeCondition(rawCondition);
      language = normalizeLanguage(
        getColumnValue(normalizedRowMap, "language"),
      );
      isAltered = normalizeBooleanFlag(
        getColumnValue(normalizedRowMap, "altered", "alter"),
      );
      isMisprint = normalizeBooleanFlag(
        getColumnValue(normalizedRowMap, "misprint"),
      );
    } else if (format === "tcgplayer_app") {
      cardName =
        getColumnValue(normalizedRowMap, "simple name", "name") || null;
      scryfallId = normalizeScryfallId(
        getColumnValue(normalizedRowMap, "scryfall id"),
      );
      tcgplayerProductId = normalizeTcgplayerProductId(
        getColumnValue(normalizedRowMap, "product id"),
      );
      setCode = normalizeSetCode(getColumnValue(normalizedRowMap, "set code"));
      setName = getColumnValue(normalizedRowMap, "set", "set name") || null;
      collectorNumber = normalizeCollectorNumber(
        getColumnValue(normalizedRowMap, "card number", "collector number"),
      );
      const rawPrinting = getColumnValue(normalizedRowMap, "printing");
      const rawCondition = getColumnValue(normalizedRowMap, "condition");
      finish = normalizeFinish(rawPrinting, rawCondition);
      condition = normalizeCondition(rawCondition);
      language = normalizeLanguage(
        getColumnValue(normalizedRowMap, "language"),
      );
      isAltered = normalizeBooleanFlag(
        getColumnValue(normalizedRowMap, "altered"),
      );
      isMisprint = normalizeBooleanFlag(
        getColumnValue(normalizedRowMap, "misprint"),
      );
    } else {
      // dragon_shield
      cardName =
        getColumnValue(normalizedRowMap, "card name", "name") || null;
      scryfallId = normalizeScryfallId(
        getColumnValue(normalizedRowMap, "scryfall id"),
      );
      tcgplayerProductId = normalizeTcgplayerProductId(
        getColumnValue(normalizedRowMap, "product id"),
      );
      setCode = normalizeSetCode(getColumnValue(normalizedRowMap, "set code"));
      setName = getColumnValue(normalizedRowMap, "set name") || null;
      collectorNumber = normalizeCollectorNumber(
        getColumnValue(normalizedRowMap, "card number", "collector number"),
      );
      const rawPrinting = getColumnValue(normalizedRowMap, "printing");
      const rawCondition = getColumnValue(normalizedRowMap, "condition");
      finish = normalizeFinish(rawPrinting, rawCondition);
      condition = normalizeCondition(rawCondition);
      language = normalizeLanguage(
        getColumnValue(normalizedRowMap, "language"),
      );
      isAltered = normalizeBooleanFlag(
        getColumnValue(normalizedRowMap, "altered"),
      );
      isMisprint = normalizeBooleanFlag(
        getColumnValue(normalizedRowMap, "misprint"),
      );
    }

    rows.push({
      rowNumber: record.rowNumber,
      format,
      cardName,
      scryfallId,
      tcgplayerProductId,
      setCode,
      setName,
      collectorNumber,
      finish,
      condition,
      language,
      isAltered,
      isMisprint,
      quantity,
      rawRow,
    });
  }

  return {
    format,
    headers,
    rows,
    skippedRows,
  };
}
