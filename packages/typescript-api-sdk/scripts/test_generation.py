import copy
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch, MagicMock

from spec_for_types import hoist_composed_required, materialize_required_properties
from sync_spec import ROOT, sync


class Generation(unittest.TestCase):
    def test_inherited_required_is_preserved_without_mutating_ref(self):
        schema = {"allOf": [{"$ref": "#/components/schemas/Base"}, {
            "properties": {"name": {"type": "string"}}, "required": ["name", "image"]
        }]}
        hoist_composed_required(schema)
        self.assertEqual(schema["required"], ["image"])
        self.assertEqual(schema["allOf"][1]["required"], ["name"])
        before = copy.deepcopy(schema)
        hoist_composed_required(schema)
        self.assertEqual(schema, before)

    def test_nested_inheritance_preserves_constraints_and_optional_base(self):
        base = {"type": "object", "properties": {"image": {"type": "string", "minLength": 1}}}
        spec = {"components": {"schemas": {
            "Base": base,
            "Container": {"allOf": [{"$ref": "#/components/schemas/Base"}]},
            "Request": {"allOf": [{"$ref": "#/components/schemas/Container"},
                                   {"required": ["image"]}]},
            "Update": {"allOf": [{"$ref": "#/components/schemas/Container"}]},
        }}}
        original_base = copy.deepcopy(base)
        hoist_composed_required(spec)
        materialize_required_properties(spec)
        request = spec["components"]["schemas"]["Request"]
        self.assertEqual(request["required"], ["image"])
        self.assertEqual(request["properties"]["image"], base["properties"]["image"])
        self.assertIsNot(request["properties"]["image"], base["properties"]["image"])
        self.assertEqual(base, original_base)
        self.assertNotIn("required", spec["components"]["schemas"]["Update"])
        before = copy.deepcopy(spec)
        hoist_composed_required(spec)
        materialize_required_properties(spec)
        self.assertEqual(spec, before)

    def test_nested_inline_requirements_and_intersecting_constraints(self):
        schema = {"allOf": [
            {"properties": {"image": {"type": "string"}}},
            {"allOf": [{"required": ["image"]},
                       {"properties": {"image": {"minLength": 1}}}]},
        ]}
        hoist_composed_required(schema)
        materialize_required_properties(schema)
        self.assertEqual(schema["required"], ["image"])
        self.assertEqual(schema["properties"]["image"], {"allOf": [{"type": "string"}, {"minLength": 1}]})

    def test_python_failure_cannot_overwrite_generated_output(self):
        output = ROOT / "src/generated/schema.ts"
        before = output.read_bytes()
        result = subprocess.run(["node", "scripts/generate.mjs", "--spec", "/missing/runpod-spec.yaml"],
                                cwd=ROOT, capture_output=True, env={**os.environ, "PYTHON": sys.executable})
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(output.read_bytes(), before)

    def test_freshness_check_fails_without_rewriting_output(self):
        output = ROOT / "src/generated/schema.ts"
        before = output.read_bytes()
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "openapi.yaml"
            text = (ROOT / "spec/openapi.yaml").read_text()
            path.write_text(text.replace("Environment variables as key-value pairs", "Changed environment description", 1))
            self.assertNotEqual(path.read_text(), text)
            result = subprocess.run(["node", "scripts/generate.mjs", "--check", "--spec", str(path)],
                                    cwd=ROOT, capture_output=True, env={**os.environ, "PYTHON": sys.executable})
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(b"Generated schema is stale", result.stderr)
            self.assertEqual(output.read_bytes(), before)

    def test_invalid_download_leaves_vendored_spec_unchanged(self):
        response = MagicMock()
        response.__enter__.return_value.read.return_value = b'{"error":"unavailable"}'
        with tempfile.TemporaryDirectory() as tmp, patch("sync_spec.urlopen", return_value=response):
            path = Path(tmp) / "openapi.yaml"
            path.write_text("original")
            with self.assertRaises(ValueError):
                sync("https://example.test", path)
            self.assertEqual(path.read_text(), "original")

    def test_generation_failure_leaves_vendored_spec_unchanged(self):
        response = MagicMock()
        response.__enter__.return_value.read.return_value = (ROOT / "spec/openapi.yaml").read_bytes()
        with tempfile.TemporaryDirectory() as tmp, patch("sync_spec.urlopen", return_value=response), \
             patch("sync_spec.subprocess.run", side_effect=subprocess.CalledProcessError(1, "node")):
            path = Path(tmp) / "openapi.yaml"
            path.write_text("original")
            with self.assertRaises(subprocess.CalledProcessError):
                sync("https://example.test", path)
            self.assertEqual(path.read_text(), "original")
            self.assertEqual(list(Path(tmp).iterdir()), [path])

    def test_drift_detects_referenced_schema_changes(self):
        response = MagicMock()
        text = (ROOT / "spec/openapi.yaml").read_text()
        response.__enter__.return_value.read.return_value = text.encode()
        with tempfile.TemporaryDirectory() as tmp, patch("sync_spec.urlopen", return_value=response):
            path = Path(tmp) / "openapi.yaml"
            path.write_text(text.replace("minItems: 1", "minItems: 2", 1))
            self.assertNotEqual(path.read_text(), text)
            with self.assertRaisesRegex(ValueError, "differs"):
                sync("https://example.test", path, check=True)
