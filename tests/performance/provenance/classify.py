"""Classify the history reads replay-probe.ts recorded (Performance 004 spike).
   python3 classify.py todos.jsonl
For each evaluated entry: which history records it read, by whose change:
the incoming change, a change accepted between its base and head (the
window), or an older change (before or at its base)."""
import json, sys, collections
rows = [json.loads(l) for l in open(sys.argv[1])]
change_at = {}
for r in rows: change_at.setdefault(r['change'], r['index'])

def change_of(field, key):
    if field in ('effects', 'outputs', 'origins'):
        if key.startswith('['):
            return json.loads(key)[0]
        for p in ('snapshot:', 'imported:', 'snapshot-alternative:', 'existence:', 'context:', 'alternative:'):
            if key.startswith(p): return key[len(p):].split(':')[0]
        return None
    if field == 'changes': return key
    return None

tot = collections.Counter(); per_kind = collections.defaultdict(collections.Counter)
examples = collections.defaultdict(list)
enum = collections.Counter(); enum_entries = collections.Counter()
old_depths = collections.defaultdict(list)
for r in rows:
    kind = r['kind'] + ('/ff-path' if r.get('path') == 1 else '')
    per_kind[kind]['entries'] += 1
    base = r['base'] if r['base'] is not None else -1
    for field, v in r['reads'].items():
        if v['enumerated']:
            enum[(kind, field)] += 1; enum_entries[(kind, field)] += sum(v['enumerated'])
        for status in ('found', 'missing'):
            for key in v[status]:
                c = change_of(field, key)
                if c == r['change']: cls = 'incoming'
                elif c is None or c not in change_at: cls = 'unknown'
                else:
                    i = change_at[c]
                    cls = 'window' if base < i < r['index'] else 'old' if i <= base else 'future?'
                    if cls == 'old': old_depths[(kind, field)].append(r['index'] - i)
                tag = (field, status, cls)
                per_kind[kind][tag] += 1
                if cls in ('old', 'unknown') and len(examples[(kind,) + tag]) < 3:
                    examples[(kind,) + tag].append((r['index'], key[:120]))
for kind, c in sorted(per_kind.items()):
    print(f"\n== {kind}: {c['entries']} entries")
    for tag, n in sorted(((t, n) for t, n in c.items() if t != 'entries'), key=str):
        print('  ', tag, n)
print('\n== whole-map enumerations (kind, field): times, total records')
for k, n in sorted(enum.items()): print('  ', k, n, enum_entries[k])
print('\n== old reads: age in entries (p50, p90, max)')
for k, d in sorted(old_depths.items()):
    d.sort(); print('  ', k, len(d), d[len(d)//2], d[int(.9*(len(d)-1))], d[-1])
print('\n== examples of old/unknown reads')
for k, v in sorted(examples.items()): print('  ', k, v)
