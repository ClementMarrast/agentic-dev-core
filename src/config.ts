/**
 * Configuration globale et Registre des Projets Cibles (V1)
 * Conformément à US-HUB-01.
 */

export interface ProjectConfig {
  id: "volvo" | "kids";
  name: string;
  localPath: string;
  githubRepo: string;
  testCommands: string[];
  defaultEpicBranch: string;
  notionProjectId?: string;
}

export const CONFIG = {
  // Moteur Dev : 'gemini' (défaut) ou 'claude' (Claude CLI headless)
  AGENT_DEV_ENGINE: (process.env.AGENT_DEV_ENGINE || "gemini").toLowerCase(),

  // Triade de modèles IA & Tolérance de Quota (Haute Disponibilité)
  AGENT_DEV_MODEL: process.env.AGENT_DEV_MODEL || "Gemini 4 Aragon",
  AGENT_DEV_FALLBACK_MODEL: process.env.AGENT_DEV_FALLBACK_MODEL || "Gemini 3.8 High",
  AGENT_QA_MODEL: process.env.AGENT_QA_MODEL || "Gemini 3.8 Flash",

  // Plafond de rétroaction QA -> Dev (2 retries max avant passage en status: blocked)
  MAX_QA_RETRIES: Number(process.env.MAX_QA_RETRIES ?? 2),

  // Identifiants Notion pour le Reporting Matinal consolidé
  NOTION_API_KEY: process.env.NOTION_API_KEY || process.env.NOTION_TOKEN || "",
  NOTION_JOURNAL_DB_ID: process.env.NOTION_JOURNAL_DB_ID || "b3af95c7-7375-44ad-8d32-b18bff426baa",

  // Labels de gouvernance GitHub
  LABELS: {
    READY_FOR_DEV: "status: ready-for-dev",
    IN_PROGRESS: "status: in-progress",
    QA_TESTING: "status: qa-testing",
    DONE: "status: done",
    BLOCKED: "status: blocked",
    READY_FOR_HUMAN: "🔍 Ready for Human Validation",
    BATCH_TONIGHT: "batch: tonight"
  }
};

export const PROJECTS: Record<ProjectConfig["id"], ProjectConfig> = {
  volvo: {
    id: "volvo",
    name: "Volvo P3 Logger",
    localPath: "/home/clem/Documents/dev/volvo-p3-logger",
    githubRepo: "ClementMarrast/volvo-p3-logger",
    testCommands: ["npm test", "npm run typecheck"],
    defaultEpicBranch: "epic/m1-cockpit",
    notionProjectId: "408a3747-e4f6-81e9-858e-d75307e05a49"
  },
  kids: {
    id: "kids",
    name: "Storya Kids",
    localPath: "/home/clem/Documents/dev/KidsStoriesAppV2",
    githubRepo: "ClementMarrast/KidsStoriesAppV2",
    testCommands: ["npm test", "npm run typecheck"],
    defaultEpicBranch: "epic/beta-stores"
  }
};

export function resolveProjects(targetArg?: string, isPortfolio?: boolean): ProjectConfig[] {
  if (isPortfolio || !targetArg || targetArg === "all") {
    return [PROJECTS.volvo, PROJECTS.kids];
  }
  const normalized = targetArg.toLowerCase().trim();
  if (normalized === "volvo" || normalized === "volvo-p3-logger") {
    return [PROJECTS.volvo];
  }
  if (normalized === "kids" || normalized === "kidsstoriesappv2" || normalized === "storya") {
    return [PROJECTS.kids];
  }
  throw new Error(`Projet cible inconnu : '${targetArg}'. Valeurs supportées : 'volvo', 'kids', 'all'.`);
}
