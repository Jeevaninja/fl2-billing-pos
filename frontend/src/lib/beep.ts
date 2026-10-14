let audio: AudioContext | null = null

/** Short scan feedback: a high blip for success, a low buzz for an error. Silent if audio is unavailable. */
export function beep(kind: 'ok' | 'error'): void {
  try {
    audio ??= new AudioContext()
    const osc = audio.createOscillator()
    const gain = audio.createGain()
    osc.type = kind === 'ok' ? 'sine' : 'square'
    osc.frequency.value = kind === 'ok' ? 1760 : 220
    gain.gain.value = 0.06
    osc.connect(gain).connect(audio.destination)
    const now = audio.currentTime
    osc.start(now)
    osc.stop(now + (kind === 'ok' ? 0.06 : 0.22))
  } catch {
    // No audio device or autoplay blocked: feedback stays visual only.
  }
}
