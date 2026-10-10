"""Shared test setup."""
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
