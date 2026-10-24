# Dossier de conception — CollabDoc

## 1. Objectif et périmètre

Application web d'écriture à plusieurs pour une association étudiante : plusieurs centaines de
rédacteurs écrivent ensemble, puis la production est diffusée par un lien de téléchargement
PDF limité en nombre (ex. 500 exemplaires), annoncé à heure fixe.

Le projet vise un **MVP qui respecte toutes les contraintes du sujet**, sans fonctionnalité
superflue. Chaque choix ci-dessous est justifié par une contrainte ou par une règle du sujet
(compte AWS gratuit, une seule région, aucune clé dans le dépôt, moindre privilège, fichiers
dans S3).

Hors périmètre, assumé : vrais comptes (le sujet autorise un nom + e-mail), mise en forme
riche du texte (le sujet parle d'« un simple texte »), nom de domaine personnalisé.

## 2. Architecture

```
                         ┌──────────────────────── CloudFront ────────────────────────┐
 Navigateur ────────────►│  /*        → S3 (site React, privé, accès via OAC)          │
 (rédacteur / visiteur)  │  /public/* → API HTTP (statut des liens, cache 2 s)         │
                         └─────────────────────────────────────────────────────────────┘
      │ HTTPS (JSON)                                   │ WSS
      ▼                                                ▼
 API Gateway HTTP API                          API Gateway WebSocket API
  ├─ ApiFunction     (session, documents,       ├─ WsConnectFunction    ($connect)
  │                   partage, versions, liens) ├─ WsDisconnectFunction ($disconnect)
  ├─ UpdateFunction  (modifications)            └─ WsMessageFunction    (présence)
  ├─ ClaimFunction   (téléchargements, public)
  └─ AdminFunction   (tableau de bord)                 ▲ diffusion (postToConnection)
      │                                                │
      ▼                                                │
 DynamoDB (9 tables, à la demande) ────────────────────┘
   Links ──stream (remaining 1→0)──► NotifyFunction ──► SES (e-mail au créateur)
 S3 « data » : pdf/<doc>/<rev>.pdf (cache des PDF), versions/<doc>/<id>.txt
 EventBridge Scheduler (10 min) ──► SnapshotFunction (versions automatiques)
 SSM Parameter Store : secret de signature des sessions, jeton admin (SecureString)
 CloudWatch Logs : un groupe de journaux, rétention 14 jours
```

Tout est décrit dans `template.yaml` (AWS SAM, traduit en CloudFormation) : une commande
déploie, une commande supprime.

### 2.1 Pourquoi du *serverless* ?

| Critère | Choix serverless (Lambda, API Gateway, DynamoDB) | Alternative écartée (EC2 + serveur Node.js) |
|---|---|---|
| Pic de 15 000 visiteurs en 1 min | Montée en charge automatique et immédiate | Il faut dimensionner, mettre un équilibreur de charge et de l'auto-scaling (plus lent qu'un pic d'une minute) |
| Coût (plan gratuit) | Paiement à l'usage, quasi nul au repos | Instance payée en continu |
| Exploitation | Aucun serveur à patcher | Système, sécurité, redémarrages à gérer |
| Sécurité | Un rôle IAM par fonction | Un rôle pour tout le serveur |
| Contrepartie | Pas d'état en mémoire partagé : la collaboration doit être conçue sans serveur « central » (voir §3.2) | Plus simple pour garder un document en mémoire |

La contrepartie est réelle, et c'est précisément ce qui a guidé le choix d'un CRDT (§3.2).

### 2.2 Région unique

Le compte AWS (nouvelle expérience, plan gratuit) est rattaché à **eu-north-1 (Stockholm)** ;
toutes les ressources régionales y sont créées. CloudFront est un service global (pas de
ressource dans une autre région ; pas de WAF ni de certificat us-east-1 utilisés).

## 3. Réponse à chaque contrainte

### 3.1 Contrainte 1 — jamais un téléchargement de trop

*Un lien permet exactement le nombre de téléchargements autorisé, quel que soit le nombre de
visiteurs qui cliquent au même instant.*

Le compteur `remaining` du lien est un attribut d'un item DynamoDB. Prendre un exemplaire,
c'est **une seule écriture conditionnelle atomique** :

```
UpdateItem  SET remaining = remaining - 1   CONDITION remaining > 0
```

DynamoDB applique les écritures sur un même item **l'une après l'autre** et évalue la
condition sur la valeur courante : avec `N` exemplaires, exactement `N` écritures réussissent ;
toutes les autres échouent (`ConditionalCheckFailed`) → réponse `410 épuisé`. Aucun verrou,
aucune lecture-puis-écriture (qui aurait une fenêtre de concurrence).

- Une lecture préalable (non garantie) évite d'écrire quand le lien est déjà épuisé ; elle ne
  sert qu'à économiser, la garantie vient de la condition.
- Chaque exemplaire attribué est tracé dans la table `Claims` (preuve dans le rapport de test).
- Si la génération du PDF échoue *après* la réservation, l'exemplaire est rendu
  (`remaining + 1`) et le visiteur réessaie : on peut distribuer moins, jamais plus.
- Le PDF est délivré par une **URL S3 pré-signée valable 60 s** (le fichier reste privé dans S3,
  la bande passante ne passe pas par Lambda).

*Alternative écartée :* une transaction DynamoDB (décrément + écriture de l'audit) — les
transactions concurrentes sur un même item se rejettent mutuellement (`TransactionConflict`) ;
sous un pic, cela produit beaucoup d'échecs inutiles. L'écriture conditionnelle simple est
sérialisée sans conflit.

### 3.2 Contrainte 2 — aucune modification acceptée perdue, tous voient le même document

*Quel que soit le nombre de personnes qui écrivent en même temps, y compris au même endroit.*

**Choix : un CRDT ([Yjs](https://docs.yjs.dev)).** Chaque modification est une « mise à jour »
binaire. Les mises à jour Yjs sont **commutatives, associatives et idempotentes** : appliquer
le même ensemble de mises à jour, dans n'importe quel ordre et même en double, donne le même
texte. Deux insertions au même endroit sont toutes deux conservées, dans un ordre
déterministe identique pour tous.

Conséquence : le serveur n'a pas besoin de « transformer » les modifications ni de les
ordonner — il n'a qu'à **ne perdre aucune mise à jour acceptée et les transmettre à tous**.
C'est ce qui rend l'approche compatible avec Lambda (sans état en mémoire).

Protocole :
1. Le client regroupe ses frappes (~80 ms) et envoie la mise à jour par `POST /updates`,
   **une requête à la fois**, avec un identifiant unique.
2. La fonction stocke la mise à jour dans la table `Updates` (clé `docId` + `updateId`),
   **puis seulement** répond `200` : *acceptée = écrite durablement dans DynamoDB*.
3. Elle la diffuse à tous les participants connectés au document (WebSocket).
4. L'état d'un document = fusion de toutes ses mises à jour stockées
   (`GET /state`, lecture fortement cohérente). Chaque client relit cet état à chaque
   (re)connexion : ce qu'il aurait manqué hors ligne est rattrapé.

Robustesse :
- **Réseau coupé pendant l'envoi** : le client renvoie avec le *même* `id` ; la condition
  `attribute_not_exists(updateId)` garantit un stockage unique, et la réponse est quand même
  `200` (`duplicate: true`).
- **Diffusion WebSocket perdue** : sans gravité, l'état fusionné relu par le client la contient ;
  et les doublons reçus sont sans effet (idempotence).

*Alternatives écartées :*
- *Dernier qui écrit gagne* (envoi du texte entier) : perd des modifications concurrentes.
- *Transformation opérationnelle (OT)* : exige un serveur central qui ordonne toutes les
  opérations d'un document — mal adapté à Lambda, et plus complexe à prouver.
- *Envoi des modifications par WebSocket* : une trame API Gateway WebSocket est limitée à
  32 Kio (un collage important la dépasse) et l'accusé de réception serait à construire.
  En HTTP, la réponse **est** l'accusé de réception, et le jury peut tester l'API avec de
  simples requêtes HTTP.

### 3.3 Contrainte 3 — le lien donne le document tel qu'il est à l'instant T1

Le PDF n'est pas fabriqué à la création du lien mais **au moment du téléchargement**, à partir
de l'état courant. Pour ne pas regénérer un PDF à chaque visiteur :

- chaque modification acceptée incrémente un compteur de révision `rev` du document ;
- le PDF est mis en cache dans S3 sous la clé `pdf/<docId>/<rev>.pdf` ;
- au téléchargement : lecture fortement cohérente de `rev` → si le PDF de cette révision
  existe, il est servi, sinon il est généré puis stocké.

**Ordre des opérations (c'est ce qui garantit la cohérence)** : la modification est stockée,
*puis* `rev` est incrémenté, *puis* la modification est acquittée. Tout téléchargement qui
commence après l'acquittement voit donc une révision au moins égale, dont le PDF a été généré
à partir d'une lecture postérieure au stockage de la modification. Le PDF est toujours
« complet et cohérent » : c'est l'état fusionné d'un ensemble de mises à jour, jamais un
mélange partiel.

*Pourquoi `rev` n'est pas dans la même transaction que le stockage :* toutes les
modifications d'un même document écriraient alors le même item dans des transactions
concurrentes, qui se rejetteraient mutuellement. Un `ADD` atomique simple n'a pas ce
problème.

Rendu PDF : bibliothèque `pdf-lib` (JavaScript pur, pas de navigateur embarqué), police
standard Helvetica ; les caractères non représentables (émojis…) sont remplacés par `?`.

### 3.4 Contrainte 4 — jamais plus que le crédit du jour, même depuis plusieurs appareils

- Un item par rédacteur et par jour UTC : `<email>#<AAAA-MM-JJ>` avec l'attribut `used`.
- Le **serveur compte lui-même** les caractères insérés en décodant la mise à jour Yjs (il ne
  fait pas confiance au client). Les suppressions ne consomment pas de crédit ; le texte
  inséré puis effacé avant l'envoi est quand même compté (comptage prudent : jamais en
  dessous).
- Le débit du crédit et le stockage de la modification sont faits dans **une seule
  transaction DynamoDB**, avec la condition `used ≤ 10 000 − caractères`. Deux appareils qui
  écrivent au même instant ne peuvent pas passer tous les deux la condition si la somme
  dépasse le crédit ; et si la transaction échoue, rien n'est stocké.
- Le crédit est rechargé implicitement : le lendemain, c'est un nouvel item (les anciens
  disparaissent par TTL).
- Côté navigateur, l'éditeur refuse déjà la frappe au-delà du crédit restant (confort), mais la
  garantie est côté serveur.

### 3.5 Détection des abus

Chaque écriture refusée (crédit épuisé, écriture pendant un blocage) est un « avertissement »
compté par fenêtre de 10 minutes. À **20 avertissements**, la personne est **bloquée 15
minutes** : ses écritures et ses connexions WebSocket sont refusées (`423`). Les compteurs et
blocages expirent seuls (TTL DynamoDB + date de fin vérifiée). Les blocages apparaissent dans
le tableau de bord.

Les visiteurs anonymes, eux, sont limités globalement par le débit d'API Gateway (§3.6).

### 3.6 Contrainte 5 — le pic : 15 000 visiteurs (80 % en 1 minute) et 300 rédacteurs

Ordre de grandeur : 12 000 visiteurs en 60 s ≈ **200 requêtes/s** en moyenne, davantage à la
seconde de l'annonce.

| Mesure | Effet |
|---|---|
| Page de téléchargement statique sur CloudFront | 15 000 chargements de page sans toucher l'API |
| Statut du lien servi via CloudFront (`/public/…`, cache 2 s) | Les visiteurs qui attendent interrogent le cache, pas Lambda |
| Limite de débit API Gateway sur `POST /claim` (300 req/s, rafale 300) | Au-delà, réponse immédiate `429` au lieu d'une surcharge |
| Concurrence Lambda réservée à `ClaimFunction` (100 sur 400) | Le pic ne peut pas consommer la capacité des fonctions d'édition : **les 300 rédacteurs continuent d'écrire** |
| DynamoDB à la demande | Absorbe le débit sans provisionnement |
| PDF en cache par révision | Au plus quelques générations de PDF pendant le pic |
| Lien épuisé mémorisé dans chaque instance Lambda | Après le dernier exemplaire, réponse `410` sans lecture ni écriture |

**Chaque visiteur obtient toujours une réponse explicite** : `200` (télécharger), `410`
(épuisé), ou `429`/`503` (patienter). La page affiche « Forte affluence — veuillez patienter »
et réessaie automatiquement avec un délai croissant aléatoire (*exponential backoff + jitter*),
pour étaler les nouvelles tentatives au lieu de les synchroniser.

### 3.7 Contrainte 6 — fin de distribution

- Dès que `remaining = 0`, `POST /claim` répond `410` immédiatement, sans générer de PDF ni
  présigner d'URL : l'application ne délivre plus de service épuisé.
- Les pages ouvertes interrogent le statut toutes les ~5 s (via CloudFront, 2 s de cache) :
  elles affichent « Lien épuisé » en quelques secondes, même sans cliquer. Les visiteurs en
  attente l'apprennent à leur prochaine tentative.
- Le créateur du lien reçoit un e-mail : le *stream* DynamoDB de la table `Links` déclenche
  `NotifyFunction`, avec un filtre sur la transition `remaining 1 → 0` (un seul événement).
  L'e-mail est hors du chemin du téléchargement : un échec d'envoi ne bloque aucun visiteur, et
  la fonction de téléchargement n'a aucun droit SES.

## 4. Fonctionnalités

| Besoin du sujet | Réalisation |
|---|---|
| Créer un document et y donner accès | `POST /documents`, `POST /documents/{id}/members` (table `Members`, index par document) |
| Écrire à plusieurs, voir presque aussitôt | Yjs + CodeMirror 6 ; envoi toutes les ~80 ms ; diffusion WebSocket |
| Savoir qui est présent et où il écrit | Protocole *awareness* de Yjs relayé par WebSocket : curseurs colorés nommés dans le texte + liste « Nom · ligne N » |
| Versions précédentes et restauration | Instantanés texte dans S3 (manuels + automatiques toutes les 10 min si modifié) ; la restauration sauvegarde l'état courant puis applique une modification CRDT qui remplace le texte (aucune perte, convergence normale) |
| Lien de téléchargement à N exemplaires | §3.1, §3.3 |
| Crédit quotidien, blocage | §3.4, §3.5 |
| État de l'application pour l'association | `GET /admin/state` + page `#/admin` rafraîchie toutes les 5 s : documents ouverts (connexions WebSocket actives) et qui y est, liens actifs et exemplaires restants, personnes bloquées |
| E-mail au dernier téléchargement | §3.7 |
| Identification par nom + e-mail | `POST /session` → jeton signé (HMAC-SHA256, secret dans SSM) |

## 5. Modèle de données (DynamoDB)

| Table | Clé | Contenu / rôle |
|---|---|---|
| `Documents` | `docId` | titre, propriétaire, `rev`, `versionRev` |
| `Members` | `email` + `docId` (index `byDoc`) | qui a accès à quoi |
| `Updates` | `docId` + `updateId` | mises à jour Yjs acceptées (binaire) — **la source de vérité du contenu** |
| `Credits` | `email#jour` | caractères utilisés (TTL 2 jours) |
| `Connections` | `connectionId` (index `byDoc`) | WebSockets ouverts (TTL 3 h) |
| `Links` | `linkId` (index `byDoc`) | `maxDownloads`, `remaining` ; *stream* activé |
| `Claims` | `linkId` + `claimId` | audit : un item par exemplaire distribué |
| `Versions` | `docId` + `versionId` | métadonnées des versions (texte dans S3) |
| `Abuse` | `pk` | avertissements par fenêtre, blocages (TTL) |

Mode de facturation **à la demande** partout : pas de capacité à prévoir pour le pic, coût nul
au repos.

## 6. Sécurité

- **Aucune clé AWS dans le code ou le dépôt.** Les fonctions utilisent leur rôle IAM ; le
  déploiement utilise des identifiants temporaires (`aws login`). Les secrets applicatifs
  (signature des sessions, jeton admin) sont générés par `scripts/bootstrap.sh` directement
  dans SSM Parameter Store (SecureString chiffré KMS), jamais écrits sur disque.
- **Moindre privilège** : un rôle par fonction, limité aux actions et ressources utilisées.
  Exemples : `ClaimFunction` peut seulement lire/décrémenter `Links`, écrire dans `Claims`,
  lire `Documents`/`Updates` et lire/écrire `pdf/*` dans S3 — rien sur les crédits, SES ou
  SSM. `NotifyFunction` ne peut qu'envoyer un e-mail depuis l'adresse expéditrice configurée.
  `AdminFunction` est en lecture seule.
- Buckets S3 privés (*Block Public Access*), chiffrés, HTTPS obligatoire ; le site n'est
  lisible que par CloudFront (Origin Access Control).
- Entrées validées côté serveur (e-mail, titres, taille et **nature** des mises à jour : seules
  des modifications de texte sont acceptées).
- Limitation de débit API Gateway (globale et spécifique au téléchargement).
- Limite assumée : l'identité est *déclarée* (nom + e-mail), comme le permet le sujet ;
  quelqu'un peut donc saisir l'e-mail d'un autre. De vrais comptes (Amazon Cognito) seraient
  l'évolution naturelle.

## 7. Bonnes pratiques appliquées

- Infrastructure as Code (SAM/CloudFormation), déploiement et suppression scriptés.
- Étiquette `project=collabdoc` sur les ressources (suivi des coûts).
- Journaux centralisés avec rétention de 14 jours (pas d'accumulation de coûts).
- Idempotence des écritures, reprises avec *backoff* exponentiel et *jitter*.
- Tests unitaires lancés à chaque déploiement ; tests de bout en bout et de charge reproductibles.
- Architecture ARM64 (Graviton) pour Lambda : moins chère à performance égale.

## 8. Limites connues et évolutions

| Limite | Impact | Évolution |
|---|---|---|
| L'historique `Updates` d'un document n'est jamais compacté | La lecture de l'état grossit avec le nombre de modifications | Compacter périodiquement en un instantané Yjs stocké dans S3 |
| SES en mode *sandbox* | E-mails seulement vers des adresses vérifiées | Demander l'accès production SES |
| Identité déclarative | Usurpation d'e-mail possible | Amazon Cognito |
| Diffusion à N connexions par une seule Lambda | Coût linéaire en nombre de participants d'un même document | Suffisant pour quelques dizaines de rédacteurs par document |
| Jour de crédit = jour UTC | Recharge à 01:00 heure du Cameroun | Paramétrer le fuseau |
