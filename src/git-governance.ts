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

export interface PendingPrInfo {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  baseRefName: string;
  labels?: Array<{ name: string }>;
  createdAt?: string;
}

export interface ConventionalCommitResult {
  type: string;
  scope: string;
  subject: string;
  commitMessage: string;
  prTitle: string;
}

/**
 * Normalise et formate un message de commit et un titre de PR selon les spécifications
 * de Conventional Commits (type(scope): description (US-XXX, #YY)).
 */
export function formatConventionalCommit(
  issue: GitHubIssue,
  fallbackScope?: string
): ConventionalCommitResult {
  const rawTitle = issue.title.trim();

  // 1. Détection si le titre respecte déjà le format Conventional Commits
  const conventionalMatch = rawTitle.match(
    /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(?:\(([^)]+)\))?!?:\s*(.+)$/i
  );

  if (conventionalMatch) {
    const type = conventionalMatch[1].toLowerCase();
    const scope = (conventionalMatch[2] || "").toLowerCase().trim();
    let subject = conventionalMatch[3].trim().replace(/\s*\((?:closes\s+)?#\d+\)$/i, "");
    const scopeStr = scope ? `(${scope})` : "";
    const commitMessage = `${type}${scopeStr}: ${subject} (#${issue.number})`;
    const prTitle = `${type}${scopeStr}: ${subject} (#${issue.number})`;
    return { type, scope, subject, commitMessage, prTitle };
  }

  let type = "feat";
  let scope = "";
  let subject = rawTitle;

  // 2. Extraction des tags entre crochets : ex [Arch/Apps], [Story/MVP], [Bug], [Feature/Security], [OTA], [Distribution/Android]
  const tagMatch = subject.match(/^\[(.*?)\]\s*/);
  let tag = "";
  if (tagMatch) {
    tag = tagMatch[1];
    subject = subject.slice(tagMatch[0].length).trim();
  }

  // 3. Extraction de l'identifiant User Story : ex US-516, US-101
  const usMatch = subject.match(/^US-(\d+)\s*[:-]\s*/i) || rawTitle.match(/\b(US-\d+)\b/i);
  let usId = "";
  if (usMatch) {
    usId = (usMatch[1].startsWith("US-") ? usMatch[1] : `US-${usMatch[1]}`).toUpperCase();
    subject = subject.replace(/^US-\d+\s*[:-]\s*/i, "").trim();
  }

  // Suppression des tags de test superflus en fin de titre, ex [TEST]
  subject = subject.replace(/\s*\[TEST\]$/i, "").trim();

  // 4. Détermination du type Conventional Commits
  const lowerTag = tag.toLowerCase();
  const lowerSubj = subject.toLowerCase();
  if (
    lowerTag.includes("bug") ||
    lowerTag.includes("fix") ||
    lowerSubj.startsWith("fix ") ||
    lowerSubj.startsWith("corriger ") ||
    lowerSubj.startsWith("correction ")
  ) {
    type = "fix";
  } else if (lowerTag.includes("arch") || lowerTag.includes("refactor")) {
    type = "refactor";
  } else if (lowerTag.includes("docs") || lowerTag.includes("spec") || lowerTag.includes("adr")) {
    type = "docs";
  } else if (
    lowerTag.includes("test") ||
    lowerTag.includes("benchmark") ||
    lowerTag.includes("qa") ||
    lowerTag.includes("e2e")
  ) {
    type = "test";
  } else if (
    lowerTag.includes("ci") ||
    lowerTag.includes("build") ||
    lowerTag.includes("packaging") ||
    lowerTag.includes("distribution") ||
    lowerTag.includes("stores")
  ) {
    type = "build";
  } else if (lowerTag.includes("style")) {
    type = "style";
  } else if (lowerTag.includes("perf")) {
    type = "perf";
  } else {
    type = "feat";
  }

  // 5. Détermination du scope
  if (tag.includes("/")) {
    const parts = tag.split("/");
    const lastPart = parts[parts.length - 1].toLowerCase().trim();
    if (!["story", "feature", "bug"].includes(lastPart)) {
      scope = lastPart;
    } else if (!["story", "feature", "bug"].includes(parts[0].toLowerCase().trim())) {
      scope = parts[0].toLowerCase().trim();
    }
  } else if (tag && !["bug", "story", "feature", "fix"].includes(tag.toLowerCase())) {
    scope = tag.toLowerCase().trim();
  }

  // Scope fallback via label d'Epic si aucun scope extrait
  if (!scope && issue.labels) {
    const epicLabel = issue.labels.find((l) => l.name.toLowerCase().startsWith("epic:"));
    if (epicLabel) {
      scope = epicLabel.name
        .replace(/^epic:\s*/i, "")
        .trim()
        .toLowerCase()
        .replace(/^epic\//, "");
    }
  }

  if (!scope && fallbackScope) {
    scope = fallbackScope.toLowerCase().trim();
  }

  scope = scope
    .replace(/[^a-z0-9\-]/g, "-")
    .replace(/^-+|-+$/g, "");

  // 6. Normalisation de la casse du sujet (minuscule initiale sauf acronymes)
  if (/^\p{Lu}\p{Ll}/u.test(subject)) {
    subject = subject.charAt(0).toLowerCase() + subject.slice(1);
  }

  const scopeStr = scope ? `(${scope})` : "";
  const refStr = usId ? `(${usId}, #${issue.number})` : `(#${issue.number})`;
  const prRefStr = usId ? `(${usId})` : `(#${issue.number})`;

  return {
    type,
    scope,
    subject,
    commitMessage: `${type}${scopeStr}: ${subject} ${refStr}`,
    prTitle: `${type}${scopeStr}: ${subject} ${prRefStr}`
  };
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
 * Construit la commande d'ouverture de PR d'une Feature directement vers `main` avec l'étiquette `🔍 Ready for Human Validation`.
 * Chaque feature part de `main` et cible `main`, permettant une validation et un test APK 100% isolés.
 */
export function buildFeaturePrCommand(
  project: ProjectConfig,
  storyBranch: string,
  issue: GitHubIssue,
  devModel: string,
  qaModel: string
): { base: string; head: string; label: string; cmd: string; title: string; body: string } {
  const commitInfo = formatConventionalCommit(issue);
  const title = commitInfo.prTitle;
  const label = CONFIG.LABELS.READY_FOR_HUMAN;
  const body = [
    `Résout #${issue.number}.`,
    "",
    `- **Branche source :** \`${storyBranch}\` (créée à partir de \`main\`)`,
    `- **Modèle Dev :** \`${devModel}\``,
    `- **Validé par QA Gate :** \`${qaModel}\``,
    "",
    `🔍 **Human Gatekeeper :** Prêt pour génération et test unitaire de l'APK indépendant avant merge sur \`main\`.`
  ].join("\n");

  const escapedTitle = title.replace(/"/g, '\\"').replace(/`/g, "\\`");
  const escapedBody = body
    .replace(/"/g, '\\"')
    .replace(/`/g, "\\`")
    .replace(/\$/g, "\\$")
    .replace(/\n/g, "\\n");

  const cmd = `gh pr create --base main --head "${storyBranch}" --title "${escapedTitle}" --body "${escapedBody}" --label "${label}" -R ${project.githubRepo}`;
  return { base: "main", head: storyBranch, label, cmd, title, body };
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
): { base: string; head: string; cmd: string; title: string; body: string } {
  assertNotDirectPushToMain(epicBranch, "story PR target");
  const commitInfo = formatConventionalCommit(issue);
  const title = commitInfo.prTitle;
  const body = [
    `Résout #${issue.number}.`,
    "",
    `- **Modèle Dev :** \`${devModel}\``,
    `- **Validé par QA Gate :** \`${qaModel}\``,
    `- **Branche d'Epic cible :** \`${epicBranch}\``
  ].join("\n");

  const escapedTitle = title.replace(/"/g, '\\"').replace(/`/g, "\\`");
  const escapedBody = body
    .replace(/"/g, '\\"')
    .replace(/`/g, "\\`")
    .replace(/\$/g, "\\$")
    .replace(/\n/g, "\\n");

  const cmd = `gh pr create --base "${epicBranch}" --head "${storyBranch}" --title "${escapedTitle}" --body "${escapedBody}" -R ${project.githubRepo}`;
  return { base: epicBranch, head: storyBranch, cmd, title, body };
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
): { base: string; head: string; label: string; cmd: string; title: string; body: string } {
  if (!epicBranch.startsWith("epic/")) {
    throw new GitGovernanceError(`La branche source d'une PR finale vers main doit être une branche d'Epic ('epic/*'), reçu: '${epicBranch}'`);
  }

  const label = CONFIG.LABELS.READY_FOR_HUMAN;
  const storiesMd =
    mergedStories.length > 0
      ? mergedStories.map((s) => `- #${s.number} : ${s.title}`).join("\n")
      : "- Validation consolidée de l'Epic";

  const body = [
    `## 🌙 Batch Control Plane (${project.name}) — ${dateStr}`,
    "",
    `Cet Epic regroupe les User Stories développées par **${devModel}** et validées par la QA Gate **${qaModel}**.`,
    "",
    "### Stories intégrées :",
    storiesMd,
    "",
    "🔍 **Gouvernance Human Gatekeeper** : Prêt pour validation et merge humain vers `main`."
  ].join("\n");

  const title = `[Epic Release] ${project.name} : ${epicBranch} (${dateStr})`;
  const escapedTitle = title.replace(/"/g, '\\"').replace(/`/g, "\\`");
  const escapedBody = body
    .replace(/"/g, '\\"')
    .replace(/`/g, "\\`")
    .replace(/\$/g, "\\$")
    .replace(/\n/g, "\\n");

  const cmd = `gh pr create --base main --head "${epicBranch}" --title "${escapedTitle}" --body "${escapedBody}" --label "${label}" -R ${project.githubRepo}`;

  return {
    base: "main",
    head: epicBranch,
    label,
    cmd,
    title,
    body
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

/**
 * Récupère les Pull Requests ouvertes en attente de validation humaine pour un projet donné.
 * Détecte les PRs ouvertes étiquetées '🔍 Ready for Human Validation' ou ciblant 'main'/'master'.
 */
export function fetchPendingValidationPrs(project: ProjectConfig): PendingPrInfo[] {
  try {
    const json = execSync(
      `gh pr list --state open -R ${project.githubRepo} --json number,title,url,headRefName,baseRefName,labels,createdAt --limit 50`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    );
    const prs: PendingPrInfo[] = JSON.parse(json);

    return prs.filter((pr) => {
      const hasReadyLabel = pr.labels?.some((l) => l.name === CONFIG.LABELS.READY_FOR_HUMAN);
      const targetsMain = pr.baseRefName === "main" || pr.baseRefName === "master";
      return hasReadyLabel || targetsMain;
    });
  } catch {
    return [];
  }
}
