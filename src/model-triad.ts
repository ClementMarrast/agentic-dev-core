/**
 * Gestionnaire de la Triade de Modèles & Tolérance de Quota (Haute Disponibilité)
 * - Dev Primaire : Gemini 4 Aragon (AGENT_DEV_MODEL)
 * - Dev Fallback Quota : Gemini 3.8 High (AGENT_DEV_FALLBACK_MODEL) sur HTTP 429 / RESOURCE_EXHAUSTED
 * - QA Gate : Gemini 3.8 Flash (AGENT_QA_MODEL)
 */

import { CONFIG } from "./config";

export interface DevExecutionResult<T = string> {
  output: T;
  modelUsed: string;
  fallbackTriggered: boolean;
  fallbackReason?: string;
}

export class QuotaExhaustedError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(message = "HTTP 429: RESOURCE_EXHAUSTED on primary model", statusCode = 429, code = "RESOURCE_EXHAUSTED") {
    super(message);
    this.name = "QuotaExhaustedError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function isQuotaError(error: unknown): boolean {
  if (!error) return false;
  if (error instanceof QuotaExhaustedError) return true;

  const errObj = error as Record<string, any>;
  if (errObj.status === 429 || errObj.statusCode === 429) return true;
  if (errObj.code === "RESOURCE_EXHAUSTED" || errObj.error?.status === "RESOURCE_EXHAUSTED") return true;

  const msg = String(errObj.message || errObj.stderr || errObj.stdout || error);
  return (
    msg.includes("429") ||
    msg.includes("RESOURCE_EXHAUSTED") ||
    msg.toLowerCase().includes("quota exceeded") ||
    msg.toLowerCase().includes("rate limit")
  );
}

export class ModelTriadManager {
  private primaryDevModel: string;
  private fallbackDevModel: string;
  private qaModel: string;
  private activeDevModel: string;
  private fallbackActive = false;

  constructor(
    primaryDevModel = CONFIG.AGENT_DEV_MODEL,
    fallbackDevModel = CONFIG.AGENT_DEV_FALLBACK_MODEL,
    qaModel = CONFIG.AGENT_QA_MODEL
  ) {
    this.primaryDevModel = primaryDevModel;
    this.fallbackDevModel = fallbackDevModel;
    this.qaModel = qaModel;
    this.activeDevModel = primaryDevModel;
  }

  public getPrimaryDevModel(): string {
    return this.primaryDevModel;
  }

  public getFallbackDevModel(): string {
    return this.fallbackDevModel;
  }

  public getQaModel(): string {
    return this.qaModel;
  }

  public getActiveDevModel(): string {
    return this.activeDevModel;
  }

  public isFallbackActive(): boolean {
    return this.fallbackActive;
  }

  /**
   * Exécute une tâche de développement sur le modèle primaire (Gemini 4 Aragon).
   * En cas d'erreur HTTP 429 ou RESOURCE_EXHAUSTED, bascule automatiquement
   * et de façon transparente sur Gemini 3.8 High sans faire crasher le runner.
   */
  public async executeDevTask<T>(
    taskFn: (model: string) => Promise<T> | T,
    onFallbackLog?: (reason: string, fallbackModel: string) => void
  ): Promise<DevExecutionResult<T>> {
    // Si le fallback a déjà été activé durant la session, on utilise directement le modèle de secours
    if (this.fallbackActive) {
      const output = await taskFn(this.fallbackDevModel);
      return {
        output,
        modelUsed: this.fallbackDevModel,
        fallbackTriggered: true,
        fallbackReason: "Bascule quota déjà active sur la session"
      };
    }

    try {
      const output = await taskFn(this.primaryDevModel);
      return {
        output,
        modelUsed: this.primaryDevModel,
        fallbackTriggered: false
      };
    } catch (error: unknown) {
      if (isQuotaError(error)) {
        const reason = error instanceof Error ? error.message : String(error);
        this.fallbackActive = true;
        this.activeDevModel = this.fallbackDevModel;

        if (onFallbackLog) {
          onFallbackLog(reason, this.fallbackDevModel);
        }

        const output = await taskFn(this.fallbackDevModel);
        return {
          output,
          modelUsed: this.fallbackDevModel,
          fallbackTriggered: true,
          fallbackReason: reason
        };
      }
      throw error;
    }
  }
}
