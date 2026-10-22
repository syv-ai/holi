export type ModelRecord = {
  id: string
  name: string
  provider: string
  /** Context window, unit free so the view owns the label. */
  context: string
  capability: string
  /** Called out in the picker as the default for most work. */
  recommended?: boolean
}

export const MODELS: ModelRecord[] = [
  {
    id: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    provider: "Anthropic",
    context: "200K",
    capability: "Code",
    recommended: true,
  },
  {
    id: "gpt-5-1",
    name: "GPT-5.1",
    provider: "OpenAI",
    context: "256K",
    capability: "Balanced",
  },
  {
    id: "gemini-3-pro",
    name: "Gemini 3 Pro",
    provider: "Google",
    context: "1M",
    capability: "Long input",
  },
  {
    id: "mistral-large",
    name: "Mistral Large",
    provider: "Mistral",
    context: "128K",
    capability: "Fastest",
  },
]

export const NEW_THREAD_ID = "th_new"

export type ThreadRecord = {
  id: string
  title: string
  updatedLabel: string
  pinned: boolean
}

export const THREADS: ThreadRecord[] = [
  {
    id: "th_9f2k4m",
    title: "Stripe webhook 500s on charge.refunded",
    updatedLabel: "2m",
    pinned: true,
  },
  {
    id: "th_4a71cd",
    title: "Q3 release notes draft",
    updatedLabel: "1h",
    pinned: true,
  },
  {
    id: "th_c31f88",
    title: "Stream chat responses",
    updatedLabel: "2h",
    pinned: false,
  },
  {
    id: "th_b820ee",
    title: "Churn by plan tier",
    updatedLabel: "3h",
    pinned: false,
  },
  {
    id: "th_5c19a0",
    title: "Mobile onboarding revamp scope",
    updatedLabel: "Yesterday",
    pinned: false,
  },
  {
    id: "th_77de31",
    title: "Why is p95 latency up on eu-west",
    updatedLabel: "Yesterday",
    pinned: false,
  },
  {
    id: "th_e3806b",
    title: "Rewrite the trial expiry email",
    updatedLabel: "Tue",
    pinned: false,
  },
  {
    id: "th_a90f52",
    title: "Postgres index for events table",
    updatedLabel: "Mon",
    pinned: false,
  },
]