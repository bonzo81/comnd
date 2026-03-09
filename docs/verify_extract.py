"""Verify quality of extracted command entries."""
import json

with open("docs/iosxe-17.15-commands-extracted.json") as f:
    cmds = json.load(f)

samples = ["show vlan", "hostname", "reload", "switchport trunk", "show spanning-tree", "ip access-list"]
for c in cmds:
    if c["name"] in samples:
        print(f"=== {c['name']} ===")
        print(f"  mode: {c['mode']}")
        print(f"  section: {c['section']}")
        desc = c.get("description") or "(none)"
        print(f"  desc: {desc[:150]}")
        syntax = c.get("syntax") or "(none)"
        print(f"  syntax: {syntax[:150]}")
        subs = c.get("subcommands", [])[:10]
        print(f"  subcommands: {subs}")
        print()

# Also show file size
import os
size = os.path.getsize("docs/iosxe-17.15-commands-extracted.json")
print(f"JSON file size: {size / 1024:.0f} KB")
