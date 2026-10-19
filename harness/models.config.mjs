// Model configuration for ordered free-tier failover.
// Primary: Vertex Gemini. Fallbacks: NVIDIA NIM / Groq / others.
// Extend with your keys via environment variables.

export const models = [
  {
    id: "vertex-gemini",
    name: "Vertex Gemini 2.5 Flash/Pro",
    baseURL: process.env.VERTEX_BASE_URL || "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKey: process.env.VERTEX_API_KEY || process.env.GOOGLE_API_KEY,
    model: "gemini-2.5-flash",
    priority: 1,
  },
  {
    id: "nvidia-glm",
    name: "NVIDIA GLM 5.3 Flash",
    baseURL: process.env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1",
    apiKey: process.env.NVIDIA_API_KEY,
    model: "nvidia/llama-3.1-nemotron-ultra-253b-v1", // or glm equivalent
    priority: 2,
  },
  {
    id: "groq",
    name: "Groq",
    baseURL: process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1",
    apiKey: process.env.GROQ_API_KEY,
    model: "llama-3.3-70b-versatile",
    priority: 3,
  },
];

export function getAvailableModels() {
  return models.filter(m => m.apiKey).sort((a, b) => a.priority - b.priority);
}
