#!/usr/bin/env python3
"""Emit the generator-facing view of the vendored spec, as JSON on stdout.

openapi-typescript honors an `allOf` member's `required` list only for the
properties that member declares itself; a name inherited from a sibling `$ref`
branch can be dropped. For example, a composed request can declare
`required: [name, image]` on its inline branch while `image` comes from
a referenced container configuration. This normalization preserves such
requirements whenever the vendored contract uses that pattern.

Moving those names onto the schema that owns the `allOf` is equivalent for
validation (every `allOf` member sees the same instance) and is the shape
openapi-typescript resolves against each branch, emitting
`WithRequired<ContainerConfig, "image">` for direct inheritance. For nested
inheritance, materialize required property constraints onto the owner as well;
otherwise openapi-typescript can still drop the requirement. Shared base
schemas are left unchanged so update requests remain partial.

This is a read-only view for `task generate`: spec/openapi.yaml is never
written. API-contract fixes belong in scripts/fix_spec.py.

Usage:
    python3 scripts/spec_for_types.py spec/openapi.yaml > /tmp/spec.json
"""

import argparse
import copy
import json
import sys

import yaml

from fix_spec import SpecLoader


def hoist_composed_required(node) -> None:
    """Move `required` names an `allOf` member does not declare up to its owner."""
    if isinstance(node, list):
        for item in node:
            hoist_composed_required(item)
        return
    if not isinstance(node, dict):
        return

    # Normalize children first so nested allOf requirements reach their owner.
    for value in node.values():
        hoist_composed_required(value)

    members = node.get("allOf")
    if isinstance(members, list):
        inherited = []
        for member in members:
            if not isinstance(member, dict) or not isinstance(member.get("required"), list):
                continue
            properties = member.get("properties")
            declared = properties if isinstance(properties, dict) else {}
            from_branch = [name for name in member["required"] if name not in declared]
            if not from_branch:
                continue
            inherited += from_branch
            own = [name for name in member["required"] if name in declared]
            if own:
                member["required"] = own
            else:
                del member["required"]
        if inherited:
            owner = node.get("required")
            if not isinstance(owner, list):
                owner = []
                node["required"] = owner
            owner += [name for name in inherited if name not in owner]


def materialize_required_properties(spec):
    """Give required inherited fields concrete schemas across nested $ref/allOf.

    openapi-typescript cannot apply WithRequired through every nested allOf.
    Copy only the required property constraints onto the owner in this read-only
    generator view. Shared base schemas remain optional for update requests.
    """
    def definitions(node, name, seen):
        if not isinstance(node, dict) or id(node) in seen:
            return []
        seen = seen | {id(node)}
        result = []
        if name in node.get("properties", {}):
            result.append(node["properties"][name])
        ref = node.get("$ref")
        if ref and ref.startswith("#/"):
            target = spec
            for key in ref[2:].split("/"):
                target = target[key.replace("~1", "/").replace("~0", "~")]
            result.extend(definitions(target, name, seen))
        for member in node.get("allOf", []):
            result.extend(definitions(member, name, seen))
        return result

    def visit(node):
        if isinstance(node, list):
            for value in node:
                visit(value)
        elif isinstance(node, dict):
            for value in list(node.values()):
                visit(value)
            if not node.get("allOf"):
                return
            for name in node.get("required", []):
                if name in node.get("properties", {}):
                    continue
                constraints = []
                for definition in definitions(node, name, set()):
                    if definition not in constraints:
                        constraints.append(definition)
                if constraints:
                    combined = constraints[0] if len(constraints) == 1 else {"allOf": constraints}
                    node.setdefault("properties", {})[name] = copy.deepcopy(combined)

    visit(spec)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Print the vendored OpenAPI spec as JSON, normalized for openapi-typescript."
    )
    parser.add_argument("spec", help="Path to the OpenAPI YAML spec (read only)")
    args = parser.parse_args()

    with open(args.spec, "r", encoding="utf-8") as fh:
        spec = yaml.load(fh, Loader=SpecLoader)
    if not isinstance(spec, dict) or "openapi" not in spec or "paths" not in spec:
        print(f"{args.spec}: not an OpenAPI document", file=sys.stderr)
        return 1

    hoist_composed_required(spec)
    materialize_required_properties(spec)
    json.dump(spec, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
