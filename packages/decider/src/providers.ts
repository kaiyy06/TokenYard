/** Known System One endpoints. Model ids differ by provider for the same model. */
export interface ProviderPreset {
  readonly baseURL: string;
  /** Environment variable conventionally holding the API key, if one is needed. */
  readonly apiKeyEnv?: string;
  readonly defaultModel: string;
}

export type ProviderName = "openrouter" | "typesafe" | "kev-local";

export const providers: Readonly<Record<ProviderName, ProviderPreset>> = {
  openrouter: {
    baseURL: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    defaultModel: "typesafe/jev-1.13",
  },
  typesafe: {
    baseURL: "https://api.typesafe.ai/v1",
    apiKeyEnv: "TYPESAFE_API_KEY",
    defaultModel: "jev-1.13",
  },
  /** Kev served locally with `python -m kev.serve --port 8009`. */
  "kev-local": {
    baseURL: "http://127.0.0.1:8009/v1",
    defaultModel: "kev-latest",
  },
};
