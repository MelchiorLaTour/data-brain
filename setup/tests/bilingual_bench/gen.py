#!/usr/bin/env python3
"""Synthetic bilingual benchmark: invented notes only (no real data). Usage: gen.py OUTDIR N_EN N_FR SEED
Writes OUTDIR/src/*.md, OUTDIR/index.tsv (path title themes keywords), OUTDIR/questions.tsv (id lang question target)."""
import os, random, sys, collections
out, n_en, n_fr, seed = os.path.abspath(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4])
rnd = random.Random(seed)
src = os.path.join(out, 'src'); os.makedirs(src, exist_ok=True)

NAMES = ['Maelle Dorval','Teodor Brandt','Ilias Verhoeven','Sunniva Caro','Anselm Okafor','Perrine Lazar','Quentin Abbate','Odalys Meurice','Bastien Rinaldi','Yolanda Pastor','Evrard Nilsen','Lucile Marchetti','Gaspard Imbert','Noor Haddad','Cosima Delarue','Rainier Voss','Thessaly Moreau','Matthis Orlov','Justine Calloway','Dario Fontana','Margaux Teisseire','Luka Brennan','Ondine Garreau','Fabrice Lindqvist','Solene Baptiste','Idris Kowalczyk','Clemence Arnaud','Joaquim Reyes','Philomene Dubreuil','Casimir Hale']
CITIES = ['Lisbon','Porto','Seville','Bologna','Ghent','Turin','Krakow','Bergen','Valencia','Antwerp','Lyon','Annecy','Nantes','Biarritz','Dijon','Aix','Strasbourg','Montpellier','Rennes','Toulouse']
MONTHS_EN = ['January','February','March','April','May','June','July','August','September','October','November','December']
MONTHS_FR = ['janvier','février','mars','avril','mai','juin','juillet','août','septembre','octobre','novembre','décembre']
HOTELS = ['Casa Alvorada','Hotel Brisa','Pension Miradouro','Albergo Luna','Maison Orchidée','Auberge du Pont','Hostal Naranjo','Villa Cèdre','Gîte des Tilleuls','Residence Aurore']
DISH_EN = ['lemon barley risotto','smoked paprika chickpea stew','roasted beet and walnut salad','miso glazed aubergine','cardamom plum crumble','harissa lentil soup','saffron fish pie','sesame soba noodles','apple fennel slaw','ginger carrot soup','pumpkin gnocchi','tahini banana bread','basil pea fritters','coconut dal','rosemary focaccia']
ING_EN = ['pearl barley','smoked paprika','golden beets','white miso','green cardamom','red lentils','saffron threads','toasted sesame','fennel bulb','fresh ginger','sage butter','tahini','spring peas','coconut milk','sea salt flakes']
DISH_FR = ['gratin de courge au thym','soupe de lentilles corail','tarte fine aux poireaux','ratatouille du dimanche','far breton aux pruneaux','velouté de panais','blanquette de veau','salade de lentilles tièdes','clafoutis aux cerises','gâteau au yaourt citronné','tian de légumes','crème de potimarron','galettes de sarrasin','riz au lait vanillé','pot-au-feu d’hiver']
ING_FR = ['courge muscade','lentilles corail','poireaux nouveaux','aubergines','pruneaux d’Agen','panais','épaule de veau','échalotes','cerises noires','citron bio','courgettes','potimarron','farine de sarrasin','vanille bourbon','gros sel']
DAYS_EN = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday']
DAYS_FR = ['lundi','mardi','mercredi','jeudi','vendredi','samedi','dimanche']
EXO_EN = ['deadlift','overhead press','pull-ups','front squat','rowing machine','dumbbell lunges','kettlebell swings','dips','hip thrust','farmer carries']
EXO_FR = ['soulevé de terre','développé militaire','tractions','squat avant','rameur','fentes avec haltères','kettlebell swings','dips','relevé de bassin','marche du fermier']
TOP_EN = ['pricing page','onboarding emails','server migration','hiring plan','invoice template','security review','mobile launch','partner contract','quarterly budget','support backlog']
TOP_FR = ['page des tarifs','courriels d’accueil','migration du serveur','plan de recrutement','modèle de facture','revue de sécurité','lancement mobile','contrat partenaire','budget trimestriel','retard du support']
BOOKS_EN = ['The Slow Orchard','Salt and Ledger','A Map of Quiet Rooms','Iron Garden','The Cartographer’s Daughter','Night Trains to Nowhere','Small Gods of Commerce','The Glass Almanac']
BOOKS_FR = ['Le Verger lent','Sel et registre','Carte des pièces silencieuses','Le Jardin de fer','La Fille du cartographe','Trains de nuit','Les Petits Dieux du commerce','L’Almanach de verre']
FIX_EN = ['leaking kitchen tap','squeaky hallway door','loose bathroom tile','wobbly shelf bracket','cracked window seal','dripping radiator valve','stuck garage latch','flickering porch light']
FIX_FR = ['robinet de cuisine qui fuit','porte du couloir qui grince','carreau de salle de bain décollé','équerre d’étagère branlante','joint de fenêtre fissuré','purgeur de radiateur qui goutte','loquet de garage coincé','lampe du porche qui clignote']
TOOL_EN = ['adjustable spanner','flat screwdriver','tile adhesive','spirit level','silicone sealant','radiator key','graphite spray','LED driver']
TOOL_FR = ['clé à molette','tournevis plat','colle à carrelage','niveau à bulle','mastic silicone','clé de purge','graisse graphite','alimentation LED']
SUBJ_EN = ['organic chemistry','macroeconomics','linear algebra','art history','roman law','statistics','cell biology','political theory']
SUBJ_FR = ['chimie organique','macroéconomie','algèbre linéaire','histoire de l’art','droit romain','statistiques','biologie cellulaire','théorie politique']
PROF_EN = ['electrician','plumber','dentist','piano tuner','accountant','locksmith','vet','bike mechanic']
PROF_FR = ['électricien','plombier','dentiste','accordeur de piano','comptable','serrurier','vétérinaire','réparateur de vélos']

def phone(): return '06 %02d %02d %02d %02d' % tuple(rnd.randint(10,99) for _ in range(4))
def slug(s): 
    import unicodedata,re
    s=unicodedata.normalize('NFKD',s).encode('ascii','ignore').decode().lower()
    return re.sub(r'[^a-z0-9]+','-',s).strip('-')[:60]

notes=[]   # (lang, family, title, body, themes, slots)
seen_keys=set()
def add(lang,family,title,body,themes,slots):
    key=(title,body)
    if key in seen_keys: return False
    seen_keys.add(key); notes.append(dict(lang=lang,family=family,title=title,body=body,themes=themes,slots=slots)); return True

def make_en(i):
    fam = ['recipe','trip','workout','meeting','book','fix','study','contact'][i%8]
    if fam=='recipe':
        k=rnd.randrange(len(DISH_EN)); d=DISH_EN[k]; mins=rnd.choice([20,25,35,40,45,55,70])
        add('en',fam,f'Recipe: {d}',f'My notes on the {d}. Main ingredient: {ING_EN[k]}. It takes about {mins} minutes and I made it twice last winter. Next time use less salt and more lemon. Serve it warm with bread.','recipes cooking',dict(dish=d,ing=ING_EN[k],mins=mins))
    elif fam=='trip':
        c=rnd.choice(CITIES); m=rnd.choice(MONTHS_EN); h=rnd.choice(HOTELS); b=rnd.choice([300,450,600,800,950])
        add('en',fam,f'Trip to {c} in {m}',f'Plan for the trip to {c} in {m}. We booked {h} for three nights. The budget is {b} euros for the two of us. Train tickets are the main cost and we want one slow evening by the river.','travel plans',dict(city=c,month=m,hotel=h,budget=b))
    elif fam=='workout':
        d=rnd.choice(DAYS_EN); a,b=rnd.sample(EXO_EN,2); st=rnd.choice([3,4,5])
        add('en',fam,f'Gym session {d}',f'The {d} gym session is built around the {a} and the {b}. I do {st} sets and rest two minutes between sets. I should note the weights next week.','gym training',dict(day=d,a=a,b=b))
    elif fam=='meeting':
        p=rnd.choice(NAMES); t=rnd.choice(TOP_EN); dec=rnd.choice(['postpone to next month','approve with a smaller scope','ask for a second quote','drop it for now','start on Monday'])
        add('en',fam,f'Meeting with {p} about the {t}',f'We met {p} to talk about the {t}. Decision: {dec}. Follow up by email and send the summary to the team before Friday.','meetings work',dict(person=p,topic=t,decision=dec))
    elif fam=='book':
        b=rnd.choice(BOOKS_EN); a=rnd.choice(NAMES)
        add('en',fam,f'Reading notes: {b}',f'Notes on {b} by {a}. The central idea is that small habits compound quietly over years. I liked the second chapter most and want to reread the ending.','books reading',dict(book=b,author=a))
    elif fam=='fix':
        k=rnd.randrange(len(FIX_EN)); f=FIX_EN[k]; tl=TOOL_EN[k]
        add('en',fam,f'Home repair: {f}',f'How to fix the {f}. You need the {tl}. Turn off the water or power first, then work slowly and test twice. I bought the parts at the hardware store near the station.','home repairs',dict(fix=f,tool=tl))
    elif fam=='study':
        s=rnd.choice(SUBJ_EN); ch=rnd.randint(2,14)
        add('en',fam,f'Study notes: {s} chapter {ch}',f'Summary of chapter {ch} of {s}. The key point is to work the exercises before reading the solutions. Exam is in June and the practice sets are on the course page.','study school',dict(subject=s,chapter=ch))
    else:
        pr=rnd.choice(PROF_EN); n=rnd.choice(NAMES); ph=phone()
        add('en',fam,f'Contact: {pr}',f'My {pr} is {n}, phone {ph}. Call in the morning, the office closes at five. Ask for the winter rate.','contacts people',dict(prof=pr,name=n,phone=ph))

def make_fr(i):
    fam = ['recipe','trip','workout','meeting','book','fix','study','contact'][i%8]
    if fam=='recipe':
        k=rnd.randrange(len(DISH_FR)); d=DISH_FR[k]; mins=rnd.choice([20,25,35,40,45,55,70])
        add('fr',fam,f'Recette : {d}',f'Mes notes sur la recette du {d}. Ingrédient principal : {ING_FR[k]}. Elle prend environ {mins} minutes et je l’ai faite deux fois cet hiver. La prochaine fois, il faut moins de sel et plus de citron. On la sert chaude avec du pain.','recettes cuisine',dict(dish=d,ing=ING_FR[k],mins=mins))
    elif fam=='trip':
        c=rnd.choice(CITIES); m=rnd.choice(MONTHS_FR); h=rnd.choice(HOTELS); b=rnd.choice([300,450,600,800,950])
        add('fr',fam,f'Voyage à {c} en {m}',f'Plan du voyage à {c} en {m}. Nous avons réservé {h} pour trois nuits. Le budget est de {b} euros pour nous deux. Les billets de train sont la dépense principale et nous voulons une soirée tranquille au bord de l’eau.','voyages projets',dict(city=c,month=m,hotel=h,budget=b))
    elif fam=='workout':
        d=rnd.choice(DAYS_FR); a,b=rnd.sample(EXO_FR,2); st=rnd.choice([3,4,5])
        add('fr',fam,f'Séance d’entraînement du {d}',f'La séance du {d} est construite autour du {a} et du {b}. Je fais {st} séries avec deux minutes de repos entre les séries. Il faut que je note les charges la semaine prochaine.','salle entraînement',dict(day=d,a=a,b=b))
    elif fam=='meeting':
        p=rnd.choice(NAMES); t=rnd.choice(TOP_FR); dec=rnd.choice(['reporter au mois prochain','valider avec un périmètre réduit','demander un deuxième devis','abandonner pour le moment','commencer lundi'])
        add('fr',fam,f'Réunion avec {p} sur la {t}' if t.startswith(('page','revue','migration','retard')) else f'Réunion avec {p} sur le {t}',f'Nous avons vu {p} pour parler de la {t}. Décision : {dec}. Il faut relancer par courriel et envoyer le compte rendu à l’équipe avant vendredi.','réunions travail',dict(person=p,topic=t,decision=dec))
    elif fam=='book':
        b=rnd.choice(BOOKS_FR); a=rnd.choice(NAMES)
        add('fr',fam,f'Notes de lecture : {b}',f'Notes sur {b} de {a}. L’idée centrale est que les petites habitudes s’accumulent doucement au fil des années. J’ai préféré le deuxième chapitre et je veux relire la fin.','livres lecture',dict(book=b,author=a))
    elif fam=='fix':
        k=rnd.randrange(len(FIX_FR)); f=FIX_FR[k]; tl=TOOL_FR[k]
        add('fr',fam,f'Bricolage : {f}',f'Comment réparer le {f}. Il faut la {tl}. Coupez d’abord l’eau ou le courant, puis travaillez lentement et testez deux fois. J’ai acheté les pièces au magasin de bricolage près de la gare.','bricolage maison',dict(fix=f,tool=tl))
    elif fam=='study':
        s=rnd.choice(SUBJ_FR); ch=rnd.randint(2,14)
        add('fr',fam,f'Révisions : {s} chapitre {ch}',f'Résumé du chapitre {ch} de {s}. Le point clé est de faire les exercices avant de lire les corrigés. L’examen est en juin et les séries d’entraînement sont sur la page du cours.','révisions école',dict(subject=s,chapter=ch))
    else:
        pr=rnd.choice(PROF_FR); n=rnd.choice(NAMES); ph=phone()
        add('fr',fam,f'Contact : {pr}',f'Mon {pr} est {n}, téléphone {ph}. Appelez le matin, le cabinet ferme à dix-sept heures. Demandez le tarif d’hiver.','contacts personnes',dict(prof=pr,name=n,phone=ph))

def fill(make,lang,target):
    i=0
    while sum(1 for n in notes if n['lang']==lang)<target and i<target*60:
        make(i); i+=1
fill(make_en,'en',n_en); fill(make_fr,'fr',n_fr)

# unique file names; keep the first note of any exact duplicate title+body out
seen=set(); uniq=[]
for n in notes:
    key=(n['title'],n['body'])
    if key in seen: continue
    seen.add(key); uniq.append(n)
notes=uniq
used=set()
with open(os.path.join(out,'index.tsv'),'w',encoding='utf8') as idx:
    idx.write('# path\ttitle\tthemes\tkeywords\n')
    for n in notes:
        base=slug(n['title']); name=base; k=2
        while name in used: name=f'{base}-{k}'; k+=1
        used.add(name); n['path']=os.path.join(src,name+'.md')
        with open(n['path'],'w',encoding='utf8') as f: f.write(f"# {n['title']}\n\n{n['body']}\n")
        idx.write(f"{n['path']}\t{n['title']}\t{n['themes']}\t-\n")

# 15 questions per language in three kinds: easy (the note's own title words), detail (two facts from the body, none of the title's
# phrasing), natural (everyday paraphrase with plurals and accents). Each has exactly one answering note.
def Pq(lang,fam): return [n for n in notes if n['lang']==lang and n['family']==fam]
def uniq(lang,fam,keyfn):
    c=Pq(lang,fam); cnt={}
    for n in c: cnt[keyfn(n)]=cnt.get(keyfn(n),0)+1
    return [n for n in c if cnt[keyfn(n)]==1]
def build_questions():
    qs=[]
    for lang in ('en','fr'):
        en=lang=='en'
        kinds={'easy':[], 'detail':[], 'natural':[], 'accent':[]}
        nonascii=lambda t: any(ord(ch)>127 for ch in t)
        for n in uniq(lang,'recipe',lambda n:n['slots']['dish']):
            d=n['slots']['dish']; kinds['easy'].append((('what do i need to cook the %s'%d) if en else ('de quoi ai-je besoin pour préparer le %s'%d),n))
        for n in uniq(lang,'recipe',lambda n:(n['slots']['ing'],n['slots']['mins'])):
            kinds['detail'].append((('the dish with %s that takes %s minutes'%(n['slots']['ing'],n['slots']['mins'])) if en else ('le plat avec %s qui prend %s minutes'%(n['slots']['ing'],n['slots']['mins'])),n))
        for n in uniq(lang,'recipe',lambda n:n['slots']['ing']):
            kinds['natural'].append((('how many minutes does the %s recipe need'%n['slots']['ing']) if en else ('combien de minutes pour les recettes à base de %s'%n['slots']['ing']),n))
        for n in uniq(lang,'trip',lambda n:(n['slots']['city'],n['slots']['month'])):
            kinds['easy'].append((('which hotel did we book for %s in %s'%(n['slots']['city'],n['slots']['month'])) if en else ('quel hôtel avons-nous réservé à %s en %s'%(n['slots']['city'],n['slots']['month'])),n))
        for n in uniq(lang,'trip',lambda n:(n['slots']['hotel'],n['slots']['budget'])):
            kinds['detail'].append((('the trip where we stayed at %s with a budget of %s euros'%(n['slots']['hotel'],n['slots']['budget'])) if en else ('le voyage à l’hôtel %s avec un budget de %s euros'%(n['slots']['hotel'],n['slots']['budget'])),n))
        for n in uniq(lang,'workout',lambda n:n['slots']['day']):
            kinds['easy'].append((('what is in my %s workout'%n['slots']['day']) if en else ('que contient ma séance du %s'%n['slots']['day']),n))
        for n in uniq(lang,'workout',lambda n:(n['slots']['a'],n['slots']['b'])):
            kinds['detail'].append((('the session with %s and %s'%(n['slots']['a'],n['slots']['b'])) if en else ('la séance avec %s et %s'%(n['slots']['a'],n['slots']['b'])),n))
        for n in uniq(lang,'meeting',lambda n:(n['slots']['person'],n['slots']['topic'])):
            kinds['easy'].append((('what did we decide with %s about the %s'%(n['slots']['person'],n['slots']['topic'])) if en else ('qu’avons-nous décidé avec %s sur la %s'%(n['slots']['person'],n['slots']['topic'])),n))
        for n in uniq(lang,'meeting',lambda n:(n['slots']['person'],n['slots']['decision'])):
            kinds['detail'].append((('when did we agree to %s with %s'%(n['slots']['decision'],n['slots']['person'])) if en else ('quand avons-nous convenu de %s avec %s'%(n['slots']['decision'],n['slots']['person'])),n))
        for n in uniq(lang,'meeting',lambda n:n['slots']['person']):
            kinds['natural'].append((('my meetings with %s'%n['slots']['person']) if en else ('mes réunions avec %s'%n['slots']['person']),n))
        for n in uniq(lang,'book',lambda n:n['slots']['book']):
            kinds['easy'].append((('what is the main idea of %s'%n['slots']['book']) if en else ('quelle est l’idée centrale de %s'%n['slots']['book']),n))
        for n in uniq(lang,'book',lambda n:n['slots']['author']):
            kinds['natural'].append((('which book did %s write'%n['slots']['author']) if en else ('quel livre a écrit %s'%n['slots']['author']),n))
        for n in uniq(lang,'fix',lambda n:n['slots']['fix']):
            kinds['easy'].append((('what tool do i need for the %s'%n['slots']['fix']) if en else ('quel outil faut-il pour le %s'%n['slots']['fix']),n))
        for n in uniq(lang,'fix',lambda n:n['slots']['tool']):
            kinds['natural'].append((('how do i fix something with the %s'%n['slots']['tool']) if en else ('comment réparer avec la %s'%n['slots']['tool']),n))
        for n in uniq(lang,'study',lambda n:(n['slots']['subject'],n['slots']['chapter'])):
            kinds['easy'].append((('summary of %s chapter %s'%(n['slots']['subject'],n['slots']['chapter'])) if en else ('résumé du chapitre %s de %s'%(n['slots']['chapter'],n['slots']['subject'])),n))
        for n in uniq(lang,'contact',lambda n:n['slots']['prof']):
            kinds['easy'].append((('what is the phone number of my %s'%n['slots']['prof']) if en else ('quel est le numéro de mon %s'%n['slots']['prof']),n))
        for n in uniq(lang,'contact',lambda n:n['slots']['name']):
            kinds['natural'].append((('who is %s and when do they close'%n['slots']['name']) if en else ('qui est %s et quand ferme-t-il'%n['slots']['name']),n))
        if not en:
            for n in uniq(lang,'contact',lambda n:n['slots']['prof']):
                if nonascii(n['slots']['prof']): kinds['accent'].append(('quel est le numéro de l’%s'%n['slots']['prof'],n))
            for n in uniq(lang,'study',lambda n:n['slots']['subject']):
                if nonascii(n['slots']['subject']): kinds['accent'].append(('mes révisions de %s'%n['slots']['subject'],n))
            for n in uniq(lang,'workout',lambda n:(n['slots']['a'],n['slots']['b'])):
                if nonascii(n['slots']['a']+n['slots']['b']): kinds['accent'].append(('la séance avec le %s et le %s'%(n['slots']['a'],n['slots']['b']),n))
            for n in uniq(lang,'trip',lambda n:n['slots']['hotel']):
                if nonascii(n['slots']['hotel']): kinds['accent'].append(('le séjour à l’hôtel %s'%n['slots']['hotel'],n))
        pool=[]; used_t=set()
        quotas=(('easy',5),('detail',5),('natural',5)) if en else (('accent',4),('easy',4),('detail',4),('natural',3))
        for kind,k in quotas:
            c=[x for x in kinds[kind] if x[1]['path'] not in used_t]; rnd.shuffle(c)
            fam_seen=collections.Counter(); picked=[]
            for text,n in c:
                if fam_seen[n['family']]>=2: continue
                picked.append((text,n)); fam_seen[n['family']]+=1; used_t.add(n['path'])
                if len(picked)==k: break
            pool+=picked
        for text,n in pool: qs.append((lang,text,n['path']))
    return qs
Qs=build_questions()
with open(os.path.join(out,'questions.tsv'),'w',encoding='utf8') as f:
    for i,(lang,text,target) in enumerate(Qs,1): f.write(f"q{i:02d}\t{lang}\t{text}\t{target}\n")
print(f"notes={len(notes)} en={sum(1 for n in notes if n['lang']=='en')} fr={sum(1 for n in notes if n['lang']=='fr')} questions={len(Qs)} en_q={sum(1 for q in Qs if q[0]=='en')} fr_q={sum(1 for q in Qs if q[0]=='fr')}")
