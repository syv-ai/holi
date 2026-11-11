/**
 * What counts as speech, the same in the recorder (where a chunk closes,
 * `renderer/audio/chunker.ts`) and in main (who spoke, `main/stitcher.ts`
 * and `main/vad.ts`): a 20 ms frame this far above the channel's quietest,
 * within these bounds, and on the microphone not the speakers' echo.
 */

/** One frame of audio, in seconds. */
export const FRAME_SECONDS = 0.02
/** Speech is this far above the noise floor. */
export const MARGIN_DB = 10
/** However quiet the room, a frame below this is not speech; however loud,
 *  one above this is. */
export const MIN_THRESHOLD_DB = -55
export const MAX_THRESHOLD_DB = -30
/** The computer this much louder than the microphone: the microphone hears
 *  the speakers, not a person. */
export const ECHO_RATIO = 2
