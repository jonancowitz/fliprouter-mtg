from __future__ import annotations

import bz2
import contextlib
import gzip
import json
import sys
from decimal import Decimal
from pathlib import Path
from typing import Any

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import sync_catalog  # noqa: E402


class FakeCursor:
    def __init__(self, executed: list[tuple[str, list[dict[str, Any]]]]) -> None:
        self._executed = executed
        self.rowcount = 3

    def __enter__(self) -> FakeCursor:
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        return None

    def executemany(self, sql: str, params_seq: list[dict[str, Any]]) -> None:
        self._executed.append((sql, list(params_seq)))

    def execute(self, sql: str) -> None:
        self._executed.append((sql, []))


class FakeConnection:
    def __init__(self) -> None:
        self.executed: list[tuple[str, list[dict[str, Any]]]] = []
        self.transactions: int = 0

    @contextlib.contextmanager
    def transaction(self):
        self.transactions += 1
        yield

    def cursor(self) -> FakeCursor:
        return FakeCursor(self.executed)


def _sample_scryfall_cards() -> list[dict[str, Any]]:
    return [
        {
            "id": "7673784e-db4b-43a1-8d55-1bb9fc1e284f",
            "oracle_id": "4457ed35-7c10-48c8-9776-456485fdf070",
            "tcgplayer_id": 697344,
            "tcgplayer_etched_id": 697345,
            "name": "Lightning Bolt",
            "set": "2X2",
            "set_name": "Double Masters 2022",
            "collector_number": "117",
            "rarity": "Uncommon",
            "finishes": ["nonfoil", "foil", "etched"],
            "games": ["paper", "mtgo"],
            "image_uris": {"normal": "https://cards.scryfall.io/normal/bolt.jpg"},
            "prices": {"usd": "2.45", "usd_foil": "4.90", "usd_etched": "6.15"},
        },
        {
            # Double-faced card with face-level oracle_id and image_uris
            "id": "f6555d1f-d4cf-41f7-99d3-88fd53e75457",
            "name": "Delver of Secrets // Insectile Aberration",
            "set": "ISD",
            "set_name": "Innistrad",
            "collector_number": "51",
            "rarity": "common",
            "finishes": ["nonfoil", "foil"],
            "games": ["paper"],
            "card_faces": [
                {
                    "name": "Delver of Secrets",
                    "oracle_id": "d4246e4d-390d-4925-a5a8-89cd096a237c",
                    "image_uris": {"normal": "https://cards.scryfall.io/normal/delver_front.jpg"},
                },
                {
                    "name": "Insectile Aberration",
                    "image_uris": {"normal": "https://cards.scryfall.io/normal/delver_back.jpg"},
                },
            ],
            "prices": {"usd": "0.89", "usd_foil": "14.25", "usd_etched": None},
        },
        {
            # Digital-only card must be filtered out
            "id": "11111111-2222-3333-4444-555555555555",
            "oracle_id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            "name": "Arena Exclusive Spell",
            "set": "Y25",
            "set_name": "Alchemy 2025",
            "collector_number": "1",
            "rarity": "rare",
            "finishes": ["nonfoil"],
            "games": ["arena"],
            "prices": {"usd": None, "usd_foil": None, "usd_etched": None},
        },
    ]


def test_parse_usd_cents_and_ck_credit_use_exact_decimal_math() -> None:
    assert sync_catalog.parse_usd("18.54") == Decimal("18.54")
    assert sync_catalog.parse_usd(Decimal("0.355")) == Decimal("0.36")
    assert sync_catalog.parse_usd(11.5) == Decimal("11.50")
    assert sync_catalog.parse_usd(0) == Decimal("0.00")
    assert sync_catalog.parse_usd(None) is None
    assert sync_catalog.parse_usd("") is None
    assert sync_catalog.parse_usd("-1.00") is None
    assert sync_catalog.parse_usd(True) is None

    assert sync_catalog.parse_cents_to_usd(307) == Decimal("3.07")
    assert sync_catalog.parse_cents_to_usd(0) == Decimal("0.00")
    assert sync_catalog.parse_cents_to_usd("1664") == Decimal("16.64")
    assert sync_catalog.parse_cents_to_usd(-5) is None
    assert sync_catalog.parse_cents_to_usd(None) is None

    # Card Kingdom store credit is Cash * 1.30 quantized HALF_UP
    assert sync_catalog.compute_ck_credit(Decimal("11.50")) == Decimal("14.95")
    assert sync_catalog.compute_ck_credit(Decimal("0.35")) == Decimal("0.46")
    assert sync_catalog.compute_ck_credit(
        Decimal("10.00"), explicit_credit=Decimal("13.25")
    ) == Decimal("13.25")


def test_default_batch_size_matches_spec() -> None:
    assert sync_catalog.DEFAULT_BATCH_SIZE == 5000


def test_streaming_json_array_and_gzipped_jsonl_formats(tmp_path: Path) -> None:
    cards = _sample_scryfall_cards()

    json_array_path = tmp_path / "default-cards.json"
    json_array_path.write_text(json.dumps(cards), encoding="utf-8")

    jsonl_gz_path = tmp_path / "default-cards.jsonl.gz"
    with gzip.open(jsonl_gz_path, "wt", encoding="utf-8") as gz:
        for card in cards:
            gz.write(json.dumps(card) + "\n")

    for path in (json_array_path, jsonl_gz_path):
        conn = FakeConnection()
        sink = sync_catalog.PostgresCatalogSink(conn)
        stats = sync_catalog.SyncStats()
        with sync_catalog.open_streaming_source(path) as stream:
            sync_catalog.sync_scryfall_stage(stream, sink, stats, batch_size=1)

        assert stats.scryfall_seen == 3
        assert stats.scryfall_upserted == 2
        assert stats.scryfall_batches == 2
        assert conn.transactions == 2

        first_sql, first_rows = conn.executed[0]
        assert "ON CONFLICT (scryfall_id) DO UPDATE" in first_sql
        assert first_rows[0]["set_code"] == "2x2"
        assert first_rows[0]["tcg_market_nm"] == Decimal("2.45")
        assert first_rows[0]["tcg_market_etched"] == Decimal("6.15")

        _, second_rows = conn.executed[1]
        assert second_rows[0]["oracle_id"] == "d4246e4d-390d-4925-a5a8-89cd096a237c"
        assert (
            second_rows[0]["image_uri"]
            == "https://cards.scryfall.io/normal/delver_front.jpg"
        )


def test_end_to_end_bz2_etched_prices_manapool_supplement_and_prune(
    tmp_path: Path,
) -> None:
    scryfall_path = tmp_path / "scryfall.jsonl.gz"
    with gzip.open(scryfall_path, "wt", encoding="utf-8") as gz:
        for card in _sample_scryfall_cards():
            gz.write(json.dumps(card) + "\n")

    identifiers_payload = {
        "meta": {"date": "2026-11-14", "version": "5.3.0"},
        "data": {
            "00010d56-fe38-5e35-8aed-518019aa36a5": {
                "side": "a",
                "availability": ["paper"],
                "identifiers": {
                    "scryfallId": "f6555d1f-d4cf-41f7-99d3-88fd53e75457",
                    "cardKingdomId": "185001",
                    "cardKingdomFoilId": "185002",
                    "tcgplayerProductId": "56001",
                },
            },
            "99990d56-fe38-5e35-8aed-518019aa36a5": {
                "side": "b",
                "availability": ["paper"],
                "identifiers": {
                    "scryfallId": "f6555d1f-d4cf-41f7-99d3-88fd53e75457",
                },
            },
            "0003caab-9ff5-5d1a-bc06-976dd0457f19": {
                "availability": ["paper", "mtgo"],
                "identifiers": {
                    "scryfallId": "7673784e-db4b-43a1-8d55-1bb9fc1e284f",
                    "cardKingdomId": "240111",
                    "cardKingdomFoilId": "240112",
                },
            },
        },
    }
    identifiers_bz2 = tmp_path / "AllIdentifiers.json.bz2"
    with bz2.open(identifiers_bz2, "wt", encoding="utf-8") as bz:
        json.dump(identifiers_payload, bz)

    prices_payload = {
        "meta": {"date": "2026-11-14", "version": "5.3.0"},
        "data": {
            "0003caab-9ff5-5d1a-bc06-976dd0457f19": {
                "paper": {
                    "tcgplayer": {
                        "retail": {
                            "normal": {"2026-11-13": 2.30, "2026-11-14": 2.55},
                            "foil": {"2026-11-14": 5.10},
                            "etched": {"2026-11-14": 6.40},
                        },
                        "retail_low": {
                            "etched": {"2026-11-14": 5.95},
                        },
                    },
                    "manapool": {
                        "retail": {
                            "normal": {"2026-11-14": 2.15},
                            "foil": {"2026-11-14": 4.65},
                            "etched": {"2026-11-14": 5.85},
                        }
                    },
                    "cardkingdom": {
                        "buylist": {
                            "normal": {"2026-11-14": 1.40},
                            "foil": {"2026-11-14": 2.80},
                            "etched": {"2026-11-14": 3.50},
                        }
                    },
                }
            },
            "deadbeef-dead-beef-dead-beefdeadbeef": {
                "mtgo": {"cardhoarder": {"retail": {"normal": {"2026-11-14": 0.05}}}}
            },
        },
    }
    prices_bz2 = tmp_path / "AllPricesToday.json.bz2"
    with bz2.open(prices_bz2, "wt", encoding="utf-8") as bz:
        json.dump(prices_payload, bz)

    manapool_singles_payload = {
        "meta": {"as_of": "2026-11-15T02:21:26.180Z"},
        "data": [
            {
                "scryfall_id": "f6555d1f-d4cf-41f7-99d3-88fd53e75457",
                "tcgplayer_product_id": 56001,
                "price_cents": 75,
                "price_cents_nm": 85,
                "price_cents_foil": 1350,
                "price_cents_nm_foil": None,
                "price_cents_etched": None,
                "price_cents_nm_etched": 1995,
            }
        ],
    }
    manapool_gz = tmp_path / "singles.json.gz"
    with gzip.open(manapool_gz, "wt", encoding="utf-8") as gz:
        json.dump(manapool_singles_payload, gz)

    conn = FakeConnection()
    sink = sync_catalog.PostgresCatalogSink(conn)
    stats = sync_catalog.run_sync_pipeline(
        sink,
        scryfall_source=scryfall_path,
        identifiers_source=identifiers_bz2,
        prices_source=prices_bz2,
        manapool_source=manapool_gz,
        batch_size=5000,
    )

    assert stats.scryfall_upserted == 2
    assert stats.identifiers_mapped == 2
    assert stats.prices_updated == 1
    assert stats.manapool_supplemented == 1
    assert stats.sku_cache_pruned == 3

    price_sql, price_rows = conn.executed[2]
    assert "WHERE mtgjson_uuid = %(mtgjson_uuid)s" in price_sql
    bolt_price = price_rows[0]
    assert bolt_price["tcg_market_nm"] == Decimal("2.55")
    assert bolt_price["tcg_market_etched"] == Decimal("6.40")
    assert bolt_price["tcg_low_etched"] == Decimal("5.95")
    assert bolt_price["manapool_low_nm"] == Decimal("2.15")
    assert bolt_price["manapool_low_etched"] == Decimal("5.85")
    assert bolt_price["ck_buylist_cash_etched"] == Decimal("3.50")
    assert bolt_price["ck_buylist_credit_etched"] == Decimal("4.55")

    mp_sql, mp_rows = conn.executed[3]
    assert "COALESCE(card_catalog.manapool_low_nm, %(manapool_low_nm)s)" in mp_sql
    assert mp_rows[0] == {
        "scryfall_id": "f6555d1f-d4cf-41f7-99d3-88fd53e75457",
        "tcgplayer_id": 56001,
        "manapool_low_nm": Decimal("0.85"),
        "manapool_low_foil": Decimal("13.50"),
        "manapool_low_etched": Decimal("19.95"),
    }

    prune_sql, _ = conn.executed[4]
    assert "DELETE FROM sku_price_cache" in prune_sql


def test_http_streaming_and_graceful_manapool_fallback() -> None:
    cards = _sample_scryfall_cards()[:1]
    gz_payload = gzip.compress((json.dumps(cards[0]) + "\n").encode("utf-8"))

    def handler(request: httpx.Request) -> httpx.Response:
        assert "FlipRouterMTG" in request.headers.get("user-agent", "")
        if str(request.url) == sync_catalog.SCRYFALL_BULK_METADATA_URL:
            return httpx.Response(
                200,
                json={
                    "object": "bulk_data",
                    "type": "default_cards",
                    "jsonl_download_uri": "https://data.scryfall.test/default-cards.jsonl.gz",
                },
            )
        if str(request.url) == "https://data.scryfall.test/default-cards.jsonl.gz":
            return httpx.Response(200, content=gz_payload)
        if str(request.url) == sync_catalog.MANAPOOL_SINGLES_URL:
            return httpx.Response(503, text="Service Unavailable")
        return httpx.Response(404)

    transport = httpx.MockTransport(handler)
    with httpx.Client(
        transport=transport,
        headers={"User-Agent": sync_catalog.DEFAULT_USER_AGENT},
    ) as client:
        sink = sync_catalog.DryRunCatalogSink()
        stats = sync_catalog.run_sync_pipeline(
            sink,
            skip_identifiers=True,
            skip_prices=True,
            http_client=client,
        )
        assert stats.scryfall_seen == 1
        assert stats.scryfall_upserted == 1
        assert stats.manapool_fallback_failed is True

        with pytest.raises(httpx.HTTPStatusError):
            sync_catalog.run_sync_pipeline(
                sink,
                skip_scryfall=True,
                skip_identifiers=True,
                skip_prices=True,
                strict_manapool=True,
                http_client=client,
            )


def test_cli_dry_run_and_missing_database_url_guard(tmp_path: Path) -> None:
    scryfall_path = tmp_path / "cards.json"
    scryfall_path.write_text(json.dumps(_sample_scryfall_cards()), encoding="utf-8")

    rc_dry = sync_catalog.main(
        [
            "--dry-run",
            "--scryfall-source",
            str(scryfall_path),
            "--skip-identifiers",
            "--skip-prices",
            "--skip-manapool",
            "--limit",
            "2",
        ]
    )
    assert rc_dry == 0

    rc_no_db = sync_catalog.main(
        [
            "--database-url",
            "",
            "--scryfall-source",
            str(scryfall_path),
            "--skip-identifiers",
            "--skip-prices",
            "--skip-manapool",
        ]
    )
    assert rc_no_db == 2
