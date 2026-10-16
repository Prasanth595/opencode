#!/usr/bin/env python3
"""Rank high-volume spans in OpenCode markdown exports. Counts source characters, not API tokens."""
from collections import Counter
from bisect import bisect_right
from pathlib import Path
import argparse
import csv
import json
import re

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('export', type=Path)
parser.add_argument('--out', type=Path, default=Path('docs/token-economy'))
args = parser.parse_args()
text = args.export.read_text(encoding='utf-8')
starts = [0] + [m.end() for m in re.finditer('\n', text)]
markers = list(re.finditer(r'(?m)^(?:## (?:Assistant|User)\s*$|\*\*Tool: [^\n]+\*\*\s*$)', text))
spans = []
for index, match in enumerate(markers):
    segment = text[match.start():markers[index + 1].start() if index + 1 < len(markers) else len(text)]
    m = re.match(r'\*\*Tool: ([^\n]+)\*\*', segment)
    kind = m.group(1) if m else 'Assistant' if segment.startswith('## Assistant') else 'User'
    # The export contains code-block wrappers. Separate the tool invocation from its response.
    tool_body = segment.find('```', segment.find('```') + 3) if m else -1
    input_chars = tool_body + 3 if tool_body >= 0 else 0
    output_chars = len(segment) - input_chars if tool_body >= 0 else 0
    if kind == 'User': continue
    if kind == 'webfetch':
        category = 'Fetched page / site chrome'
        action = 'Focus main content; retain full-page escape hatch'
    elif kind == 'shell':
        category = 'Command output / repeated inspection'
        action = 'Bound previews; preserve initial context and final diagnostic lines'
    elif kind in ('read', 'grep'):
        category = 'File inspection results'
        action = 'Narrow search/read scope; deduplicate exact repeated results'
    elif kind == 'Assistant':
        category = 'Assistant reasoning and commentary'
        action = 'Reduce unnecessary investigation loops; harness trimming cannot eliminate generated reasoning'
    else:
        category = 'Tool arguments or responses'
        action = 'Review individually; edits and writes must remain byte-exact'
    chars = len(segment)
    spans.append(dict(kind=kind, line=bisect_right(starts, match.start()), chars=chars,
                      input_chars=input_chars, output_chars=output_chars,
                      category=category, action=action))

spans.sort(key=lambda item: item['chars'], reverse=True)
summary = dict(raw_characters=len(text), raw_bytes=len(text.encode()),
               sections=len(spans), ranking_length=min(120,len(spans)),
               by_type={k: dict(sections=sum(s['kind'] == k for s in spans),
                                chars=sum(s['chars'] for s in spans if s['kind'] == k),
                                outputs=sum(s['output_chars'] for s in spans if s['kind'] == k))
                        for k in sorted(set(s['kind'] for s in spans))})
args.out.mkdir(parents=True, exist_ok=True)
with (args.out / 'ranked-120.csv').open('w', newline='') as target:
    writer = csv.DictWriter(target, fieldnames=['rank','kind','line','chars','input_chars','output_chars','category','action'])
    writer.writeheader()
    for rank, row in enumerate(spans[:120], 1): writer.writerow({'rank':rank,**row})
(args.out / 'audit.json').write_text(json.dumps(summary,indent=2)+'\n')
with (args.out / 'ranked-120.md').open('w') as out:
    out.write('# DeepSeek transcript: top 120 high-volume spans\n\n')
    out.write('**Method:** Ranked by UTF-8 decoded character volume in the supplied Markdown export. '
              'These are **candidate optimization zones**, not 120 independently established sources of waste. '
              'Exported text includes reasoning but lacks provider-level cache and usage fields. '
              'Trimming every row would be incorrect, especially tool inputs containing edits.\n\n')
    out.write('| # | Export line | Origin | Characters | Result chars | Category | Potential intervention |\n'
              '|---:|---:|---|---:|---:|---|---|\n')
    for rank, row in enumerate(spans[:120], 1):
        out.write(f'| {rank} | {row["line"]} | {row["kind"]} | {row["chars"]:,} | {row["output_chars"]:,} | {row["category"]} | {row["action"]} |\n')
    out.write('\nIndividual token savings cannot be inferred from these counts; use an API usage trace for exact token accounting.\n')
print(json.dumps(summary,indent=2))
