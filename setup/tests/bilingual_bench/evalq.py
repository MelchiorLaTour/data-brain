#!/usr/bin/env python3
"""evalq.py CASE_DIR ENGINE_CMD...  -> per-language hit@1/hit@3/hit@5 and misses. ENGINE_CMD gets the query as the last arg and a result limit via env LIM.
Reads only the synthetic questions and prints rankings of synthetic paths."""
import os, re, subprocess, sys, collections
case=sys.argv[1]; cmd=sys.argv[2:]
home=os.path.expanduser('~')
def norm(p): return os.path.abspath(p.replace('~',home,1) if p.startswith('~') else p)
qs=[l.rstrip('\n').split('\t') for l in open(os.path.join(case,'questions.tsv'),encoding='utf8')]
res=collections.defaultdict(lambda:[0,0,0,0]); miss=[]
for qid,lang,q,target in qs:
    out=subprocess.run(cmd+[q],capture_output=True,text=True,env={**os.environ,'LIM':'8'}).stdout
    ranked=[norm(m.group(1)) for m in (re.match(r'^\s*\d+\s+-?[0-9.]+\s+(.+)$',l) for l in out.split('\n')) if m]
    r=res[lang]; r[3]+=1
    pos=ranked.index(target)+1 if target in ranked else 99
    if pos<=1: r[0]+=1
    if pos<=3: r[1]+=1
    if pos<=5: r[2]+=1
    if pos>5: miss.append((qid,lang,q,pos))
for lang in sorted(res):
    a,b,c,n=res[lang]; print(f"{lang}: hit@1 {a}/{n}  hit@3 {b}/{n}  hit@5 {c}/{n}")
for m in miss: print('  miss',m)
