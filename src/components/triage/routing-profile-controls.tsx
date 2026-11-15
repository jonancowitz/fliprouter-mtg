"use client";

import {
  RotateCcw,
  Save,
  Sliders,
  Sparkles,
  Truck,
  Zap,
} from "lucide-react";
import type { ConduitTierPreference } from "@/db/schema";
import {
  type BuylistCashSelectionMode,
  DEFAULT_ROUTING_PROFILE,
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

function parseSliderNumber(val: string, fallback: number): number {
  const num = Number.parseFloat(val);
  return Number.isFinite(num) ? num : fallback;
}

function formatSliderUsd(num: number): string {
  return num.toFixed(2);
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
  const hourlyRateNum = parseSliderNumber(profile.hourlyLaborRateUsd, 20);
  const minGainNum = parseSliderNumber(
    profile.minSingleNetGainOverBuylistUsd,
    1.25,
  );
  const boxShippingNum = parseSliderNumber(
    profile.outboundBuylistBoxShippingUsd,
    12,
  );
  const pweNum = parseSliderNumber(profile.pweShippingCostUsd, 0.9);
  const trackedNum = parseSliderNumber(profile.trackedShippingCostUsd, 4.25);
  const thresholdNum = parseSliderNumber(profile.trackedThresholdUsd, 25);

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

        {/* Hourly Labor Rate */}
        <div>
          <div className="mb-1 flex items-center justify-between text-xs">
            <label
              htmlFor="slider-hourly-labor"
              className="text-slate-400"
            >
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
            max={60}
            step={1}
            value={hourlyRateNum}
            onChange={(e) =>
              onChangeProfile({
                hourlyLaborRateUsd: formatSliderUsd(Number(e.target.value)),
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
              {(profile.secondsPerSingleOrder / 60).toFixed(1)}m)
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

        {/* Min Single Net Gain Over Buylist */}
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
            max={5}
            step={0.05}
            value={minGainNum}
            onChange={(e) =>
              onChangeProfile({
                minSingleNetGainOverBuylistUsd: formatSliderUsd(
                  Number(e.target.value),
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

        {/* Outbound Buylist Box Shipping */}
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
            max={25}
            step={0.5}
            value={boxShippingNum}
            onChange={(e) =>
              onChangeProfile({
                outboundBuylistBoxShippingUsd: formatSliderUsd(
                  Number(e.target.value),
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
              type="number"
              min={0}
              max={5}
              step={0.05}
              value={pweNum}
              onChange={(e) =>
                onChangeProfile({
                  pweShippingCostUsd: formatSliderUsd(
                    Math.max(0, parseSliderNumber(e.target.value, 0.9)),
                  ),
                })
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
              type="number"
              min={0}
              max={15}
              step={0.25}
              value={trackedNum}
              onChange={(e) =>
                onChangeProfile({
                  trackedShippingCostUsd: formatSliderUsd(
                    Math.max(0, parseSliderNumber(e.target.value, 4.25)),
                  ),
                })
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
              type="number"
              min={5}
              max={100}
              step={1}
              value={thresholdNum}
              onChange={(e) =>
                onChangeProfile({
                  trackedThresholdUsd: formatSliderUsd(
                    Math.max(
                      0,
                      parseSliderNumber(
                        e.target.value,
                        Number(DEFAULT_ROUTING_PROFILE.trackedThresholdUsd),
                      ),
                    ),
                  ),
                })
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
