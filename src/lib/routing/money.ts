export interface RationalCents {
  readonly num: bigint;
  readonly den: bigint;
}

const DECIMAL_PATTERN = /^[+-]?(?:\d+\.?\d*|\.\d+)$/;

function absBigInt(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function gcdBigInt(a: bigint, b: bigint): bigint {
  let x = absBigInt(a);
  let y = absBigInt(b);
  while (y !== 0n) {
    const remainder = x % y;
    x = y;
    y = remainder;
  }
  return x === 0n ? 1n : x;
}

export function makeRational(num: bigint, den: bigint = 1n): RationalCents {
  if (den === 0n) {
    throw new RangeError("Rational denominator cannot be zero.");
  }
  if (num === 0n) {
    return { num: 0n, den: 1n };
  }
  const sign = den < 0n ? -1n : 1n;
  const normalizedNum = num * sign;
  const normalizedDen = den * sign;
  const divisor = gcdBigInt(normalizedNum, normalizedDen);
  return {
    num: normalizedNum / divisor,
    den: normalizedDen / divisor,
  };
}

export function rationalFromCents(cents: bigint): RationalCents {
  return { num: cents, den: 1n };
}

export function addRational(a: RationalCents, b: RationalCents): RationalCents {
  return makeRational(a.num * b.den + b.num * a.den, a.den * b.den);
}

export function subRational(a: RationalCents, b: RationalCents): RationalCents {
  return makeRational(a.num * b.den - b.num * a.den, a.den * b.den);
}

export function mulRational(a: RationalCents, b: RationalCents): RationalCents {
  return makeRational(a.num * b.num, a.den * b.den);
}

export function compareRational(a: RationalCents, b: RationalCents): -1 | 0 | 1 {
  const lhs = a.num * b.den;
  const rhs = b.num * a.den;
  if (lhs < rhs) return -1;
  if (lhs > rhs) return 1;
  return 0;
}

export function minRational(a: RationalCents, b: RationalCents): RationalCents {
  return compareRational(a, b) <= 0 ? a : b;
}

export function maxRational(a: RationalCents, b: RationalCents): RationalCents {
  return compareRational(a, b) >= 0 ? a : b;
}

export function divRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) {
    throw new RangeError("Division denominator cannot be zero.");
  }
  if (numerator === 0n) {
    return 0n;
  }
  const negative = (numerator < 0n) !== (denominator < 0n);
  const absNum = absBigInt(numerator);
  const absDen = absBigInt(denominator);
  const rounded = (absNum * 2n + absDen) / (2n * absDen);
  return negative ? -rounded : rounded;
}

export function roundRationalToCents(value: RationalCents): bigint {
  return divRoundHalfUp(value.num, value.den);
}

export function mulCentsByRatioHalfUp(
  cents: bigint,
  numerator: bigint,
  denominator: bigint,
): bigint {
  return divRoundHalfUp(cents * numerator, denominator);
}

export function maxCents(...values: [bigint, ...bigint[]]): bigint {
  let best = values[0];
  for (let i = 1; i < values.length; i += 1) {
    const current = values[i]!;
    if (current > best) {
      best = current;
    }
  }
  return best;
}

export function minCents(...values: [bigint, ...bigint[]]): bigint {
  let best = values[0];
  for (let i = 1; i < values.length; i += 1) {
    const current = values[i]!;
    if (current < best) {
      best = current;
    }
  }
  return best;
}

/**
 * Parses a USD decimal string (e.g. "12.34", "$1,234.5", "-0.85") into exact
 * integer cents using string digit arithmetic and half-up rounding—never floats.
 */
export function parseUsdToCents(
  raw: string | null | undefined,
): bigint | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  let trimmed = raw.trim();
  if (trimmed === "") {
    return null;
  }

  let signPrefix = "";
  if (trimmed.startsWith("-") || trimmed.startsWith("+")) {
    signPrefix = trimmed[0]!;
    trimmed = trimmed.slice(1).trim();
  }
  if (trimmed.startsWith("$")) {
    trimmed = trimmed.slice(1).trim();
  }
  if (trimmed.startsWith("-") || trimmed.startsWith("+")) {
    if (signPrefix !== "") {
      throw new SyntaxError(`Invalid USD decimal string: "${raw}"`);
    }
    signPrefix = trimmed[0]!;
    trimmed = trimmed.slice(1).trim();
  }

  const strippedDigits = trimmed.replace(/,/g, "");
  if (strippedDigits === "") {
    throw new SyntaxError(`Invalid USD decimal string: "${raw}"`);
  }
  const cleaned = `${signPrefix}${strippedDigits}`;
  if (!DECIMAL_PATTERN.test(cleaned)) {
    throw new SyntaxError(`Invalid USD decimal string: "${raw}"`);
  }

  let body = cleaned;
  let negative = false;
  if (body.startsWith("-")) {
    negative = true;
    body = body.slice(1);
  } else if (body.startsWith("+")) {
    body = body.slice(1);
  }

  const [wholeRaw = "0", fracRaw = ""] = body.split(".");
  const wholeDigits = wholeRaw === "" ? "0" : wholeRaw;
  const twoFracDigits = `${fracRaw}00`.slice(0, 2);

  let cents = BigInt(wholeDigits) * 100n + BigInt(twoFracDigits);
  if (fracRaw.length > 2 && fracRaw.charCodeAt(2) >= 53) {
    cents += 1n;
  }

  if (cents === 0n) {
    return 0n;
  }
  return negative ? -cents : cents;
}

export function parseRequiredUsdToCents(
  raw: string,
  fieldName = "amount",
): bigint {
  const parsed = parseUsdToCents(raw);
  if (parsed === null) {
    throw new SyntaxError(`Missing required USD value for ${fieldName}.`);
  }
  return parsed;
}

export function coalesceUsdToCents(
  ...values: Array<string | null | undefined>
): bigint | null {
  for (const candidate of values) {
    const parsed = parseUsdToCents(candidate);
    if (parsed !== null) {
      return parsed;
    }
  }
  return null;
}

export function coalescePositiveUsdToCents(
  ...values: Array<string | null | undefined>
): bigint | null {
  for (const candidate of values) {
    const parsed = parseUsdToCents(candidate);
    if (parsed !== null && parsed > 0n) {
      return parsed;
    }
  }
  return null;
}

export function formatCentsToUsd(cents: bigint): string {
  const negative = cents < 0n;
  const abs = absBigInt(cents);
  const dollars = abs / 100n;
  const remainder = (abs % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${dollars.toString()}.${remainder}`;
}

export function formatBasisPointsToPercent(bps: bigint): string {
  return formatCentsToUsd(bps);
}

export interface CostBasisItemWeight {
  readonly quantity: number;
  readonly unitFmvCents: bigint;
}

export interface AllocatedItemCostBasis {
  /** Per-copy cost basis (`roundHalfUp(totalCostBasisCents / quantity)`). */
  readonly unitCostBasisCents: bigint;
  /** Line-item Schedule C cost basis (`lot_items.allocated_cost_basis_usd`), summing cent-exact to `purchaseCostCents`. */
  readonly totalCostBasisCents: bigint;
}

function allocateHamiltonRowTotals(
  totalPoolCents: bigint,
  rowWeights: readonly bigint[],
  totalWeight: bigint,
): bigint[] {
  const allocations = new Array<bigint>(rowWeights.length).fill(0n);
  const remainders: Array<{
    index: number;
    remainder: bigint;
    weight: bigint;
  }> = [];

  let allocatedSum = 0n;
  for (let i = 0; i < rowWeights.length; i += 1) {
    const weight = rowWeights[i]!;
    if (weight <= 0n) {
      continue;
    }
    const numerator = totalPoolCents * weight;
    const floorShare = numerator / totalWeight;
    const remainder = numerator % totalWeight;
    allocations[i] = floorShare;
    allocatedSum += floorShare;
    remainders.push({ index: i, remainder, weight });
  }

  const missingCents = totalPoolCents - allocatedSum;
  remainders.sort((a, b) => {
    if (a.remainder !== b.remainder) {
      return a.remainder > b.remainder ? -1 : 1;
    }
    if (a.weight !== b.weight) {
      return a.weight > b.weight ? -1 : 1;
    }
    return a.index - b.index;
  });

  for (let k = 0; BigInt(k) < missingCents && k < remainders.length; k += 1) {
    const target = remainders[k]!;
    allocations[target.index] = allocations[target.index]! + 1n;
  }

  return allocations;
}

/**
 * Splits a line item's allocated Schedule C cost basis across a partial sale
 * (`soldQuantity` out of `totalQuantity`), preserving cent-exact reconciliation
 * (`soldCostBasisCents + remainingCostBasisCents === rowCostBasisCents`).
 */
export function splitAllocatedCostBasis(
  rowCostBasisCents: bigint,
  totalQuantity: number,
  soldQuantity: number,
): {
  readonly soldCostBasisCents: bigint;
  readonly remainingCostBasisCents: bigint;
} {
  if (rowCostBasisCents < 0n) {
    throw new RangeError("rowCostBasisCents cannot be negative.");
  }
  if (!Number.isInteger(totalQuantity) || totalQuantity <= 0) {
    throw new RangeError(
      `totalQuantity must be a positive integer (got ${totalQuantity}).`,
    );
  }
  if (
    !Number.isInteger(soldQuantity) ||
    soldQuantity < 0 ||
    soldQuantity > totalQuantity
  ) {
    throw new RangeError(
      `soldQuantity must be an integer between 0 and ${totalQuantity} (got ${soldQuantity}).`,
    );
  }
  if (soldQuantity === 0 || rowCostBasisCents === 0n) {
    return { soldCostBasisCents: 0n, remainingCostBasisCents: rowCostBasisCents };
  }
  if (soldQuantity === totalQuantity) {
    return { soldCostBasisCents: rowCostBasisCents, remainingCostBasisCents: 0n };
  }
  const soldCostBasisCents = divRoundHalfUp(
    rowCostBasisCents * BigInt(soldQuantity),
    BigInt(totalQuantity),
  );
  return {
    soldCostBasisCents,
    remainingCostBasisCents: rowCostBasisCents - soldCostBasisCents,
  };
}

/**
 * Computes proportional IRS Schedule C Fair Market Value cost basis per line item
 * (`SPEC.md` §4.D):
 *
 * - `totalCostBasisCents` allocates `C_lot * (q_i * V_i / V_total)` via the
 *   Largest-Remainder (Hamilton) method so persisted `lot_items.allocated_cost_basis_usd`
 *   always sums cent-for-cent to `purchaseCostCents` whenever `V_total > 0`,
 *   regardless of multi-copy quantities (`q_i > 1`).
 * - `unitCostBasisCents` provides the half-up per-copy cost basis
 *   (`roundHalfUp(totalCostBasisCents / q_i)`).
 */
export function allocateScheduleCCostBasis(
  purchaseCostCents: bigint,
  items: readonly CostBasisItemWeight[],
): AllocatedItemCostBasis[] {
  if (purchaseCostCents < 0n) {
    throw new RangeError("Lot purchaseCostUsd cannot be negative.");
  }
  if (items.length === 0) {
    return [];
  }

  const rowWeights: bigint[] = [];
  let totalFmvCents = 0n;

  for (const item of items) {
    if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
      throw new RangeError(
        `Lot item quantity must be a positive integer (got ${item.quantity}).`,
      );
    }
    const unitFmv = item.unitFmvCents > 0n ? item.unitFmvCents : 0n;
    const rowFmv = BigInt(item.quantity) * unitFmv;
    rowWeights.push(rowFmv);
    totalFmvCents += rowFmv;
  }

  if (purchaseCostCents === 0n || totalFmvCents === 0n) {
    return items.map(() => ({
      unitCostBasisCents: 0n,
      totalCostBasisCents: 0n,
    }));
  }

  const hamiltonRowTotals = allocateHamiltonRowTotals(
    purchaseCostCents,
    rowWeights,
    totalFmvCents,
  );

  return items.map((item, idx) => {
    const rowTotalCents = hamiltonRowTotals[idx]!;
    const unitBasisCents =
      rowTotalCents > 0n
        ? divRoundHalfUp(rowTotalCents, BigInt(item.quantity))
        : 0n;
    return {
      unitCostBasisCents: unitBasisCents,
      totalCostBasisCents: rowTotalCents,
    };
  });
}
