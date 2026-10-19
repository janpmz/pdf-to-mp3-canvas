// Names and gender: https://docs.cloud.google.com/text-to-speech/docs/gemini-tts#voice_options
export const DEFAULT_VOICE = "Enceladus";
export const DEFAULT_PACE = "slow";
export const VOICE_CHOICES = Object.freeze([
  { name: DEFAULT_VOICE, gender: "Male" },
  { name: "Kore", gender: "Female" },
  { name: "Sadachbia", gender: "Male" },
  { name: "Zephyr", gender: "Female" },
].map(Object.freeze));
export const VOICES = Object.freeze(VOICE_CHOICES.map(({ name }) => name));
export const PACES = Object.freeze(["slow", "normal", "fast"]);
export const normalizeVoice = (value) => VOICES.includes(value) ? value : DEFAULT_VOICE;
export const normalizePace = (value) => PACES.includes(value) ? value : DEFAULT_PACE;
export const paceFromSpeed = (value) => !Number.isFinite(value) ? DEFAULT_PACE : value < 1 ? "slow" : value > 1 ? "fast" : "normal";

export function paceInstruction(value) {
  switch (normalizePace(value)) {
    case "slow": return "Read slowly and clearly, with an unhurried pace and natural pauses. Keep the voice's natural pitch and tone.";
    case "fast": return "Read at a brisk, clear pace, with short natural pauses. Keep every word clear and the voice's natural pitch and tone.";
    default: return "Read at a natural, steady conversational pace.";
  }
}
