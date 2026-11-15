"use client";

import {
  RotateCcw,
  Save,
  Sliders,
  Sparkles,
  Truck,
  Zap,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { ConduitTierPreference } from "@/db/schema";
import {
  type BuylistCashSelectionMode,
  DEFAULT_ROUTING_PROFILE,
  divRoundHalfUp,
  formatCentsToUsd,
  parseUsdToCents,
} from "@/lib/routing";
import type { SerializedRoutingProfile } from "@/lib/triage/types";
import { cn } from "@/lib/utils";
import { formatUsdDisplay } from "./formatters";

interface RoutingProfileControlsProps {
  profile: SerializedRoutingProfile;
  buylistCashMode: BuylistCashSelectionMode;
  computedLaborPerOrderUsd: string;
  isSavingProfile: boolean;
  onChangeProfile: (patch: Partial<SerializedRoutingProfile>) => void;
  onChangeBuylistCashMode: (mode: BuylistCashSelectionMode) => void;
  onResetDefaults: () => void;
  onSaveProfileDefault: () => Promise<void>;
}

function parseCentsClamped(
  usd: string,
  fallbackCents: bigint,
  minCents: bigint,
  maxCents: bigint,
): number {
  try {
    const parsed = parseUsdToCents(usd);
    const cents = parsed === null ? fallbackCents : parsed;
    if (cents < minCents) return Number(minCents);
    if (cents > maxCents) return Number(maxCents);
    return Number(cents);
  } catch {
    return Number(fallbackCents);
  }
}

function formatSecondsAsMinutesTenths(seconds: number): string {
  const tenths = divRoundHalfUp(BigInt(Math.max(0, seconds)) * 10n, 60n);
  const whole = tenths / 10n;
  const frac = tenths % 10n;
  return `${whole.toString()}.${frac.toString()}`;
}

export function RoutingProfileControls({
  profile,
  buylistCashMode,
  computedLaborPerOrderUsd,
  isSavingProfile,
  onChangeProfile,
  onChangeBuylistCashMode,
  onResetDefaults,
  onSaveProfileDefault,
}: RoutingProfileControlsProps): React.ReactElement {
  const hourlyRateCents = parseCentsClamped(
    profile.hourlyLaborRateUsd,
    2000n,
    0n,
    6000n,
  );
  const minGainCents = parseCentsClamped(
    profile.minSingleNetGainOverBuylistUsd,
    125n,
    0n,
    500n,
  );
  const boxShippingCents = parseCentsClamped(
    profile.outboundBuylistBoxShippingUsd,
    1200n,
    0n,
    2500n,
  );

  // Local draft strings for text/decimal postage inputs so Backspace / partial decimals never snap mid-edit
  const [pweDraft, setPweDraft] = useState(profile.pweShippingCostUsd);
  const [trackedDraft, setTrackedDraft] = useState(
    profile.trackedShippingCostUsd,
  );
  const [thresholdDraft, setThresholdDraft] = useState(
    profile.trackedThresholdUsd,
  );

  useEffect(() => {
    setPweDraft(profile.pweShippingCostUsd);
  }, [profile.pweShippingCostUsd]);

  useEffect(() => {
    setTrackedDraft(profile.trackedShippingCostUsd);
  }, [profile.trackedShippingCostUsd]);

  useEffect(() => {
    setThresholdDraft(profile.trackedThresholdUsd);
  }, [profile.trackedThresholdUsd]);

  const commitPostageField = (
    raw: string,
    fallbackUsd: string,
    maxCents: bigint,
    field:
      | "pweShippingCostUsd"
      | "trackedShippingCostUsd"
      | "trackedThresholdUsd",
    setDraft: (next: string) => void,
  ) => {
    try {
      const parsed = parseUsdToCents(raw);
      if (parsed === null || parsed < 0n) {
        setDraft(fallbackUsd);
        onChangeProfile({ [field]: fallbackUsd });
        return;
      }
      const clamped = parsed > maxCents ? maxCents : parsed;
      const formatted = formatCentsToUsd(clamped);
      setDraft(formatted);
      onChangeProfile({ [field]: formatted });
    } catch {
      setDraft(fallbackUsd);
      onChangeProfile({ [field]: fallbackUsd });
    }
  };

  const handleLivePostageChange = (
    raw: string,
    maxCents: bigint,
    field:
      | "pweShippingCostUsd"
      | "trackedShippingCostUsd"
      | "trackedThresholdUsd",
    setDraft: (next: string) => void,
  ) => {
    setDraft(raw);
    if (raw.trim() === "") return;
    try {
      const parsed = parseUsdToCents(raw);
      if (parsed !== null && parsed >= 0n) {
        const clamped = parsed > maxCents ? maxCents : parsed;
        onChangeProfile({ [field]: formatCentsToUsd(clamped) });
      }
    } catch {
      // Wait for blur or valid numeric continuation
    }
  };

  return (
    <aside className="flex flex-col gap-4 rounded-2xl border border-slate-800/90 bg-slate-900/75 p-4 shadow-lg">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 border-b border-slate-800 pb-3">
        <div className="flex items-center gap-2">
          <Sliders className="h-4 w-4 text-emerald-400" />
          <div>
            <h2 className="text-sm font-semibold text-slate-100">
              Live Routing Controls
            </h2>
            <p className="text-[11px] text-slate-400">
              Zero API re-bills · Instant <code className="font-mono">bigint</code>{" "}
              re-triage
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onResetDefaults}
          className="inline-flex items-center gap-1 rounded-md border border-slate-800 bg-slate-950 px-2 py-1 text-[11px] text-slate-400 hover:border-slate-700 hover:text-slate-200"
          title="Reset sliders to SPEC defaults"
        >
          <RotateCcw className="h-3 w-3" />
          Reset
        </button>
      </div>

      {/* Store Credit Arbitrage Toggle (Hero Control) */}
      <div
        className={cn(
          "rounded-xl border p-3.5 transition",
          profile.enableCreditArbitrage
            ? "border-violet-500/50 bg-violet-500/10"
            : "border-slate-800 bg-slate-950/70",
        )}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Sparkles
              className={cn(
                "h-4 w-4",
                profile.enableCreditArbitrage
                  ? "text-violet-300"
                  : "text-slate-400",
              )}
            />
            <div>
              <span className="text-xs font-semibold text-slate-100">
                Store Credit Arbitrage (Pile 3)
              </span>
              <p className="text-[11px] text-slate-400">
                CK +30% Credit &times; 0.82 ={" "}
                <span className="font-mono text-violet-300">1.066&times;</span>{" "}
                cash up-trade
              </p>
            </div>
          </div>

          <button
            type="button"
            role="switch"
            aria-checked={profile.enableCreditArbitrage}
            aria-label="Enable Store Credit Arbitrage"
            onClick={() =>
              onChangeProfile({
                enableCreditArbitrage: !profile.enableCreditArbitrage,
              })
            }
            className={cn(
              "relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors",
              profile.enableCreditArbitrage ? "bg-violet-500" : "bg-slate-700",
            )}
          >
            <span
              className={cn(
                "inline-block h-4 w-4 transform rounded-full bg-white transition-transform",
                profile.enableCreditArbitrage
                  ? "translate-x-6"
                  : "translate-x-1",
              )}
            />
          </button>
        </div>
      </div>

      {/* Labor Cost Controls */}
      <div className="space-y-3 rounded-xl border border-slate-800/80 bg-slate-950/50 p-3.5">
        <div className="flex items-center justify-between text-xs">
          <span className="font-medium text-slate-300">
            Packing Labor Value
          </span>
          <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 font-mono text-[11px] text-emerald-300">
            {formatUsdDisplay(computedLaborPerOrderUsd)} / single order
          </span>
        </div>

        {/* Hourly Labor Rate (cents: 0..6000 step 100) */}
        <div>
          <div className="mb-1 flex items-center justify-between text-xs">
            <label htmlFor="slider-hourly-labor" className="text-slate-400">
              Hourly Packing Rate
            </label>
            <span className="font-mono font-semibold text-slate-100">
              ${profile.hourlyLaborRateUsd}/hr
            </span>
          </div>
          <input
            id="slider-hourly-labor"
            type="range"
            min={0}
            max={6000}
            step={100}
            value={hourlyRateCents}
            onChange={(e) =>
              onChangeProfile({
                hourlyLaborRateUsd: formatCentsToUsd(BigInt(e.target.value)),
              })
            }
            className="fliprouter-slider w-full"
          />
          <div className="mt-0.5 flex justify-between font-mono text-[10px] text-slate-500">
            <span>$0/hr</span>
            <span>$20 default</span>
            <span>$60/hr</span>
          </div>
        </div>

        {/* Seconds per Single Order */}
        <div>
          <div className="mb-1 flex items-center justify-between text-xs">
            <label htmlFor="slider-seconds-order" className="text-slate-400">
              Pick / Pack / Ship Time
            </label>
            <span className="font-mono font-semibold text-slate-100">
              {profile.secondsPerSingleOrder}s (
              {formatSecondsAsMinutesTenths(profile.secondsPerSingleOrder)}m)
            </span>
          </div>
          <input
            id="slider-seconds-order"
            type="range"
            min={30}
            max={360}
            step={15}
            value={profile.secondsPerSingleOrder}
            onChange={(e) =>
              onChangeProfile({
                secondsPerSingleOrder: Number.parseInt(e.target.value, 10),
              })
            }
            className="fliprouter-slider w-full"
          />
          <div className="mt-0.5 flex justify-between font-mono text-[10px] text-slate-500">
            <span>30s</span>
            <span>180s (3m)</span>
            <span>360s</span>
          </div>
        </div>
      </div>

      {/* Buylist Hurdle & Box Postage Controls */}
      <div className="space-y-3 rounded-xl border border-slate-800/80 bg-slate-950/50 p-3.5">
        <div className="flex items-center gap-1.5 text-xs font-medium text-slate-300">
          <Zap className="h-3.5 w-3.5 text-amber-400" />
          <span>Buylist Hurdle &amp; Box Postage</span>
        </div>

        {/* Min Single Net Gain Over Buylist (cents: 0..500 step 5) */}
        <div>
          <div className="mb-1 flex items-center justify-between text-xs">
            <label htmlFor="slider-min-gain" className="text-slate-400">
              Min Single Gain Over Buylist (&tau;)
            </label>
            <span className="font-mono font-semibold text-emerald-300">
              +${profile.minSingleNetGainOverBuylistUsd}
            </span>
          </div>
          <input
            id="slider-min-gain"
            type="range"
            min={0}
            max={500}
            step={5}
            value={minGainCents}
            onChange={(e) =>
              onChangeProfile({
                minSingleNetGainOverBuylistUsd: formatCentsToUsd(
                  BigInt(e.target.value),
                ),
              })
            }
            className="fliprouter-slider w-full"
          />
          <div className="mt-0.5 flex justify-between font-mono text-[10px] text-slate-500">
            <span>$0.00</span>
            <span>$1.25 default</span>
            <span>$5.00</span>
          </div>
        </div>

        {/* Outbound Buylist Box Shipping (cents: 0..2500 step 50) */}
        <div>
          <div className="mb-1 flex items-center justify-between text-xs">
            <label htmlFor="slider-box-shipping" className="text-slate-400">
              Outbound Buylist Box Postage
            </label>
            <span className="font-mono font-semibold text-slate-100">
              ${profile.outboundBuylistBoxShippingUsd}/box
            </span>
          </div>
          <input
            id="slider-box-shipping"
            type="range"
            min={0}
            max={2500}
            step={50}
            value={boxShippingCents}
            onChange={(e) =>
              onChangeProfile({
                outboundBuylistBoxShippingUsd: formatCentsToUsd(
                  BigInt(e.target.value),
                ),
              })
            }
            className="fliprouter-slider w-full"
          />
          <div className="mt-0.5 flex justify-between font-mono text-[10px] text-slate-500">
            <span>$0</span>
            <span>$12.00 USPS/UPS</span>
            <span>$25</span>
          </div>
        </div>

        {/* Card Conduit Tier Selector */}
        <div className="pt-1">
          <div className="mb-1.5 flex items-center justify-between text-xs">
            <span className="text-slate-400">Card Conduit Service Tier</span>
            <span className="font-mono text-[11px] text-teal-300">
              {profile.conduitTierPreference === "sorted"
                ? "2% fee · ≤500/batch"
                : profile.conduitTierPreference === "curated"
                  ? "5% fee · ≥90% ≥$0.50"
                  : "10% + $0.03/card"}
            </span>
          </div>
          <div className="grid grid-cols-3 gap-1 rounded-lg border border-slate-800 bg-slate-900 p-1">
            {(["sorted", "curated", "standard"] as ConduitTierPreference[]).map(
              (tier) => (
                <button
                  key={tier}
                  type="button"
                  onClick={() =>
                    onChangeProfile({ conduitTierPreference: tier })
                  }
                  className={cn(
                    "rounded-md py-1 text-xs font-medium capitalize transition",
                    profile.conduitTierPreference === tier
                      ? "bg-teal-500/20 text-teal-200 border border-teal-500/40"
                      : "text-slate-400 hover:text-slate-200",
                  )}
                >
                  {tier}
                </button>
              ),
            )}
          </div>
        </div>

        {/* Wholesale Cash Vendor Mode */}
        <div>
          <div className="mb-1.5 flex items-center justify-between text-xs">
            <span className="text-slate-400">Pile 1 Cash Destination</span>
          </div>
          <div className="grid grid-cols-3 gap-1 rounded-lg border border-slate-800 bg-slate-900 p-1">
            {(
              [
                { value: "best", label: "Auto Best" },
                { value: "ck_direct", label: "CK Cash" },
                { value: "conduit", label: "Conduit" },
              ] as const
            ).map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => onChangeBuylistCashMode(opt.value)}
                className={cn(
                  "rounded-md py-1 text-[11px] font-medium transition",
                  buylistCashMode === opt.value
                    ? "bg-emerald-500/20 text-emerald-200 border border-emerald-500/40"
                    : "text-slate-400 hover:text-slate-200",
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Singles Postage & Tracked Threshold */}
      <div className="space-y-2.5 rounded-xl border border-slate-800/80 bg-slate-950/50 p-3.5">
        <div className="flex items-center gap-1.5 text-xs font-medium text-slate-300">
          <Truck className="h-3.5 w-3.5 text-sky-400" />
          <span>Singles Postage &amp; Tracked Threshold</span>
        </div>

        <div className="grid grid-cols-3 gap-2">
          <div>
            <label
              htmlFor="input-pwe-cost"
              className="block text-[10px] uppercase text-slate-400"
            >
              PWE ($)
            </label>
            <input
              id="input-pwe-cost"
              type="text"
              inputMode="decimal"
              value={pweDraft}
              onChange={(e) =>
                handleLivePostageChange(
                  e.target.value,
                  5000n,
                  "pweShippingCostUsd",
                  setPweDraft,
                )
              }
              onBlur={() =>
                commitPostageField(
                  pweDraft,
                  DEFAULT_ROUTING_PROFILE.pweShippingCostUsd,
                  5000n,
                  "pweShippingCostUsd",
                  setPweDraft,
                )
              }
              className="mt-1 w-full rounded-lg border border-slate-800 bg-slate-900 px-2 py-1 font-mono text-xs text-slate-100 focus:border-emerald-500 focus:outline-none"
            />
          </div>

          <div>
            <label
              htmlFor="input-tracked-cost"
              className="block text-[10px] uppercase text-slate-400"
            >
              Tracked ($)
            </label>
            <input
              id="input-tracked-cost"
              type="text"
              inputMode="decimal"
              value={trackedDraft}
              onChange={(e) =>
                handleLivePostageChange(
                  e.target.value,
                  10_000n,
                  "trackedShippingCostUsd",
                  setTrackedDraft,
                )
              }
              onBlur={() =>
                commitPostageField(
                  trackedDraft,
                  DEFAULT_ROUTING_PROFILE.trackedShippingCostUsd,
                  10_000n,
                  "trackedShippingCostUsd",
                  setTrackedDraft,
                )
              }
              className="mt-1 w-full rounded-lg border border-slate-800 bg-slate-900 px-2 py-1 font-mono text-xs text-slate-100 focus:border-emerald-500 focus:outline-none"
            />
          </div>

          <div>
            <label
              htmlFor="input-tracked-threshold"
              className="block text-[10px] uppercase text-slate-400"
            >
              Track &ge; ($)
            </label>
            <input
              id="input-tracked-threshold"
              type="text"
              inputMode="decimal"
              value={thresholdDraft}
              onChange={(e) =>
                handleLivePostageChange(
                  e.target.value,
                  100_000n,
                  "trackedThresholdUsd",
                  setThresholdDraft,
                )
              }
              onBlur={() =>
                commitPostageField(
                  thresholdDraft,
                  DEFAULT_ROUTING_PROFILE.trackedThresholdUsd,
                  100_000n,
                  "trackedThresholdUsd",
                  setThresholdDraft,
                )
              }
              className="mt-1 w-full rounded-lg border border-slate-800 bg-slate-900 px-2 py-1 font-mono text-xs text-slate-100 focus:border-emerald-500 focus:outline-none"
            />
          </div>
        </div>
      </div>

      {/* Save Default Profile Button */}
      <button
        type="button"
        disabled={isSavingProfile}
        onClick={onSaveProfileDefault}
        className="inline-flex w-full items-center justify-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800/90 px-3 py-2 text-xs font-medium text-slate-200 hover:bg-slate-700 disabled:opacity-50"
      >
        <Save className="h-3.5 w-3.5 text-emerald-400" />
        {isSavingProfile
          ? "Saving Profile..."
          : "Save as Default Flipper Profile"}
      </button>
    </aside>
  );
}
