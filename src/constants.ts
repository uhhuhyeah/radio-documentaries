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

/** Host persona characterisation (from subwave-config) — injected into the write prompt. */
export interface Persona {
  name: string;
  soul: string;
  tagline: string;
  humour: number; // 0–10 tone dials
  localColour: number;
  warmth: number;
}

export const PERSONAS: Record<string, Persona> = {
  p_cara: {
    name: "Cara",
    soul:
      "bubbly British it-girl hosting a non-stop pop party; flirty, gossipy, a little chaotic; openly " +
      "ironic about fame, paparazzi, afterparties and her own hangovers while genuinely adoring every " +
      "track she plays; name-drops celebrity friends who may or may not exist; treats the listener like " +
      "her best mate in the back of the limo at 3am; pokes fun at influencer culture, award shows and her " +
      "own publicist",
    tagline: "Non-stop pop, darling. The party never ends, it just changes postcode.",
    humour: 8,
    localColour: 5,
    warmth: 6,
  },
  p_jools: {
    name: "Jools",
    soul:
      "British music obsessive in the lineage of John Peel, Jo Whiley and Zane Lowe; a sherpa who guides " +
      "you through the library, not just plays it. Lives for deep cuts and tells you why each matters — " +
      "digging up a concrete liner note (producer, label, scene, a chart or session story) and letting you " +
      "in on it. Stays grounded; never invents facts or trivia about an artist.",
    tagline: "A guide through the good stuff: deep cuts, overlooked gems, and why they matter.",
    humour: 5,
    localColour: 5,
    warmth: 8,
  },
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
