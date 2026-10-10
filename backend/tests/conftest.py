"""Shared test setup."""
import os

import pytest

from app import config


@pytest.fixture(autouse=True, scope="session")
def _no_price_lists(tmp_path_factory):
    """Price lists activated in the local app (data/price_lists) must not change the golden numbers."""
    old = config.PRICE_LISTS_DIR
    config.PRICE_LISTS_DIR = tmp_path_factory.mktemp("price_lists")
    yield
    config.PRICE_LISTS_DIR = old


@pytest.fixture(autouse=True, scope="session")
def _no_local_tenders(tmp_path_factory):
    """Tests never read or write the local app's tenders (data/tenders) or learned.json next to them:
    creating a price list re-prices and logs every tender in TENDERS_DIR."""
    old = config.TENDERS_DIR
    config.TENDERS_DIR = tmp_path_factory.mktemp("local") / "tenders"
    yield
    config.TENDERS_DIR = old


@pytest.fixture(autouse=True, scope="session")
def _no_paid_llm_calls():
    """A key in .env must not make the suite call the LLM (cost, and new files in the committed llm_cache).
    Tests that need the LLM path patch config.LLM_OFFLINE themselves; LLM_LIVE_TESTS=1 runs live."""
    old = config.LLM_OFFLINE
    if os.getenv("LLM_LIVE_TESTS") != "1":
        config.LLM_OFFLINE = True
    yield
    config.LLM_OFFLINE = old
