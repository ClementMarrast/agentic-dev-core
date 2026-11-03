/**
 * Moteur central d'orchestration agentique (Control Plane Transverse)
 * - Pilote les projets externes sans modifier leurs fichiers agentiques
 * - Supporte le moteur Dev Claude CLI (`AGENT_DEV_ENGINE=claude`) ou Modèles Gemini (Aragon -> Fallback 3.8 High)
 * - Applique la QA Gate (`Gemini 3.8 Flash`) : tests unitaires + typecheck + audit Gherkin
 * - Applique la boucle de rétroaction QA -> Dev (max 2 retries avant `status: blocked`)
 * - Applique la Gouvernance Git stricte (PR story -> epic/<feature>, PR finale -> main avec `🔍 Ready for Human Validation`)
 */

import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { CONFIG, ProjectConfig } from "./config";
import { parseGherkinScenarios, validateGherkinCoverage } from "./gherkin-validator";
import {
  assertNotDirectPushToMain,
  buildFinalEpicPrCommand,
  buildStoryBranchName,
  buildStoryPrCommand,
  ensureGitHubLabelExists,
  GitHubIssue,
  resolveEpicBranch,
  runInProject
} from "./git-governance";
import { ModelTriadManager, QuotaExhaustedError } from "./model-triad";
import { ProjectExecutionSummary } from "./reporter";

const COLORS = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  blue: "\x1b[34m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  bold: "\x1b[1m"
};

export function logInfo(msg: string): void {
  console.log(`${COLORS.blue}[Control Plane]${COLORS.reset} ${msg}`);
}

export function logDev(model: string, msg: string): void {
  console.log(`${COLORS.magenta}[Dev Agent : ${model}]${COLORS.reset} ${msg}`);
}

export function logQA(model: string, msg: string): void {
  console.log(`${COLORS.cyan}[QA Gate : ${model}]${COLORS.reset} ${msg}`);
}

export function logSuccess(msg: string): void {
  console.log(`${COLORS.green}✔ ${msg}${COLORS.reset}`);
}

export function logWarning(msg: string): void {
  console.log(`${COLORS.yellow}⚠ ${msg}${COLORS.reset}`);
}

export function logError(msg: string): void {
  console.error(`${COLORS.red}✖ ${msg}${COLORS.reset}`);
}

export interface RunnerOptions {
  all?: boolean;
  label?: string;
  issueNumber?: number;
  dryRun?: boolean;
  simulate429?: boolean;
  skipRemoteGit?: boolean;
  devEngine?: "gemini" | "claude";
  customDevExecutor?: (issue: GitHubIssue, model: string, attempt: number, previousQaError?: string) => Promise<void> | void;
  customQaExecutor?: (project: ProjectConfig, issue: GitHubIssue) => { success: boolean; report: string };
}

export interface IssueProcessOutcome {
  success: boolean;
  blocked: boolean;
  issue: GitHubIssue;
  storyBranch: string;
  epicBranch: string;
  devModelUsed: string;
  fallbackTriggered: boolean;
  fallbackReason?: string;
  qaRetries: number;
  prUrl?: string;
  errorReport?: string;
}

/**
 * Exécute Claude CLI (`claude -p`) dans le répertoire du projet cible.
 */
export function executeClaudeDevEngine(
  project: ProjectConfig,
  issue: GitHubIssue,
  attempt: number,
  previousQaError?: string
): void {
  const feedbackContext = previousQaError
    ? `\n\nATTENTION : La précédente tentative a échoué lors de la QA Gate :\n${previousQaError}\nCorrige spécifiquement cette erreur.`
    : "";

  const prompt = `Tu es l'agent Software Developer autonome.
Ta mission est d'implémenter l'issue GitHub #${issue.number} : "${issue.title}".

Description & Critères d'acceptation :
${issue.body || "Pas de description détaillée."}
${feedbackContext}

Règles impératives :
1. Modifie le code directement dans le répertoire pour satisfaire les critères d'acceptation.
2. Assure-toi que les commandes de test du projet passent (${project.testCommands.join(" && ")}).
3. Ne commite pas et ne pousse pas (la gouvernance Git est prise en charge par le Control Plane).`;

  try {
    execSync(`claude -p "${prompt.replace(/"/g, '\\"')}" --dangerously-skip-permissions`, {
      cwd: project.localPath,
      stdio: "inherit",
      encoding: "utf-8"
    });
  } catch (err: any) {
    throw new Error(`Échec de l'exécution Claude CLI : ${err.message}`);
  }
}

/**
 * Vérifie que l'adaptateur du projet cible est valide et accessible en mode externe.
 */
export function verifyExternalProjectAdapter(project: ProjectConfig): { valid: boolean; reason?: string } {
  if (!fs.existsSync(project.localPath)) {
    return { valid: false, reason: `Chemin local introuvable : ${project.localPath}` };
  }
  const pkgPath = `${project.localPath}/package.json`;
  if (!fs.existsSync(pkgPath)) {
    return { valid: false, reason: `package.json introuvable dans ${project.localPath}` };
  }
  return { valid: true };
}

/**
 * Récupère les issues ouvertes depuis le dépôt GitHub cible.
 */
export function fetchProjectIssues(project: ProjectConfig, filterLabel?: string, specificIssue?: number): GitHubIssue[] {
  try {
    const json = execSync(
      `gh issue list --state open --json number,title,body,labels,milestone -R ${project.githubRepo} --limit 100`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    );
    let issues: GitHubIssue[] = JSON.parse(json);

    // Exclure les tickets déjà bloqués
    issues = issues.filter((i) => !i.labels.some((l) => l.name === CONFIG.LABELS.BLOCKED));

    if (specificIssue !== undefined) {
      return issues.filter((i) => i.number === specificIssue);
    }

    if (filterLabel) {
      issues = issues.filter((i) => i.labels.some((l) => l.name === filterLabel));
    } else {
      const ready = issues.filter((i) => i.labels.some((l) => l.name === CONFIG.LABELS.READY_FOR_DEV));
      if (ready.length > 0) {
        issues = ready;
      }
    }

    issues.sort((a, b) => a.number - b.number);
    return issues;
  } catch (err: any) {
    logWarning(`Impossible de lister les issues GitHub pour ${project.githubRepo} : ${err.message}`);
    return [];
  }
}

/**
 * Exécute la QA Gate (`Gemini 3.8 Flash`) :
 * 1. Inspection de la conformité Gherkin
 * 2. Exécution des commandes de test du projet cible (`npm test` et `npm run typecheck`)
 */
export function executeQAGate(
  project: ProjectConfig,
  issue: GitHubIssue,
  qaModel: string,
  options: { dryRun?: boolean; customQaExecutor?: RunnerOptions["customQaExecutor"] } = {}
): { success: boolean; report: string } {
  logQA(qaModel, `Audit de conformité Gherkin & exécution de la suite de tests pour #${issue.number} (${project.name})...`);

  if (options.customQaExecutor) {
    return options.customQaExecutor(project, issue);
  }

  // 1. Validation Gherkin
  const scenarios = parseGherkinScenarios(issue.body || "");
  const gherkinValidation = validateGherkinCoverage(scenarios);
  if (!gherkinValidation.valid) {
    logQA(qaModel, `✖ Rejet Gherkin : ${gherkinValidation.report}`);
    return { success: false, report: gherkinValidation.report };
  }
  logQA(qaModel, `✔ Conformité Gherkin validée (${scenarios.length} scénario(s)).`);

  if (options.dryRun) {
    logQA(qaModel, `[DRY-RUN] Commandes de validation simulées : ${project.testCommands.join(" && ")}`);
    return { success: true, report: "Dry-run : Gherkin et commandes de test validés." };
  }

  // 2. Exécution des commandes de test et typecheck du repo cible
  for (const cmd of project.testCommands) {
    try {
      logQA(qaModel, `Exécution de '${cmd}' dans ${project.localPath}...`);
      runInProject(project, cmd, { silent: false });
      logQA(qaModel, `✔ '${cmd}' passé avec succès.`);
    } catch (err: any) {
      const errOut = err?.stderr || err?.stdout || err?.message || `Échec de la commande '${cmd}'`;
      const report = `Échec QA Gate sur '${cmd}' dans ${project.name} :\n${String(errOut).slice(0, 1000)}`;
      logQA(qaModel, `✖ ${report}`);
      return { success: false, report };
    }
  }

  return {
    success: true,
    report: `Toutes les vérifications Gherkin et commandes (${project.testCommands.join(", ")}) sont 100% au vert.`
  };
}

/**
 * Traite une User Story de bout en bout avec :
 * - Choix du moteur Dev (Claude CLI ou Gemini Aragon -> 3.8 High)
 * - QA Gate (`Gemini 3.8 Flash`)
 * - Boucle de rétroaction QA -> Dev (max 2 retries avant `status: blocked`)
 * - Gouvernance Git (`us-<id>-<slug>` -> PR vers `epic/<feature>`)
 */
export async function processSingleIssue(
  project: ProjectConfig,
  issue: GitHubIssue,
  triad: ModelTriadManager,
  options: RunnerOptions = {}
): Promise<IssueProcessOutcome> {
  const epicBranch = resolveEpicBranch(issue, project);
  const storyBranch = buildStoryBranchName(issue);
  const devEngine = options.devEngine || (CONFIG.AGENT_DEV_ENGINE as "gemini" | "claude") || "gemini";

  // Vérification stricte Human Gatekeeper : aucune story ne cible main directement
  assertNotDirectPushToMain(epicBranch, "processSingleIssue target epicBranch");

  const effectivePrimaryModel = devEngine === "claude" ? "Claude Code CLI" : triad.getActiveDevModel();

  logInfo(`\n------------------------------------------------------------`);
  logInfo(`${COLORS.bold}[${project.name}] Issue #${issue.number} : "${issue.title}"${COLORS.reset}`);
  logInfo(`Branche d'Epic cible : ${COLORS.cyan}${epicBranch}${COLORS.reset}`);
  logInfo(`Branche User Story   : ${COLORS.cyan}${storyBranch}${COLORS.reset}`);
  logInfo(`Moteur Dev           : ${COLORS.magenta}${devEngine.toUpperCase()} (${effectivePrimaryModel})${COLORS.reset}`);
  logInfo(`Modèle QA Gate       : ${COLORS.cyan}${triad.getQaModel()}${COLORS.reset}`);
  logInfo(`------------------------------------------------------------`);

  if (!options.dryRun && !options.skipRemoteGit) {
    spawnSync(
      "gh",
      [
        "issue",
        "edit",
        String(issue.number),
        "--remove-label",
        CONFIG.LABELS.READY_FOR_DEV,
        "--add-label",
        CONFIG.LABELS.IN_PROGRESS,
        "-R",
        project.githubRepo
      ],
      { cwd: project.localPath, stdio: "pipe" }
    );

    // Préparation de la branche d'Epic et de la branche de Story
    try {
      runInProject(
        project,
        `git checkout ${epicBranch} 2>/dev/null || git checkout -b ${epicBranch}`,
        { silent: true }
      );
      runInProject(project, `git checkout -B ${storyBranch} ${epicBranch}`, { silent: true });
    } catch (err: any) {
      logError(`Erreur lors de la création de la branche ${storyBranch} : ${err.message}`);
      return {
        success: false,
        blocked: true,
        issue,
        storyBranch,
        epicBranch,
        devModelUsed: effectivePrimaryModel,
        fallbackTriggered: triad.isFallbackActive(),
        qaRetries: 0,
        errorReport: err.message
      };
    }
  }

  let attempt = 0;
  let lastQaReport = "";
  let devModelUsed = effectivePrimaryModel;
  let fallbackTriggered = triad.isFallbackActive();
  let fallbackReason: string | undefined;
  let simulated429Fired = false;

  while (attempt <= CONFIG.MAX_QA_RETRIES) {
    if (attempt > 0) {
      logWarning(
        `[Feedback Loop QA -> Dev] Rejet QA détecté. Tentative de correction ${attempt}/${CONFIG.MAX_QA_RETRIES}...`
      );
    }

    // 1. Exécution du Dev (Claude CLI ou Triade Gemini)
    if (devEngine === "claude") {
      logDev(
        "Claude Code CLI",
        attempt === 0
          ? `Conception et implémentation de la story #${issue.number} sur '${storyBranch}' via Claude CLI...`
          : `Correction suite aux logs QA (retry #${attempt}) via Claude CLI : ${lastQaReport}`
      );
      if (options.customDevExecutor) {
        await options.customDevExecutor(issue, "Claude Code CLI", attempt, lastQaReport || undefined);
      } else if (!options.dryRun) {
        executeClaudeDevEngine(project, issue, attempt, lastQaReport || undefined);
      }
      devModelUsed = "Claude Code CLI";
    } else {
      const devResult = await triad.executeDevTask(
        async (model) => {
          if (options.simulate429 && !simulated429Fired && model === triad.getPrimaryDevModel()) {
            simulated429Fired = true;
            throw new QuotaExhaustedError(
              `HTTP 429 Too Many Requests: RESOURCE_EXHAUSTED on model ${model}`
            );
          }

          logDev(
            model,
            attempt === 0
              ? `Conception et implémentation de la story #${issue.number} sur '${storyBranch}'...`
              : `Correction suite aux logs QA (retry #${attempt}) : ${lastQaReport}`
          );

          if (options.customDevExecutor) {
            await options.customDevExecutor(issue, model, attempt, lastQaReport || undefined);
          }

          return `Dev pass completed by ${model}`;
        },
        (reason, fallbackModel) => {
          logWarning(
            `⚡ [Tolérance Quota] Saturation détectée sur '${triad.getPrimaryDevModel()}' (${reason}). Bascule transparente immédiate sur '${fallbackModel}' !`
          );
        }
      );

      devModelUsed = devResult.modelUsed;
      fallbackTriggered = fallbackTriggered || devResult.fallbackTriggered;
      if (devResult.fallbackReason) {
        fallbackReason = devResult.fallbackReason;
      }
    }

    // 2. Exécution de la QA Gate (Gemini 3.8 Flash)
    const qaRes = executeQAGate(project, issue, triad.getQaModel(), {
      dryRun: options.dryRun,
      customQaExecutor: options.customQaExecutor
    });

    if (qaRes.success) {
      logSuccess(`QA Gate (${triad.getQaModel()}) validée avec succès (tentative ${attempt + 1}).`);
      lastQaReport = qaRes.report;
      break;
    }

    lastQaReport = qaRes.report;
    attempt++;
  }

  // Si le plafond de retries (MAX_QA_RETRIES = 2) est dépassé
  if (attempt > CONFIG.MAX_QA_RETRIES) {
    logError(
      `🛑 Plafond de ${CONFIG.MAX_QA_RETRIES} retries QA atteint pour #${issue.number}. Passage en '${CONFIG.LABELS.BLOCKED}'.`
    );

    if (!options.dryRun && !options.skipRemoteGit) {
      ensureGitHubLabelExists(project, CONFIG.LABELS.BLOCKED, "D93F0B");
      spawnSync(
        "gh",
        [
          "issue",
          "edit",
          String(issue.number),
          "--remove-label",
          CONFIG.LABELS.IN_PROGRESS,
          "--add-label",
          CONFIG.LABELS.BLOCKED,
          "-R",
          project.githubRepo
        ],
        { cwd: project.localPath, stdio: "pipe" }
      );

      spawnSync(
        "gh",
        [
          "issue",
          "comment",
          String(issue.number),
          "--body",
          `🛑 **Escalation Control Plane (\`agentic-dev-core\`)**\n\nÉchec persistant de la QA Gate (**${triad.getQaModel()}**) après **${CONFIG.MAX_QA_RETRIES} retries**.\n\n**Dernier rapport d'erreur :**\n\`\`\`\n${lastQaReport}\n\`\`\`\n\nTicket basculé en \`${CONFIG.LABELS.BLOCKED}\` pour intervention humaine.`,
          "-R",
          project.githubRepo
        ],
        { cwd: project.localPath, stdio: "pipe" }
      );
    }

    return {
      success: false,
      blocked: true,
      issue,
      storyBranch,
      epicBranch,
      devModelUsed,
      fallbackTriggered,
      fallbackReason,
      qaRetries: CONFIG.MAX_QA_RETRIES,
      errorReport: lastQaReport
    };
  }

  // 3. Succès QA : Ouverture et fusion de la PR de la story dans la branche d'Epic
  const prSpec = buildStoryPrCommand(
    project,
    epicBranch,
    storyBranch,
    issue,
    devModelUsed,
    triad.getQaModel()
  );

  let prUrl: string | undefined;

  if (options.dryRun || options.skipRemoteGit) {
    prUrl = `https://github.com/${project.githubRepo}/pull/dry-run-${issue.number}`;
    logInfo(`[Gouvernance Git] PR Story préparée : ${storyBranch} -> ${epicBranch}`);
  } else {
    try {
      assertNotDirectPushToMain(storyBranch, "git push storyBranch");
      // Commit des changements éventuels de Claude
      const gitStatus = runInProject(project, "git status --porcelain", { silent: true });
      if (gitStatus.length > 0) {
        runInProject(project, "git add -A", { silent: true });
        runInProject(
          project,
          `git commit -m "feat(issue-${issue.number}): ${issue.title.replace(/"/g, '\\"')}"`,
          { silent: true }
        );
      }

      runInProject(project, `git push -u origin ${storyBranch}`, { silent: true });
      const out = runInProject(project, prSpec.cmd, { silent: true });
      prUrl = out.trim();
      logSuccess(`PR de Story créée vers '${epicBranch}' : ${prUrl}`);

      logQA(triad.getQaModel(), `Fusion de la PR '${storyBranch}' dans '${epicBranch}'...`);
      runInProject(project, `gh pr merge ${storyBranch} --merge -R ${project.githubRepo}`, { silent: true });
    } catch (err: any) {
      logWarning(`Opération PR Git distante ignorée ou déjà mergée : ${err.message}`);
    }
  }

  return {
    success: true,
    blocked: false,
    issue,
    storyBranch,
    epicBranch,
    devModelUsed,
    fallbackTriggered,
    fallbackReason,
    qaRetries: attempt,
    prUrl
  };
}

/**
 * Exécute le cycle complet du Control Plane sur un projet cible.
 */
export async function runProjectCycle(
  project: ProjectConfig,
  triad: ModelTriadManager,
  options: RunnerOptions = {}
): Promise<ProjectExecutionSummary> {
  logInfo(`\n============================================================`);
  logInfo(`${COLORS.bold}🚀 Démarrage Control Plane pour : ${project.name} (${project.githubRepo})${COLORS.reset}`);
  logInfo(`Chemin local : ${project.localPath}`);
  logInfo(`Branche d'intégration par défaut : ${project.defaultEpicBranch}`);
  logInfo(`============================================================`);

  const adapterCheck = verifyExternalProjectAdapter(project);
  if (!adapterCheck.valid) {
    throw new Error(`Adaptateur projet invalide pour ${project.name} : ${adapterCheck.reason}`);
  }

  const issues = fetchProjectIssues(project, options.label, options.issueNumber);
  const selectedIssues = options.all ? issues : issues.slice(0, 1);

  logInfo(`${issues.length} issue(s) éligible(s) détectée(s), ${selectedIssues.length} sélectionnée(s) pour ce cycle.`);

  const outcomes: IssueProcessOutcome[] = [];
  let epicBranch = project.defaultEpicBranch;

  if (selectedIssues.length === 0) {
    logInfo(`Vérification d'intégrité directe sur ${project.name}...`);
    let simulated429Fired = false;
    const devCheck = await triad.executeDevTask(
      async (model) => {
        if (options.simulate429 && !simulated429Fired && model === triad.getPrimaryDevModel()) {
          simulated429Fired = true;
          throw new QuotaExhaustedError(`HTTP 429: RESOURCE_EXHAUSTED on ${model}`);
        }
        return model;
      },
      (reason, fallbackModel) => {
        logWarning(`⚡ [Tolérance Quota] Bascule automatique sur '${fallbackModel}' (${reason})`);
      }
    );

    const syntheticIssue: GitHubIssue = {
      number: 0,
      title: `Healthcheck Control Plane ${project.name}`,
      body: `### Scénario 1 : Intégrité Control Plane\n- Étant donné le dépôt ${project.name}\n- Quand la QA Gate s'exécute\n- Alors les tests sont au vert`,
      labels: [{ name: `epic: ${project.defaultEpicBranch.replace(/^epic\//, "")}` }]
    };

    const qaCheck = executeQAGate(project, syntheticIssue, triad.getQaModel(), {
      dryRun: options.dryRun,
      customQaExecutor: options.customQaExecutor
    });

    return {
      projectId: project.id,
      projectName: project.name,
      githubRepo: project.githubRepo,
      epicBranch,
      devModelUsed: devCheck.modelUsed,
      fallbackTriggered: devCheck.fallbackTriggered,
      fallbackReason: devCheck.fallbackReason,
      qaModelUsed: triad.getQaModel(),
      testsPassed: qaCheck.success,
      testCommandsRun: project.testCommands,
      mergedStories: [],
      blockedStories: [],
      humanValidationLabel: CONFIG.LABELS.READY_FOR_HUMAN
    };
  }

  for (const issue of selectedIssues) {
    const outcome = await processSingleIssue(project, issue, triad, options);
    outcomes.push(outcome);
    epicBranch = outcome.epicBranch;
  }

  const mergedStories = outcomes
    .filter((o) => o.success)
    .map((o) => ({
      number: o.issue.number,
      title: o.issue.title,
      branch: o.storyBranch,
      prUrl: o.prUrl,
      devModel: o.devModelUsed
    }));

  const blockedStories = outcomes
    .filter((o) => o.blocked)
    .map((o) => ({
      number: o.issue.number,
      title: o.issue.title,
      reason: o.errorReport || "Rejet QA persistant",
      retries: o.qaRetries
    }));

  const dateStr = new Date().toISOString().slice(0, 10);
  let finalEpicPrUrl: string | undefined;

  // Quand tous les tickets du lot d'Epic sont intégrés (et au moins 1 mergé sans blocage)
  if (mergedStories.length > 0 && blockedStories.length === 0) {
    const finalPrSpec = buildFinalEpicPrCommand(
      project,
      epicBranch,
      dateStr,
      mergedStories,
      triad.getActiveDevModel(),
      triad.getQaModel()
    );

    if (options.dryRun || options.skipRemoteGit) {
      finalEpicPrUrl = `https://github.com/${project.githubRepo}/pull/epic-release-${epicBranch.replace(/\//g, "-")}`;
      logSuccess(
        `[Human Gatekeeper] PR Finale d'Epic prête vers 'main' avec étiquette '${finalPrSpec.label}' : ${finalEpicPrUrl}`
      );
    } else {
      try {
        ensureGitHubLabelExists(project, CONFIG.LABELS.READY_FOR_HUMAN, "FBCA04");
        assertNotDirectPushToMain(epicBranch, "git push epicBranch");
        runInProject(project, `git push -u origin ${epicBranch}`, { silent: true });
        finalEpicPrUrl = runInProject(project, finalPrSpec.cmd, { silent: true }).trim();
        logSuccess(`PR Finale ouverte vers 'main' [${CONFIG.LABELS.READY_FOR_HUMAN}] : ${finalEpicPrUrl}`);
      } catch (err: any) {
        logWarning(`Ouverture PR finale vers main ignorée ou déjà existante : ${err.message}`);
      }
    }
  }

  const anyFallback = outcomes.some((o) => o.fallbackTriggered);
  const lastDevModel = outcomes[outcomes.length - 1]?.devModelUsed || triad.getActiveDevModel();

  return {
    projectId: project.id,
    projectName: project.name,
    githubRepo: project.githubRepo,
    epicBranch,
    devModelUsed: lastDevModel,
    fallbackTriggered: anyFallback,
    fallbackReason: outcomes.find((o) => o.fallbackReason)?.fallbackReason,
    qaModelUsed: triad.getQaModel(),
    testsPassed: blockedStories.length === 0,
    testCommandsRun: project.testCommands,
    mergedStories,
    blockedStories,
    finalEpicPrUrl,
    humanValidationLabel: CONFIG.LABELS.READY_FOR_HUMAN
  };
}
