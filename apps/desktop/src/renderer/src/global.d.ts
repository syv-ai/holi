declare global {
  interface Window {
    holi: { ping(): Promise<string> }
  }
}

export {}
