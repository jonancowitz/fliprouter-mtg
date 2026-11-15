import type { ScannerFormat } from "@/lib/csv";

export interface DemoScannerPreset {
  readonly id: string;
  readonly format: ScannerFormat;
  readonly formatLabel: string;
  readonly title: string;
  readonly subtitle: string;
  readonly filename: string;
  readonly suggestedLotName: string;
  readonly suggestedPurchaseCostUsd: string;
  readonly badge: string;
  readonly csvText: string;
}

export const DEMO_SCANNER_PRESETS: readonly DemoScannerPreset[] = [
  {
    id: "manabox-weekend-buy",
    format: "manabox",
    formatLabel: "ManaBox",
    title: "Weekend Backpack Buy (Full 4-Pile Showcase)",
    subtitle:
      "36 rows / 81 cards: $850 Cradle ($75 TCG fee cap), LP Volcanic Island (24h SKU cache), Credit Arb candidates, Quarantines & Bulk.",
    filename: "manabox-weekend-collection-buy.csv",
    suggestedLotName: "GP Hartford Backpack Binder Buy (62% Market)",
    suggestedPurchaseCostUsd: "1850.00",
    badge: "Recommended Default",
    csvText: [
      "Name,Set code,Set name,Collector number,Foil,Rarity,Quantity,ManaBox ID,Scryfall ID,Purchase price,Misprint,Altered,Condition,Language,Purchase price currency",
      `"Gaea's Cradle",USG,"Urza's Saga",321,normal,rare,1,1001,10000001-4000-8000-a000-000000000001,510.00,false,false,near_mint,en,USD`,
      `"Volcanic Island",3ED,"Revised Edition",291,normal,rare,1,1002,10000002-4000-8000-a000-000000000002,415.00,false,false,lightly_played,en,USD`,
      `"Mox Diamond",STH,Stronghold,138,normal,rare,1,1003,10000003-4000-8000-a000-000000000003,380.00,false,false,near_mint,en,USD`,
      `"Mana Vault",2X2,"Double Masters 2022",394,foil,mythic,1,1004,10000004-4000-8000-a000-000000000004,70.00,false,false,near_mint,en,USD`,
      `"The One Ring",LTR,"The Lord of the Rings: Tales of Middle-earth",246,normal,mythic,1,1005,10000005-4000-8000-a000-000000000005,58.00,false,false,near_mint,en,USD`,
      `"Sheoldred, the Apocalypse",DMU,"Dominaria United",107,normal,mythic,1,1006,10000006-4000-8000-a000-000000000006,52.00,false,false,near_mint,en,USD`,
      `"Deflecting Swat",CMM,"Commander Masters",214,normal,rare,2,1008,10000008-4000-8000-a000-000000000008,17.00,false,false,near_mint,en,USD`,
      `"Fierce Guardianship",CMM,"Commander Masters",94,normal,rare,1,1009,10000009-4000-8000-a000-000000000009,16.50,false,false,near_mint,en,USD`,
      `"Vampiric Tutor",CMR,"Commander Legends",156,normal,mythic,1,1010,10000010-4000-8000-a000-000000000010,17.50,false,false,near_mint,en,USD`,
      `"Force of Negation",2X2,"Double Masters 2022",50,etched,mythic,1,1011,10000011-4000-8000-a000-000000000011,26.00,false,false,near_mint,en,USD`,
      `"Ragavan, Nimble Pilferer",MH2,"Modern Horizons 2",138,normal,mythic,1,1012,10000012-4000-8000-a000-000000000012,20.00,false,false,near_mint,en,USD`,
      `"Dockside Extortionist",2X2,"Double Masters 2022",107,etched,mythic,1,1014,10000014-4000-8000-a000-000000000014,13.00,false,false,near_mint,en,USD`,
      `"Ocelot Pride",MH3,"Modern Horizons 3",38,normal,mythic,1,1015,10000015-4000-8000-a000-000000000015,21.00,false,false,near_mint,en,USD`,
      `"Polluted Delta",MH3,"Modern Horizons 3",224,normal,rare,2,1016,10000016-4000-8000-a000-000000000016,9.00,false,false,near_mint,en,USD`,
      `"Flooded Strand",MH3,"Modern Horizons 3",220,normal,rare,2,1017,10000017-4000-8000-a000-000000000017,8.00,false,false,near_mint,en,USD`,
      `"Wooded Foothills",MH3,"Modern Horizons 3",236,normal,rare,2,1018,10000018-4000-8000-a000-000000000018,8.50,false,false,near_mint,en,USD`,
      `"Windswept Heath",MH3,"Modern Horizons 3",235,normal,rare,2,1019,10000019-4000-8000-a000-000000000019,7.00,false,false,near_mint,en,USD`,
      `"Bloodstained Mire",MH3,"Modern Horizons 3",216,normal,rare,2,1020,10000020-4000-8000-a000-000000000020,8.50,false,false,near_mint,en,USD`,
      `"Birds of Paradise",RVR,"Ravnica Remastered",133,normal,rare,2,1021,10000021-4000-8000-a000-000000000021,4.00,false,false,near_mint,en,USD`,
      `"Swords to Plowshares",CMM,"Commander Masters",60,normal,uncommon,3,1022,10000022-4000-8000-a000-000000000022,1.20,false,false,near_mint,en,USD`,
      `"Rhystic Study",WOT,"Wilds of Eldraine: Enchanting Tales",25,normal,mythic,1,1025,10000025-4000-8000-a000-000000000025,25.00,false,false,near_mint,en,USD`,
      `"Orcish Bowmasters",LTR,"The Lord of the Rings: Tales of Middle-earth",103,normal,rare,1,1026,10000026-4000-8000-a000-000000000026,28.00,false,false,near_mint,en,USD`,
      `"Cyclonic Rift",RVR,"Ravnica Remastered",40,normal,rare,1,1027,10000027-4000-8000-a000-000000000027,15.00,false,false,near_mint,en,USD`,
      `"Smothering Tithe",CMM,"Commander Masters",57,normal,rare,1,1028,10000028-4000-8000-a000-000000000028,14.00,false,false,near_mint,en,USD`,
      `"Esper Sentinel",MH2,"Modern Horizons 2",12,normal,rare,1,1029,10000029-4000-8000-a000-000000000029,12.50,false,false,near_mint,en,USD`,
      `"Boseiju, Who Endures",NEO,"Kamigawa: Neon Dynasty",266,normal,rare,1,1030,10000030-4000-8000-a000-000000000030,19.00,false,false,near_mint,en,USD`,
      `"Misty Rainforest",MH2,"Modern Horizons 2",250,foil,rare,1,1031,10000031-4000-8000-a000-000000000031,18.00,false,false,lightly_played,en,USD`,
      `"Scalding Tarn",MH2,"Modern Horizons 2",254,normal,rare,1,1032,10000032-4000-8000-a000-000000000032,11.00,false,false,moderately_played,en,USD`,
      `"Demonic Tutor",CMM,"Commander Masters",150,normal,mythic,1,1034,10000034-4000-8000-a000-000000000034,9.00,false,false,damaged,en,USD`,
      `"Lightning Bolt",STA,"Strixhaven Mystical Archive",102,foil,rare,1,1035,10000035-4000-8000-a000-000000000035,28.00,false,false,near_mint,ja,USD`,
      `"Sol Ring",CMD,"Commander 2011",261,normal,uncommon,1,1036,10000036-4000-8000-a000-000000000036,2.00,false,true,lightly_played,en,USD`,
      `"Counterspell",MH2,"Modern Horizons 2",267,normal,uncommon,1,1037,10000037-4000-8000-a000-000000000037,1.00,true,false,near_mint,en,USD`,
      `"Cultivate",CMM,"Commander Masters",279,normal,common,6,1040,10000040-4000-8000-a000-000000000040,0.20,false,false,near_mint,en,USD`,
      `"Command Tower",ELD,"Throne of Eldraine",333,normal,common,10,1041,10000041-4000-8000-a000-000000000041,0.15,false,false,near_mint,en,USD`,
      `"Llanowar Elves",FDN,Foundations,227,normal,common,12,1042,10000042-4000-8000-a000-000000000042,0.05,false,false,near_mint,en,USD`,
      `"Evolving Wilds",BRO,"The Brothers' War",261,normal,common,12,1044,10000044-4000-8000-a000-000000000044,0.02,false,false,near_mint,en,USD`,
    ].join("\n"),
  },
  {
    id: "dragon-shield-modern-folder",
    format: "dragon_shield",
    formatLabel: "Dragon Shield",
    title: "Modern & Commander Trade Folder",
    subtitle:
      "Exercises set+collector lookup, promo 'pmh2' prefix fallback, '031' leading-zero & '117/331' slash collector normalization.",
    filename: "dragon-shield-modern-folder.csv",
    suggestedLotName: "Dragon Shield Facebook Lot (58% Market)",
    suggestedPurchaseCostUsd: "295.00",
    badge: "Set/Collector Quirks",
    csvText: [
      "Folder Name,Quantity,Trade Quantity,Card Name,Set Code,Set Name,Card Number,Condition,Printing,Language,Price Bought,Date Bought,LOW,MID,MARKET",
      `Modern Staples,1,1,"Ragavan, Nimble Pilferer",PMH2,"Modern Horizons 2 Promos",138,NearMint,Normal,English,20.00,2026-10-12,31.00,33.00,33.50`,
      `Modern Staples,1,1,"Solitude",MH2,"Modern Horizons 2",433,Mint,Foil Etched,English,13.00,2026-10-12,19.80,21.00,21.50`,
      `Modern Staples,2,2,"Lightning Bolt",2X2,"Double Masters 2022",117/331,NearMint,Foil Etched,English,3.50,2026-10-12,5.95,6.20,6.40`,
      `Modern Staples,2,2,"Counterbalance",CSP,Coldsnap,031,LightlyPlayed,Normal,English,6.50,2026-10-12,10.90,11.50,11.80`,
      `Modern Staples,2,2,"Polluted Delta",MH3,"Modern Horizons 3",224,NearMint,Normal,English,9.00,2026-10-12,13.80,14.20,14.50`,
      `Modern Staples,2,2,"Flooded Strand",MH3,"Modern Horizons 3",220,NearMint,Normal,English,8.00,2026-10-12,12.50,13.00,13.20`,
      `Modern Staples,2,2,"Wooded Foothills",MH3,"Modern Horizons 3",236,NearMint,Normal,English,8.25,2026-10-12,13.10,13.50,13.80`,
      `Commander Binder,1,1,"Rhystic Study",WOT,"Wilds of Eldraine: Enchanting Tales",025,NearMint,Normal,English,25.00,2026-10-12,39.50,41.00,42.00`,
      `Commander Binder,1,1,"Orcish Bowmasters",LTR,"The Lord of the Rings: Tales of Middle-earth",103,NearMint,Normal,English,27.00,2026-10-12,43.50,45.00,46.00`,
      `Commander Binder,1,1,"Deflecting Swat",CMM,"Commander Masters",214,NearMint,Normal,English,16.50,2026-10-12,28.00,28.20,28.50`,
      `Commander Binder,1,1,"Lightning Bolt",STA,"Strixhaven Mystical Archive",102,NearMint,Foil,Japanese,26.00,2026-10-12,44.00,46.00,48.00`,
      `Commander Binder,4,4,"Path to Exile",2X2,"Double Masters 2022",023,NearMint,Normal,English,1.30,2026-10-12,2.30,2.50,2.60`,
      `Bulk Box,8,8,"Negate",MOM,"March of the Machine",068,NearMint,Normal,English,0.05,2026-10-12,0.10,0.12,0.15`,
    ].join("\n"),
  },
  {
    id: "tcgplayer-app-staples",
    format: "tcgplayer_app",
    formatLabel: "TCGplayer App",
    title: "High-End Showcase & Etched Foils Scan",
    subtitle:
      "Resolves directly via TCGplayer Product ID (`tcgplayer_id` & `tcgplayer_etched_id`) across RL & Mythic staples.",
    filename: "tcgplayer-app-staples.csv",
    suggestedLotName: "Show Case Booth Buyout (65% TCG Low)",
    suggestedPurchaseCostUsd: "1180.00",
    badge: "Product ID Match",
    csvText: [
      "Quantity,Name,Simple Name,Set,Card Number,Set Code,Printing,Condition,Language,Rarity,Product ID,SKU",
      `1,"Gaea's Cradle","Gaea's Cradle","Urza's Saga",321,USG,Normal,Near Mint,English,Rare,4301,9004301`,
      `1,"Mox Diamond","Mox Diamond",Stronghold,138,STH,Normal,Near Mint,English,Rare,5392,9005392`,
      `1,"Ancient Tomb","Ancient Tomb","Ultimate Masters",236,UMA,Normal,Near Mint,English,Rare,180430,9180430`,
      `1,"The One Ring","The One Ring","The Lord of the Rings: Tales of Middle-earth",246,LTR,Foil,Near Mint,English,Mythic,488264,9488264`,
      `1,"Force of Negation (Foil Etched)","Force of Negation","Double Masters 2022",50,2X2,Foil Etched,Near Mint,English,Mythic,276901,9276901`,
      `1,"Deflecting Swat","Deflecting Swat","Commander Masters",214,CMM,Normal,Near Mint,English,Rare,504192,9504192`,
      `1,"Vampiric Tutor","Vampiric Tutor","Commander Legends",156,CMR,Normal,Near Mint,English,Mythic,226790,9226790`,
      `2,"Polluted Delta","Polluted Delta","Modern Horizons 3",224,MH3,Normal,Near Mint,English,Rare,552501,9552501`,
      `2,"Bloodstained Mire","Bloodstained Mire","Modern Horizons 3",216,MH3,Normal,Near Mint,English,Rare,552505,9552505`,
      `1,"Teferi's Protection","Teferi's Protection","Double Masters 2022",32,2X2,Normal,Heavily Played,English,Rare,276432,9276432`,
    ].join("\n"),
  },
  {
    id: "delver-lens-postage-guard",
    format: "delver_lens",
    formatLabel: "Delver Lens",
    title: "Small Binder ($12 Box Postage Demotion Demo)",
    subtitle:
      "Small 10-card scan where 4 buylist cards (3 SKUs) cannot clear the $12.00 outbound box shipping hurdle and auto-demote!",
    filename: "delver-lens-small-binder-postage-guard.csv",
    suggestedLotName: "Local FNM Walk-Up Mini Binder",
    suggestedPurchaseCostUsd: "92.00",
    badge: "$12 Postage Guard",
    csvText: [
      "Name,Edition,Edition code,Collector's number,Price,Foil,Quantity,Scryfall ID,Condition,Language",
      `"Sheoldred, the Apocalypse","Dominaria United",DMU,107,86.00,,1,10000006-4000-8000-a000-000000000006,NM,English`,
      `"Deflecting Swat","Commander Masters",CMM,214,28.50,,1,10000008-4000-8000-a000-000000000008,NM,English`,
      `"Birds of Paradise","Ravnica Remastered",RVR,133,6.80,,1,10000021-4000-8000-a000-000000000021,NM,English`,
      `"Swords to Plowshares","Commander Masters",CMM,60,2.40,,2,10000022-4000-8000-a000-000000000022,NM,English`,
      `"Arcane Signet","Commander Masters",CMM,367,1.95,,1,10000024-4000-8000-a000-000000000024,NM,English`,
      `"Cultivate","Commander Masters",CMM,279,0.85,,4,10000040-4000-8000-a000-000000000040,NM,English`,
    ].join("\n"),
  },
];

export function getScannerPresetById(id: string): DemoScannerPreset | undefined {
  return DEMO_SCANNER_PRESETS.find((preset) => preset.id === id);
}
