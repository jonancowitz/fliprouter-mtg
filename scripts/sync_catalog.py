#!/usr/bin/env python3
"""
Nightly Scryfall, MTGJSON & Mana Pool Streaming Ingestion Pipeline (04:00 UTC Cron).

Populates and refreshes PostgreSQL `card_catalog` in strict 5-stage order:
1. Scryfall `default_cards` bulk data -> card identity + Scryfall baseline USD prices.
2. MTGJSON `AllIdentifiers.json.bz2` -> `scryfall_id` <-> `mtgjson_uuid` & vendor IDs.
3. MTGJSON `AllPricesToday.json.bz2` -> `tcgplayer.retail`, `cardkingdom.buylist`,
   and `manapool.retail` daily prices across `normal`, `foil`, and `etched`.
4. Mana Pool public singles feed (`https://manapool.com/api/v1/prices/singles`) ->
   supplements any `normal`/`foil`/`etched` Mana Pool prices missing from MTGJSON.
5. Batched PostgreSQL writes in chunks of 5,000 rows (`ON CONFLICT (scryfall_id) DO UPDATE`
   for catalog upserts and batched updates by `scryfall_id` / `mtgjson_uuid`) plus
   TTL pruning of expired `sku_price_cache` rows (`expires_at <= NOW()`).

Hard Guardrails:
- Never scrapes HTML pages from TCGplayer, Card Kingdom, or eBay.
- Never loads multi-hundred-MB JSON payloads into memory; streams with `ijson`.
- Converts all currency values via `decimal.Decimal` quantized to `0.01` (`ROUND_HALF_UP`).
"""

from __future__ import annotations

import argparse
import bz2
import contextlib
import dataclasses
import gzip
import io
import itertools
import logging
import os
import sys
import uuid
from collections.abc import Generator, Iterable, Iterator
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from pathlib import Path
from typing import Any, BinaryIO, Protocol

import httpx
import ijson

LOGGER = logging.getLogger("fliprouter.sync_catalog")

DEFAULT_BATCH_SIZE = 5000
SCRYFALL_BULK_METADATA_URL = "https://api.scryfall.com/bulk-data/default-cards"
MTGJSON_IDENTIFIERS_URL = "https://mtgjson.com/api/v5/AllIdentifiers.json.bz2"
MTGJSON_PRICES_TODAY_URL = "https://mtgjson.com/api/v5/AllPricesToday.json.bz2"
MANAPOOL_SINGLES_URL = "https://manapool.com/api/v1/prices/singles"

DEFAULT_USER_AGENT = "FlipRouterMTG/0.1 (+https://github.com/jonancowitz/fliprouter-mtg)"
CENTS_QUANT = Decimal("0.01")
CENTS_DIVISOR = Decimal("100")
CK_CREDIT_MULTIPLIER = Decimal("1.30")
MAX_NUMERIC_10_2_USD = Decimal("99999999.99")


@dataclasses.dataclass(frozen=True, slots=True)
class ScryfallCatalogRecord:
    scryfall_id: str
    oracle_id: str
    tcgplayer_id: int | None
    tcgplayer_etched_id: int | None
    cardkingdom_id: int | None
    cardkingdom_foil_id: int | None
    name: str
    set_code: str
    set_name: str
    collector_number: str
    rarity: str
    finishes: list[str]
    image_uri: str | None
    tcg_market_nm: Decimal | None
    tcg_market_foil: Decimal | None
    tcg_market_etched: Decimal | None


@dataclasses.dataclass(frozen=True, slots=True)
class IdentifierMappingRecord:
    scryfall_id: str
    mtgjson_uuid: str
    tcgplayer_id: int | None = None
    tcgplayer_etched_id: int | None = None
    cardkingdom_id: int | None = None
    cardkingdom_foil_id: int | None = None


@dataclasses.dataclass(frozen=True, slots=True)
class PriceUpdateRecord:
    mtgjson_uuid: str
    tcg_market_nm: Decimal | None = None
    tcg_low_nm: Decimal | None = None
    tcg_market_foil: Decimal | None = None
    tcg_low_foil: Decimal | None = None
    tcg_market_etched: Decimal | None = None
    tcg_low_etched: Decimal | None = None
    manapool_low_nm: Decimal | None = None
    manapool_low_foil: Decimal | None = None
    manapool_low_etched: Decimal | None = None
    ck_buylist_cash_nm: Decimal | None = None
    ck_buylist_credit_nm: Decimal | None = None
    ck_buylist_cash_foil: Decimal | None = None
    ck_buylist_credit_foil: Decimal | None = None
    ck_buylist_cash_etched: Decimal | None = None
    ck_buylist_credit_etched: Decimal | None = None

    def has_any_price(self) -> bool:
        return any(
            value is not None
            for value in (
                self.tcg_market_nm,
                self.tcg_low_nm,
                self.tcg_market_foil,
                self.tcg_low_foil,
                self.tcg_market_etched,
                self.tcg_low_etched,
                self.manapool_low_nm,
                self.manapool_low_foil,
                self.manapool_low_etched,
                self.ck_buylist_cash_nm,
                self.ck_buylist_credit_nm,
                self.ck_buylist_cash_foil,
                self.ck_buylist_credit_foil,
                self.ck_buylist_cash_etched,
                self.ck_buylist_credit_etched,
            )
        )


@dataclasses.dataclass(frozen=True, slots=True)
class ManaPoolSingleRecord:
    scryfall_id: str
    tcgplayer_id: int | None = None
    manapool_low_nm: Decimal | None = None
    manapool_low_foil: Decimal | None = None
    manapool_low_etched: Decimal | None = None

    def has_any_price(self) -> bool:
        return any(
            value is not None
            for value in (
                self.manapool_low_nm,
                self.manapool_low_foil,
                self.manapool_low_etched,
            )
        )


@dataclasses.dataclass(slots=True)
class SyncStats:
    scryfall_seen: int = 0
    scryfall_upserted: int = 0
    scryfall_batches: int = 0
    identifiers_seen: int = 0
    identifiers_mapped: int = 0
    identifiers_batches: int = 0
    daily_prices_reset: int = 0
    prices_seen: int = 0
    prices_updated: int = 0
    prices_batches: int = 0
    manapool_seen: int = 0
    manapool_supplemented: int = 0
    manapool_batches: int = 0
    manapool_fallback_failed: bool = False
    sku_cache_pruned: int = 0


UPSERT_SCRYFALL_SQL = """
INSERT INTO card_catalog (
    scryfall_id,
    oracle_id,
    tcgplayer_id,
    tcgplayer_etched_id,
    cardkingdom_id,
    cardkingdom_foil_id,
    name,
    set_code,
    set_name,
    collector_number,
    rarity,
    finishes,
    image_uri,
    tcg_market_nm,
    tcg_market_foil,
    tcg_market_etched,
    updated_at
) VALUES (
    %(scryfall_id)s::uuid,
    %(oracle_id)s::uuid,
    %(tcgplayer_id)s::integer,
    %(tcgplayer_etched_id)s::integer,
    %(cardkingdom_id)s::integer,
    %(cardkingdom_foil_id)s::integer,
    %(name)s::text,
    %(set_code)s::varchar(16),
    %(set_name)s::text,
    %(collector_number)s::varchar(32),
    %(rarity)s::varchar(16),
    %(finishes)s::text[],
    %(image_uri)s::text,
    %(tcg_market_nm)s::numeric(10, 2),
    %(tcg_market_foil)s::numeric(10, 2),
    %(tcg_market_etched)s::numeric(10, 2),
    NOW()
)
ON CONFLICT (scryfall_id) DO UPDATE SET
    oracle_id = EXCLUDED.oracle_id,
    tcgplayer_id = COALESCE(EXCLUDED.tcgplayer_id, card_catalog.tcgplayer_id),
    tcgplayer_etched_id = COALESCE(EXCLUDED.tcgplayer_etched_id, card_catalog.tcgplayer_etched_id),
    cardkingdom_id = COALESCE(EXCLUDED.cardkingdom_id, card_catalog.cardkingdom_id),
    cardkingdom_foil_id = COALESCE(EXCLUDED.cardkingdom_foil_id, card_catalog.cardkingdom_foil_id),
    name = EXCLUDED.name,
    set_code = EXCLUDED.set_code,
    set_name = EXCLUDED.set_name,
    collector_number = EXCLUDED.collector_number,
    rarity = EXCLUDED.rarity,
    finishes = EXCLUDED.finishes,
    image_uri = COALESCE(EXCLUDED.image_uri, card_catalog.image_uri),
    tcg_market_nm = COALESCE(EXCLUDED.tcg_market_nm, card_catalog.tcg_market_nm),
    tcg_market_foil = COALESCE(EXCLUDED.tcg_market_foil, card_catalog.tcg_market_foil),
    tcg_market_etched = COALESCE(EXCLUDED.tcg_market_etched, card_catalog.tcg_market_etched),
    updated_at = NOW();
"""

UPDATE_IDENTIFIERS_SQL = """
UPDATE card_catalog
SET
    mtgjson_uuid = CASE
        WHEN EXISTS (
            SELECT 1
            FROM card_catalog existing
            WHERE existing.mtgjson_uuid = %(mtgjson_uuid)s::uuid
              AND existing.scryfall_id <> %(scryfall_id)s::uuid
        ) THEN card_catalog.mtgjson_uuid
        ELSE %(mtgjson_uuid)s::uuid
    END,
    tcgplayer_id = COALESCE(%(tcgplayer_id)s::integer, tcgplayer_id),
    tcgplayer_etched_id = COALESCE(%(tcgplayer_etched_id)s::integer, tcgplayer_etched_id),
    cardkingdom_id = COALESCE(%(cardkingdom_id)s::integer, cardkingdom_id),
    cardkingdom_foil_id = COALESCE(%(cardkingdom_foil_id)s::integer, cardkingdom_foil_id),
    updated_at = NOW()
WHERE scryfall_id = %(scryfall_id)s::uuid;
"""

RESET_DAILY_VENDOR_PRICES_SQL = """
UPDATE card_catalog
SET
    tcg_low_nm = NULL,
    tcg_low_foil = NULL,
    tcg_low_etched = NULL,
    manapool_low_nm = NULL,
    manapool_low_foil = NULL,
    manapool_low_etched = NULL,
    ck_buylist_cash_nm = NULL,
    ck_buylist_credit_nm = NULL,
    ck_buylist_cash_foil = NULL,
    ck_buylist_credit_foil = NULL,
    ck_buylist_cash_etched = NULL,
    ck_buylist_credit_etched = NULL,
    updated_at = NOW()
WHERE tcg_low_nm IS NOT NULL
   OR tcg_low_foil IS NOT NULL
   OR tcg_low_etched IS NOT NULL
   OR manapool_low_nm IS NOT NULL
   OR manapool_low_foil IS NOT NULL
   OR manapool_low_etched IS NOT NULL
   OR ck_buylist_cash_nm IS NOT NULL
   OR ck_buylist_credit_nm IS NOT NULL
   OR ck_buylist_cash_foil IS NOT NULL
   OR ck_buylist_credit_foil IS NOT NULL
   OR ck_buylist_cash_etched IS NOT NULL
   OR ck_buylist_credit_etched IS NOT NULL;
"""

UPDATE_PRICES_BY_MTGJSON_SQL = """
UPDATE card_catalog
SET
    tcg_market_nm = COALESCE(%(tcg_market_nm)s::numeric(10, 2), tcg_market_nm),
    tcg_low_nm = %(tcg_low_nm)s::numeric(10, 2),
    tcg_market_foil = COALESCE(%(tcg_market_foil)s::numeric(10, 2), tcg_market_foil),
    tcg_low_foil = %(tcg_low_foil)s::numeric(10, 2),
    tcg_market_etched = COALESCE(%(tcg_market_etched)s::numeric(10, 2), tcg_market_etched),
    tcg_low_etched = %(tcg_low_etched)s::numeric(10, 2),
    manapool_low_nm = %(manapool_low_nm)s::numeric(10, 2),
    manapool_low_foil = %(manapool_low_foil)s::numeric(10, 2),
    manapool_low_etched = %(manapool_low_etched)s::numeric(10, 2),
    ck_buylist_cash_nm = %(ck_buylist_cash_nm)s::numeric(10, 2),
    ck_buylist_credit_nm = %(ck_buylist_credit_nm)s::numeric(10, 2),
    ck_buylist_cash_foil = %(ck_buylist_cash_foil)s::numeric(10, 2),
    ck_buylist_credit_foil = %(ck_buylist_credit_foil)s::numeric(10, 2),
    ck_buylist_cash_etched = %(ck_buylist_cash_etched)s::numeric(10, 2),
    ck_buylist_credit_etched = %(ck_buylist_credit_etched)s::numeric(10, 2),
    updated_at = NOW()
WHERE mtgjson_uuid = %(mtgjson_uuid)s::uuid;
"""

SUPPLEMENT_MANAPOOL_BY_SCRYFALL_SQL = """
UPDATE card_catalog
SET
    tcgplayer_id = COALESCE(card_catalog.tcgplayer_id, %(tcgplayer_id)s::integer),
    manapool_low_nm = COALESCE(card_catalog.manapool_low_nm, %(manapool_low_nm)s::numeric(10, 2)),
    manapool_low_foil = COALESCE(card_catalog.manapool_low_foil, %(manapool_low_foil)s::numeric(10, 2)),
    manapool_low_etched = COALESCE(card_catalog.manapool_low_etched, %(manapool_low_etched)s::numeric(10, 2)),
    updated_at = NOW()
WHERE scryfall_id = %(scryfall_id)s::uuid
  AND (
      (card_catalog.tcgplayer_id IS NULL AND %(tcgplayer_id)s::integer IS NOT NULL)
      OR (card_catalog.manapool_low_nm IS NULL AND %(manapool_low_nm)s::numeric(10, 2) IS NOT NULL)
      OR (card_catalog.manapool_low_foil IS NULL AND %(manapool_low_foil)s::numeric(10, 2) IS NOT NULL)
      OR (card_catalog.manapool_low_etched IS NULL AND %(manapool_low_etched)s::numeric(10, 2) IS NOT NULL)
  );
"""

REFRESH_MANAPOOL_BY_SCRYFALL_SQL = """
UPDATE card_catalog
SET
    tcgplayer_id = COALESCE(card_catalog.tcgplayer_id, %(tcgplayer_id)s::integer),
    manapool_low_nm = %(manapool_low_nm)s::numeric(10, 2),
    manapool_low_foil = %(manapool_low_foil)s::numeric(10, 2),
    manapool_low_etched = %(manapool_low_etched)s::numeric(10, 2),
    updated_at = NOW()
WHERE scryfall_id = %(scryfall_id)s::uuid
  AND (
      (card_catalog.tcgplayer_id IS NULL AND %(tcgplayer_id)s::integer IS NOT NULL)
      OR card_catalog.manapool_low_nm IS DISTINCT FROM %(manapool_low_nm)s::numeric(10, 2)
      OR card_catalog.manapool_low_foil IS DISTINCT FROM %(manapool_low_foil)s::numeric(10, 2)
      OR card_catalog.manapool_low_etched IS DISTINCT FROM %(manapool_low_etched)s::numeric(10, 2)
  );
"""

PRUNE_EXPIRED_SKU_CACHE_SQL = """
DELETE FROM sku_price_cache
WHERE expires_at <= NOW();
"""


class CatalogSink(Protocol):
    def upsert_scryfall_batch(self, batch: list[ScryfallCatalogRecord]) -> int: ...

    def update_identifier_batch(self, batch: list[IdentifierMappingRecord]) -> int: ...

    def reset_daily_vendor_prices(self) -> int: ...

    def update_price_batch(self, batch: list[PriceUpdateRecord]) -> int: ...

    def supplement_manapool_batch(
        self,
        batch: list[ManaPoolSingleRecord],
        *,
        overwrite: bool = False,
    ) -> int: ...

    def prune_expired_sku_cache(self) -> int: ...


class DryRunCatalogSink:
    """No-op database sink for --dry-run verification and smoke tests."""

    def upsert_scryfall_batch(self, batch: list[ScryfallCatalogRecord]) -> int:
        return len(batch)

    def update_identifier_batch(self, batch: list[IdentifierMappingRecord]) -> int:
        return len(batch)

    def reset_daily_vendor_prices(self) -> int:
        return 0

    def update_price_batch(self, batch: list[PriceUpdateRecord]) -> int:
        return len(batch)

    def supplement_manapool_batch(
        self,
        batch: list[ManaPoolSingleRecord],
        *,
        overwrite: bool = False,
    ) -> int:
        _ = overwrite
        return len(batch)

    def prune_expired_sku_cache(self) -> int:
        return 0


class PostgresCatalogSink:
    """Batched PostgreSQL sink backed by psycopg v3."""

    def __init__(self, conn: Any) -> None:
        self._conn = conn

    def upsert_scryfall_batch(self, batch: list[ScryfallCatalogRecord]) -> int:
        if not batch:
            return 0
        deduped = {record.scryfall_id: dataclasses.asdict(record) for record in batch}
        rows = list(deduped.values())
        with self._conn.transaction():
            with self._conn.cursor() as cur:
                cur.executemany(UPSERT_SCRYFALL_SQL, rows)
        return len(rows)

    def update_identifier_batch(self, batch: list[IdentifierMappingRecord]) -> int:
        if not batch:
            return 0
        by_scryfall: dict[str, IdentifierMappingRecord] = {}
        seen_mtgjson: set[str] = set()
        for record in batch:
            if record.mtgjson_uuid in seen_mtgjson:
                continue
            seen_mtgjson.add(record.mtgjson_uuid)
            by_scryfall[record.scryfall_id] = record
        rows = [dataclasses.asdict(rec) for rec in by_scryfall.values()]
        with self._conn.transaction():
            with self._conn.cursor() as cur:
                cur.executemany(UPDATE_IDENTIFIERS_SQL, rows)
        return len(rows)

    def reset_daily_vendor_prices(self) -> int:
        with self._conn.transaction():
            with self._conn.cursor() as cur:
                cur.execute(RESET_DAILY_VENDOR_PRICES_SQL)
                rowcount = getattr(cur, "rowcount", 0)
                return int(rowcount) if isinstance(rowcount, int) and rowcount > 0 else 0

    def update_price_batch(self, batch: list[PriceUpdateRecord]) -> int:
        if not batch:
            return 0
        deduped = {record.mtgjson_uuid: dataclasses.asdict(record) for record in batch}
        rows = list(deduped.values())
        with self._conn.transaction():
            with self._conn.cursor() as cur:
                cur.executemany(UPDATE_PRICES_BY_MTGJSON_SQL, rows)
        return len(rows)

    def supplement_manapool_batch(
        self,
        batch: list[ManaPoolSingleRecord],
        *,
        overwrite: bool = False,
    ) -> int:
        if not batch:
            return 0
        deduped = {record.scryfall_id: dataclasses.asdict(record) for record in batch}
        rows = list(deduped.values())
        sql = (
            REFRESH_MANAPOOL_BY_SCRYFALL_SQL
            if overwrite
            else SUPPLEMENT_MANAPOOL_BY_SCRYFALL_SQL
        )
        with self._conn.transaction():
            with self._conn.cursor() as cur:
                cur.executemany(sql, rows)
        return len(rows)

    def prune_expired_sku_cache(self) -> int:
        with self._conn.transaction():
            with self._conn.cursor() as cur:
                cur.execute(PRUNE_EXPIRED_SKU_CACHE_SQL)
                rowcount = getattr(cur, "rowcount", 0)
                return int(rowcount) if isinstance(rowcount, int) and rowcount > 0 else 0


def parse_usd(raw: Any) -> Decimal | None:
    """Convert raw JSON value into a 2-decimal USD Decimal without float rounding."""
    if raw is None or isinstance(raw, bool):
        return None
    if isinstance(raw, Decimal):
        dec = raw
    elif isinstance(raw, int):
        dec = Decimal(raw)
    elif isinstance(raw, float):
        dec = Decimal(str(raw))
    elif isinstance(raw, str):
        stripped = raw.strip()
        if not stripped:
            return None
        try:
            dec = Decimal(stripped)
        except InvalidOperation:
            return None
    else:
        return None

    if not dec.is_finite() or dec < 0:
        return None
    quantized = dec.quantize(CENTS_QUANT, rounding=ROUND_HALF_UP)
    if quantized > MAX_NUMERIC_10_2_USD:
        return None
    return quantized


def parse_cents_to_usd(raw: Any) -> Decimal | None:
    """Convert integer cents (e.g., Mana Pool `price_cents_nm`) into exact 2-decimal USD."""
    if raw is None or isinstance(raw, bool):
        return None
    if isinstance(raw, int):
        cents = Decimal(raw)
    elif isinstance(raw, Decimal):
        cents = raw
    elif isinstance(raw, str) and raw.strip().isdigit():
        cents = Decimal(raw.strip())
    else:
        return None

    if not cents.is_finite() or cents < 0:
        return None
    quantized = (cents / CENTS_DIVISOR).quantize(CENTS_QUANT, rounding=ROUND_HALF_UP)
    if quantized > MAX_NUMERIC_10_2_USD:
        return None
    return quantized


def compute_ck_credit(
    cash: Decimal | None,
    explicit_credit: Decimal | None = None,
) -> Decimal | None:
    if explicit_credit is not None:
        return explicit_credit if explicit_credit <= MAX_NUMERIC_10_2_USD else None
    if cash is None:
        return None
    credit = (cash * CK_CREDIT_MULTIPLIER).quantize(CENTS_QUANT, rounding=ROUND_HALF_UP)
    if credit > MAX_NUMERIC_10_2_USD:
        return None
    return credit


def normalize_uuid(raw: Any) -> str | None:
    if not isinstance(raw, str) or not raw.strip():
        return None
    try:
        return str(uuid.UUID(raw.strip()))
    except ValueError:
        return None


def parse_optional_int(raw: Any) -> int | None:
    if raw is None or isinstance(raw, bool):
        return None
    if isinstance(raw, int):
        return raw
    if isinstance(raw, str):
        stripped = raw.strip()
        if stripped.isdigit():
            return int(stripped)
    return None


def chunked(iterable: Iterable[Any], size: int) -> Iterator[list[Any]]:
    if size <= 0:
        raise ValueError("batch size must be positive")
    iterator = iter(iterable)
    while True:
        batch = list(itertools.islice(iterator, size))
        if not batch:
            return
        yield batch


def resolve_image_uri(card: dict[str, Any]) -> str | None:
    image_uris = card.get("image_uris")
    if isinstance(image_uris, dict):
        uri = image_uris.get("normal") or image_uris.get("large") or image_uris.get("small")
        if isinstance(uri, str) and uri:
            return uri

    faces = card.get("card_faces")
    if isinstance(faces, list):
        for face in faces:
            if isinstance(face, dict):
                face_uris = face.get("image_uris")
                if isinstance(face_uris, dict):
                    uri = (
                        face_uris.get("normal")
                        or face_uris.get("large")
                        or face_uris.get("small")
                    )
                    if isinstance(uri, str) and uri:
                        return uri
    return None


def resolve_oracle_id(card: dict[str, Any]) -> str | None:
    direct = normalize_uuid(card.get("oracle_id"))
    if direct:
        return direct
    faces = card.get("card_faces")
    if isinstance(faces, list):
        for face in faces:
            if isinstance(face, dict):
                face_oracle = normalize_uuid(face.get("oracle_id"))
                if face_oracle:
                    return face_oracle
    return None


def normalize_scryfall_card(card: dict[str, Any]) -> ScryfallCatalogRecord | None:
    games = card.get("games")
    if isinstance(games, list) and games and "paper" not in games:
        return None

    scryfall_id = normalize_uuid(card.get("id"))
    oracle_id = resolve_oracle_id(card)
    name = card.get("name")
    set_code = card.get("set")
    set_name = card.get("set_name")
    collector_number = card.get("collector_number")
    rarity = card.get("rarity")

    if not (
        scryfall_id
        and oracle_id
        and isinstance(name, str)
        and name
        and isinstance(set_code, str)
        and set_code
        and isinstance(set_name, str)
        and set_name
        and isinstance(collector_number, str)
        and collector_number
        and isinstance(rarity, str)
        and rarity
    ):
        return None

    raw_finishes = card.get("finishes")
    if isinstance(raw_finishes, list) and raw_finishes:
        finishes = [str(f) for f in raw_finishes if isinstance(f, str) and f]
    else:
        finishes = ["nonfoil"]

    prices = card.get("prices") if isinstance(card.get("prices"), dict) else {}

    return ScryfallCatalogRecord(
        scryfall_id=scryfall_id,
        oracle_id=oracle_id,
        tcgplayer_id=parse_optional_int(card.get("tcgplayer_id")),
        tcgplayer_etched_id=parse_optional_int(card.get("tcgplayer_etched_id")),
        cardkingdom_id=parse_optional_int(card.get("cardkingdom_id")),
        cardkingdom_foil_id=parse_optional_int(card.get("cardkingdom_foil_id")),
        name=name,
        set_code=set_code.lower(),
        set_name=set_name,
        collector_number=collector_number,
        rarity=rarity.lower(),
        finishes=finishes,
        image_uri=resolve_image_uri(card),
        tcg_market_nm=parse_usd(prices.get("usd")),
        tcg_market_foil=parse_usd(prices.get("usd_foil")),
        tcg_market_etched=parse_usd(prices.get("usd_etched")),
    )


def extract_identifier_mapping(
    mtgjson_uuid_raw: str,
    card_obj: dict[str, Any],
) -> IdentifierMappingRecord | None:
    if not isinstance(card_obj, dict):
        return None

    # For multi-face MTGJSON entries sharing one Scryfall printing ID, only bind primary side ('a' or None)
    side = card_obj.get("side")
    if side not in (None, "a"):
        return None

    availability = card_obj.get("availability")
    if isinstance(availability, list) and availability and "paper" not in availability:
        return None

    mtgjson_uuid = normalize_uuid(mtgjson_uuid_raw)
    identifiers = card_obj.get("identifiers")
    if not mtgjson_uuid or not isinstance(identifiers, dict):
        return None

    scryfall_id = normalize_uuid(identifiers.get("scryfallId"))
    if not scryfall_id:
        return None

    return IdentifierMappingRecord(
        scryfall_id=scryfall_id,
        mtgjson_uuid=mtgjson_uuid,
        tcgplayer_id=parse_optional_int(identifiers.get("tcgplayerProductId")),
        tcgplayer_etched_id=parse_optional_int(identifiers.get("tcgplayerEtchedProductId")),
        cardkingdom_id=parse_optional_int(identifiers.get("cardKingdomId")),
        cardkingdom_foil_id=parse_optional_int(identifiers.get("cardKingdomFoilId")),
    )


def latest_series_price(series: Any) -> Decimal | None:
    if not isinstance(series, dict) or not series:
        return None
    latest_date = max(str(k) for k in series.keys())
    return parse_usd(series.get(latest_date))


def extract_price_update(
    mtgjson_uuid_raw: str,
    payload: dict[str, Any],
) -> PriceUpdateRecord | None:
    mtgjson_uuid = normalize_uuid(mtgjson_uuid_raw)
    if not mtgjson_uuid or not isinstance(payload, dict):
        return None

    paper = payload.get("paper")
    if not isinstance(paper, dict) or not paper:
        return None

    tcgplayer = paper.get("tcgplayer") if isinstance(paper.get("tcgplayer"), dict) else {}
    tcg_retail = (
        tcgplayer.get("retail") if isinstance(tcgplayer.get("retail"), dict) else {}
    )
    tcg_retail_low = (
        tcgplayer.get("retail_low")
        if isinstance(tcgplayer.get("retail_low"), dict)
        else {}
    )

    manapool = paper.get("manapool") if isinstance(paper.get("manapool"), dict) else {}
    manapool_retail = (
        manapool.get("retail") if isinstance(manapool.get("retail"), dict) else {}
    )

    cardkingdom = (
        paper.get("cardkingdom") if isinstance(paper.get("cardkingdom"), dict) else {}
    )
    ck_buylist = (
        cardkingdom.get("buylist")
        if isinstance(cardkingdom.get("buylist"), dict)
        else {}
    )
    ck_buylist_credit = (
        cardkingdom.get("buylist_credit")
        if isinstance(cardkingdom.get("buylist_credit"), dict)
        else {}
    )

    ck_cash_nm = latest_series_price(ck_buylist.get("normal"))
    ck_cash_foil = latest_series_price(ck_buylist.get("foil"))
    ck_cash_etched = latest_series_price(ck_buylist.get("etched"))
    explicit_credit_nm = latest_series_price(ck_buylist_credit.get("normal"))
    explicit_credit_foil = latest_series_price(ck_buylist_credit.get("foil"))
    explicit_credit_etched = latest_series_price(ck_buylist_credit.get("etched"))

    record = PriceUpdateRecord(
        mtgjson_uuid=mtgjson_uuid,
        tcg_market_nm=latest_series_price(tcg_retail.get("normal")),
        tcg_low_nm=latest_series_price(tcg_retail_low.get("normal")),
        tcg_market_foil=latest_series_price(tcg_retail.get("foil")),
        tcg_low_foil=latest_series_price(tcg_retail_low.get("foil")),
        tcg_market_etched=latest_series_price(tcg_retail.get("etched")),
        tcg_low_etched=latest_series_price(tcg_retail_low.get("etched")),
        manapool_low_nm=latest_series_price(manapool_retail.get("normal")),
        manapool_low_foil=latest_series_price(manapool_retail.get("foil")),
        manapool_low_etched=latest_series_price(manapool_retail.get("etched")),
        ck_buylist_cash_nm=ck_cash_nm,
        ck_buylist_credit_nm=compute_ck_credit(ck_cash_nm, explicit_credit_nm),
        ck_buylist_cash_foil=ck_cash_foil,
        ck_buylist_credit_foil=compute_ck_credit(ck_cash_foil, explicit_credit_foil),
        ck_buylist_cash_etched=ck_cash_etched,
        ck_buylist_credit_etched=compute_ck_credit(
            ck_cash_etched, explicit_credit_etched
        ),
    )
    return record if record.has_any_price() else None


def extract_manapool_single(entry: dict[str, Any]) -> ManaPoolSingleRecord | None:
    if not isinstance(entry, dict):
        return None

    scryfall_id = normalize_uuid(entry.get("scryfall_id"))
    if not scryfall_id and isinstance(entry.get("scryfall_ids"), list):
        for candidate in entry["scryfall_ids"]:
            scryfall_id = normalize_uuid(candidate)
            if scryfall_id:
                break
    if not scryfall_id:
        return None

    # Restrict strictly to Near Mint Mana Pool quotes (`price_cents_nm*`); never fall back
    # to unconstrained `price_cents*`, which includes HP/DMG listings and would cause
    # double condition discounting when Step 3 applies non-NM multipliers.
    nm = parse_cents_to_usd(entry.get("price_cents_nm"))
    foil = parse_cents_to_usd(entry.get("price_cents_nm_foil"))
    etched = parse_cents_to_usd(entry.get("price_cents_nm_etched"))

    record = ManaPoolSingleRecord(
        scryfall_id=scryfall_id,
        tcgplayer_id=parse_optional_int(entry.get("tcgplayer_product_id")),
        manapool_low_nm=nm,
        manapool_low_foil=foil,
        manapool_low_etched=etched,
    )
    return record if record.has_any_price() else None


class _HttpRawStream(io.RawIOBase):
    """Adapts an httpx byte iterator into a readable RawIOBase stream for ijson/gzip/bz2."""

    def __init__(self, byte_iter: Iterator[bytes]) -> None:
        super().__init__()
        self._iter = byte_iter
        self._buffer = bytearray()
        self._eof = False

    def readable(self) -> bool:
        return True

    def readinto(self, b: Any) -> int:
        target = memoryview(b)
        desired = len(target)
        if desired == 0:
            return 0
        while len(self._buffer) < desired and not self._eof:
            try:
                chunk = next(self._iter)
            except StopIteration:
                self._eof = True
                break
            if chunk:
                self._buffer.extend(chunk)
        n = min(desired, len(self._buffer))
        if n == 0:
            return 0
        target[:n] = self._buffer[:n]
        del self._buffer[:n]
        return n


def _wrap_decompressed_stream(
    raw_stream: BinaryIO,
    source_name: str,
    stack: contextlib.ExitStack,
) -> io.BufferedReader:
    _ = source_name
    buffered = io.BufferedReader(raw_stream)
    magic = buffered.peek(4)

    if magic.startswith(b"\x1f\x8b"):
        gz_file = stack.enter_context(gzip.GzipFile(fileobj=buffered, mode="rb"))
        return io.BufferedReader(gz_file)

    if magic.startswith(b"BZh"):
        bz_file = stack.enter_context(bz2.BZ2File(buffered, mode="rb"))
        return io.BufferedReader(bz_file)

    return buffered


@contextlib.contextmanager
def open_streaming_source(
    source: str | Path,
    client: httpx.Client | None = None,
) -> Generator[io.BufferedReader, None, None]:
    source_str = str(source)
    with contextlib.ExitStack() as stack:
        if source_str.startswith(("http://", "https://")):
            http_client = client or stack.enter_context(build_http_client())
            response = stack.enter_context(http_client.stream("GET", source_str))
            response.raise_for_status()
            raw_reader: BinaryIO = _HttpRawStream(response.iter_bytes(chunk_size=65536))
            yield _wrap_decompressed_stream(raw_reader, source_str, stack)
        else:
            file_obj = stack.enter_context(Path(source_str).open("rb"))
            yield _wrap_decompressed_stream(file_obj, source_str, stack)


def build_http_client(user_agent: str | None = None) -> httpx.Client:
    ua = user_agent or os.environ.get("SCRYFALL_USER_AGENT") or DEFAULT_USER_AGENT
    return httpx.Client(
        headers={
            "User-Agent": ua,
            "Accept": "application/json",
        },
        follow_redirects=True,
        timeout=httpx.Timeout(connect=30.0, read=120.0, write=30.0, pool=30.0),
    )


def fetch_scryfall_download_uri(
    client: httpx.Client,
    metadata_url: str = SCRYFALL_BULK_METADATA_URL,
) -> str:
    resp = client.get(metadata_url)
    resp.raise_for_status()
    payload = resp.json()
    uri = payload.get("download_uri") or payload.get("jsonl_download_uri")
    if not isinstance(uri, str) or not uri:
        raise RuntimeError(
            f"Scryfall bulk metadata missing download_uri/jsonl_download_uri: {payload!r}"
        )
    return uri


def iter_scryfall_stream(stream: io.BufferedReader) -> Iterator[dict[str, Any]]:
    """
    Stream Scryfall cards via `ijson` from either:
    - Top-level JSON array (`[ {...}, {...} ]` -> `ijson.items(stream, 'item')`)
    - JSON Lines (`{...}\\n{...}` -> `ijson.items(stream, '', multiple_values=True)`)
    """
    peeked = stream.peek(64).lstrip()
    if peeked.startswith(b"["):
        yield from ijson.items(stream, "item")
    else:
        yield from ijson.items(stream, "", multiple_values=True)


def sync_scryfall_stage(
    stream: io.BufferedReader,
    sink: CatalogSink,
    stats: SyncStats,
    batch_size: int = DEFAULT_BATCH_SIZE,
    limit: int | None = None,
) -> None:
    def normalized_records() -> Iterator[ScryfallCatalogRecord]:
        for raw_card in iter_scryfall_stream(stream):
            stats.scryfall_seen += 1
            if isinstance(raw_card, dict):
                normalized = normalize_scryfall_card(raw_card)
                if normalized is not None:
                    yield normalized
            if limit is not None and stats.scryfall_seen >= limit:
                break

    for batch in chunked(normalized_records(), batch_size):
        stats.scryfall_upserted += sink.upsert_scryfall_batch(batch)
        stats.scryfall_batches += 1


def sync_identifiers_stage(
    stream: io.BufferedReader,
    sink: CatalogSink,
    stats: SyncStats,
    batch_size: int = DEFAULT_BATCH_SIZE,
    limit: int | None = None,
) -> None:
    def mapped_records() -> Iterator[IdentifierMappingRecord]:
        for mtgjson_uuid, card_obj in ijson.kvitems(stream, "data"):
            stats.identifiers_seen += 1
            mapping = extract_identifier_mapping(mtgjson_uuid, card_obj)
            if mapping is not None:
                yield mapping
            if limit is not None and stats.identifiers_seen >= limit:
                break

    for batch in chunked(mapped_records(), batch_size):
        stats.identifiers_mapped += sink.update_identifier_batch(batch)
        stats.identifiers_batches += 1


def sync_prices_stage(
    stream: io.BufferedReader,
    sink: CatalogSink,
    stats: SyncStats,
    batch_size: int = DEFAULT_BATCH_SIZE,
    limit: int | None = None,
) -> None:
    def price_records() -> Iterator[PriceUpdateRecord]:
        for mtgjson_uuid, payload in ijson.kvitems(stream, "data"):
            stats.prices_seen += 1
            record = extract_price_update(mtgjson_uuid, payload)
            if record is not None:
                yield record
            if limit is not None and stats.prices_seen >= limit:
                break

    for batch in chunked(price_records(), batch_size):
        stats.prices_updated += sink.update_price_batch(batch)
        stats.prices_batches += 1


def sync_manapool_singles_stage(
    stream: io.BufferedReader,
    sink: CatalogSink,
    stats: SyncStats,
    batch_size: int = DEFAULT_BATCH_SIZE,
    limit: int | None = None,
    overwrite: bool = False,
) -> None:
    def single_records() -> Iterator[ManaPoolSingleRecord]:
        for entry in ijson.items(stream, "data.item"):
            stats.manapool_seen += 1
            record = extract_manapool_single(entry)
            if record is not None:
                yield record
            if limit is not None and stats.manapool_seen >= limit:
                break

    for batch in chunked(single_records(), batch_size):
        stats.manapool_supplemented += sink.supplement_manapool_batch(
            batch,
            overwrite=overwrite,
        )
        stats.manapool_batches += 1


def run_sync_pipeline(
    sink: CatalogSink,
    *,
    scryfall_source: str | Path | None = None,
    identifiers_source: str | Path | None = MTGJSON_IDENTIFIERS_URL,
    prices_source: str | Path | None = MTGJSON_PRICES_TODAY_URL,
    manapool_source: str | Path | None = MANAPOOL_SINGLES_URL,
    skip_scryfall: bool = False,
    skip_identifiers: bool = False,
    skip_prices: bool = False,
    skip_manapool: bool = False,
    strict_manapool: bool = False,
    skip_prune_sku_cache: bool = False,
    batch_size: int = DEFAULT_BATCH_SIZE,
    limit: int | None = None,
    http_client: httpx.Client | None = None,
) -> SyncStats:
    stats = SyncStats()
    with contextlib.ExitStack() as stack:
        client = http_client or stack.enter_context(build_http_client())

        if not skip_scryfall:
            resolved_scryfall = scryfall_source or fetch_scryfall_download_uri(client)
            LOGGER.info(
                "Stage 1/4: Streaming Scryfall default_cards from %s", resolved_scryfall
            )
            with open_streaming_source(resolved_scryfall, client=client) as stream:
                sync_scryfall_stage(
                    stream,
                    sink,
                    stats,
                    batch_size=batch_size,
                    limit=limit,
                )
            LOGGER.info(
                "Stage 1 complete: seen=%d upserted=%d batches=%d",
                stats.scryfall_seen,
                stats.scryfall_upserted,
                stats.scryfall_batches,
            )

        if not skip_identifiers and identifiers_source is not None:
            LOGGER.info(
                "Stage 2/4: Streaming MTGJSON AllIdentifiers from %s", identifiers_source
            )
            with open_streaming_source(identifiers_source, client=client) as stream:
                sync_identifiers_stage(
                    stream,
                    sink,
                    stats,
                    batch_size=batch_size,
                    limit=limit,
                )
            LOGGER.info(
                "Stage 2 complete: seen=%d mapped=%d batches=%d",
                stats.identifiers_seen,
                stats.identifiers_mapped,
                stats.identifiers_batches,
            )

        if not skip_prices and prices_source is not None:
            LOGGER.info(
                "Stage 3/4: Streaming MTGJSON AllPricesToday from %s", prices_source
            )
            with open_streaming_source(prices_source, client=client) as stream:
                if limit is None and stream.peek(4):
                    stats.daily_prices_reset = sink.reset_daily_vendor_prices()
                sync_prices_stage(
                    stream,
                    sink,
                    stats,
                    batch_size=batch_size,
                    limit=limit,
                )
            LOGGER.info(
                "Stage 3 complete: reset=%d seen=%d updated=%d batches=%d",
                stats.daily_prices_reset,
                stats.prices_seen,
                stats.prices_updated,
                stats.prices_batches,
            )

        if not skip_manapool and manapool_source is not None:
            LOGGER.info(
                "Stage 4/4: Streaming Mana Pool singles supplement from %s",
                manapool_source,
            )
            try:
                with open_streaming_source(manapool_source, client=client) as stream:
                    sync_manapool_singles_stage(
                        stream,
                        sink,
                        stats,
                        batch_size=batch_size,
                        limit=limit,
                        overwrite=skip_prices,
                    )
                LOGGER.info(
                    "Stage 4 complete: seen=%d supplemented=%d batches=%d",
                    stats.manapool_seen,
                    stats.manapool_supplemented,
                    stats.manapool_batches,
                )
            except (httpx.HTTPError, OSError, ijson.JSONError) as exc:
                stats.manapool_fallback_failed = True
                if strict_manapool:
                    raise
                LOGGER.warning(
                    "Mana Pool singles supplement failed gracefully (continuing with MTGJSON baseline): %s",
                    exc,
                )

        if not skip_prune_sku_cache:
            stats.sku_cache_pruned = sink.prune_expired_sku_cache()

    return stats


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Stream Scryfall Bulk Data, MTGJSON AllPricesToday & Mana Pool singles into PostgreSQL card_catalog."
    )
    parser.add_argument(
        "--database-url",
        default=os.environ.get("DATABASE_URL"),
        help="PostgreSQL connection string (defaults to DATABASE_URL env var).",
    )
    parser.add_argument(
        "--scryfall-source",
        default=None,
        help="Override Scryfall default_cards URL or local JSON/JSONL(.gz/.bz2) path.",
    )
    parser.add_argument(
        "--identifiers-source",
        default=MTGJSON_IDENTIFIERS_URL,
        help="Override MTGJSON AllIdentifiers URL or local (.json/.bz2) path.",
    )
    parser.add_argument(
        "--prices-source",
        default=MTGJSON_PRICES_TODAY_URL,
        help="Override MTGJSON AllPricesToday URL or local (.json/.bz2) path.",
    )
    parser.add_argument(
        "--manapool-source",
        default=MANAPOOL_SINGLES_URL,
        help="Override Mana Pool singles JSON URL or local path.",
    )
    parser.add_argument(
        "--skip-scryfall",
        action="store_true",
        help="Skip Stage 1 Scryfall default_cards sync.",
    )
    parser.add_argument(
        "--skip-identifiers",
        action="store_true",
        help="Skip Stage 2 MTGJSON AllIdentifiers mapping sync.",
    )
    parser.add_argument(
        "--skip-prices",
        action="store_true",
        help="Skip Stage 3 MTGJSON AllPricesToday price sync.",
    )
    parser.add_argument(
        "--skip-manapool",
        action="store_true",
        help="Skip Stage 4 Mana Pool public singles supplement.",
    )
    parser.add_argument(
        "--strict-manapool",
        action="store_true",
        help="Fail pipeline instead of logging warning if Mana Pool singles endpoint errors.",
    )
    parser.add_argument(
        "--skip-prune-sku-cache",
        action="store_true",
        help="Skip pruning expired rows from sku_price_cache.",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=DEFAULT_BATCH_SIZE,
        help=f"Database batch upsert chunk size (default: {DEFAULT_BATCH_SIZE}).",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Optional per-stage record cap for smoke testing.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Stream and parse upstream payloads without writing to PostgreSQL.",
    )
    parser.add_argument(
        "--no-prepare",
        action="store_true",
        help="Disable psycopg server-side prepared statements (also enabled when DATABASE_PREPARE=false).",
    )
    parser.add_argument(
        "--log-level",
        default="INFO",
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
        help="Logging verbosity.",
    )
    return parser


def should_prepare_statements(
    env_value: str | None = None,
    *,
    disable_flag: bool = False,
) -> bool:
    if disable_flag:
        return False
    raw = env_value if env_value is not None else os.environ.get("DATABASE_PREPARE", "")
    return raw.strip().lower() not in {"false", "0", "no", "off"}


def connect_postgres(
    database_url: str,
    *,
    prepare_statements: bool = True,
) -> Any:
    import psycopg

    connect_kwargs: dict[str, Any] = {}
    if not prepare_statements:
        connect_kwargs["prepare_threshold"] = None
    return psycopg.connect(database_url, **connect_kwargs)


def main(argv: list[str] | None = None) -> int:
    parser = build_arg_parser()
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=getattr(logging, args.log_level),
        format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
    )

    if args.dry_run:
        sink: CatalogSink = DryRunCatalogSink()
        stats = run_sync_pipeline(
            sink,
            scryfall_source=args.scryfall_source,
            identifiers_source=args.identifiers_source,
            prices_source=args.prices_source,
            manapool_source=args.manapool_source,
            skip_scryfall=args.skip_scryfall,
            skip_identifiers=args.skip_identifiers,
            skip_prices=args.skip_prices,
            skip_manapool=args.skip_manapool,
            strict_manapool=args.strict_manapool,
            skip_prune_sku_cache=args.skip_prune_sku_cache,
            batch_size=args.batch_size,
            limit=args.limit,
        )
        LOGGER.info("Dry-run completed successfully: %s", stats)
        return 0

    if not args.database_url:
        LOGGER.error("DATABASE_URL or --database-url is required unless --dry-run is set.")
        return 2

    prepare_statements = should_prepare_statements(disable_flag=args.no_prepare)
    with connect_postgres(
        args.database_url,
        prepare_statements=prepare_statements,
    ) as conn:
        pg_sink = PostgresCatalogSink(conn)
        stats = run_sync_pipeline(
            pg_sink,
            scryfall_source=args.scryfall_source,
            identifiers_source=args.identifiers_source,
            prices_source=args.prices_source,
            manapool_source=args.manapool_source,
            skip_scryfall=args.skip_scryfall,
            skip_identifiers=args.skip_identifiers,
            skip_prices=args.skip_prices,
            skip_manapool=args.skip_manapool,
            strict_manapool=args.strict_manapool,
            skip_prune_sku_cache=args.skip_prune_sku_cache,
            batch_size=args.batch_size,
            limit=args.limit,
        )
        LOGGER.info("PostgreSQL catalog sync completed successfully: %s", stats)

    return 0


if __name__ == "__main__":
    sys.exit(main())
