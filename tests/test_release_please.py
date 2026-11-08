"""Regression tests for release-please configuration."""

import json
from pathlib import Path
import re

import pytest

ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.unit
def test_release_manifest_contains_only_package_versions() -> None:
    """Release-please parses every manifest value as a version."""
    manifest = json.loads((ROOT / ".release-please-manifest.json").read_text(encoding="utf-8"))
    config = json.loads((ROOT / "release-please-config.json").read_text(encoding="utf-8"))

    assert manifest.keys() == config["packages"].keys()
    for version in manifest.values():
        assert isinstance(version, str)
        assert re.fullmatch(r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?", version)

    assert config["packages"]["."]["release-type"] == "simple"
    assert config["packages"]["."]["prerelease"] is True
