# CollabDoc - éditeur de documents partagé sur AWS

Application web d'écriture à plusieurs : édition simultanée d'un même texte (avec présence et
curseurs des autres rédacteurs), historique des versions avec restauration, liens de
téléchargement PDF limités en nombre, crédit d'écriture quotidien, détection des abus,
tableau de bord pour l'association, e-mail au créateur d'un lien lors du dernier téléchargement.

| Document | Contenu |
|---|---|
| [docs/conception.md](docs/conception.md) | Dossier de conception : architecture, choix et justifications, réponse à chaque contrainte |
| [docs/api.md](docs/api.md) | Description de l'API (HTTP + WebSocket), suffisante pour écrire ses propres tests |
| [docs/rapport-tests.md](docs/rapport-tests.md) | Rapport de test : méthode, objectifs, résultats bruts, analyse, preuves des contraintes 1 et 2 |
| [docs/couts.md](docs/couts.md) | Preuve et analyse du coût du projet |

## Architecture en bref

```
Navigateur ──CloudFront──► S3 (site statique React)            /public/* ─► statut de lien (cache 2 s)
   │ HTTPS  ──► API Gateway HTTP ──► Lambda (api, update, claim, admin) ──► DynamoDB ──stream──► Lambda notify ──► SES
   │ WSS    ──► API Gateway WebSocket ──► Lambda (connect, disconnect, message)
   └ PDF   ◄── URL S3 pré-signée (60 s) ◄── S3 (pdf/, versions/)          EventBridge Scheduler ──► Lambda snapshot (10 min)
```

Tout est décrit en *Infrastructure as Code* dans [template.yaml](template.yaml) (AWS SAM / CloudFormation),
dans une seule région : **eu-north-1 (Stockholm)**.

## Arborescence

```
template.yaml          infrastructure (SAM)
samconfig.toml         paramètres de déploiement (nom de pile, région)
backend/               fonctions Lambda (TypeScript, Node.js 22) + tests unitaires (Vitest)
frontend/              application web (React + Vite, CodeMirror 6 + Yjs)
tests/                 tests de bout en bout et de charge (Node.js, k6) — résultats bruts dans tests/results/
scripts/               bootstrap.sh, deploy.sh, destroy.sh, loadtest.sh (générateur de charge temporaire)
docs/                  documentation
```

## Prérequis

- Un compte AWS et une session CLI **sans clé d'accès stockée** :
  `aws login --region eu-north-1` (identifiants temporaires obtenus via la console).
- AWS CLI v2 (≥ 2.32), AWS SAM CLI, Node.js ≥ 20, npm, `openssl`.
- Pour les tests de charge : [k6](https://grafana.com/docs/k6/latest/set-up/install-k6/).
- Une adresse e-mail **vérifiée dans Amazon SES** (expéditeur des notifications). En mode
  *sandbox* SES, les destinataires doivent aussi être vérifiés :
  `aws sesv2 create-email-identity --email-identity vous@exemple.com` puis cliquer le lien reçu.

## Déployer

```bash
# 1. Une seule fois : création des secrets (SSM Parameter Store, SecureString)
./scripts/bootstrap.sh

# 2. Construction + tests unitaires + déploiement de l'infrastructure + mise en ligne du site
NOTIFY_EMAIL=vous@exemple.com ./scripts/deploy.sh
```

Le script affiche à la fin l'URL du site (CloudFront), de l'API et du WebSocket.
Jeton du tableau de bord (page `#/admin`) :

```bash
aws ssm get-parameter --region eu-north-1 --name /collabdoc/admin-token --with-decryption --query Parameter.Value --output text
```

Aucune clé AWS n'apparaît dans le code ni dans le dépôt : les fonctions utilisent leur rôle IAM
(un rôle par fonction, limité aux tables/préfixes S3/actions qu'elle utilise), et les secrets
applicatifs sont lus dans SSM au démarrage.

## Tester

```bash
# Tests unitaires (comptage des caractères, propriétés CRDT, rattrapage, jetons, PDF)
cd backend && npm test

# Tests de bout en bout contre l'application déployée (lisent les URL dans la pile CloudFormation)
cd tests && npm ci
FRONT_URL=<FrontendUrl> node smoke.mjs                 # parcours complet de toutes les fonctions
WRITERS=50 EDITS=20 node convergence/convergence.mjs   # contrainte 2
MAX=100 CLICKS=3000 node load/claim-race.mjs           # contrainte 1
DEVICES=10          node load/credit-multidevice.mjs   # contrainte 4 + blocage
```

Pic de publication (contraintes 5 et 6 : 300 rédacteurs + 15 000 visiteurs). Il se lance depuis
une machine temporaire **dans la même région** (un ordinateur personnel sature avant l'application),
décrite dans [tests/load/loadgen.yaml](tests/load/loadgen.yaml) et pilotée par SSM (aucun port ouvert) :

```bash
./scripts/loadtest.sh up                        # crée la machine (~3 min, type autorisé par le plan gratuit)
./scripts/loadtest.sh run 'bash load/peak.sh'   # rédacteurs + k6 en parallèle (~8 min)
./scripts/loadtest.sh pull                      # rapatrie les résultats dans tests/results/
tests/load/cloudwatch-metrics.sh <début UTC> <fin UTC> > tests/results/cloudwatch-<run>.json
./scripts/loadtest.sh down                      # supprime la machine
```

Chaque script écrit ses résultats bruts (JSON) dans `tests/results/` et affiche PASS/FAIL.
La méthode et l'analyse sont dans [docs/rapport-tests.md](docs/rapport-tests.md).

## Supprimer

```bash
./scripts/destroy.sh
```

Vide les deux buckets S3, supprime la pile CloudFormation (tables, fonctions, API, CloudFront…)
et les secrets SSM. L'identité SES et le bucket de déploiement créé par SAM
(`aws-sam-cli-managed-default`) peuvent être supprimés à la main si besoin.

## Développement local du frontend

```bash
cd frontend && npm install
# pointer vers l'API déployée :
printf "window.COLLABDOC_CONFIG = { apiUrl: '%s', wsUrl: '%s' }\n" "<ApiUrl>" "<WebSocketUrl>" > public/config.js
npm run dev
```
