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
- Chaque User Story crée sa branche de travail normalisée `us-<id>-<slug>` à partir de la branche d'Epic (`epic/<nom-feature>`).
- L'agent QA valide et fusionne la PR de la story dans la branche d'Epic.
- Une fois les stories d'un lot intégrées, le Control Plane ouvre la PR finale `epic/<nom-feature> -> main` avec l'étiquette : **`🔍 Ready for Human Validation`**.
- 🔒 **Règle d'Isolation APK & PR Unique (1 feature par batch) :**
  - **Plafond par batch :** Chaque projet traite au maximum **1 seule feature** (`MAX_FEATURES_PER_BATCH = 1`) par batch de nuit pour permettre un test indépendant et sans ambiguïté de l'APK généré.
  - **Blocage strict des batchs suivants :** Tant qu'une PR avec l'étiquette `🔍 Ready for Human Validation` ou ciblant `main` est ouverte ("en cours"), tout batch ultérieur pour ce projet est **gelé**. Le Control Plane ne démarre aucun nouveau développement tant que l'humain n'a pas testé l'APK et validé/mergé la PR en cours.

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
