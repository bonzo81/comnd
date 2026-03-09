"""
Extract all commands from the Cisco IOS-XE 17.15 Command Reference PDF.
Produces a JSON file with: name, section, mode, description, syntax, page.
"""
import fitz
import re
import json

doc = fitz.open(r"C:\Users\andyt\development\netsh\docs\b_1715_9200_cr (1).pdf")
toc = doc.get_toc()

# Build section mapping and level-3 entries
sections = {}
current_section = ""
l3_entries = []

for entry in toc:
    level, title, page = entry
    if level == 1 and title not in [
        "Contents",
        "Command Reference, Cisco IOS XE 17.15.x (Catalyst 9200 Switches)",
    ]:
        current_section = title
    elif level == 3 and current_section:
        l3_entries.append((title.strip(), page, current_section))


def normalise_mode(mode_text):
    """Map verbose mode text to canonical mode values."""
    m = mode_text.lower().strip()
    if "privileged exec" in m or "privileged-exec" in m:
        return "privileged-exec"
    if "user exec" in m:
        return "user-exec"
    if "global configuration" in m or "(config)" in m:
        return "global-config"
    if "interface configuration" in m or "(config-if)" in m:
        return "interface-config"
    if "rommon" in m:
        return "rommon"
    if "routing" in m or "(config-router)" in m:
        return "routing-config"
    if "line" in m and "config" in m:
        return "line-config"
    if "vlan" in m and "config" in m:
        return "vlan-config"
    if "config" in m:
        return "global-config"  # catch-all for various config sub-modes
    if "exec" in m:
        return "privileged-exec"  # default exec to privileged
    return mode_text.strip()[:60]


def extract_command(title, start_page, next_page):
    """Extract structured data from a command's pages."""
    pages_text = ""
    for p in range(start_page - 1, min(start_page + 5, next_page, len(doc))):
        pages_text += doc[p].get_text() + "\n"

    # Mode
    mode_match = re.search(
        r"Command Modes?\s*\n(.+?)(?:\n(?:Command History|Usage|Examples?))",
        pages_text,
        re.DOTALL,
    )
    raw_mode = mode_match.group(1).strip() if mode_match else ""
    mode = normalise_mode(raw_mode) if raw_mode else "privileged-exec"

    # Description — "To <verb> ... , use ..." line
    desc_match = re.search(
        r"(?:^|\n)" + re.escape(title) + r"\s*\nTo (.+?)(?:,\s*use\b)",
        pages_text,
        re.DOTALL,
    )
    if desc_match:
        desc_raw = desc_match.group(1).strip()
        # Clean up line breaks within the description
        desc = re.sub(r"\s+", " ", desc_raw)
        desc = "To " + desc
    else:
        desc = ""

    # Syntax — between second occurrence of command name and "Syntax Description"
    syntax_match = re.search(
        r"\n(" + re.escape(title) + r".*?)(?:\nSyntax Description|\nCommand Default)",
        pages_text,
        re.DOTALL,
    )
    if syntax_match:
        syntax_raw = syntax_match.group(1).strip()
        syntax = re.sub(r"\s+", " ", syntax_raw)
        # Cap length
        if len(syntax) > 300:
            syntax = syntax[:300] + "..."
    else:
        syntax = title

    # Subcommand keywords from the Syntax Description section
    subcommands = []
    syntax_desc_match = re.search(
        r"Syntax Description\s*\n(.+?)(?:Command Default|Command Modes?)",
        pages_text,
        re.DOTALL,
    )
    if syntax_desc_match:
        block = syntax_desc_match.group(1)
        # Look for keywords — typically a word or phrase at the start of a line
        # followed by description text. Keywords are often in bold (not detectable
        # from plain text) but tend to be short phrases followed by description.
        # We'll look for lines that look like keyword definitions.
        lines = block.split("\n")
        # Keywords tend to be short (<40 chars) non-sentence lines followed by
        # longer description text
        for line in lines:
            line = line.strip()
            if not line or len(line) > 60:
                continue
            # Skip lines that look like descriptions (start with caps article/verb)
            if re.match(r"^(Specif|Displa|Option|Enable|Sets|The |A |An |This |Enter|Use |\()", line):
                continue
            if re.match(r"^Note$", line):
                continue
            # Likely a keyword/option
            if line and not line.endswith(".") and len(line.split()) <= 4:
                subcommands.append(line)

    return {
        "name": title,
        "mode": mode,
        "description": desc[:500] if desc else None,
        "syntax": syntax if syntax != title else None,
        "subcommands": subcommands[:20] if subcommands else [],
    }


# Process all commands
results = []
for i, (title, page, section) in enumerate(l3_entries):
    next_page = l3_entries[i + 1][1] if i + 1 < len(l3_entries) else len(doc) + 1
    try:
        info = extract_command(title, page, next_page)
        info["section"] = section
        info["page"] = page
        results.append(info)
    except Exception as e:
        results.append({
            "name": title,
            "section": section,
            "page": page,
            "mode": "privileged-exec",
            "description": None,
            "syntax": None,
            "subcommands": [],
            "error": str(e),
        })

    if (i + 1) % 100 == 0:
        print(f"  Processed {i + 1}/{len(l3_entries)} commands...")

# Write output
out_path = r"C:\Users\andyt\development\netsh\docs\iosxe-17.15-commands-extracted.json"
with open(out_path, "w", encoding="utf-8") as f:
    json.dump(results, f, indent=2, ensure_ascii=False)

# Summary
print(f"\nExtracted {len(results)} commands to {out_path}")
with_desc = sum(1 for r in results if r.get("description"))
with_syntax = sum(1 for r in results if r.get("syntax"))
with_sub = sum(1 for r in results if r.get("subcommands"))
print(f"  With description: {with_desc}")
print(f"  With syntax: {with_syntax}")
print(f"  With subcommands: {with_sub}")

# Mode distribution
from collections import Counter
modes = Counter(r["mode"] for r in results)
print("\nMode distribution:")
for mode, count in modes.most_common():
    print(f"  {mode}: {count}")
