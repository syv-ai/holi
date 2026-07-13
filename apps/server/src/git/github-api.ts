// apps/server/src/git/github-api.ts  (placeholder — replaced in Task 5)
export interface GithubApi {
  exchangeCode(code: string): Promise<{ accessToken: string }>
  getUser(token: string): Promise<{ id: number; login: string }>
  getRepo(token: string, owner: string, repo: string): Promise<{ defaultBranch: string; admin: boolean }>
  createDeployKey(token: string, owner: string, repo: string, title: string, key: string): Promise<{ id: number }>
  deleteDeployKey(token: string, owner: string, repo: string, id: number): Promise<void>
  createWebhook(token: string, owner: string, repo: string, url: string, secret: string): Promise<{ id: number }>
  deleteWebhook(token: string, owner: string, repo: string, id: number): Promise<void>
}
