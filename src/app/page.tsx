import {
  TriageWorkspace,
  type TriageWorkspaceInitialState,
} from "@/components/triage/triage-workspace";
import { getReadyDb } from "@/db";
import { getCatalogSyncSnapshot } from "@/lib/catalog";
import { DEMO_SCANNER_PRESETS } from "@/lib/demo/scanner-presets";
import { ingestAndRouteScannerCsv, listPersistedLots } from "@/lib/triage";

export const dynamic = "force-dynamic";

export default async function HomePage(): Promise<React.ReactElement> {
  const { db, mode } = await getReadyDb();
  const defaultPreset = DEMO_SCANNER_PRESETS[0]!;

  const [catalogSync, initialTriage, savedLots] = await Promise.all([
    getCatalogSyncSnapshot(db),
    ingestAndRouteScannerCsv(db, {
      csvText: defaultPreset.csvText,
      purchaseCostUsd: defaultPreset.suggestedPurchaseCostUsd,
    }),
    listPersistedLots(db),
  ]);

  const initialState: TriageWorkspaceInitialState = {
    dbMode: mode,
    catalogCount: catalogSync.catalogCount,
    initialCatalogSync: catalogSync,
    initialPresetId: defaultPreset.id,
    initialLotName: defaultPreset.suggestedLotName,
    initialPurchaseCostUsd: defaultPreset.suggestedPurchaseCostUsd,
    initialEvaluatedAt: initialTriage.evaluatedAt,
    initialBuylistCashMode: initialTriage.buylistCashMode,
    initialDiagnostics: initialTriage.diagnostics,
    initialInputs: initialTriage.inputs,
    initialProfile: initialTriage.profile,
    initialSavedLots: savedLots,
  };

  return <TriageWorkspace initial={initialState} />;
}
