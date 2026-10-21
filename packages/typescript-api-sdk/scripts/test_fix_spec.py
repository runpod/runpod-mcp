#!/usr/bin/env python3
"""Tests for the spec patch layer. Offline: no network, no credentials.

    python3 scripts/test_fix_spec.py     (or: task spec-test)

The first two tests pin the bug that made `task spec-pull` corrupt the spec:
PyYAML implements YAML 1.1, so a bare `OFF` loads as boolean false, while the
Go and TypeScript generators read YAML 1.2 and see the string. The rest assert
the invariants the vendored spec has to keep for `task generate` to be
reproducible.
"""

import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest

import yaml

SCRIPTS = pathlib.Path(__file__).resolve().parent
REPO = SCRIPTS.parent
SPEC = REPO / "spec" / "openapi.yaml"

sys.path.insert(0, str(SCRIPTS))

from fix_spec import SpecLoader, dump_spec, use_placeholder_aws_account_ids  # noqa: E402  (path set above)

# Every scalar YAML 1.1 reads as a boolean, plus one control value.
YAML_11_BOOLEANS = ["OFF", "ON", "YES", "NO", "y", "n", "Off", "True", "FLASHBOOT"]


class RoundTrip(unittest.TestCase):
    def test_yaml_11_boolean_strings_survive_a_round_trip(self):
        spec = {
            "openapi": "3.1.0",
            "paths": {},
            "components": {
                "schemas": {
                    "FlashBoot": {"type": "string", "enum": list(YAML_11_BOOLEANS)},
                    "Env": {"examples": [{"JUPYTER_ENABLE_LAB": "yes"}]},
                }
            },
        }
        text = dump_spec(spec)
        # Both the YAML 1.2 loader used here and a stock YAML 1.1 reader must
        # give the strings back: the output has to be unambiguous for either.
        for reader in (SpecLoader, yaml.SafeLoader):
            reloaded = yaml.load(text, Loader=reader)
            self.assertEqual(
                reloaded["components"]["schemas"]["FlashBoot"]["enum"],
                YAML_11_BOOLEANS,
                f"{reader.__name__} did not read the enum back as strings",
            )
            self.assertEqual(
                reloaded["components"]["schemas"]["Env"]["examples"],
                [{"JUPYTER_ENABLE_LAB": "yes"}],
                f"{reader.__name__} did not read the example back as a string",
            )
        self.assertEqual(reloaded, spec)

    def test_extra_yaml_line_breaks_survive_a_round_trip(self):
        # The 2026-10 global-volume `name` pattern ends in a raw U+0085. YAML
        # reads NEL, LS and PS as line breaks, so unescaped they fold to a
        # space on reload and the pattern silently changes.
        pattern = "[^\\p{Z}\\t-\\r\x85]"
        spec = {
            "openapi": "3.1.0",
            "paths": {},
            "components": {
                "schemas": {
                    "Name": {"type": "string", "pattern": pattern},
                    "Prose": {"description": "a\u2028b\u2029c"},
                }
            },
        }
        text = dump_spec(spec)
        for reader in (SpecLoader, yaml.SafeLoader):
            self.assertEqual(yaml.load(text, Loader=reader), spec, reader.__name__)

    def test_stock_pyyaml_shows_why_the_loader_is_needed(self):
        # The bug this guards against, spelled out: plain `OFF` is false in 1.1.
        self.assertIs(yaml.safe_load("enum: [OFF]")["enum"][0], False)
        self.assertEqual(yaml.load("enum: [OFF]", Loader=SpecLoader)["enum"][0], "OFF")


class VendoredSpec(unittest.TestCase):
    def setUp(self):
        self.text = SPEC.read_text(encoding="utf-8")
        self.spec = yaml.load(self.text, Loader=SpecLoader)

    def test_patch_layer_run_is_a_no_op(self):
        """The tracked spec is patch-layer output, so a re-run must not touch it."""
        with tempfile.TemporaryDirectory() as tmp:
            copy = pathlib.Path(tmp) / "openapi.yaml"
            shutil.copyfile(SPEC, copy)
            result = subprocess.run(
                [sys.executable, str(SCRIPTS / "fix_spec.py"), str(copy)],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("already normalized", result.stdout)
            self.assertEqual(copy.read_text(encoding="utf-8"), self.text, "patch layer rewrote the spec")

    def test_flashboot_enum_is_strings_under_both_yaml_versions(self):
        for reader in (SpecLoader, yaml.SafeLoader):
            spec = yaml.load(self.text, Loader=reader)
            self.assertEqual(
                spec["components"]["schemas"]["FlashBoot"]["enum"],
                ["OFF", "FLASHBOOT", "PRIORITY_FLASHBOOT"],
                f"{reader.__name__} misread the FlashBoot enum",
            )

    def test_explicit_enum_names_match_their_members(self):
        """Keep existing annotations consistent; TS literal unions need no constant names."""
        for path, schema in enums(self.spec):
            if "x-enum-varnames" not in schema:
                continue
            self.assertEqual(
                len(schema["x-enum-varnames"]),
                len(schema["enum"]),
                f"{path}: constant names do not match the enum members",
            )

    def test_delegation_operations_declare_the_typed_auth_errors(self):
        for path, method in (
            ("/v2/registries/delegations", "get"),
            ("/v2/registries/delegations", "post"),
            ("/v2/registries/delegations/{id}", "delete"),
        ):
            responses = self.spec["paths"][path][method]["responses"]
            self.assertIn("401", responses, f"{method.upper()} {path}")
            self.assertIn("403", responses, f"{method.upper()} {path}")

    def test_no_concrete_aws_account_ids_in_examples(self):
        self.assertEqual(use_placeholder_aws_account_ids(self.spec), 0)
        self.assertIn("123456789012", self.text)


class AccountExamples(unittest.TestCase):
    def test_accounts_are_normalized_without_changing_unrelated_numbers(self):
        spec = {
            "awsUser": {"examples": ["000000000000", "000000000"]},
            "examples": [{"awsUser": "000000000000"}],
            "arn": "arn:aws:ecr:us-east-2:000000000000:repository/example",
            "registry": "000000000.dkr.ecr.us-east-2.amazonaws.com",
            "unrelated": "000000000000",
        }
        self.assertEqual(use_placeholder_aws_account_ids(spec), 5)
        self.assertEqual(spec["awsUser"]["examples"], ["123456789012"] * 2)
        self.assertEqual(spec["examples"][0]["awsUser"], "123456789012")
        self.assertEqual(spec["arn"], "arn:aws:ecr:us-east-2:123456789012:repository/example")
        self.assertEqual(spec["registry"], "123456789012.dkr.ecr.us-east-2.amazonaws.com")
        self.assertEqual(spec["unrelated"], "000000000000")
        self.assertEqual(use_placeholder_aws_account_ids(spec), 0)


def enums(node, path=""):
    """Every schema in the document that declares an enum, inline ones included."""
    if isinstance(node, dict):
        if isinstance(node.get("enum"), list):
            yield path, node
        for key, value in node.items():
            yield from enums(value, f"{path}.{key}")
    elif isinstance(node, list):
        for index, value in enumerate(node):
            yield from enums(value, f"{path}[{index}]")


if __name__ == "__main__":
    unittest.main(verbosity=2)
