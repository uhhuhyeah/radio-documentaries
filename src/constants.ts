/**
 * Shared constants — single source of truth for the deterministic stages.
 * Mirrors subwave-config; see producer-guide.md "SUB/WAVE Personas".
 */

export interface Voice {
  name: string;
  voiceId: string;
  speed: number;
}

/** Documentary hosts: persona id -> ElevenLabs voice + speed. */
export const VOICES: Record<string, Voice> = {
  p_cara: { name: "Cara", voiceId: "ZF6FPAbjXT4488VcRRnw", speed: 1.1 },
  p_jools: { name: "Jools", voiceId: "1BUhH8aaMvGMUdGAmWVM", speed: 1.0 },
};

/** ElevenLabs credit cost per character, per model (approximate; see the guide). */
export const MODEL_CREDIT_RATE: Record<string, number> = {
  eleven_flash_v2_5: 0.5,
  eleven_multilingual_v2: 1.0,
};

export const REQUIRED_FRONT_MATTER = [
  "season",
  "episode",
  "album",
  "artist",
  "host",
  "host_name",
  "model",
  "target_minutes",
  "reference_tracks",
] as const;

/** matches script-format.md duration math */
export const WORDS_PER_MINUTE = 150;
