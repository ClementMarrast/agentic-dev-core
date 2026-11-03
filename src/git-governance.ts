/**
 * Gouvernance Git Absolue (Human Gatekeeper)
 * - Interdiction absolue de pousser directement sur `main`.
 * - Chaque User Story crée sa branche de travail (`us-<id>-<slug>`) issue de la branche d'Epic (`epic/<nom-feature>`).
 * - L'agent QA valide et fusionne la PR dans la branche d'Epic.
 * - Quand tous les tickets d'un Epic sont intégrés, ouvre la PR finale de l'Epic vers `main` avec l'étiquette `🔍 Ready for Human Validation`.
 */

import { execSync, spawnSync } from "node:child_process";
import { CONFIG, ProjectConfig } from "./config";

export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  labels: Array<{ name: string }>;
  milestone?: { title: string };
}

export class GitGovernanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitGovernanceError";
  }
}

/**
 * Vérifie qu'une commande ou opération Git ne tente jamais un push direct vers `main` ou `master`.
 */
export function assertNotDirectPushToMain(targetBranch: string, operation = "git push"): void {
  const normalized = targetBranch.trim().replace(/^refs\/heads\//, "");
  if (normalized === "main" || normalized === "master" || normalized.endsWith(":main") || normalized.endsWith(":master")) {
    throw new GitGovernanceError(
      `🛑 VIOLATION DE GOUVERNANCE GIT (Human Gatekeeper) : Interdiction absolue d'exécuter '${operation}' directement vers '${targetBranch}'. Utilisez une branche d'Epic et une Pull Request étiquetée '${CONFIG.LABELS.READY_FOR_HUMAN}'.`
    );
  }
}

/**
 * Détermine la branche d'Epic cible pour une issue ou retourne la branche d'Epic par défaut du projet.
 * Ne retourne JAMAIS `main`.
 */
export function resolveEpicBranch(issue: GitHubIssue, project: ProjectConfig): string {
  const epicLabel = issue.labels.find((l) => l.name.toLowerCase().startsWith("epic:"));
  if (epicLabel) {
    const slug = epicLabel.name
      .replace(/^epic:\s*/i, "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9\-_/]+/g, "-");
    if (slug && slug !== "main" && slug !== "master") {
      return slug.startsWith("epic/") ? slug : `epic/${slug}`;
    }
  }
  return project.defaultEpicBranch;
}

/**
 * Génère le nom normalisé de la branche de travail : `us-<id>-<slug>`
 */
export function buildStoryBranchName(issue: GitHubIssue): string {
  const cleanTitle = issue.title
    .toLowerCase()
    .replace(/^\[.*?\]\s*/, "")
    .replace(/^us-\d+\s*[:\-]\s*/i, "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");

  return `us-${issue.number}-${cleanTitle || "story"}`;
}

/**
 * Construit la commande d'ouverture de PR d'une User Story vers la branche d'Epic.
 */
export function buildStoryPrCommand(
  project: ProjectConfig,
  epicBranch: string,
  storyBranch: string,
  issue: GitHubIssue,
  devModel: string,
  qaModel: string
): { base: string; head: string; cmd: string } {
  assertNotDirectPushToMain(epicBranch, "story PR target");
  const title = issue.title.replace(/"/g, '\\"');
  const body = `Résout #${issue.number}.\\n\\n- **Modèle Dev :** \`${devModel}\`\\n- **Validé par QA Gate :** \`${qaModel}\`\\n- **Branche d'Epic cible :** \`${epicBranch}\``;
  const cmd = `gh pr create --base "${epicBranch}" --head "${storyBranch}" --title "${title}" --body "${body}" -R ${project.githubRepo}`;
  return { base: epicBranch, head: storyBranch, cmd };
}

/**
 * Construit la commande d'ouverture de la PR finale d'Epic vers `main` avec le tag `🔍 Ready for Human Validation`.
 */
export function buildFinalEpicPrCommand(
  project: ProjectConfig,
  epicBranch: string,
  dateStr: string,
  mergedStories: Array<{ number: number; title: string }>,
  devModel: string,
  qaModel: string
): { base: string; head: string; label: string; cmd: string } {
  if (!epicBranch.startsWith("epic/")) {
    throw new GitGovernanceError(`La branche source d'une PR finale vers main doit être une branche d'Epic ('epic/*'), reçu: '${epicBranch}'`);
  }

  const label = CONFIG.LABELS.READY_FOR_HUMAN;
  const storiesMd =
    mergedStories.length > 0
      ? mergedStories.map((s) => `- #${s.number} : ${s.title}`).join("\\n")
      : "- Validation consolidée de l'Epic";

  const body =
    `## 🌙 Batch Control Plane (${project.name}) — ${dateStr}\\n\\n` +
    `Cet Epic regroupe les User Stories développées par **${devModel}** et validées par la QA Gate **${qaModel}**.\\n\\n` +
    `### Stories intégrées :\\n${storiesMd}\\n\\n` +
    `🔍 **Gouvernance Human Gatekeeper** : Prêt pour validation et merge humain vers \`main\`.`;

  const title = `[Epic Release] ${project.name} : ${epicBranch} (${dateStr})`;
  const cmd = `gh pr create --base main --head "${epicBranch}" --title "${title.replace(/"/g, '\\"')}" --body "${body.replace(/"/g, '\\"')}" --label "${label}" -R ${project.githubRepo}`;

  return {
    base: "main",
    head: epicBranch,
    label,
    cmd
  };
}

/**
 * Exécute une commande shell dans le répertoire du projet cible (`cwd: project.localPath`).
 */
export function runInProject(
  project: ProjectConfig,
  cmd: string,
  options: { silent?: boolean; env?: Record<string, string> } = {}
): string {
  // Protection contre tout `git push origin main`
  if (/git\s+push\b/i.test(cmd)) {
    const tokens = cmd.split(/\s+/);
    const lastToken = tokens[tokens.length - 1];
    if (lastToken === "main" || lastToken === "master" || lastToken.endsWith(":main") || lastToken.endsWith(":master")) {
      assertNotDirectPushToMain(lastToken, cmd);
    }
  }

  const res = execSync(cmd, {
    cwd: project.localPath,
    encoding: "utf-8",
    stdio: options.silent ? "pipe" : "inherit",
    env: { ...process.env, ...options.env }
  });
  return typeof res === "string" ? res.trim() : "";
}

export function ensureGitHubLabelExists(project: ProjectConfig, labelName: string, color = "0E8A16"): void {
  spawnSync(
    "gh",
    ["label", "create", labelName, "--color", color, "--force", "-R", project.githubRepo],
    { cwd: project.localPath, stdio: "pipe" }
  );
}
