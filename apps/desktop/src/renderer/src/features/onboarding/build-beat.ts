/** The least time each build step holds the threshold, in ms. */
const BUILD_BEAT = 700
export const beat = () => new Promise<void>((done) => setTimeout(done, BUILD_BEAT))
