# Description de l'API

Cette page suffit pour écrire un client ou un test indépendant. Les URL de base sont des
sorties de la pile CloudFormation :

```bash
aws cloudformation describe-stacks --region eu-north-1 --stack-name collabdoc --query "Stacks[0].Outputs" --output table
```

- `ApiUrl` : API HTTP, ex. `https://abc123.execute-api.eu-north-1.amazonaws.com`
- `WebSocketUrl` : ex. `wss://def456.execute-api.eu-north-1.amazonaws.com/prod`
- `FrontendUrl` : site, ex. `https://d1234.cloudfront.net` (sert aussi `/public/*`)

## Conventions

- Corps de requête et de réponse en JSON (`content-type: application/json`).
- Rédacteurs : en-tête `Authorization: Bearer <token>`, jeton obtenu par `POST /session`.
- Erreurs : statut HTTP + corps `{ "error": "CODE", "message": "..." }` (+ champs éventuels).
- CORS ouvert (`*`) : l'authentification passe par un en-tête, jamais par un cookie.

| Code | Signification |
|---|---|
| 400 | Requête invalide (`INVALID_JSON`, `INVALID_EMAIL`, `INVALID_UPDATE`, …) |
| 401 | Jeton absent/invalide/expiré (`UNAUTHORIZED`) |
| 403 | Pas accès au document (`FORBIDDEN`) ; crédit épuisé (`CREDIT_EXHAUSTED`) |
| 404 | Ressource inconnue |
| 410 | Lien de téléchargement épuisé (`status: "exhausted"`) |
| 423 | Rédacteur bloqué temporairement (`WRITER_BLOCKED`) |
| 429 | Limitation de débit d'API Gateway : **patienter et réessayer** |
| 503 | Indisponibilité passagère : **réessayer** (même requête, même `id` pour une modification) |

---

## 1. Session

### `POST /session`
Identifie un rédacteur (pas de vrai compte, conformément au sujet).

```json
// requête
{ "name": "Alice", "email": "alice@example.com" }
// 200
{ "token": "eyJuIjoiQWxpY2Ui...Q", "name": "Alice", "email": "alice@example.com" }
```
Le jeton (HMAC-SHA256, valable 7 jours) contient le nom et l'e-mail (normalisé en minuscules).
Plusieurs sessions avec le même e-mail = plusieurs appareils de la même personne (crédit partagé).

### `GET /me`
```json
{ "name": "Alice", "email": "alice@example.com",
  "credit": { "used": 1200, "limit": 10000, "remaining": 8800, "resetsAt": "2026-10-26T00:00:00.000Z" },
  "blockedUntil": null }
```
Le crédit est rechargé chaque jour à 00:00 UTC.

## 2. Documents et partage

| Méthode | Chemin | Corps | Réponse |
|---|---|---|---|
| `GET` | `/documents` | — | `{ documents: [{ docId, title, role, addedAt }] }` |
| `POST` | `/documents` | `{ title }` (1–120 car.) | `201 { docId, title, ownerEmail, createdAt }` |
| `GET` | `/documents/{docId}` | — | `{ docId, title, ownerEmail, rev, …, members: [{ email, role }] }` |
| `POST` | `/documents/{docId}/members` | `{ email }` | `{ docId, email, role: "editor" }` (idempotent) |

Toute route `/documents/{docId}/…` exige d'être membre du document (sinon `403 FORBIDDEN`).

## 3. Édition collaborative

Le contenu d'un document est un **Y.Text nommé `content`** ([Yjs](https://docs.yjs.dev), CRDT).
Un client :
1. ouvre le WebSocket (§4) ;
2. lit l'état complet : `GET /documents/{docId}/state` → `{ docId, rev, updates, state, diff }`
   où `state` est une mise à jour Yjs complète encodée en base64 (`Y.applyUpdate(doc, state)`).
   Avec `?sv=<vecteur d'état Yjs du client, base64>` (`Y.encodeStateVector(doc)`), seule la
   partie **manquante** est renvoyée (`diff: true`) : le client s'en sert toutes les 15 s pour
   rattraper une diffusion qu'il aurait manquée ;
3. envoie chacune de ses modifications avec `POST /documents/{docId}/updates` ;
4. applique les modifications des autres reçues par WebSocket.

### `POST /documents/{docId}/updates`
```json
// requête
{ "id": "123456789-lq2x1-0", "update": "<mise à jour Yjs incrémentale, base64>" }
// 200 — modification ACCEPTÉE (stockée durablement)
{ "accepted": true, "duplicate": false, "chars": 12,
  "credit": { "used": 1212, "limit": 10000, "remaining": 8788, "resetsAt": "…" } }
```
- `id` : identifiant choisi par le client, `[A-Za-z0-9_-]{1,80}`, **unique par modification**.
  Renvoyer la même requête (même `id`) après une erreur réseau/429/503 est sans danger :
  elle n'est stockée et décomptée qu'une fois (`duplicate: true`).
- Une modification n'est acceptée qu'avec la réponse `200`. Elle est alors diffusée à tous
  les participants connectés.
- `chars` = caractères insérés, **comptés par le serveur** en décodant la mise à jour
  (les suppressions ne consomment pas de crédit).
- Refus : `403 CREDIT_EXHAUSTED` (`{ chars, credit }`), `423 WRITER_BLOCKED` (`{ blockedUntil }`),
  `400 INVALID_UPDATE` (pas une modification de texte), `413 UPDATE_TOO_LARGE` (> 256 Kio).
- Abus : 20 refus en 10 minutes ⇒ blocage de 15 minutes (`423`).

Exemple minimal (Node.js) :
```js
import * as Y from 'yjs'
const doc = new Y.Doc()
Y.applyUpdate(doc, Buffer.from(stateBase64, 'base64'))        // état initial
const sv = Y.encodeStateVector(doc)
doc.getText('content').insert(0, 'Bonjour ')
const update = Buffer.from(Y.encodeStateAsUpdate(doc, sv)).toString('base64')
await fetch(`${API}/documents/${docId}/updates`, { method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify({ id: `${doc.clientID}-1`, update }) })
```

## 4. WebSocket (réception temps réel et présence)

Connexion : `wss://…/prod?token=<token>&docId=<docId>&cid=<Y.Doc clientID>`
(refus à la connexion si jeton invalide, non-membre ou rédacteur bloqué).

Messages reçus (JSON) :
| `type` | Champs | Action du client |
|---|---|---|
| `update` | `data` (base64), `id` | `Y.applyUpdate(doc, data)` (inoffensif si déjà appliqué) |
| `awareness` | `data` (base64) | `applyAwarenessUpdate(awareness, data)` (y-protocols) |
| `join` | `name`, `email` | renvoyer sa propre présence |
| `leave` | `cid`, `name` | `removeAwarenessStates(awareness, [cid])` |

Message envoyé : `{ "action": "awareness", "data": "<encodeAwarenessUpdate(...) base64>" }`
— présence (nom, couleur, position du curseur), relayée aux autres sans être stockée.

## 5. Versions

| Méthode | Chemin | Réponse |
|---|---|---|
| `GET` | `/documents/{docId}/versions` | `{ versions: [{ versionId, createdAt, createdBy, label, rev, length, preview }] }` (récentes d'abord) |
| `POST` | `/documents/{docId}/versions` (`{ label? }`) | `201` métadonnées de la version créée |
| `GET` | `/documents/{docId}/versions/{versionId}` | `{ docId, versionId, text }` |
| `POST` | `/documents/{docId}/versions/{versionId}/restore` | `{ restored, backupVersionId }` |

Une version automatique est créée toutes les 10 minutes pour chaque document modifié.
La restauration sauvegarde d'abord l'état courant en version, puis applique une modification
qui remplace le texte (diffusée à tous comme une modification normale, sans consommer de crédit).

## 6. Liens de téléchargement

### Création (rédacteur) — `POST /documents/{docId}/links`
```json
{ "maxDownloads": 500 }
// 201
{ "linkId": "Xk3_9aQ2bLk", "docId": "…", "docTitle": "Journal", "maxDownloads": 500,
  "remaining": 500, "creatorEmail": "…", "createdAt": "…" }
```
`GET /documents/{docId}/links` → `{ links: [...] }`. Page publique : `<FrontendUrl>/#/d/<linkId>`.

### Statut (public) — `GET /links/{linkId}` ou `GET <FrontendUrl>/public/links/{linkId}`
```json
{ "linkId": "…", "docTitle": "Journal", "maxDownloads": 500, "remaining": 12, "status": "available" }
```
La variante `/public/…` passe par CloudFront et peut avoir jusqu'à ~2 s de retard (cache).

### Téléchargement (public) — `POST /links/{linkId}/claim`
| Statut | Corps | Signification |
|---|---|---|
| `200` | `{ status: "ok", url, expiresIn: 60, copyNumber, remaining, rev }` | Un exemplaire vous est attribué : `url` = PDF du document **dans son état actuel**, URL S3 pré-signée valable 60 s |
| `410` | `{ status: "exhausted", remaining: 0 }` | Lien épuisé |
| `404` | `{ status: "not_found" }` | Lien inconnu |
| `429` | `{ message: "Too Many Requests" }` | Forte affluence : patienter et réessayer |
| `503` | `{ status: "retry", retryAfter: 2 }` | Erreur passagère (l'exemplaire n'a pas été consommé) : réessayer |

Garantie : sur un lien créé avec `maxDownloads = N`, **au plus N** appels reçoivent `200`,
quel que soit le nombre d'appels simultanés. Lorsque le dernier exemplaire est pris,
le créateur du lien reçoit un e-mail.

Test simple de la garantie :
```bash
seq 1 300 | xargs -P 300 -I{} curl -s -o /dev/null -w "%{http_code}\n" -X POST "$API/links/$LINK/claim" | sort | uniq -c
```

## 7. Administration — `GET /admin/state`
En-tête `x-admin-token: <jeton>` (dans SSM : `/collabdoc/admin-token`).
```json
{ "generatedAt": "…",
  "openDocuments": [{ "docId": "…", "title": "…", "connections": 3, "users": [{ "name": "…", "email": "…", "connectedAt": "…" }] }],
  "activeLinks": [{ "linkId": "…", "docTitle": "…", "creatorEmail": "…", "maxDownloads": 500, "remaining": 42, "createdAt": "…" }],
  "exhaustedLinks": [{ "linkId": "…", "docTitle": "…", "maxDownloads": 50 }],
  "blockedWriters": [{ "email": "…", "reason": "credit_exhausted", "strikes": 20, "blockedUntil": "…" }] }
```
