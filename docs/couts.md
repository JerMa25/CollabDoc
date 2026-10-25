# Coûts du projet

## 1. Cadre

- Compte AWS sur le **plan gratuit** (*Free plan*, nouvelle expérience AWS) : ce plan **ne peut
  générer aucune facture**. Il fournit des crédits (100 $ à l'ouverture, plus des bonus
  d'activités) et des niveaux toujours gratuits (Lambda : 1 M de requêtes et 400 000 Go-s par
  mois ; CloudFront : 1 To et 10 M de requêtes par mois ; etc.).
- Toutes les ressources portent l'étiquette `project=collabdoc` (la machine de charge :
  `project=collabdoc-loadtest`), dans une seule région : **eu-north-1**.
- **Montant réellement payé : 0 $.** Ce qui suit montre ce que le projet a consommé sur les crédits.

## 2. Preuve

### 2.1 Crédits du plan gratuit (relevés par la CLI)

```bash
aws freetier get-account-plan-state --region eu-north-1
```

| Date (WAT) | Plan | Crédits restants | Événement |
|---|---|---|---|
| 24/10 19:25 | FREE | 119,98 $ | Avant tout déploiement |
| 24/10 23:50 | FREE | 139,98 $ | Après déploiements et tous les tests de charge (+20 $ de bonus d'activité « lancer une instance EC2 » ; la consommation du jour n'est imputée qu'avec ~24 h de retard) |
| 26/10 matin | FREE | *à relever* | Relevé final |

### 2.2 Coûts par service (AWS Cost Explorer)

Cost Explorer publie les coûts avec environ **24 h de retard** ; le relevé définitif est fait
le lundi matin :

```bash
aws ce get-cost-and-usage --region us-east-1 --time-period Start=2026-10-24,End=2026-10-27 \
  --granularity DAILY --metrics UnblendedCost --group-by Type=DIMENSION,Key=SERVICE \
  --query 'ResultsByTime[].{jour:TimePeriod.Start,services:Groups[?Metrics.UnblendedCost.Amount>`0.001`].[Keys[0],Metrics.UnblendedCost.Amount]}'
```

Captures à joindre : console *Billing and Cost Management → Cost Explorer* (filtre région
eu-north-1, regroupement par service, du 24 au 26/10) et page *Free plan / Credits*.

## 3. Estimation détaillée (prix officiels eu-north-1, API AWS Pricing)

Prix relevés avec `aws pricing get-products` (région EU Stockholm) :

| Service | Prix unitaire |
|---|---|
| API Gateway HTTP API | 1,06 $ / million de requêtes |
| API Gateway WebSocket | 1,083 $ / million de messages ; 0,271 $ / million de minutes de connexion |
| DynamoDB à la demande | 0,67 $ / million d'unités d'écriture ; 0,1345 $ / million d'unités de lecture |
| Lambda (arm64) | dans le niveau toujours gratuit (1 M requêtes, 400 000 Go-s / mois) |
| EC2 m7i-flex.large | 0,10175 $ / heure |
| CloudFront, S3, SNS (1 000 e-mails/mois gratuits), SSM (standard), CloudWatch Logs | volumes négligeables ou dans les niveaux gratuits |

### 3.1 Le test de pic (le poste principal)

Volumes mesurés par CloudWatch pendant les ~10 minutes du pic final
([cloudwatch-20261024223158.json](../tests/results/cloudwatch-20261024223158.json)) :

| Poste | Volume | Calcul | Coût |
|---|---|---|---|
| Messages WebSocket diffusés | 786 447 | × 1,083 $/M | ≈ 0,85 $ |
| Requêtes API HTTP | 116 368 | × 1,06 $/M | ≈ 0,12 $ |
| Écritures DynamoDB (≈ 5 unités par modification : transaction + révision) | ≈ 0,40 M unités | × 0,67 $/M | ≈ 0,27 $ |
| Lectures DynamoDB (accès, crédit, connexions, états) | ≈ 0,35 M unités | × 0,1345 $/M | ≈ 0,05 $ |
| Lambda (≈ 110 000 invocations) | — | niveau gratuit | 0 $ |
| **Total d'un pic** | | | **≈ 1,30 $** |

### 3.2 Ensemble du projet (week-end)

| Poste | Estimation |
|---|---|
| 3 runs de pic (dont 2 archivés) + tests de preuve | ≈ 3 × 1,30 $ + 0,30 $ ≈ 4,20 $ |
| Machine de charge EC2 (≈ 1 h au total) | ≈ 0,10 $ |
| Déploiements, développement, démonstrations | < 0,20 $ |
| Application au repos (aucun serveur allumé) | ≈ 0 $ / jour |
| **Total estimé** | **≈ 4,50 $ de crédits, 0 $ payé** |

## 4. Analyse

- **Le coût est proportionnel à l'usage, et nul au repos** : c'est l'intérêt du choix
  *serverless* (dossier de conception §2.1). Une architecture à serveurs dimensionnés pour le pic
  coûterait la même chose un jour calme que le jour de la parution.
- **Le premier poste est la diffusion WebSocket** (~65 % d'un pic) : chaque modification est
  envoyée à tous les participants du document. Pistes si le coût devenait un sujet : regrouper
  davantage les frappes côté client (envoi toutes les 200 ms au lieu de 80 ms), ou ne diffuser
  qu'aux participants dont le document est visible.
- **La parution elle-même coûte très peu** : 15 000 visiteurs = environ 30 000 requêtes de
  téléchargement (≈ 0,03 $) ; les pages et le statut des liens sont servis par CloudFront
  (niveau gratuit).
- **Garde-fous** : plan gratuit (aucune facturation possible), étiquettes de suivi, rétention des
  journaux limitée à 14 jours, PDF expirés après 2 jours dans S3, machine de charge supprimée
  après usage (et arrêt automatique programmé au bout de 4 h par sécurité), suppression complète
  par `scripts/destroy.sh`.
