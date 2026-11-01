#!/usr/bin/env python3
"""make_skew.py MAIN_DIR SKEW_DIR KEEP_FR : the main corpus with only KEEP_FR French notes (the French questions' targets first), so French is a few percent of the corpus."""
import os, shutil, sys
main, skew, keep = os.path.abspath(sys.argv[1]), os.path.abspath(sys.argv[2]), int(sys.argv[3])
qs=[l.rstrip('\n').split('\t') for l in open(f'{main}/questions.tsv',encoding='utf8')]
rows=[l.rstrip('\n').split('\t') for l in open(f'{main}/index.tsv',encoding='utf8') if not l.startswith('#')]
targets=[q[3] for q in qs if q[1]=='fr']
fr_paths=[r[0] for r in rows if any(t==r[0] for t in targets)]
FR_THEMES={'recettes cuisine','voyages projets','salle entraînement','réunions travail','livres lecture','bricolage maison','révisions école','contacts personnes'}
fr_rows=[r for r in rows if r[2] in FR_THEMES]
other=[r for r in rows if r not in fr_rows]
keep_rows=[r for r in fr_rows if r[0] in targets]
for r in fr_rows:
    if len(keep_rows)>=keep: break
    if r not in keep_rows: keep_rows.append(r)
keep_rows=keep_rows[:max(keep,len([r for r in fr_rows if r[0] in targets]))]
os.makedirs(f'{skew}/src',exist_ok=True)
with open(f'{skew}/index.tsv','w',encoding='utf8') as f:
    f.write('# path\ttitle\tthemes\tkeywords\n')
    for r in other+keep_rows:
        new=r[0].replace(f'{main}/src',f'{skew}/src'); shutil.copy(r[0],new); f.write('\t'.join([new]+r[1:])+'\n')
with open(f'{skew}/questions.tsv','w',encoding='utf8') as f:
    for q in qs:
        if q[1]=='fr' and q[3] not in [r[0] for r in keep_rows]: continue
        f.write('\t'.join(q[:3]+[q[3].replace(f'{main}/src',f'{skew}/src')])+'\n')
print('skew notes',len(other)+len(keep_rows),'fr notes',len(keep_rows))
