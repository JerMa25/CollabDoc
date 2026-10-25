# Rapport de test — CollabDoc

Ce rapport présente la méthode, les objectifs fixés, les résultats bruts, leur analyse et la
**preuve que les deux contraintes les plus importantes (1 et 2) sont respectées**.
Tous les résultats bruts sont dans [`tests/results/`](../tests/results/) (JSON produits par les
scripts, journaux, métriques CloudWatch). Les runs ayant révélé un bug sont conservés dans
[`tests/results/archive/`](../tests/results/archive/) avec leur explication.

## 1. Synthèse

| Contrainte | Objectif fixé | Résultat | Verdict |
|---|---|---|---|
| **1** — jamais un téléchargement de trop | 0 téléchargement au-delà de N, quel que soit le nombre de clics simultanés | 50/50 pour 1 000 clics simultanés ; 100/100 pour 3 000 ; **500/500 pour 15 000 visiteurs** ; `remaining` final = 0 | ✅ |
| **2** — aucune modification acceptée perdue, convergence | 0 modification acceptée absente ou dupliquée ; toutes les copies identiques | 50 rédacteurs au **même endroit** : 1 000/1 000 ; **pendant le pic : 79 334/79 334** ; copies identiques | ✅ |
| 3 — le lien donne l'état à T1 | PDF généré avec le contenu courant | Test de bout en bout + conception (§3.3 du dossier) | ✅ |
| 4 — crédit, même depuis plusieurs appareils | ≤ 10 000 caractères/jour, avec 8 à 10 appareils en parallèle | Exactement 10 000 acceptés, refus ensuite ; blocage après 20 refus | ✅ |
| 5 — pic de 15 000 visiteurs + 300 rédacteurs | Chaque visiteur obtient une réponse explicite ; pas de casse ; rédacteurs non pénalisés | **0 visiteur sans réponse, 0 réponse inattendue, 0 erreur serveur** ; rédacteurs p99 = 221 ms | ✅ |
| 6 — fin de distribution | Les visiteurs l'apprennent vite, plus de service délivré | Réponse « épuisé » en p50 = 44 ms ; 1 seul e-mail envoyé | ✅ |

## 2. Méthode

### 2.1 Environnement
- Application déployée telle que livrée (pile `collabdoc`, eu-north-1), sans réglage spécial.
- **Générateur de charge dans la même région** : une instance EC2 temporaire `m7i-flex.large`
  (2 vCPU, 8 Gio — le plus gros type autorisé par le plan gratuit), décrite en IaC
  ([`tests/load/loadgen.yaml`](../tests/load/loadgen.yaml)), pilotée par SSM sans port ouvert,
  supprimée après les tests ([`scripts/loadtest.sh`](../scripts/loadtest.sh)).
  *Pourquoi :* les premiers essais depuis un ordinateur personnel (connexion domestique au
  Cameroun) échouaient côté client au-delà d'environ 300 connexions simultanées ; on aurait mesuré
  la connexion internet et non l'application.
- Les tests n'utilisent **que l'API publique** décrite dans [api.md](api.md), comme le ferait le jury.

### 2.2 Outils et scripts

| Script | Mesure | Contrainte |
|---|---|---|
| [`backend/test/*.test.ts`](../backend/test/) (Vitest, 14 tests) | Comptage des caractères, propriétés CRDT (commutativité, idempotence), rattrapage par vecteur d'état, jetons, PDF | 2, 4 |
| [`tests/smoke.mjs`](../tests/smoke.mjs) | Parcours complet : session, édition, doublon, PDF, épuisement, versions, restauration | 1, 3 |
| [`tests/convergence/convergence.mjs`](../tests/convergence/convergence.mjs) | N rédacteurs insèrent **en même temps à la position 0** ; vérifie chaque modification acceptée et compare toutes les copies | **2** |
| [`tests/load/claim-race.mjs`](../tests/load/claim-race.mjs) | N clics lancés **au même instant** sur un lien de M exemplaires, sans nouvel essai | **1** |
| [`tests/load/credit-multidevice.mjs`](../tests/load/credit-multidevice.mjs) | Même e-mail sur 8–10 sessions écrivant en parallèle, puis acharnement | 4 |
| [`tests/load/peak.sh`](../tests/load/peak.sh) = [`writers.mjs`](../tests/load/writers.mjs) + [`spike.js`](../tests/load/spike.js) (k6) | 300 rédacteurs pendant 7 min + 15 000 visiteurs sur un lien de 500 | 5, 6 (et 1, 2 sous charge) |
| [`tests/load/cloudwatch-metrics.sh`](../tests/load/cloudwatch-metrics.sh) | Vue serveur : erreurs, limitations, concurrence, latences | 5 |

### 2.3 Comment la preuve est construite
- **Contrainte 1** : on compte les réponses `200` côté client, on relit `remaining` côté serveur
  et on vérifie que les numéros d'exemplaire attribués sont **tous distincts** (1..N).
- **Contrainte 2** : chaque modification insère un **marqueur unique** (`<b3e17>`). À la fin, on
  vérifie dans le document du serveur que **chaque marqueur dont l'envoi a reçu `200` apparaît
  exactement une fois**, puis que la copie de chaque participant est **identique** à celle du
  serveur (d'abord telle que reçue en direct, puis après la resynchronisation que fait le client).

## 3. Contrainte 1 — résultats

### 3.1 Course aux téléchargements (clics simultanés, sans nouvel essai)

| Run | Lien | Clics simultanés | 200 | 410 épuisé | 429/503 patienter | Sans réponse¹ | Numéros distincts | `remaining` final |
|---|---|---|---|---|---|---|---|---|
| [claim-race-20261024193820](../tests/results/claim-race-20261024193820.json) (PC) | 50 | 1 000 | **50** | 582 | 0 | 368 | 50 (1..50) | **0** |
| [claim-race-20261024215802](../tests/results/claim-race-20261024215802.json) (AWS) | 100 | 3 000 | **100** | 1 290 | 727 | 883 | 100 (1..100) | **0** |

¹ *Erreurs de connexion côté client* (`UND_ERR_CONNECT_TIMEOUT` du client HTTP de Node.js qui
ouvre des milliers de connexions TLS à la fois). Le serveur n'a enregistré aucune erreur (§5.3) ;
avec k6, client plus efficace, ce chiffre tombe à 0 sur 15 000 visiteurs (§5).

### 3.2 Pendant le pic (15 000 visiteurs)
Lien de **500** exemplaires : **500** réponses `200`, `remaining` final = 0
([spike-summary-20261024223158](../tests/results/spike-summary-20261024223158.json)).

**Analyse.** Dans tous les runs, le nombre de succès est exactement égal au nombre d'exemplaires,
jamais supérieur, alors que des centaines de requêtes arrivaient dans la même seconde. C'est la
propriété attendue de l'écriture conditionnelle DynamoDB (`remaining > 0`) : les écritures sur un
item sont appliquées l'une après l'autre et la condition est évaluée sur la valeur courante.

## 4. Contrainte 2 — résultats

### 4.1 Tous au même endroit

| Run | Rédacteurs × modif. | Acceptées | Absentes | En double | Copies ≠ serveur (direct) | Copies ≠ serveur (après resync) | Latence p50 / p99 |
|---|---|---|---|---|---|---|---|
| [convergence-20261024193713](../tests/results/convergence-20261024193713.json) (PC) | 20 × 25 | 500 / 500 | **0** | **0** | 1 | **0** | 371 / 2 132 ms |
| [convergence-20261024220633](../tests/results/convergence-20261024220633.json) (AWS) | 50 × 20 | 1 000 / 1 000 | **0** | **0** | **0** | **0** | 234 / 2 027 ms |

Dans le dernier run, chacun des 50 participants a reçu **1 000 diffusions sur 1 000** et la
resynchronisation n'avait rien à rattraper (200 octets au total, soit 50 différences vides).

### 4.2 Sous la charge du pic (300 rédacteurs, 30 documents, 7 minutes)
[writers-20261024223158](../tests/results/writers-20261024223158.json) : **79 334 modifications
envoyées, 79 334 acceptées, 0 absente, 0 en double.** Latence d'acceptation p50 = 67 ms,
p90 = 104 ms, p99 = 221 ms, max = 1 040 ms — pendant que 15 000 visiteurs frappaient le lien.

**Analyse.** Aucune modification acceptée n'a été perdue ni dupliquée, y compris avec 50
personnes insérant au même caractère au même moment. Toutes les copies finissent identiques :
c'est la garantie du CRDT (fusion commutative et idempotente), combinée à la règle
« acceptée = stockée avant l'acquittement » et à la resynchronisation par vecteur d'état.

## 5. Contraintes 5 et 6 — le pic

### 5.1 Scénario ([`spike.js`](../tests/load/spike.js))
- **1 500 visiteurs à la même seconde** (l'annonce) ;
- puis 175 nouveaux visiteurs/s jusqu'à la fin de la 1ʳᵉ minute → **12 000 en 1 min (80 %)** ;
- puis 12,5/s pendant 4 minutes → **15 000 au total** ;
- chaque visiteur fait ce que fait la page : lecture du statut (CloudFront), demande
  d'exemplaire, et en cas de `429`/`503` attente croissante aléatoire puis nouvel essai,
  jusqu'à une réponse finale (`200` ou `410`) ;
- **en même temps**, 300 rédacteurs écrivent (une modification toutes les 1–2 s chacun).

### 5.2 Résultats côté visiteurs (k6, run final `20261024223158`)

| Mesure | Valeur |
|---|---|
| Visiteurs simulés (itérations terminées) | 14 960 (0 non lancé par k6)² |
| Téléchargements (`200`) | **500** |
| « Lien épuisé » (`410`) | 14 460 |
| Réponses « patientez » (`429`/`503`) reçues pendant la rafale | 7 903 |
| **Réponses inattendues** (erreur réseau, 5xx autre que 503…) | **0** |
| **Visiteurs sans réponse finale** | **0** |
| Délai jusqu'à la réponse finale p50 / p90 / p99 / max | 44 ms / 5,9 s / 26,5 s / 32,5 s |
| Durée des requêtes HTTP p50 / p90 / p99 | 20 / 88 / 693 ms |

² Le scénario prévoit 15 000 arrivées ; 40 itérations de la fin de fenêtre ont été arrêtées par
k6 à l'échéance du scénario. Un run précédent (archivé) avait manqué de capacité côté k6
(436 visiteurs non lancés) : capacité augmentée pour le run final.

### 5.3 Résultats côté serveur (CloudWatch, fenêtre du pic — [cloudwatch-20261024223158.json](../tests/results/cloudwatch-20261024223158.json))

| Composant | Invocations | Erreurs | Limitations | Concurrence max | Durée p99 |
|---|---|---|---|---|---|
| UpdateFunction (rédacteurs) | 79 334 | **0** | **0** | 75 | 171 ms |
| ClaimFunction (visiteurs) | 28 165 | **0** | 1 127 → « patientez » | 100 (plafond réservé) | 42 ms |
| ApiFunction | 965 | 0 | 0 | 25 | 1 310 ms |
| WsConnect / WsDisconnect | 301 / 301 | 0 | 0 | 16 / 55 | 257 / 435 ms |
| NotifyFunction (e-mail) | **1** | 0 | 0 | 1 | 275 ms |

API HTTP : 116 368 requêtes, 0 erreur 5xx autre que les 1 127 « 503 patientez » (limitation de
la fonction de téléchargement), latence p99 = 647 ms. API WebSocket : 786 447 messages diffusés.
**DynamoDB : 0 requête limitée** sur les 9 tables. Machine de charge : charge max 1,66 pour
2 vCPU, 5,8 Gio libres (elle n'a pas été le goulot d'étranglement).

### 5.4 Analyse
- **Rien n'a cassé, rien n'a été jeté** : chaque visiteur a obtenu une réponse explicite, et
  aucune erreur serveur n'a été enregistrée.
- **Le cloisonnement fonctionne** : la fonction de téléchargement a atteint son plafond de
  concurrence réservée (100) et renvoyé « patientez », tandis que la fonction d'édition, elle,
  n'a jamais été limitée (75 exécutions simultanées max) ; la latence des rédacteurs est restée
  à 221 ms au p99. C'est l'effet recherché de la concurrence réservée (dossier de conception §3.6).
- **Fin de distribution (contrainte 6)** : les 500 exemplaires partent dans les premières
  secondes ; ensuite les visiteurs reçoivent « épuisé » en ~44 ms (p50), sans génération de PDF
  ni écriture (lien mémorisé comme épuisé dans chaque instance). Un seul e-mail a été déclenché.
- **Point d'amélioration** : la queue de distribution du délai de réponse (p99 = 26 s) vient des
  visiteurs de la rafale initiale qui ont dû patienter plusieurs fois (attente croissante jusqu'à
  30 s). C'est le compromis choisi pour ne pas synchroniser les nouvelles tentatives ; un plafond
  d'attente plus bas réduirait la queue au prix de plus de requêtes.

## 6. Contrainte 4 — crédit et abus

| Run | Appareils (même e-mail) | Caractères acceptés | Crédit serveur | Refus 403 | Bloqué après |
|---|---|---|---|---|---|
| [credit-20261024195651](../tests/results/credit-20261024195651.json) | 8 | **10 000** | 10 000 | 8 | 12 tentatives de plus (20 refus) |
| [credit-20261024215823](../tests/results/credit-20261024215823.json) | 10 | **10 000** | 10 000 | 10 | 10 tentatives de plus (20 refus) |

Avec 8 ou 10 appareils écrivant en parallèle par blocs de 400 caractères, exactement 25 blocs
sont acceptés (10 000 caractères), jamais un de plus : le débit et le stockage sont dans la même
transaction conditionnelle. L'acharnement est détecté au 20ᵉ refus et la personne est bloquée
(visible dans le tableau de bord).

## 7. Ce que les tests ont permis de corriger

Les tests ont révélé deux vrais défauts de l'application et deux défauts du banc de test ;
les runs correspondants sont archivés ([`archive/README.md`](../tests/results/archive/README.md)).

| Constat | Cause | Correction |
|---|---|---|
| La moitié des participants ne recevaient aucune diffusion en direct | API Gateway répond « Gone » pour une connexion encore en cours d'ouverture ; le code la supprimait | Ne supprimer une connexion « Gone » que si elle a plus de 30 s |
| ~23 % des diffusions reçues avec 50 participants dans le même document | Limite de débit de l'API de diffusion WebSocket | Limite relevée, nouvel essai avec *jitter*, **resynchronisation périodique du client par vecteur d'état** (rattrape toute diffusion perdue) |
| *(banc de test)* rédacteurs bloqués à tort | Le script calculait ses modifications par différence d'état et y incluait celles des autres en attente — que le serveur a, à juste titre, facturées | Le script capture sa modification comme le vrai client |
| *(banc de test)* marqueurs « manquants » | Insertion au milieu d'un autre marqueur | Insertion entre marqueurs, comptage exact |

Dans les deux défauts de l'application, **aucune modification acceptée n'avait été perdue** :
le document stocké était complet ; seul l'affichage en direct était en retard.

## 8. Limites des tests

- Un seul générateur de charge de 2 vCPU (limite du plan gratuit). Il n'a pas saturé (charge
  max 1,66), mais un test à plus grande échelle demanderait plusieurs générateurs.
- Les rédacteurs simulés écrivent des marqueurs, pas un texte réaliste ; le volume (environ
  190 modifications/s) est en revanche supérieur à celui de 300 humains.
- L'e-mail de dernier téléchargement a été vérifié avec une adresse réelle vérifiée dans SES ;
  pendant les tests de charge, les adresses fictives sont refusées par le *sandbox* SES (refus
  journalisé, sans effet sur le téléchargement).
- Effet observé de l'absence de compaction de l'historique : la création automatique de versions
  a pris jusqu'à 33 s sur des documents de ~2 600 modifications (voir limites, dossier de
  conception §8).

## 9. Reproduire

```bash
cd tests && npm ci
node smoke.mjs                                         # FRONT_URL=... pour la partie CloudFront
WRITERS=50 EDITS=20 node convergence/convergence.mjs   # contrainte 2
MAX=100 CLICKS=3000 node load/claim-race.mjs           # contrainte 1
DEVICES=10 node load/credit-multidevice.mjs            # contrainte 4

# Pic complet depuis un générateur dans la région (créé puis supprimé) :
./scripts/loadtest.sh up
./scripts/loadtest.sh run 'bash load/peak.sh'
./scripts/loadtest.sh pull
tests/load/cloudwatch-metrics.sh <début UTC> <fin UTC> > tests/results/cloudwatch-<run>.json
./scripts/loadtest.sh down
```
