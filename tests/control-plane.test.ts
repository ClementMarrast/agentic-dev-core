/**
 * Suite de Tests End-to-End & Validation Gherkin pour `agentic-dev-core` (US-HUB-01)
 * Valide :
 * - Scénario 1 : Exécution externe sur `volvo-p3-logger` et `KidsStoriesAppV2` sans modifier leurs repos
 * - Scénario 2 : Interception HTTP 429 / RESOURCE_EXHAUSTED -> Bascule transparente sur `Gemini 3.8 High`
 * - Scénario 3 : Gouvernance Git (Protection `main`, PR story -> `epic/*`, PR finale -> `main` avec `🔍 Ready for Human Validation`)
 * - Scénario 4 : Boucle de rétroaction QA (max 2 retries -> `status: blocked`) & Run d'essai à blanc 100% au vert + Reporting Matinal
 */

import assert from "node:assert";
import { execSync } from "node:child_process";
import fs from "node:fs";
import { CONFIG, PROJECTS, resolveProjects } from "../src/config";
import { parseGherkinScenarios, validateGherkinCoverage } from "../src/gherkin-validator";
import {
  assertNotDirectPushToMain,
  buildFinalEpicPrCommand,
  buildStoryBranchName,
  buildStoryPrCommand,
  GitGovernanceError,
  GitHubIssue,
  resolveEpicBranch
} from "../src/git-governance";
import { isQuotaError, ModelTriadManager, QuotaExhaustedError } from "../src/model-triad";
import { generateConsolidatedMarkdownReport, publishConsolidatedReport } from "../src/reporter";
import { processSingleIssue, runProjectCycle, verifyExternalProjectAdapter } from "../src/runner";

function getGitStatusSnapshot(repoPath: string): string {
  return execSync("git status --porcelain", { cwd: repoPath, encoding: "utf-8" }).trim();
}

async function runTests() {
  console.log("======================================================================");
  console.log("🧪 VALIDATION DE BOUT EN BOUT : AGENTIC-DEV-CORE (US-HUB-01)");
  console.log("======================================================================");

  // -------------------------------------------------------------------------
  // SCÉNARIO 1 : Initialisation Multi-Projets & Non-intrusion externe
  // -------------------------------------------------------------------------
  console.log("\n--- [Scénario 1] Connexion Externe Multi-Projets (Volvo P3 & Storya Kids) ---");

  const portfolio = resolveProjects(undefined, true);
  assert.strictEqual(portfolio.length, 2, "Le portefeuille doit contenir exactement 2 projets cibles V1");

  const volvo = PROJECTS.volvo;
  const kids = PROJECTS.kids;

  assert.strictEqual(volvo.localPath, "/home/clem/Documents/dev/volvo-p3-logger");
  assert.strictEqual(volvo.githubRepo, "ClementMarrast/volvo-p3-logger");
  assert.deepStrictEqual(volvo.testCommands, ["npm test", "npm run typecheck"]);
  assert.strictEqual(volvo.defaultEpicBranch, "epic/m1-cockpit");

  assert.strictEqual(kids.localPath, "/home/clem/Documents/dev/KidsStoriesAppV2");
  assert.strictEqual(kids.githubRepo, "ClementMarrast/KidsStoriesAppV2");
  assert.deepStrictEqual(kids.testCommands, ["npm test", "npm run typecheck"]);
  assert.strictEqual(kids.defaultEpicBranch, "epic/beta-stores");

  const volvoCheck = verifyExternalProjectAdapter(volvo);
  const kidsCheck = verifyExternalProjectAdapter(kids);
  assert.strictEqual(volvoCheck.valid, true, `Adaptateur Volvo invalide: ${volvoCheck.reason}`);
  assert.strictEqual(kidsCheck.valid, true, `Adaptateur Kids invalide: ${kidsCheck.reason}`);
  console.log("  ✔ PASS : Adaptateurs externes Volvo P3 Logger et Storya Kids connectés et vérifiés.");

  // Capture de l'état Git initial des 2 repos pour prouver qu'aucune modification parasite n'est introduite
  const volvoInitialStatus = getGitStatusSnapshot(volvo.localPath);
  const kidsInitialStatus = getGitStatusSnapshot(kids.localPath);

  // -------------------------------------------------------------------------
  // SCÉNARIO 2 : Triade de Modèles & Tolérance de Quota (HTTP 429 -> 3.8 High)
  // -------------------------------------------------------------------------
  console.log("\n--- [Scénario 2] Tolérance de Quota (Gemini 4 Aragon -> Gemini 3.8 High) ---");

  const triad = new ModelTriadManager();
  assert.strictEqual(triad.getPrimaryDevModel(), "Gemini 4 Aragon");
  assert.strictEqual(triad.getFallbackDevModel(), "Gemini 3.8 High");
  assert.strictEqual(triad.getQaModel(), "Gemini 3.8 Flash");

  let callCount = 0;
  const fallbackResult = await triad.executeDevTask(async (model) => {
    callCount++;
    if (model === "Gemini 4 Aragon") {
      throw new QuotaExhaustedError("HTTP 429 Too Many Requests: RESOURCE_EXHAUSTED on Gemini 4 Aragon");
    }
    return `Code généré avec succès par ${model}`;
  });

  assert.strictEqual(callCount, 2, "La tâche doit avoir été ré-exécutée automatiquement sur le modèle fallback");
  assert.strictEqual(fallbackResult.fallbackTriggered, true);
  assert.strictEqual(fallbackResult.modelUsed, "Gemini 3.8 High");
  assert.strictEqual(triad.isFallbackActive(), true);
  assert.ok(isQuotaError({ status: 429 }));
  assert.ok(isQuotaError(new Error("RESOURCE_EXHAUSTED: Quota exceeded")));
  console.log("  ✔ PASS : Interception HTTP 429 / RESOURCE_EXHAUSTED et bascule transparente sur Gemini 3.8 High.");

  // -------------------------------------------------------------------------
  // SCÉNARIO 3 : Gouvernance Git Absolue (Human Gatekeeper) & Feedback Loop QA
  // -------------------------------------------------------------------------
  console.log("\n--- [Scénario 3] Gouvernance Git Absolue & Feedback Loop QA (2 retries max) ---");

  // 3.a Interdiction absolue de push direct sur main
  assert.throws(
    () => assertNotDirectPushToMain("main", "git push origin main"),
    GitGovernanceError,
    "Un push direct sur main DOIT lever une GitGovernanceError"
  );
  assert.throws(
    () => assertNotDirectPushToMain("origin/main:main", "git push"),
    GitGovernanceError,
    "Un push vers :main DOIT lever une GitGovernanceError"
  );
  console.log("  ✔ PASS : Protection stricte contre tout push direct sur 'main' active.");

  // 3.b Branche de Story issue de l'Epic & PR de Story vers l'Epic
  const sampleVolvoIssue: GitHubIssue = {
    number: 101,
    title: "[Story/Cockpit] US-101 : Jauge Pression Turbo Temps Réel",
    body: `### Scénario 1 : Affichage Pression Boost
- Étant donné le cockpit connecté en BLE
- Quand la trame OBD PID 0x0B est reçue
- Alors la jauge affiche la pression en Bar`,
    labels: [{ name: "status: ready-for-dev" }]
  };

  const resolvedVolvoEpic = resolveEpicBranch(sampleVolvoIssue, volvo);
  assert.strictEqual(resolvedVolvoEpic, "epic/m1-cockpit");

  const storyBranch = buildStoryBranchName(sampleVolvoIssue);
  assert.strictEqual(storyBranch, "us-101-jauge-pression-turbo-temps-reel");

  const storyPr = buildStoryPrCommand(
    volvo,
    resolvedVolvoEpic,
    storyBranch,
    sampleVolvoIssue,
    "Gemini 4 Aragon",
    "Gemini 3.8 Flash"
  );
  assert.strictEqual(storyPr.base, "epic/m1-cockpit");
  assert.strictEqual(storyPr.head, storyBranch);
  assert.ok(storyPr.cmd.includes(`--base "epic/m1-cockpit"`));
  console.log(`  ✔ PASS : Toute PR de story cible la branche d'Epic ('${storyBranch}' -> '${resolvedVolvoEpic}').`);

  // 3.c PR Finale d'Epic vers main avec l'étiquette '🔍 Ready for Human Validation'
  const finalPr = buildFinalEpicPrCommand(
    volvo,
    resolvedVolvoEpic,
    "2026-11-03",
    [{ number: 101, title: sampleVolvoIssue.title }],
    "Gemini 3.8 High",
    "Gemini 3.8 Flash"
  );
  assert.strictEqual(finalPr.base, "main");
  assert.strictEqual(finalPr.head, "epic/m1-cockpit");
  assert.strictEqual(finalPr.label, "🔍 Ready for Human Validation");
  assert.ok(finalPr.cmd.includes(`--label "🔍 Ready for Human Validation"`));
  console.log(`  ✔ PASS : PR finale d'Epic vers 'main' porte l'étiquette '${finalPr.label}'.`);

  // 3.d Boucle de rétroaction QA -> Dev (limité à 2 retries max avant passage en status: blocked)
  let qaAttempts = 0;
  const blockedOutcome = await processSingleIssue(volvo, sampleVolvoIssue, new ModelTriadManager(), {
    dryRun: true,
    customQaExecutor: () => {
      qaAttempts++;
      return { success: false, report: `Erreur de test unitaire simulée (tentative #${qaAttempts})` };
    }
  });

  // 1 exécution initiale + 2 retries = 3 passages dans la QA Gate
  assert.strictEqual(qaAttempts, 3, "La QA Gate doit être exécutée 1 fois initialement + 2 retries max (total 3)");
  assert.strictEqual(blockedOutcome.success, false);
  assert.strictEqual(blockedOutcome.blocked, true);
  assert.strictEqual(blockedOutcome.qaRetries, 2);
  console.log("  ✔ PASS : Feedback Loop QA -> Dev limitée à 2 retries max avant passage en 'status: blocked'.");

  // -------------------------------------------------------------------------
  // SCÉNARIO 4 : Run d'essai à blanc de bout en bout (Volvo + Kids) & Reporting
  // -------------------------------------------------------------------------
  console.log("\n--- [Scénario 4] Run d'essai à blanc Multi-Projets & Reporting Matinal ---");

  const e2eTriad = new ModelTriadManager();
  const volvoSummary = await runProjectCycle(volvo, e2eTriad, {
    dryRun: true,
    simulate429: true
  });
  const kidsSummary = await runProjectCycle(kids, e2eTriad, {
    dryRun: true
  });

  assert.strictEqual(volvoSummary.testsPassed, true, "Le cycle Volvo en dry-run doit passer à 100%");
  assert.strictEqual(volvoSummary.fallbackTriggered, true, "La simulation 429 doit avoir déclenché le fallback sur Volvo");
  assert.strictEqual(volvoSummary.devModelUsed, "Gemini 3.8 High");

  assert.strictEqual(kidsSummary.testsPassed, true, "Le cycle Storya Kids en dry-run doit passer à 100%");
  assert.strictEqual(kidsSummary.devModelUsed, "Gemini 3.8 High", "Le fallback reste actif pour la suite de la session");

  const reportRes = await publishConsolidatedReport({
    date: "2026-11-03",
    projects: [volvoSummary, kidsSummary]
  });

  assert.ok(fs.existsSync(reportRes.localPath), "Le fichier de rapport matinal doit exister sur disque");
  const reportContent = fs.readFileSync(reportRes.localPath, "utf-8");
  assert.ok(reportContent.includes("Volvo P3 Logger"));
  assert.ok(reportContent.includes("Storya Kids"));
  assert.ok(reportContent.includes("Gemini 3.8 High"));
  assert.ok(reportContent.includes("🔍 Ready for Human Validation"));
  console.log(`  ✔ PASS : Rapport matinal consolidé généré avec succès (${reportRes.localPath}).`);

  // Vérification finale de non-altération des dépôts cibles
  const volvoFinalStatus = getGitStatusSnapshot(volvo.localPath);
  const kidsFinalStatus = getGitStatusSnapshot(kids.localPath);
  assert.strictEqual(volvoFinalStatus, volvoInitialStatus, "Le dépôt volvo-p3-logger ne doit pas avoir été altéré");
  assert.strictEqual(kidsFinalStatus, kidsInitialStatus, "Le dépôt KidsStoriesAppV2 ne doit pas avoir été altéré");
  console.log("  ✔ PASS : Aucune altération parasite dans les dépôts cibles (volvo-p3-logger & KidsStoriesAppV2).");

  console.log("\n======================================================================");
  console.log("🎉 100% DES SCÉNARIOS GHERKIN (US-HUB-01) SONT VALIDÉS ET AU VERT !");
  console.log("======================================================================\n");
}

runTests().catch((err) => {
  console.error("✖ Échec des tests Control Plane :", err);
  process.exit(1);
});
