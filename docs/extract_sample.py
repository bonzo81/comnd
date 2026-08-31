"""Extract structured data from sample command pages in the Cisco PDF."""
import fitz
import re

doc = fitz.open(r"C:\Users\andyt\development\netssh\docs\b_1715_9200_cr (1).pdf")
toc = doc.get_toc()

# Level-3 entries are the individual commands
l3_entries = [(t, p) for l, t, p in toc if l == 3]

def extract_command_info(title, start_page, next_page_limit):
    pages_text = ""
    for p in range(start_page - 1, min(start_page + 4, next_page_limit, len(doc))):
        pages_text += doc[p].get_text() + "\n"

    # Extract Command Mode
    mode_match = re.search(
        r"Command Modes?\s*\n(.+?)(?:\n(?:Command History|Usage|Examples?))",
        pages_text, re.DOTALL
    )
    mode = mode_match.group(1).strip() if mode_match else "NOT FOUND"

    # Extract first-line description
    desc_match = re.search(
        r"^" + re.escape(title) + r"\s*\nTo (.+?)(?:,\s*use|\.\s)",
        pages_text, re.MULTILINE
    )
    desc = ("To " + desc_match.group(1).strip()) if desc_match else "NOT FOUND"

    # Extract syntax block (lines between the command name repeat and "Syntax Description")
    syntax_match = re.search(
        r"\n(" + re.escape(title) + r".+?)(?:\nSyntax Description)",
        pages_text, re.DOTALL
    )
    syntax = syntax_match.group(1).strip() if syntax_match else "NOT FOUND"

    return {"mode": mode[:200], "desc": desc[:300], "syntax": syntax[:400]}


# Test on well-known commands
samples = [
    "show vlan", "show interfaces", "channel-group", "hostname",
    "ip access-group", "ip access-list", "show spanning-tree",
    "switchport trunk", "show vtp", "reload"
]

for title, page in l3_entries:
    if title.strip() in samples:
        idx = l3_entries.index((title, page))
        next_p = l3_entries[idx + 1][1] if idx + 1 < len(l3_entries) else len(doc)
        info = extract_command_info(title.strip(), page, next_p)
        print(f"=== {title} (p{page}) ===")
        print(f"  Mode: {info['mode']}")
        print(f"  Desc: {info['desc']}")
        print(f"  Syntax: {info['syntax'][:200]}")
        print()
