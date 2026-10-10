"""Paths and settings. Reads .env from the repo root."""
import os
from pathlib import Path

from dotenv import load_dotenv

BACKEND_DIR = Path(__file__).resolve().parent.parent
REPO_DIR = BACKEND_DIR.parent
load_dotenv(REPO_DIR / ".env")

DATA_DIR = BACKEND_DIR / "data"
REFERENCE_DIR = DATA_DIR / "reference"
TENDERS_DIR = DATA_DIR / "tenders"
LLM_CACHE_DIR = DATA_DIR / "llm_cache"
STARTER_DIR = REPO_DIR / "problem_statement" / "Schulhaus_Oberglatt_Hackathon_Starter_Package_v2"
DEMO_PDF = STARTER_DIR / "BKP_244_LV_Lueftung_260804.pdf"

LLM_MODEL = os.getenv("LLM_MODEL", "gpt-5.4-mini")
LLM_MODEL_STRONG = os.getenv("LLM_MODEL_STRONG", "gpt-5.4")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
AZURE_OPENAI_ENDPOINT = os.getenv("AZURE_OPENAI_ENDPOINT")
AZURE_OPENAI_API_KEY = os.getenv("AZURE_OPENAI_API_KEY")
AZURE_OPENAI_API_VERSION = os.getenv("AZURE_OPENAI_API_VERSION", "2025-04-01-preview")
# Set LLM_OFFLINE=1 to run without any API calls (rules-only matching, cache hits still used).
LLM_OFFLINE = os.getenv("LLM_OFFLINE") == "1"

for d in (TENDERS_DIR, LLM_CACHE_DIR):
    d.mkdir(parents=True, exist_ok=True)
