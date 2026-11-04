#!/usr/bin/env node
/**
 * Point d'entrée CLI du Control Plane Transverse (`agentic-dev-core`)
 * Supporte :
 * - `--repo=volvo` / `--repo=kids` / `--portfolio`
 * - `--all`
 * - `--label="batch: tonight"`
 * - `--issue=<number>`
 * - `--dev-engine=claude` / `--dev-engine=gemini`
 * - `--daemon` : mode permanent en tâche de fond (polling automatique toutes les 60s)
 * - `--dry-run`
 * - `--simulate-429`
 */

import { CONFIG, resolveProjects } from "./config";
import { ModelTriadManager } from "./model-triad";
import { publishConsolidatedReport } from "./reporter";
import { logError, logInfo, logSuccess, runProjectCycle } from "./runner";

export function parseCliArgs(argv: string[]) {
  const repoArg = argv.find((a) => a.startsWith("--repo="))?.split("=")[1];
  const isPortfolio = argv.includes("--portfolio") || (!repoArg && argv.includes("--all"));
  const isAll = argv.includes("--all");
  const isDaemon = argv.includes("--daemon");
  const isDryRun = argv.includes("--dry-run") || process.env.DRY_RUN === "true";
  const simulate429 = argv.includes("--simulate-429") || process.env.SIMULATE_429 === "true";

  const devEngineArg = argv.find((a) => a.startsWith("--dev-engine="))?.split("=")[1];
  const devEngine = (devEngineArg || process.env.AGENT_DEV_ENGINE || CONFIG.AGENT_DEV_ENGINE || "gemini").toLowerCase() as "gemini" | "claude";

  const labelArg = argv.find((a) => a.startsWith("--label="));
  const label = labelArg ? labelArg.slice("--label=".length).replace(/^["']|["']$/g, "").trim() : undefined;

  const issueArg = argv.find((a) => a.startsWith("--issue="));
  const issueNumber = issueArg ? Number(issueArg.split("=")[1]) : undefined;

  const maxFeaturesArg = argv.find((a) => a.startsWith("--max-features="))?.split("=")[1];
  const maxFeatures = maxFeaturesArg ? Number(maxFeaturesArg) : CONFIG.MAX_FEATURES_PER_BATCH;

  const skipPendingPrCheck = argv.includes("--skip-pending-check") || argv.includes("--force");

  return {
    repoArg,
    isPortfolio,
    isAll,
    isDaemon,
    isDryRun,
    simulate429,
    devEngine,
    label,
    issueNumber,
    maxFeatures,
    skipPendingPrCheck
  };
}

export async function runIteration(args: ReturnType<typeof parseCliArgs>, triad: ModelTriadManager) {
  const targetProjects = resolveProjects(args.repoArg, args.isPortfolio);

  logInfo(`Initialisation d'agentic-dev-core (Control Plane Transverse)...`);
  logInfo(
    `Configuration Moteurs : Dev Engine='${args.devEngine.toUpperCase()}' | Dev Model='${triad.getPrimaryDevModel()}' | Fallback='${triad.getFallbackDevModel()}' | QA Gate='${triad.getQaModel()}'`
  );
  logInfo(`Projets ciblés (${targetProjects.length}) : ${targetProjects.map((p) => p.name).join(", ")}`);
  logInfo(`Plafond de batch : max ${args.maxFeatures} feature(s) par projet (isolation des APKs)`);
  if (args.label) {
    logInfo(`Filtre de label actif : '${args.label}'`);
  }
  if (args.isDryRun) {
    logInfo(`Mode DRY-RUN activé (aucune écriture distante ni modification des repos cibles).`);
  }

  const projectSummaries = [];
  for (const project of targetProjects) {
    const summary = await runProjectCycle(project, triad, {
      all: args.isAll,
      label: args.label,
      issueNumber: args.issueNumber,
      maxFeatures: args.maxFeatures,
      dryRun: args.isDryRun,
      simulate429: args.simulate429,
      skipPendingPrCheck: args.skipPendingPrCheck,
      checkPendingPrsInDryRun: true,
      devEngine: args.devEngine
    });
    projectSummaries.push(summary);
  }

  const dateStr = new Date().toISOString().slice(0, 10);
  const reportResult = await publishConsolidatedReport({
    date: dateStr,
    projects: projectSummaries
  });

  logSuccess(`Rapport matinal consolidé généré : ${reportResult.localPath}`);
  if (reportResult.notionUrl) {
    logSuccess(`Journal Notion mis à jour : ${reportResult.notionUrl}`);
  }

  return {
    projects: projectSummaries,
    reportPath: reportResult.localPath,
    notionUrl: reportResult.notionUrl
  };
}

export async function runCli(argv = process.argv.slice(2)) {
  const args = parseCliArgs(argv);
  const triad = new ModelTriadManager();

  if (args.isDaemon) {
    logInfo(`🚀 Démarrage du Control Plane en mode DAEMON permanent (veille de 60s)...`);
    while (true) {
      try {
        await runIteration(args, triad);
      } catch (err: any) {
        logError(`Erreur lors de l'itération daemon : ${err.message}`);
      }
      logInfo(`💤 En veille pour 60 secondes avant le prochain check de portefeuille...`);
      await new Promise((resolve) => setTimeout(resolve, 60000));
    }
  } else {
    return await runIteration(args, triad);
  }
}

if (require.main === module) {
  runCli().catch((err) => {
    logError(`Erreur fatale Control Plane : ${err.message}`);
    process.exit(1);
  });
}
