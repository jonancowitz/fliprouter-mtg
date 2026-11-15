import {
  TriageWorkspace,
  type TriageWorkspaceInitialState,
} from "@/components/triage/triage-workspace";
import { getReadyDb } from "@/db";
import { getCatalogCount } from "@/db/seed-demo";
import { DEMO_SCANNER_PRESETS } from "@/lib/demo/scanner-presets";
import { ingestAndRouteScannerCsv, listPersistedLots } from "@/lib/triage";

export const dynamic = "force-dynamic";

export default async function HomePage(): Promise<React.ReactElement> {
  const { db, mode } = await getReadyDb();
  const catalogCount = await getCatalogCount(db);
  const defaultPreset = DEMO_SCANNER_PRESETS[0]!;

  const [initialTriage, savedLots] = await Promise.all([
    ingestAndRouteScannerCsv(db, {
      csvText: defaultPreset.csvText,
      purchaseCostUsd: defaultPreset.suggestedPurchaseCostUsd,
    }),
    listPersistedLots(db),
  ]);

  const initialState: TriageWorkspaceInitialState = {
    dbMode: mode,
    catalogCount,
    initialPresetId: defaultPreset.id,
    initialLotName: defaultPreset.suggestedLotName,
    initialPurchaseCostUsd: defaultPreset.suggestedPurchaseCostUsd,
    initialDiagnostics: initialTriage.diagnostics,
    initialInputs: initialTriage.inputs,
    initialProfile: initialTriage.profile,
    initialSavedLots: savedLots,
  };

  return <TriageWorkspace initial={initialState} />;
}
