# 🎯 `agentic-dev-core` — Control Plane Transverse Multi-Projets

Dépôt central d'orchestration agentique autonome conçu conformément à la spécification **[US-HUB-01](https://app.notion.com/p/US-HUB-01-Initialisation-du-Control-Plane-Transverse-Volvo-KidsStories-40da3747e4f681afa929e73954a78ad5)**.

Ce Control Plane pilote le développement autonome, la recette QA Gherkin et la livraison Git de plusieurs projets cibles **en mode externe**, sans dupliquer ni modifier le code agentique dans les dépôts applicatifs.

---

## 📦 Projets Cibles Connectés (V1)

| Projet | ID CLI | Chemin Local | Dépôt GitHub | Commandes QA | Branche d'Epic par défaut |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Volvo P3 Logger** | `volvo` | `/home/clem/Documents/dev/volvo-p3-logger` | `ClementMarrast/volvo-p3-logger` | `npm test`, `npm run typecheck` | `epic/m1-cockpit` |
| **Storya Kids** | `kids` | `/home/clem/Documents/dev/KidsStoriesAppV2` | `ClementMarrast/KidsStoriesAppV2` | `npm test`, `npm run typecheck` | `epic/beta-stores` |

---

## 🧠 Triade de Modèles & Haute Disponibilité

1. **Dev Primaire (`AGENT_DEV_MODEL`) :** `Gemini 4 Aragon` (conception et implémentation).
2. **Dev Fallback Quota (`AGENT_DEV_FALLBACK_MODEL`) :** `Gemini 3.8 High` (bascule automatique et transparente en cas d'erreur HTTP `429` ou `RESOURCE_EXHAUSTED` sur Aragon, sans interrompre le runner).
3. **QA Gatekeeper (`AGENT_QA_MODEL`) :** `Gemini 3.8 Flash` (audit de conformité Gherkin, exécution de `npm test` et `npm run typecheck`, validation du merge).
4. **Feedback Loop QA -> Dev :** En cas de rejet QA, retour au modèle Dev avec les logs d'erreurs, limité à **2 retries max** avant escalade en `status: blocked`.

---

## 🛡️ Gouvernance Git Absolue (Human Gatekeeper)

- 🛑 **Interdiction absolue de pousser directement sur `main`** (`GitGovernanceError`).
- 🌿 **Démarrage strict depuis `main` (Isolation des branches) :**
  - Chaque User Story/Feature repart **strictement de `origin/main` propre et à jour** (`git checkout -B us-<id>-<slug> main`), jamais d'une branche ou d'un Epic en cours de développement.
  - Aucun code non validé ou en attente de review n'est hérité par les développements suivants.
- 📱 **Isolation des APKs (1 Feature par nuit max) :**
  - Chaque nuit et par projet, le Control Plane développe au maximum **1 seule feature** (`MAX_FEATURES_PER_BATCH = 1`).
  - La PR est ouverte **directement vers `main`** avec l'étiquette **`🔍 Ready for Human Validation`**, produisant un APK unitaire et reproductible.
  - La même nuit, tout nouveau batch est mis en pause (`prCreatedTonight`) pour éviter d'empiler des APKs.
- 🌅 **Autonomie pour la nuit suivante :**
  - Si la nuit suivante arrive alors que la PR de la veille n'a pas encore été revue par l'humain, **le nouveau batch n'est pas bloqué**.
  - Il démarre à nouveau depuis le `main` stable, produit sa propre PR et son propre APK.
  - L'humain conserve ainsi l'APK de la veille et dispose du nouvel APK, tous deux testables de manière 100% indépendante.

---

## 🚀 Commandes CLI

```bash
# Traiter les issues prêtes de Volvo P3 Logger
npm run run:volvo

# Traiter les issues prêtes de Storya Kids
npm run run:kids

# Dépiler l'ensemble du portefeuille (Volvo + Storya Kids)
npm run run:all

# Cibler uniquement les issues étiquetées "batch: tonight"
npm run run:tonight

# Exécuter un essai à blanc (Dry-Run) avec simulation de bascule HTTP 429
npx tsx src/cli.ts --portfolio --dry-run --simulate-429

# Vérification du typage et suite de tests du Control Plane
npm run typecheck
npm test
```

---

## 🌅 Reporting Matinal

Chaque exécution génère un rapport consolidé :
- **Local :** `reports/nightly-YYYYMMDD.md`
- **Notion :** Base Journal (`b3af95c7-7375-44ad-8d32-b18bff426baa`) si `NOTION_API_KEY` est défini.
