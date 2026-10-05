import type { CardType, PlayerId } from "./types.ts";

// Card Pool table order (Game Specification v1.0 §4): each drawn at 25%.
export const CARD_TYPES: readonly CardType[] = ["fire", "lightning", "water", "nature"];

// Returns a float in [0, 1), same contract as Math.random — injectable so
// tests can force specific outcomes instead of asserting on real randomness.
export type RandomSource = () => number;

export function randomCard(random: RandomSource = Math.random): CardType {
  const index = Math.floor(random() * CARD_TYPES.length);
  return CARD_TYPES[Math.min(index, CARD_TYPES.length - 1)];
}

export function pickFirstPlayer(random: RandomSource = Math.random): PlayerId {
  return random() < 0.5 ? "A" : "B";
}
