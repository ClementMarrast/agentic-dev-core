#!/usr/bin/env node
/**
 * Point d'entrée CLI du Control Plane Transverse (`agentic-dev-core`)
 * Supporte :
 * - `--repo=volvo` / `--repo=kids` / `--portfolio`
 * - `--all`
 * - `--label="batch: tonight"`
 * - `--issue=<number>`
 * - `--dry-run`
 * - `--simulate-429`
 */

import { resolveProjects } from "./config";
import { ModelTriadManager } from "./model-triad";
import { publishConsolidatedReport } from "./reporter";
import { logError, logInfo, logSuccess, runProjectCycle } from "./runner";

export function parseCliArgs(argv: string[]) {
  const repoArg = argv.find((a) => a.startsWith("--repo="))?.split("=")[1];
  const isPortfolio = argv.includes("--portfolio") || (!repoArg && argv.includes("--all"));
  const isAll = argv.includes("--all");
  const isDryRun = argv.includes("--dry-run") || process.env.DRY_RUN === "true";
  const simulate429 = argv.includes("--simulate-429") || process.env.SIMULATE_429 === "true";

  const labelArg = argv.find((a) => a.startsWith("--label="));
  const label = labelArg ? labelArg.slice("--label=".length).replace(/^["']|["']$/g, "").trim() : undefined;

  const issueArg = argv.find((a) => a.startsWith("--issue="));
  const issueNumber = issueArg ? Number(issueArg.split("=")[1]) : undefined;

  return {
    repoArg,
    isPortfolio,
    isAll,
    isDryRun,
    simulate429,
    label,
    issueNumber
  };
}

export async function runCli(argv = process.argv.slice(2)) {
  const args = parseCliArgs(argv);
  const targetProjects = resolveProjects(args.repoArg, args.isPortfolio);
  const triad = new ModelTriadManager();

  logInfo(`Initialisation d'agentic-dev-core (Control Plane Transverse)...`);
  logInfo(
    `Triade de Modèles : Dev='${triad.getPrimaryDevModel()}' | Fallback='${triad.getFallbackDevModel()}' | QA='${triad.getQaModel()}'`
  );
  logInfo(`Projets ciblés (${targetProjects.length}) : ${targetProjects.map((p) => p.name).join(", ")}`);
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
      dryRun: args.isDryRun,
      simulate429: args.simulate429
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

if (require.main === module) {
  runCli().catch((err) => {
    logError(`Erreur fatale Control Plane : ${err.message}`);
    process.exit(1);
  });
}
