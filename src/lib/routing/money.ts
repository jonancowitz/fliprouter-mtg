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
  const cleaned = raw.trim().replace(/^\$/, "").replace(/,/g, "").trim();
  if (cleaned === "") {
    return null;
  }
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
  readonly unitCostBasisCents: bigint;
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

  const missingCents = Number(totalPoolCents - allocatedSum);
  remainders.sort((a, b) => {
    if (a.remainder !== b.remainder) {
      return a.remainder > b.remainder ? -1 : 1;
    }
    if (a.weight !== b.weight) {
      return a.weight > b.weight ? -1 : 1;
    }
    return a.index - b.index;
  });

  for (let k = 0; k < missingCents && k < remainders.length; k += 1) {
    const target = remainders[k]!;
    allocations[target.index] = allocations[target.index]! + 1n;
  }

  return allocations;
}

/**
 * Finds a subset of positive-FMV item indices (prioritizing largest fractional
 * unit remainders) whose quantities sum exactly to `targetCents` so that
 * `SUM(quantity_i * unitCostBasisCents_i) === purchaseCostCents` whenever
 * integer-unit cent reconciliation is mathematically possible.
 */
function findExactUnitRemainderSubset(
  candidates: ReadonlyArray<{ index: number; quantity: number }>,
  targetCents: number,
): Set<number> | null {
  if (targetCents === 0) {
    return new Set();
  }
  if (targetCents < 0 || targetCents > 4000) {
    return null;
  }

  // Fast path when all candidate quantities are 1
  if (candidates.every((c) => c.quantity === 1)) {
    if (candidates.length < targetCents) {
      return null;
    }
    return new Set(candidates.slice(0, targetCents).map((c) => c.index));
  }

  const prevSum = new Int32Array(targetCents + 1).fill(-1);
  const pickedCandidatePos = new Int32Array(targetCents + 1).fill(-1);
  prevSum[0] = 0;

  for (let pos = 0; pos < candidates.length; pos += 1) {
    const qty = candidates[pos]!.quantity;
    if (qty <= 0 || qty > targetCents) {
      continue;
    }
    for (let s = targetCents; s >= qty; s -= 1) {
      if (prevSum[s] === -1 && prevSum[s - qty] !== -1) {
        prevSum[s] = s - qty;
        pickedCandidatePos[s] = pos;
      }
    }
    if (prevSum[targetCents] !== -1) {
      break;
    }
  }

  if (prevSum[targetCents] === -1) {
    return null;
  }

  const chosen = new Set<number>();
  let cursor = targetCents;
  while (cursor > 0) {
    const pos = pickedCandidatePos[cursor]!;
    chosen.add(candidates[pos]!.index);
    cursor = prevSum[cursor]!;
  }
  return chosen;
}

/**
 * Computes proportional IRS Schedule C Fair Market Value cost basis per item.
 *
 * - `totalCostBasisCents` always sums cent-for-cent to `purchaseCostCents`
 *   whenever total lot FMV > 0.
 * - `unitCostBasisCents` implements `C_lot * (V_i / V_total)` (`SPEC.md` §4.D)
 *   and reconciles `SUM(q_i * unitCostBasisCents_i) === purchaseCostCents`
 *   whenever integer-quantity cent division permits (including all `q_i = 1`
 *   and mixed-quantity lots with unit-resolvable remainders).
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

  const unitFloors = new Array<bigint>(items.length).fill(0n);
  const unitCandidates: Array<{
    index: number;
    quantity: number;
    remainder: bigint;
    unitFmv: bigint;
  }> = [];

  let floorWeightedUnitSum = 0n;
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i]!;
    const unitFmv = item.unitFmvCents > 0n ? item.unitFmvCents : 0n;
    if (unitFmv === 0n) {
      continue;
    }
    const numerator = purchaseCostCents * unitFmv;
    const unitFloor = numerator / totalFmvCents;
    const unitRemainder = numerator % totalFmvCents;
    unitFloors[i] = unitFloor;
    floorWeightedUnitSum += BigInt(item.quantity) * unitFloor;
    unitCandidates.push({
      index: i,
      quantity: item.quantity,
      remainder: unitRemainder,
      unitFmv,
    });
  }

  unitCandidates.sort((a, b) => {
    if (a.remainder !== b.remainder) {
      return a.remainder > b.remainder ? -1 : 1;
    }
    if (a.unitFmv !== b.unitFmv) {
      return a.unitFmv > b.unitFmv ? -1 : 1;
    }
    if (a.quantity !== b.quantity) {
      return a.quantity - b.quantity;
    }
    return a.index - b.index;
  });

  const missingUnitWeightedCents = purchaseCostCents - floorWeightedUnitSum;
  const exactSubset =
    missingUnitWeightedCents >= 0n &&
    missingUnitWeightedCents <= BigInt(Number.MAX_SAFE_INTEGER)
      ? findExactUnitRemainderSubset(
          unitCandidates,
          Number(missingUnitWeightedCents),
        )
      : null;

  if (exactSubset !== null) {
    return items.map((item, idx) => {
      const unitBasis = unitFloors[idx]! + (exactSubset.has(idx) ? 1n : 0n);
      return {
        unitCostBasisCents: unitBasis,
        totalCostBasisCents: BigInt(item.quantity) * unitBasis,
      };
    });
  }

  // Fallback when all positive-FMV quantities share a GCD that does not divide
  // `purchaseCostCents` (e.g. a single 3x row on a $10.00 lot): compute exact
  // half-up unit basis per SPEC.md §4.D and exact Hamilton row totals summing
  // to `purchaseCostCents`.
  const hamiltonRowTotals = allocateHamiltonRowTotals(
    purchaseCostCents,
    rowWeights,
    totalFmvCents,
  );

  return items.map((item, idx) => {
    const unitFmv = item.unitFmvCents > 0n ? item.unitFmvCents : 0n;
    const unitBasis =
      unitFmv > 0n
        ? divRoundHalfUp(purchaseCostCents * unitFmv, totalFmvCents)
        : 0n;
    return {
      unitCostBasisCents: unitBasis,
      totalCostBasisCents: hamiltonRowTotals[idx]!,
    };
  });
}
