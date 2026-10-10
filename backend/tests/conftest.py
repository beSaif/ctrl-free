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
