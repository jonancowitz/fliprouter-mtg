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
      `"Gaea's Cradle",USG,"Urza's Saga",321,normal,rare,1,1001,25b0b816-0583-44aa-9dc5-f3ff48993a51,510.00,false,false,near_mint,en,USD`,
      `"Volcanic Island",3ED,"Revised Edition",291,normal,rare,1,1002,b12e5430-0e80-47dd-80ac-85728b656a24,415.00,false,false,lightly_played,en,USD`,
      `"Mox Diamond",STH,Stronghold,138,normal,rare,1,1003,28028830-83ed-45e2-b495-3b9ad9d3e988,380.00,false,false,near_mint,en,USD`,
      `"Mana Vault",2X2,"Double Masters 2022",394,foil,mythic,1,1004,a941b1f6-9f18-4c9e-993f-bf8f52bd6f53,70.00,false,false,near_mint,en,USD`,
      `"The One Ring",LTR,"The Lord of the Rings: Tales of Middle-earth",246,normal,mythic,1,1005,d5806e68-1054-458e-866d-1f2470f682b2,58.00,false,false,near_mint,en,USD`,
      `"Sheoldred, the Apocalypse",DMU,"Dominaria United",107,normal,mythic,1,1006,d67be074-cdd4-41d9-ac89-0a0456c4e4b2,52.00,false,false,near_mint,en,USD`,
      `"Deflecting Swat",CMM,"Commander Masters",214,normal,rare,2,1008,b4b36435-55b3-4615-8812-af41d4fc64d9,17.00,false,false,near_mint,en,USD`,
      `"Fierce Guardianship",CMM,"Commander Masters",94,normal,rare,1,1009,f7f3dd95-bd14-4e0f-a388-444f9cf1b0dc,16.50,false,false,near_mint,en,USD`,
      `"Vampiric Tutor",CMR,"Commander Legends",156,normal,mythic,1,1010,18bd50f2-c3ba-4217-a2d5-bb771e199706,17.50,false,false,near_mint,en,USD`,
      `"Force of Negation",2X2,"Double Masters 2022",429,etched,rare,1,1011,0d840284-ce56-4e4f-822f-8b237a261d1e,26.00,false,false,near_mint,en,USD`,
      `"Ragavan, Nimble Pilferer",MH2,"Modern Horizons 2",138,normal,mythic,1,1012,a9738cda-adb1-47fb-9f4c-ecd930228c4d,20.00,false,false,near_mint,en,USD`,
      `"Dockside Extortionist",2X2,"Double Masters 2022",452,etched,mythic,1,1014,7eea863e-ebc0-4c8e-b464-80b7dbabe30b,13.00,false,false,near_mint,en,USD`,
      `"Ocelot Pride",MH3,"Modern Horizons 3",38,normal,mythic,1,1015,89cf6f57-230f-497e-a14e-ad1e8737fd42,21.00,false,false,near_mint,en,USD`,
      `"Polluted Delta",MH3,"Modern Horizons 3",224,normal,rare,2,1016,6e288374-2b71-4ace-b1d2-a19fee6cb4af,9.00,false,false,near_mint,en,USD`,
      `"Flooded Strand",MH3,"Modern Horizons 3",220,normal,rare,2,1017,8f85e12c-196b-4459-b81f-0c9c854e9f57,8.00,false,false,near_mint,en,USD`,
      `"Wooded Foothills",MH3,"Modern Horizons 3",236,normal,rare,2,1018,4e11ea8a-f895-438d-a3b7-f070238e4161,8.50,false,false,near_mint,en,USD`,
      `"Windswept Heath",MH3,"Modern Horizons 3",235,normal,rare,2,1019,bd1d13f7-fd38-4f0b-a8e0-1eac78668117,7.00,false,false,near_mint,en,USD`,
      `"Bloodstained Mire",MH3,"Modern Horizons 3",216,normal,rare,2,1020,579743fe-f71e-4cb2-8629-d6b02ed1591d,8.50,false,false,near_mint,en,USD`,
      `"Birds of Paradise",RVR,"Ravnica Remastered",133,normal,rare,2,1021,3d69a3e0-6a2e-475a-964e-0affed1c017d,4.00,false,false,near_mint,en,USD`,
      `"Swords to Plowshares",CMM,"Commander Masters",841,normal,uncommon,3,1022,42ecba4b-9624-428f-a8af-dd88139ab13c,1.20,false,false,near_mint,en,USD`,
      `"Rhystic Study",WOT,"Wilds of Eldraine: Enchanting Tales",25,normal,mythic,1,1025,043b2d30-a40f-4d47-933b-80544512f9c2,25.00,false,false,near_mint,en,USD`,
      `"Orcish Bowmasters",LTR,"The Lord of the Rings: Tales of Middle-earth",103,normal,rare,1,1026,7c024bae-5631-4e20-ac69-df392ac9e109,28.00,false,false,near_mint,en,USD`,
      `"Cyclonic Rift",RVR,"Ravnica Remastered",40,normal,mythic,1,1027,dfb7c4b9-f2f4-4d4e-baf2-86551c8150fe,15.00,false,false,near_mint,en,USD`,
      `"Smothering Tithe",CMM,"Commander Masters",57,normal,mythic,1,1028,861b5889-0183-4bee-afeb-a4b2aa700a8e,14.00,false,false,near_mint,en,USD`,
      `"Esper Sentinel",MH2,"Modern Horizons 2",12,normal,rare,1,1029,f3537373-ef54-4578-9d05-6216420ee349,12.50,false,false,near_mint,en,USD`,
      `"Boseiju, Who Endures",NEO,"Kamigawa: Neon Dynasty",266,normal,rare,1,1030,2135ac5a-187b-4dc9-8f82-34e8d1603416,19.00,false,false,near_mint,en,USD`,
      `"Misty Rainforest",MH2,"Modern Horizons 2",250,foil,rare,1,1031,88231c0d-0cc8-44ec-bf95-81d1710ac141,18.00,false,false,lightly_played,en,USD`,
      `"Scalding Tarn",MH2,"Modern Horizons 2",254,normal,rare,1,1032,71e491c5-8c07-449b-b2f1-ffa052e6d311,11.00,false,false,moderately_played,en,USD`,
      `"Demonic Tutor",CMM,"Commander Masters",150,normal,mythic,1,1034,a24b4cb6-cebb-428b-8654-74347a6a8d63,9.00,false,false,damaged,en,USD`,
      `"Lightning Bolt",STA,"Strixhaven Mystical Archive",105,foil,rare,1,1035,b14fae63-2e82-49c1-8e62-d84a65f27479,28.00,false,false,near_mint,ja,USD`,
      `"Sol Ring",CMD,"Commander 2011",261,normal,uncommon,1,1036,71357a3d-9a9f-4ec6-8e01-1966b220206c,2.00,false,true,lightly_played,en,USD`,
      `"Counterspell",MH2,"Modern Horizons 2",267,normal,uncommon,1,1037,1920dae4-fb92-4f19-ae4b-eb3276b8dac7,1.00,true,false,near_mint,en,USD`,
      `"Cultivate",CMM,"Commander Masters",889,normal,common,6,1040,56b34b52-7a67-44b4-82e7-2860729ba410,0.20,false,false,near_mint,en,USD`,
      `"Command Tower",ELD,"Throne of Eldraine",333,normal,common,10,1041,ec1f1041-f667-4b73-b1f2-e5bcae84095e,0.15,false,false,near_mint,en,USD`,
      `"Llanowar Elves",FDN,Foundations,227,normal,common,12,1042,6a0b230b-d391-4998-a3f7-7b158a0ec2cd,0.05,false,false,near_mint,en,USD`,
      `"Evolving Wilds",BRO,"The Brothers' War",261,normal,common,12,1044,238de888-b1bd-4cce-9aa2-d0dd69ae7f0d,0.02,false,false,near_mint,en,USD`,
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
      `Modern Staples,1,1,"Chatterfang, Squirrel General",MH2,"Modern Horizons 2",410,Mint,Foil Etched,English,13.00,2026-10-12,19.80,21.00,21.50`,
      `Modern Staples,2,2,"Lightning Bolt",2X2,"Double Masters 2022",117/331,NearMint,Foil,English,3.50,2026-10-12,4.30,4.55,4.80`,
      `Modern Staples,2,2,"Counterbalance",CSP,Coldsnap,031,LightlyPlayed,Normal,English,6.50,2026-10-12,10.90,11.50,11.80`,
      `Modern Staples,2,2,"Polluted Delta",MH3,"Modern Horizons 3",224,NearMint,Normal,English,9.00,2026-10-12,13.80,14.20,14.50`,
      `Modern Staples,2,2,"Flooded Strand",MH3,"Modern Horizons 3",220,NearMint,Normal,English,8.00,2026-10-12,12.50,13.00,13.20`,
      `Modern Staples,2,2,"Wooded Foothills",MH3,"Modern Horizons 3",236,NearMint,Normal,English,8.25,2026-10-12,13.10,13.50,13.80`,
      `Commander Binder,1,1,"Rhystic Study",WOT,"Wilds of Eldraine: Enchanting Tales",025,NearMint,Normal,English,25.00,2026-10-12,39.50,41.00,42.00`,
      `Commander Binder,1,1,"Orcish Bowmasters",LTR,"The Lord of the Rings: Tales of Middle-earth",103,NearMint,Normal,English,27.00,2026-10-12,43.50,45.00,46.00`,
      `Commander Binder,1,1,"Deflecting Swat",CMM,"Commander Masters",214,NearMint,Normal,English,16.50,2026-10-12,28.00,28.20,28.50`,
      `Commander Binder,1,1,"Lightning Bolt",STA,"Strixhaven Mystical Archive",105,NearMint,Foil,Japanese,26.00,2026-10-12,44.00,46.00,48.00`,
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
      `1,"Gaea's Cradle","Gaea's Cradle","Urza's Saga",321,USG,Normal,Near Mint,English,Rare,6883,9006883`,
      `1,"Mox Diamond","Mox Diamond",Stronghold,138,STH,Normal,Near Mint,English,Rare,5382,9005382`,
      `1,"Ancient Tomb","Ancient Tomb","Ultimate Masters",236,UMA,Normal,Near Mint,English,Rare,179473,9179473`,
      `1,"The One Ring","The One Ring","The Lord of the Rings: Tales of Middle-earth",246,LTR,Foil,Near Mint,English,Mythic,487805,9487805`,
      `1,"Force of Negation (Foil Etched)","Force of Negation","Double Masters 2022",429,2X2,Foil Etched,Near Mint,English,Rare,276732,9276732`,
      `1,"Deflecting Swat","Deflecting Swat","Commander Masters",214,CMM,Normal,Near Mint,English,Rare,504494,9504494`,
      `1,"Vampiric Tutor","Vampiric Tutor","Commander Legends",156,CMR,Normal,Near Mint,English,Mythic,226134,9226134`,
      `2,"Polluted Delta","Polluted Delta","Modern Horizons 3",224,MH3,Normal,Near Mint,English,Rare,541274,9541274`,
      `2,"Bloodstained Mire","Bloodstained Mire","Modern Horizons 3",216,MH3,Normal,Near Mint,English,Rare,541275,9541275`,
      `1,"Teferi's Protection","Teferi's Protection","Double Masters 2022",32,2X2,Normal,Heavily Played,English,Rare,276254,9276254`,
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
      `"Sheoldred, the Apocalypse","Dominaria United",DMU,107,86.00,,1,d67be074-cdd4-41d9-ac89-0a0456c4e4b2,NM,English`,
      `"Deflecting Swat","Commander Masters",CMM,214,28.50,,1,b4b36435-55b3-4615-8812-af41d4fc64d9,NM,English`,
      `"Birds of Paradise","Ravnica Remastered",RVR,133,6.80,,1,3d69a3e0-6a2e-475a-964e-0affed1c017d,NM,English`,
      `"Swords to Plowshares","Commander Masters",CMM,841,2.40,,2,42ecba4b-9624-428f-a8af-dd88139ab13c,NM,English`,
      `"Arcane Signet","Commander Masters",CMM,367,1.95,,1,0539b83c-4459-41b5-a001-d15a1c9ddf23,NM,English`,
      `"Cultivate","Commander Masters",CMM,889,0.85,,4,56b34b52-7a67-44b4-82e7-2860729ba410,NM,English`,
    ].join("\n"),
  },
];

export function getScannerPresetById(id: string): DemoScannerPreset | undefined {
  return DEMO_SCANNER_PRESETS.find((preset) => preset.id === id);
}
