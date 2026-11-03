/**
 * Module de Reporting Matinal Consolidé (Multi-Projets)
 * - Génère un rapport Markdown dans `reports/nightly-YYYYMMDD.md`
 * - Publie une entrée consolidée dans la base Journal Notion (`b3af95c7-7375-44ad-8d32-b18bff426baa`)
 */

import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "./config";

export interface ProjectExecutionSummary {
  projectId: string;
  projectName: string;
  githubRepo: string;
  epicBranch: string;
  devModelUsed: string;
  fallbackTriggered: boolean;
  fallbackReason?: string;
  qaModelUsed: string;
  testsPassed: boolean;
  testCommandsRun: string[];
  mergedStories: Array<{
    number: number;
    title: string;
    branch: string;
    prUrl?: string;
    devModel: string;
  }>;
  blockedStories: Array<{
    number: number;
    title: string;
    reason: string;
    retries: number;
  }>;
  finalEpicPrUrl?: string;
  humanValidationLabel?: string;
}

export interface ConsolidatedNightlyReport {
  date: string; // YYYY-MM-DD
  projects: ProjectExecutionSummary[];
}

export function generateConsolidatedMarkdownReport(report: ConsolidatedNightlyReport): string {
  const projectSections = report.projects
    .map((proj) => {
      const modelBadge = proj.fallbackTriggered
        ? `\`${proj.devModelUsed}\` (⚠️ Bascule Quota automatique depuis \`${CONFIG.AGENT_DEV_MODEL}\`)`
        : `\`${proj.devModelUsed}\` (Primaire nominal)`;

      const testsBadge = proj.testsPassed
        ? `✅ 100% au vert (${proj.testCommandsRun.map((c) => `\`${c}\``).join(", ")})`
        : `❌ Échec détecté (${proj.testCommandsRun.map((c) => `\`${c}\``).join(", ")})`;

      const mergedList =
        proj.mergedStories.length > 0
          ? proj.mergedStories
              .map(
                (s) =>
                  `- **#${s.number}** — ${s.title} | Branche: \`${s.branch}\` | Modèle: \`${s.devModel}\` ${
                    s.prUrl ? `([PR](${s.prUrl}))` : ""
                  }`
              )
              .join("\n")
          : "_Aucune User Story mergée dans ce cycle._";

      const blockedList =
        proj.blockedStories.length > 0
          ? proj.blockedStories
              .map((s) => `- 🛑 **#${s.number}** — ${s.title} (${s.retries} retries QA) : ${s.reason}`)
              .join("\n")
          : "✅ _Aucune story bloquée._";

      const finalPrLine = proj.finalEpicPrUrl
        ? `[${proj.finalEpicPrUrl}](${proj.finalEpicPrUrl}) — Étiquette : \`${proj.humanValidationLabel || CONFIG.LABELS.READY_FOR_HUMAN}\``
        : `En attente / Mode Dry-Run (Étiquette cible : \`${CONFIG.LABELS.READY_FOR_HUMAN}\`)`;

      return `## 📦 Projet : ${proj.projectName} (\`${proj.githubRepo}\`)

- **Branche d'intégration Epic :** \`${proj.epicBranch}\`
- **Modèle Dev utilisé :** ${modelBadge}
- **Modèle QA Gate :** \`${proj.qaModelUsed}\`
- **État des Tests & Typecheck :** ${testsBadge}
- **PR Finale (Human Gatekeeper) :** ${finalPrLine}

### ✅ Stories Intégrées (${proj.mergedStories.length})
${mergedList}

### ⚠️ Stories Bloquées (${proj.blockedStories.length})
${blockedList}`;
    })
    .join("\n\n---\n\n");

  return `# 🌅 Rapport Matinal Consolidé — Control Plane (\`agentic-dev-core\`) — ${report.date}

## 🎯 Synthèse Portefeuille
- **Date d'exécution :** ${report.date}
- **Projets orchestrés :** ${report.projects.map((p) => `**${p.projectName}**`).join(", ")}
- **Triade de Modèles configurée :**
  - Dev Primaire : \`${CONFIG.AGENT_DEV_MODEL}\`
  - Dev Fallback Quota (HTTP 429) : \`${CONFIG.AGENT_DEV_FALLBACK_MODEL}\`
  - QA Gatekeeper : \`${CONFIG.AGENT_QA_MODEL}\`
- **Gouvernance Git :** Protection stricte de \`main\` active — Validation humaine requise (\`${CONFIG.LABELS.READY_FOR_HUMAN}\`).

---

${projectSections}

---

*Généré automatiquement par \`agentic-dev-core\` (Control Plane Transverse).*
`;
}

export function saveConsolidatedLocalReport(report: ConsolidatedNightlyReport, baseDir = process.cwd()): string {
  const dateCompact = report.date.replace(/-/g, "");
  const reportsDir = path.resolve(baseDir, "reports");
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }

  const filePath = path.join(reportsDir, `nightly-${dateCompact}.md`);
  const content = generateConsolidatedMarkdownReport(report);
  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

export async function publishConsolidatedReport(
  report: ConsolidatedNightlyReport,
  baseDir = process.cwd()
): Promise<{ success: boolean; localPath: string; notionUrl?: string }> {
  const localPath = saveConsolidatedLocalReport(report, baseDir);

  if (!CONFIG.NOTION_API_KEY) {
    return { success: false, localPath };
  }

  try {
    const summaryLines = report.projects.map(
      (p) =>
        `• ${p.projectName} (${p.epicBranch}) : Dev=${p.devModelUsed} | Tests=${p.testsPassed ? "OK" : "KO"} | Mergées=${
          p.mergedStories.length
        } | Bloquées=${p.blockedStories.length} | PR=${p.finalEpicPrUrl || "N/A"}`
    );

    const firstFinalPr = report.projects.find((p) => p.finalEpicPrUrl)?.finalEpicPrUrl;

    const payload = {
      parent: { database_id: CONFIG.NOTION_JOURNAL_DB_ID.replace(/-/g, "") },
      properties: {
        Nom: {
          title: [
            {
              text: {
                content: `[Control Plane] Nightly Run — ${report.date} (${report.projects.map((p) => p.projectName).join(" & ")})`
              }
            }
          ]
        },
        Type: {
          select: { name: "Release" }
        },
        Date: {
          date: { start: report.date }
        },
        ...(firstFinalPr
          ? {
              Lien: {
                url: firstFinalPr
              }
            }
          : {})
      },
      children: [
        {
          object: "block",
          type: "heading_2",
          heading_2: {
            rich_text: [{ type: "text", text: { content: "🌅 Rapport Matinal Consolidé (agentic-dev-core)" } }]
          }
        },
        {
          object: "block",
          type: "paragraph",
          paragraph: {
            rich_text: [
              {
                type: "text",
                text: {
                  content: summaryLines.join("\n")
                }
              }
            ]
          }
        }
      ]
    };

    const res = await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${CONFIG.NOTION_API_KEY}`,
        "Content-Type": "application/json",
        "Notion-Version": "2022-06-28"
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      return { success: false, localPath };
    }

    const data: any = await res.json();
    return { success: true, localPath, notionUrl: data.url };
  } catch {
    return { success: false, localPath };
  }
}
