import { createAzure } from "@ai-sdk/azure";
import type { LanguageModel } from "ai";
import { azureEnv } from "./config.ts";

/** Azure is optional: only needed for self-heal (act) and the LLM judge. */
export function azureConfigured(): boolean {
  return Boolean(azureEnv.apiKey && azureEnv.resourceName && azureEnv.deployment);
}

/** The AI SDK v5 Azure model, used by self-heal's generateObject call. */
export function getAzureModel(): LanguageModel {
  if (!azureConfigured()) {
    throw new Error("Azure not configured: set AZURE_API_KEY, AZURE_RESOURCE_NAME, AZURE_DEPLOYMENT in .env.");
  }
  const azure = createAzure({ resourceName: azureEnv.resourceName!, apiKey: azureEnv.apiKey! });
  return azure(azureEnv.deployment!);
}
