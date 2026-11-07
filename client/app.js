// Plain JS, no build step, no framework. This client renders whatever the
// server last told it and sends action messages — it never decides turn
// order, AP cost, Combo legality, or any other game rule itself (CLAUDE.md:
// "the server is the only authority"). Disabling a button here is a UI
// courtesy only, not an enforcement mechanism: the server rejects an illegal
// action regardless of whether this client happened to let the click through.
let selectedHandIndex = null;
let myPlayer = null;
let lastState = null;
let lastSeries = null;

const identityEl = document.getElementById("identity");
const disconnectBanner = document.getElementById("disconnect-banner");
const errorBanner = document.getElementById("error-banner");
const lobbyPanel = document.getElementById("lobby-panel");
const statusLine = document.getElementById("status-line");
const joinQueueBtn = document.getElementById("joinqueue-btn");
const gamePanel = document.getElementById("game-panel");
const seriesScoreEl = document.getElementById("series-score");
const myHpEl = document.getElementById("my-hp");
const oppHpEl = document.getElementById("opp-hp");
const apDisplayEl = document.getElementById("ap-display");
const turnIndicatorEl = document.getElementById("turn-indicator");
const turnTimerEl = document.getElementById("turn-timer");
const boardEl = document.getElementById("board");
const oppHandCountEl = document.getElementById("opp-hand-count");
const opponentHandEl = document.getElementById("opponent-hand");
const handEl = document.getElementById("hand");
const myHandCountEl = document.getElementById("my-hand-count");
const drawBtn = document.getElementById("draw-btn");
const endTurnBtn = document.getElementById("endturn-btn");
const quitPanel = document.getElementById("quit-panel");
const quitStatusEl = document.getElementById("quit-status");
const requestQuitBtn = document.getElementById("requestquit-btn");
const cancelQuitBtn = document.getElementById("cancelquit-btn");
const acceptQuitBtn = document.getElementById("acceptquit-btn");
const declineQuitBtn = document.getElementById("declinequit-btn");
const forfeitBtn = document.getElementById("forfeit-btn");
const newGamePanel = document.getElementById("newgame-panel");
const newGameStatusEl = document.getElementById("newgame-status");
const newGameBtn = document.getElementById("newgame-btn");
const logEl = document.getElementById("log");
const connectionStatusEl = document.getElementById("connection-status");
const connectionStatusTextEl = document.getElementById("connection-status-text");
const myHpBarEl = document.getElementById("my-hp-bar");
const oppHpBarEl = document.getElementById("opp-hp-bar");
const combatEventBanner = document.getElementById("combat-event-banner");

// Display-only scale for the HP bar. The server doesn't send max HP; this
// mirrors engine.ts's STARTING_HP and must be updated if that changes. HP
// can go below 0, so the bar is clamped — the number shows the real value.
const HP_BAR_MAX = 100;
function hpBarWidth(hp) {
  return `${Math.max(0, Math.min(100, (hp / HP_BAR_MAX) * 100))}%`;
}

// One fixed pixel-art pattern for every opponent card back. The server only
// tells this client how many cards the opponent holds, never which, so this
// is a hardcoded constant and never built from `opponent.hand`. Portrait
// 16x22 mirrored diamond (C4), muted so it never outshines hand art.
const OPPONENT_CARD_BACK_SVG = `<svg viewBox="0 0 16 22" shape-rendering="crispEdges" aria-hidden="true" focusable="false"><rect x="7" y="1" width="2" height="1" fill="var(--color-primary)"/><rect x="6" y="2" width="1" height="1" fill="var(--color-primary)"/><rect x="7" y="2" width="2" height="1" fill="var(--color-accent)"/><rect x="9" y="2" width="1" height="1" fill="var(--color-primary)"/><rect x="5" y="3" width="1" height="1" fill="var(--color-primary)"/><rect x="7" y="3" width="2" height="1" fill="var(--color-accent)"/><rect x="10" y="3" width="1" height="1" fill="var(--color-primary)"/><rect x="4" y="4" width="1" height="1" fill="var(--color-primary)"/><rect x="6" y="4" width="1" height="1" fill="var(--color-accent)"/><rect x="9" y="4" width="1" height="1" fill="var(--color-accent)"/><rect x="11" y="4" width="1" height="1" fill="var(--color-primary)"/><rect x="3" y="5" width="1" height="1" fill="var(--color-primary)"/><rect x="5" y="5" width="1" height="1" fill="var(--color-accent)"/><rect x="10" y="5" width="1" height="1" fill="var(--color-accent)"/><rect x="12" y="5" width="1" height="1" fill="var(--color-primary)"/><rect x="2" y="6" width="1" height="1" fill="var(--color-primary)"/><rect x="4" y="6" width="1" height="1" fill="var(--color-accent)"/><rect x="7" y="6" width="2" height="1" fill="var(--color-primary-strong)"/><rect x="11" y="6" width="1" height="1" fill="var(--color-accent)"/><rect x="13" y="6" width="1" height="1" fill="var(--color-primary)"/><rect x="1" y="7" width="1" height="1" fill="var(--color-primary)"/><rect x="3" y="7" width="1" height="1" fill="var(--color-accent)"/><rect x="6" y="7" width="1" height="1" fill="var(--color-primary-strong)"/><rect x="9" y="7" width="1" height="1" fill="var(--color-primary-strong)"/><rect x="12" y="7" width="1" height="1" fill="var(--color-accent)"/><rect x="14" y="7" width="1" height="1" fill="var(--color-primary)"/><rect x="0" y="8" width="1" height="1" fill="var(--color-primary)"/><rect x="2" y="8" width="1" height="1" fill="var(--color-accent)"/><rect x="5" y="8" width="1" height="1" fill="var(--color-primary-strong)"/><rect x="7" y="8" width="2" height="1" fill="var(--color-primary)"/><rect x="10" y="8" width="1" height="1" fill="var(--color-primary-strong)"/><rect x="13" y="8" width="1" height="1" fill="var(--color-accent)"/><rect x="15" y="8" width="1" height="1" fill="var(--color-primary)"/><rect x="1" y="9" width="1" height="1" fill="var(--color-accent)"/><rect x="4" y="9" width="1" height="1" fill="var(--color-primary-strong)"/><rect x="6" y="9" width="1" height="1" fill="var(--color-primary)"/><rect x="7" y="9" width="2" height="1" fill="var(--color-accent)"/><rect x="9" y="9" width="1" height="1" fill="var(--color-primary)"/><rect x="11" y="9" width="1" height="1" fill="var(--color-primary-strong)"/><rect x="14" y="9" width="1" height="1" fill="var(--color-accent)"/><rect x="0" y="10" width="1" height="1" fill="var(--color-accent)"/><rect x="3" y="10" width="1" height="1" fill="var(--color-primary-strong)"/><rect x="5" y="10" width="1" height="1" fill="var(--color-primary)"/><rect x="6" y="10" width="1" height="1" fill="var(--color-accent)"/><rect x="9" y="10" width="1" height="1" fill="var(--color-accent)"/><rect x="10" y="10" width="1" height="1" fill="var(--color-primary)"/><rect x="12" y="10" width="1" height="1" fill="var(--color-primary-strong)"/><rect x="15" y="10" width="1" height="1" fill="var(--color-accent)"/><rect x="0" y="11" width="1" height="1" fill="var(--color-accent)"/><rect x="3" y="11" width="1" height="1" fill="var(--color-primary-strong)"/><rect x="5" y="11" width="1" height="1" fill="var(--color-primary)"/><rect x="6" y="11" width="1" height="1" fill="var(--color-accent)"/><rect x="9" y="11" width="1" height="1" fill="var(--color-accent)"/><rect x="10" y="11" width="1" height="1" fill="var(--color-primary)"/><rect x="12" y="11" width="1" height="1" fill="var(--color-primary-strong)"/><rect x="15" y="11" width="1" height="1" fill="var(--color-accent)"/><rect x="1" y="12" width="1" height="1" fill="var(--color-accent)"/><rect x="4" y="12" width="1" height="1" fill="var(--color-primary-strong)"/><rect x="6" y="12" width="1" height="1" fill="var(--color-primary)"/><rect x="7" y="12" width="2" height="1" fill="var(--color-accent)"/><rect x="9" y="12" width="1" height="1" fill="var(--color-primary)"/><rect x="11" y="12" width="1" height="1" fill="var(--color-primary-strong)"/><rect x="14" y="12" width="1" height="1" fill="var(--color-accent)"/><rect x="0" y="13" width="1" height="1" fill="var(--color-primary)"/><rect x="2" y="13" width="1" height="1" fill="var(--color-accent)"/><rect x="5" y="13" width="1" height="1" fill="var(--color-primary-strong)"/><rect x="7" y="13" width="2" height="1" fill="var(--color-primary)"/><rect x="10" y="13" width="1" height="1" fill="var(--color-primary-strong)"/><rect x="13" y="13" width="1" height="1" fill="var(--color-accent)"/><rect x="15" y="13" width="1" height="1" fill="var(--color-primary)"/><rect x="1" y="14" width="1" height="1" fill="var(--color-primary)"/><rect x="3" y="14" width="1" height="1" fill="var(--color-accent)"/><rect x="6" y="14" width="1" height="1" fill="var(--color-primary-strong)"/><rect x="9" y="14" width="1" height="1" fill="var(--color-primary-strong)"/><rect x="12" y="14" width="1" height="1" fill="var(--color-accent)"/><rect x="14" y="14" width="1" height="1" fill="var(--color-primary)"/><rect x="2" y="15" width="1" height="1" fill="var(--color-primary)"/><rect x="4" y="15" width="1" height="1" fill="var(--color-accent)"/><rect x="7" y="15" width="2" height="1" fill="var(--color-primary-strong)"/><rect x="11" y="15" width="1" height="1" fill="var(--color-accent)"/><rect x="13" y="15" width="1" height="1" fill="var(--color-primary)"/><rect x="3" y="16" width="1" height="1" fill="var(--color-primary)"/><rect x="5" y="16" width="1" height="1" fill="var(--color-accent)"/><rect x="10" y="16" width="1" height="1" fill="var(--color-accent)"/><rect x="12" y="16" width="1" height="1" fill="var(--color-primary)"/><rect x="4" y="17" width="1" height="1" fill="var(--color-primary)"/><rect x="6" y="17" width="1" height="1" fill="var(--color-accent)"/><rect x="9" y="17" width="1" height="1" fill="var(--color-accent)"/><rect x="11" y="17" width="1" height="1" fill="var(--color-primary)"/><rect x="5" y="18" width="1" height="1" fill="var(--color-primary)"/><rect x="7" y="18" width="2" height="1" fill="var(--color-accent)"/><rect x="10" y="18" width="1" height="1" fill="var(--color-primary)"/><rect x="6" y="19" width="1" height="1" fill="var(--color-primary)"/><rect x="7" y="19" width="2" height="1" fill="var(--color-accent)"/><rect x="9" y="19" width="1" height="1" fill="var(--color-primary)"/><rect x="7" y="20" width="2" height="1" fill="var(--color-primary)"/></svg>`;

// C2: one fixed pixel-art glyph per CardType, purely decorative — the
// button's own text (the full card-type word) or, on the board, the cell's
// aria-label is what carries the accessible name. 12x12 grid drawn as
// outline / fill / highlight so each reads as a small illustration, not a
// flat symbol; warm tones (fire, lightning) vs cool (water, nature), all
// from existing colour tokens. Generated from ASCII pixel maps.
const CARD_TYPE_ICONS = {
  fire: `<svg viewBox="0 0 12 12" shape-rendering="crispEdges" aria-hidden="true" focusable="false"><rect x="6" y="0" width="1" height="1" fill="var(--color-accent-strong)"/><rect x="5" y="1" width="1" height="1" fill="var(--color-accent-strong)"/><rect x="6" y="1" width="1" height="1" fill="var(--color-accent)"/><rect x="7" y="1" width="1" height="1" fill="var(--color-accent-strong)"/><rect x="2" y="2" width="1" height="1" fill="var(--color-accent-strong)"/><rect x="5" y="2" width="1" height="1" fill="var(--color-accent-strong)"/><rect x="6" y="2" width="1" height="1" fill="var(--color-accent)"/><rect x="7" y="2" width="1" height="1" fill="var(--color-accent-strong)"/><rect x="10" y="2" width="1" height="1" fill="var(--color-accent-strong)"/><rect x="1" y="3" width="1" height="1" fill="var(--color-accent-strong)"/><rect x="2" y="3" width="1" height="1" fill="var(--color-accent)"/><rect x="3" y="3" width="1" height="1" fill="var(--color-accent-strong)"/><rect x="5" y="3" width="1" height="1" fill="var(--color-accent-strong)"/><rect x="6" y="3" width="2" height="1" fill="var(--color-accent)"/><rect x="8" y="3" width="1" height="1" fill="var(--color-accent-strong)"/><rect x="10" y="3" width="1" height="1" fill="var(--color-accent)"/><rect x="11" y="3" width="1" height="1" fill="var(--color-accent-strong)"/><rect x="1" y="4" width="1" height="1" fill="var(--color-accent-strong)"/><rect x="2" y="4" width="2" height="1" fill="var(--color-accent)"/><rect x="4" y="4" width="2" height="1" fill="var(--color-accent-strong)"/><rect x="6" y="4" width="3" height="1" fill="var(--color-accent)"/><rect x="9" y="4" width="1" height="1" fill="var(--color-accent-strong)"/><rect x="10" y="4" width="1" height="1" fill="var(--color-accent)"/><rect x="11" y="4" width="1" height="1" fill="var(--color-accent-strong)"/><rect x="1" y="5" width="1" height="1" fill="var(--color-accent-strong)"/><rect x="2" y="5" width="8" height="1" fill="var(--color-accent)"/><rect x="10" y="5" width="1" height="1" fill="var(--color-accent-strong)"/><rect x="0" y="6" width="1" height="1" fill="var(--color-accent-strong)"/><rect x="1" y="6" width="3" height="1" fill="var(--color-accent)"/><rect x="4" y="6" width="1" height="1" fill="#fff"/><rect x="5" y="6" width="2" height="1" fill="var(--color-accent)"/><rect x="7" y="6" width="1" height="1" fill="#fff"/><rect x="8" y="6" width="3" height="1" fill="var(--color-accent)"/><rect x="11" y="6" width="1" height="1" fill="var(--color-accent-strong)"/><rect x="0" y="7" width="1" height="1" fill="var(--color-accent-strong)"/><rect x="1" y="7" width="2" height="1" fill="var(--color-accent)"/><rect x="3" y="7" width="2" height="1" fill="#fff"/><rect x="5" y="7" width="2" height="1" fill="var(--color-accent)"/><rect x="7" y="7" width="2" height="1" fill="#fff"/><rect x="9" y="7" width="2" height="1" fill="var(--color-accent)"/><rect x="11" y="7" width="1" height="1" fill="var(--color-accent-strong)"/><rect x="0" y="8" width="1" height="1" fill="var(--color-accent-strong)"/><rect x="1" y="8" width="2" height="1" fill="var(--color-accent)"/><rect x="3" y="8" width="6" height="1" fill="#fff"/><rect x="9" y="8" width="2" height="1" fill="var(--color-accent)"/><rect x="11" y="8" width="1" height="1" fill="var(--color-accent-strong)"/><rect x="1" y="9" width="1" height="1" fill="var(--color-accent-strong)"/><rect x="2" y="9" width="2" height="1" fill="var(--color-accent)"/><rect x="4" y="9" width="4" height="1" fill="#fff"/><rect x="8" y="9" width="2" height="1" fill="var(--color-accent)"/><rect x="10" y="9" width="1" height="1" fill="var(--color-accent-strong)"/><rect x="2" y="10" width="1" height="1" fill="var(--color-accent-strong)"/><rect x="3" y="10" width="6" height="1" fill="var(--color-accent)"/><rect x="9" y="10" width="1" height="1" fill="var(--color-accent-strong)"/><rect x="3" y="11" width="6" height="1" fill="var(--color-accent-strong)"/></svg>`,
  lightning: `<svg viewBox="0 0 12 12" shape-rendering="crispEdges" aria-hidden="true" focusable="false"><rect x="6" y="0" width="5" height="1" fill="var(--color-accent-strong)"/><rect x="5" y="1" width="1" height="1" fill="var(--color-accent-strong)"/><rect x="6" y="1" width="1" height="1" fill="#fff"/><rect x="7" y="1" width="3" height="1" fill="color-mix(in srgb, var(--color-accent) 55%, #fff)"/><rect x="10" y="1" width="1" height="1" fill="var(--color-accent-strong)"/><rect x="4" y="2" width="1" height="1" fill="var(--color-accent-strong)"/><rect x="5" y="2" width="1" height="1" fill="#fff"/><rect x="6" y="2" width="2" height="1" fill="color-mix(in srgb, var(--color-accent) 55%, #fff)"/><rect x="8" y="2" width="1" height="1" fill="var(--color-accent-strong)"/><rect x="3" y="3" width="1" height="1" fill="var(--color-accent-strong)"/><rect x="4" y="3" width="1" height="1" fill="#fff"/><rect x="5" y="3" width="2" height="1" fill="color-mix(in srgb, var(--color-accent) 55%, #fff)"/><rect x="7" y="3" width="1" height="1" fill="var(--color-accent-strong)"/><rect x="2" y="4" width="1" height="1" fill="var(--color-accent-strong)"/><rect x="3" y="4" width="1" height="1" fill="#fff"/><rect x="4" y="4" width="2" height="1" fill="color-mix(in srgb, var(--color-accent) 55%, #fff)"/><rect x="6" y="4" width="4" height="1" fill="var(--color-accent-strong)"/><rect x="1" y="5" width="1" height="1" fill="var(--color-accent-strong)"/><rect x="2" y="5" width="1" height="1" fill="#fff"/><rect x="3" y="5" width="6" height="1" fill="color-mix(in srgb, var(--color-accent) 55%, #fff)"/><rect x="9" y="5" width="1" height="1" fill="var(--color-accent-strong)"/><rect x="1" y="6" width="5" height="1" fill="var(--color-accent-strong)"/><rect x="6" y="6" width="2" height="1" fill="color-mix(in srgb, var(--color-accent) 55%, #fff)"/><rect x="8" y="6" width="1" height="1" fill="var(--color-accent-strong)"/><rect x="4" y="7" width="1" height="1" fill="var(--color-accent-strong)"/><rect x="5" y="7" width="2" height="1" fill="color-mix(in srgb, var(--color-accent) 55%, #fff)"/><rect x="7" y="7" width="1" height="1" fill="var(--color-accent-strong)"/><rect x="3" y="8" width="1" height="1" fill="var(--color-accent-strong)"/><rect x="4" y="8" width="2" height="1" fill="color-mix(in srgb, var(--color-accent) 55%, #fff)"/><rect x="6" y="8" width="1" height="1" fill="var(--color-accent-strong)"/><rect x="2" y="9" width="1" height="1" fill="var(--color-accent-strong)"/><rect x="3" y="9" width="2" height="1" fill="color-mix(in srgb, var(--color-accent) 55%, #fff)"/><rect x="5" y="9" width="1" height="1" fill="var(--color-accent-strong)"/><rect x="2" y="10" width="1" height="1" fill="var(--color-accent-strong)"/><rect x="3" y="10" width="1" height="1" fill="color-mix(in srgb, var(--color-accent) 55%, #fff)"/><rect x="4" y="10" width="1" height="1" fill="var(--color-accent-strong)"/><rect x="2" y="11" width="2" height="1" fill="var(--color-accent-strong)"/></svg>`,
  water: `<svg viewBox="0 0 12 12" shape-rendering="crispEdges" aria-hidden="true" focusable="false"><rect x="5" y="0" width="2" height="1" fill="var(--color-primary-strong)"/><rect x="5" y="1" width="2" height="1" fill="var(--color-primary-strong)"/><rect x="4" y="2" width="1" height="1" fill="var(--color-primary-strong)"/><rect x="5" y="2" width="2" height="1" fill="var(--color-primary)"/><rect x="7" y="2" width="1" height="1" fill="var(--color-primary-strong)"/><rect x="4" y="3" width="1" height="1" fill="var(--color-primary-strong)"/><rect x="5" y="3" width="2" height="1" fill="var(--color-primary)"/><rect x="7" y="3" width="1" height="1" fill="var(--color-primary-strong)"/><rect x="3" y="4" width="1" height="1" fill="var(--color-primary-strong)"/><rect x="4" y="4" width="4" height="1" fill="var(--color-primary)"/><rect x="8" y="4" width="1" height="1" fill="var(--color-primary-strong)"/><rect x="2" y="5" width="1" height="1" fill="var(--color-primary-strong)"/><rect x="3" y="5" width="6" height="1" fill="var(--color-primary)"/><rect x="9" y="5" width="1" height="1" fill="var(--color-primary-strong)"/><rect x="1" y="6" width="1" height="1" fill="var(--color-primary-strong)"/><rect x="2" y="6" width="2" height="1" fill="#fff"/><rect x="4" y="6" width="6" height="1" fill="var(--color-primary)"/><rect x="10" y="6" width="1" height="1" fill="var(--color-primary-strong)"/><rect x="1" y="7" width="1" height="1" fill="var(--color-primary-strong)"/><rect x="2" y="7" width="1" height="1" fill="#fff"/><rect x="3" y="7" width="7" height="1" fill="var(--color-primary)"/><rect x="10" y="7" width="1" height="1" fill="var(--color-primary-strong)"/><rect x="1" y="8" width="1" height="1" fill="var(--color-primary-strong)"/><rect x="2" y="8" width="8" height="1" fill="var(--color-primary)"/><rect x="10" y="8" width="1" height="1" fill="var(--color-primary-strong)"/><rect x="1" y="9" width="1" height="1" fill="var(--color-primary-strong)"/><rect x="2" y="9" width="8" height="1" fill="var(--color-primary)"/><rect x="10" y="9" width="1" height="1" fill="var(--color-primary-strong)"/><rect x="2" y="10" width="1" height="1" fill="var(--color-primary-strong)"/><rect x="3" y="10" width="6" height="1" fill="var(--color-primary)"/><rect x="9" y="10" width="1" height="1" fill="var(--color-primary-strong)"/><rect x="3" y="11" width="6" height="1" fill="var(--color-primary-strong)"/></svg>`,
  nature: `<svg viewBox="0 0 12 12" shape-rendering="crispEdges" aria-hidden="true" focusable="false"><rect x="7" y="0" width="4" height="1" fill="var(--color-primary-strong)"/><rect x="5" y="1" width="2" height="1" fill="var(--color-primary-strong)"/><rect x="7" y="1" width="3" height="1" fill="var(--color-primary)"/><rect x="10" y="1" width="1" height="1" fill="var(--color-primary-strong)"/><rect x="4" y="2" width="1" height="1" fill="var(--color-primary-strong)"/><rect x="5" y="2" width="4" height="1" fill="var(--color-primary)"/><rect x="9" y="2" width="1" height="1" fill="var(--color-primary-subtle)"/><rect x="10" y="2" width="1" height="1" fill="var(--color-primary-strong)"/><rect x="3" y="3" width="1" height="1" fill="var(--color-primary-strong)"/><rect x="4" y="3" width="4" height="1" fill="var(--color-primary)"/><rect x="8" y="3" width="1" height="1" fill="var(--color-primary-subtle)"/><rect x="9" y="3" width="1" height="1" fill="var(--color-primary)"/><rect x="10" y="3" width="1" height="1" fill="var(--color-primary-strong)"/><rect x="2" y="4" width="1" height="1" fill="var(--color-primary-strong)"/><rect x="3" y="4" width="4" height="1" fill="var(--color-primary)"/><rect x="7" y="4" width="1" height="1" fill="var(--color-primary-subtle)"/><rect x="8" y="4" width="2" height="1" fill="var(--color-primary)"/><rect x="10" y="4" width="1" height="1" fill="var(--color-primary-strong)"/><rect x="2" y="5" width="1" height="1" fill="var(--color-primary-strong)"/><rect x="3" y="5" width="3" height="1" fill="var(--color-primary)"/><rect x="6" y="5" width="1" height="1" fill="var(--color-primary-subtle)"/><rect x="7" y="5" width="3" height="1" fill="var(--color-primary)"/><rect x="10" y="5" width="1" height="1" fill="var(--color-primary-strong)"/><rect x="1" y="6" width="1" height="1" fill="var(--color-primary-strong)"/><rect x="2" y="6" width="3" height="1" fill="var(--color-primary)"/><rect x="5" y="6" width="1" height="1" fill="var(--color-primary-subtle)"/><rect x="6" y="6" width="4" height="1" fill="var(--color-primary)"/><rect x="10" y="6" width="1" height="1" fill="var(--color-primary-strong)"/><rect x="1" y="7" width="1" height="1" fill="var(--color-primary-strong)"/><rect x="2" y="7" width="2" height="1" fill="var(--color-primary)"/><rect x="4" y="7" width="1" height="1" fill="var(--color-primary-subtle)"/><rect x="5" y="7" width="4" height="1" fill="var(--color-primary)"/><rect x="9" y="7" width="1" height="1" fill="var(--color-primary-strong)"/><rect x="1" y="8" width="1" height="1" fill="var(--color-primary-strong)"/><rect x="2" y="8" width="1" height="1" fill="var(--color-primary)"/><rect x="3" y="8" width="1" height="1" fill="var(--color-primary-subtle)"/><rect x="4" y="8" width="4" height="1" fill="var(--color-primary)"/><rect x="8" y="8" width="1" height="1" fill="var(--color-primary-strong)"/><rect x="1" y="9" width="1" height="1" fill="var(--color-primary-strong)"/><rect x="2" y="9" width="1" height="1" fill="var(--color-primary-subtle)"/><rect x="3" y="9" width="3" height="1" fill="var(--color-primary)"/><rect x="6" y="9" width="2" height="1" fill="var(--color-primary-strong)"/><rect x="0" y="10" width="6" height="1" fill="var(--color-primary-strong)"/><rect x="0" y="11" width="1" height="1" fill="var(--color-primary-strong)"/></svg>`,
};

function log(message) {
  logEl.textContent += message + "\n";
  logEl.scrollTop = logEl.scrollHeight;
}

// C1: visibility is a class toggle (index.html's .is-hidden) rather than an
// inline style.display, so layout rules can give these elements flex/grid
// display without JS overwriting it on every state change.
function setVisible(el, visible) {
  el.classList.toggle("is-hidden", !visible);
}

function setConnectionStatus(connected) {
  connectionStatusEl.classList.toggle("is-connected", connected);
  connectionStatusTextEl.textContent = connected ? "Connected" : "Disconnected";
}

// A single registry for "state tied to one match that must not survive past
// it" — a pending setTimeout/setInterval handle, or just a queued value like
// pendingComboAnimation. The "seriesEnded" handler below calls
// resetEphemeralUi() once rather than naming each one individually; each
// piece of ephemeral UI registers its own reset next to its own declaration
// instead. This replaces the previous shape (seriesEnded hand-enumerating
// combatEventTimeout/turnTimerInterval by name) that let a later addition —
// pendingComboAnimation — go unreset and leak a stale combo flash/damage-pop
// into the next match (code review, 2026-11-07): a future ephemeral timer or
// queued value is included automatically just by registering here, with
// nothing further to remember at this or any other call site.
const ephemeralUiResets = [];
function registerEphemeralUi(reset) {
  ephemeralUiResets.push(reset);
}
function resetEphemeralUi() {
  for (const reset of ephemeralUiResets) reset();
}

// Deliberately NOT registered with registerEphemeralUi below: unlike the
// combat-event banner/combo animation/turn timer, this one was never part of
// seriesEnded's teardown even before this registry existed (a rejection
// error can legitimately explain why the series just ended, e.g. a
// now-out-of-turn action — clearing it out from under that message would
// lose the very explanation a player might still be reading). Kept as a
// plain timeout, same as before.
let errorBannerTimeout = null;
function showError(message) {
  errorBanner.textContent = message;
  setVisible(errorBanner, true);
  clearTimeout(errorBannerTimeout);
  errorBannerTimeout = setTimeout(() => {
    setVisible(errorBanner, false);
  }, 5000);
}

// Combat Events: a one-shot cause/effect card for the Combo(s) a Play just
// resolved, built entirely from the server's own combatEvent message — this
// client never infers or recomputes Combo type/damage/effects itself (the
// server already did, in engine.ts's applyCombos). Fades on a fixed timeout,
// same pattern as showError above; a later state broadcast's own render()
// never depends on this banner, so it's safe to let it expire on its own
// clock.
const EFFECT_LABELS = { lightning: "Lightning", water: "Water", nature: "Nature", fire: "Fire" };
let combatEventTimeout = null;
registerEphemeralUi(() => {
  clearTimeout(combatEventTimeout);
  setVisible(combatEventBanner, false);
});
function showCombatEvent(event) {
  const whoActed = event.actingPlayer === myPlayer ? "You" : "Your opponent";
  const totalDamage =
    event.combos.reduce((sum, c) => sum + c.damage, 0) + event.fireBonusDamage;
  const comboWord = event.combos.length > 1 ? "combos" : "combo";
  const kinds = event.combos.map((c) => (c.ownerMatch ? "Owner" : "Type")).join(" + ");
  let text = `${whoActed} completed ${event.combos.length} ${kinds} ${comboWord} for ${totalDamage} damage.`;
  if (event.effectsApplied.length > 0) {
    const effectWords = event.effectsApplied.map((e) => EFFECT_LABELS[e]);
    text += ` Effect: ${effectWords.join(", ")}.`;
  }
  combatEventBanner.textContent = text;
  setVisible(combatEventBanner, true);
  clearTimeout(combatEventTimeout);
  combatEventTimeout = setTimeout(() => {
    setVisible(combatEventBanner, false);
  }, 4000);

  // Stage 4 (Combo Animation): this message always arrives BEFORE the
  // "state" broadcast for the same Play (server.ts's own ordering), so the
  // combo'd cells are already cleared by the time the NEXT render() rebuilds
  // the board from the new state — there is nothing left in `state.board`
  // at those coordinates to animate a "disappearing card" from. Rather than
  // reconstruct the pre-clear board just to animate it, this flashes the
  // now-empty cells themselves (still a correct "something happened here"
  // signal, driven entirely by the event's own coordinates, never
  // re-derived client-side) plus a floating damage number near the
  // defender's HP — queued here and consumed exactly once by the next
  // renderBoard() call, then cleared, so a later unrelated re-render (e.g.
  // a window resize forcing nothing to actually change) never replays it.
  pendingComboAnimation = event;
}

// One flash colour per effect, reusing this file's existing CSS tokens —
// never a new hue. A pure Owner Combo with no type match (effectsApplied
// empty) gets the neutral default border colour instead of a specific
// element tint.
const EFFECT_FLASH_CLASS = { lightning: "combo-flash--lightning", water: "combo-flash--water", nature: "combo-flash--nature", fire: "combo-flash--fire" };
let pendingComboAnimation = null;
registerEphemeralUi(() => {
  pendingComboAnimation = null;
});

const protocol = location.protocol === "https:" ? "wss:" : "ws:";
const ws = new WebSocket(`${protocol}//${location.host}/ws`);

ws.addEventListener("open", () => {
  log("[ws] connected");
  setConnectionStatus(true);
  setVisible(disconnectBanner, false);
  // A brand new session (never seated or queued before) gets no further
  // message from the server at all beyond "identity" — resolveSession's own
  // "status === new" branch (server.ts) deliberately sends nothing, since
  // the player hasn't expressed any intent yet. This is what makes the
  // lobby's "Join queue" button reachable for that case; every other status
  // (assigned/queued/waiting) overrides this immediately once its own
  // message arrives.
  statusLine.textContent = "Connected. Click \"Join queue\" to find a match.";
  setVisible(joinQueueBtn, true);
});
ws.addEventListener("close", () => {
  log("[ws] disconnected");
  // Visible, not just logged — per the stage 3 requirement that connection
  // state belongs somewhere a player will actually notice, not only in a
  // debug <pre>. The server's own disconnect-grace-period mechanism (see
  // docs/authorization.md / PROCESS.md Stage 8a) means a reload within the
  // grace window resumes the same seat, so the message says exactly that.
  setConnectionStatus(false);
  setVisible(disconnectBanner, true);
});
ws.addEventListener("error", () => log("[ws] error"));

ws.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);

  if (message.type === "identity") {
    identityEl.textContent = `You are ${message.displayId}`;
  } else if (message.type === "assigned") {
    myPlayer = message.player;
    setVisible(lobbyPanel, false);
    setVisible(gamePanel, true);
  } else if (message.type === "waiting") {
    setVisible(gamePanel, false);
    setVisible(lobbyPanel, true);
    setVisible(joinQueueBtn, false);
    statusLine.textContent = `You are Player ${myPlayer}. Waiting for the second player to join...`;
  } else if (message.type === "queued") {
    setVisible(lobbyPanel, true);
    setVisible(gamePanel, false);
    setVisible(joinQueueBtn, false);
    statusLine.textContent = "In queue — waiting for an opponent...";
  } else if (message.type === "combatEvent") {
    showCombatEvent(message.event);
  } else if (message.type === "state") {
    lastState = message.state;
    lastSeries = message.series;
    render();
  } else if (message.type === "seriesEnded") {
    myPlayer = null;
    lastState = null;
    lastSeries = null;
    // Tears down every piece of UI registered as tied to one match's
    // lifetime (combat-event banner, pending combo animation, turn timer) in
    // one call — see registerEphemeralUi's own comment for why this replaced
    // naming each one here individually.
    resetEphemeralUi();
    setVisible(gamePanel, false);
    setVisible(lobbyPanel, true);
    setVisible(joinQueueBtn, true);
    statusLine.textContent = describeSeriesEnded(message);
  } else if (message.type === "error") {
    log("[server error] " + message.message);
    showError(message.message);
  }
});

function describeSeriesEnded(message) {
  if (message.reason === "opponentDisconnected") {
    return "Your opponent disconnected and didn't return — you win the match by forfeit. Click \"Join queue\" for a new match.";
  }
  if (message.reason === "opponentForfeited") {
    return "Your opponent forfeited the match — you win. Click \"Join queue\" for a new match.";
  }
  if (message.reason === "forfeited") {
    return "You forfeited the match. Click \"Join queue\" for a new match.";
  }
  // "seriesConcluded": either a real 2-win finish, or a mutual mid-series
  // abandon (no winner) — distinguished by seriesWinner being null or set,
  // exactly as src/server/series.ts's own logic decides it server-side.
  const { gamesWon, seriesWinner } = message.series;
  const scoreText = `${gamesWon.A}-${gamesWon.B}`;
  const resultText = seriesWinner
    ? `Player ${seriesWinner} wins the match ${scoreText}!`
    : `The match ended with no winner (${scoreText}).`;
  return `${resultText} Click "Join queue" for a new match.`;
}

function send(message) {
  ws.send(JSON.stringify(message));
}

function render() {
  const state = lastState;
  const series = lastSeries;
  if (!state) return;

  const opponentId = myPlayer === "A" ? "B" : "A";
  const me = state.players[myPlayer];
  const opponent = state.players[opponentId];

  seriesScoreEl.textContent = series
    ? `You ${series.gamesWon[myPlayer]} — ${series.gamesWon[opponentId]} Opponent`
    : "";

  myHpEl.textContent = String(me.hp);
  oppHpEl.textContent = String(opponent.hp);
  myHpBarEl.style.width = hpBarWidth(me.hp);
  oppHpBarEl.style.width = hpBarWidth(opponent.hp);
  apDisplayEl.textContent = String(state.ap);

  renderTurnIndicator(state);
  renderTurnTimer(state, series);
  renderBoard(state);
  renderOpponentHand(opponent);
  renderHand(state, me);
  renderActionButtons(state);
  renderQuitPanel(state, opponentId);
  renderNewGamePanel(state, opponentId);
}

// Stage 2 (Turn Timer): display-only countdown to series.turnDeadline, the
// server's own authoritative value (see protocol.ts's own comment) — this
// client never decides a timeout itself, it only recomputes "how much of
// that server-sent deadline is left" once a second so the number keeps
// counting down between state broadcasts, not just at the moment one
// arrives. A stale interval is always cleared before a new one starts, so a
// rapid sequence of state messages (e.g. several AP-exhaustion auto-turns)
// never leaves more than one ticking at once.
let turnTimerInterval = null;
registerEphemeralUi(() => {
  clearInterval(turnTimerInterval);
  setVisible(turnTimerEl, false);
});
function renderTurnTimer(state, series) {
  clearInterval(turnTimerInterval);
  if (state.status !== "active" || !series || series.turnDeadline === null) {
    setVisible(turnTimerEl, false);
    return;
  }
  const tick = () => {
    const remainingMs = series.turnDeadline - Date.now();
    const remainingSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
    setVisible(turnTimerEl, true);
    turnTimerEl.textContent =
      state.currentPlayer === myPlayer
        ? `${remainingSeconds}s left to act`
        : `Opponent has ${remainingSeconds}s left`;
    turnTimerEl.classList.toggle("is-low", remainingSeconds <= 10);
    if (remainingMs <= 0) clearInterval(turnTimerInterval);
  };
  tick();
  turnTimerInterval = setInterval(tick, 1000);
}

function renderTurnIndicator(state) {
  // Styling hook only; the text itself still states whose turn it is.
  turnIndicatorEl.classList.toggle(
    "is-my-turn",
    state.status === "active" && state.currentPlayer === myPlayer,
  );
  if (state.status === "active") {
    turnIndicatorEl.textContent = state.currentPlayer === myPlayer ? "YOUR TURN" : "Opponent's turn";
    return;
  }
  if (state.status === "finished") {
    turnIndicatorEl.textContent =
      state.winner === myPlayer ? "You won this game!" : "You lost this game.";
  } else if (state.status === "locked") {
    turnIndicatorEl.textContent = "This game is locked — a full board with no winner.";
  } else if (state.status === "abandoned") {
    turnIndicatorEl.textContent = "This game was called off by agreement.";
  }
}

function renderBoard(state) {
  const size = state.board.length;
  const myTurn = state.status === "active" && state.currentPlayer === myPlayer;

  boardEl.innerHTML = "";
  boardEl.style.gridTemplateColumns = `repeat(${size}, var(--cell-size))`;

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const cell = state.board[r][c];
      const button = document.createElement("button");
      // A placed card shows only its type icon (same CARD_TYPE_ICONS as the
      // hand) with owner shown by the owner-a/owner-b class — the cell has
      // no room for text, so owner/type live in aria-label for anyone not
      // relying on the icon's shape/colour alone.
      if (cell) {
        button.innerHTML = CARD_TYPE_ICONS[cell.type];
        button.classList.add(cell.owner === "A" ? "owner-a" : "owner-b");
        button.setAttribute("aria-label", `Player ${cell.owner}'s ${cell.type} card`);
      } else {
        button.setAttribute("aria-label", "Empty cell");
      }
      // A filled cell, or it not being your turn, or no card selected yet,
      // all disable the button — the server would reject the action anyway
      // in every one of those cases, this just avoids sending a request that
      // can only fail.
      button.disabled = !myTurn || cell !== null || selectedHandIndex === null;
      // Purely the inverse of the disabled check above, for styling.
      button.classList.toggle("is-playable", !button.disabled);
      button.addEventListener("click", () => {
        send({ type: "play", handIndex: selectedHandIndex, row: r, col: c });
        selectedHandIndex = null;
        render();
      });
      boardEl.appendChild(button);
    }
  }

  playComboAnimation(size);
}

// Stage 4 (Combo Animation): consumes pendingComboAnimation exactly once —
// cleared immediately so a later unrelated re-render never replays it. The
// animated cells are read directly off the event's own combos[].cells
// (already-cleared-by-now coordinates, see showCombatEvent's own comment),
// never re-derived from board contents. One flash colour per combo, keyed
// by that combo's own sameType (null -> the neutral default, no specific
// element to attribute the flash to).
function playComboAnimation(renderedBoardSize) {
  const event = pendingComboAnimation;
  pendingComboAnimation = null;
  if (!event) return;
  // event.boardSize is the board size the combo's cells were computed
  // against (engine.ts's own applyCombos, captured before any same-Play
  // expand/shrink) — if that doesn't match the board size actually being
  // rendered now, the coordinates refer to a DIFFERENT grid than the one on
  // screen (e.g. a combo that completed just as the Main Board shrank back
  // to 3x3 in that same Play, see engine.test.ts's own confirmed case).
  // Skipping the animation entirely here is correct and safe: it would
  // otherwise risk flashing the wrong cells rather than the right ones, and
  // this is purely decorative — the combat-event banner's own text already
  // carries the full, correct information regardless.
  if (event.boardSize !== renderedBoardSize) return;

  for (const combo of event.combos) {
    const flashClass = combo.sameType ? EFFECT_FLASH_CLASS[combo.sameType] : "combo-flash";
    for (const [r, c] of combo.cells) {
      const index = r * renderedBoardSize + c;
      const button = boardEl.children[index];
      if (!button) continue;
      button.classList.add(flashClass);
      // Let the animation run once then clean up the class — a later
      // unrelated render() already rebuilds this button from scratch
      // anyway, so this is just tidiness for the in-between moment.
      button.addEventListener(
        "animationend",
        () => button.classList.remove(flashClass),
        { once: true },
      );
    }
  }

  const totalDamage = event.combos.reduce((sum, c) => sum + c.damage, 0) + event.fireBonusDamage;
  const defenderBarEl = event.actingPlayer === myPlayer ? oppHpBarEl : myHpBarEl;
  showDamagePop(defenderBarEl, totalDamage);
}

// A floating "-N" number near the defender's HP bar, purely decorative
// (aria-hidden — the combat-event banner's own text already carries the
// same number accessibly). Appended next to the bar, removed once its own
// CSS animation finishes; prefers-reduced-motion disables the float/fade
// keyframes (see index.html) but the element still appears and
// self-removes on a fixed timeout instead, so the number is never
// permanently lost, only its motion.
function showDamagePop(anchorEl, amount) {
  const pop = document.createElement("span");
  pop.className = "damage-pop";
  pop.textContent = `-${amount}`;
  pop.setAttribute("aria-hidden", "true");
  // anchorEl is the inner <span id="my-hp-bar"/"opp-hp-bar"> fill; its direct
  // parent is .hp-bar (overflow:hidden, 6px tall) which would clip the pop
  // entirely — .stat (one level further up) is the actual position:relative
  // anchor the CSS above targets.
  anchorEl.parentElement.parentElement.appendChild(pop);
  const remove = () => pop.remove();
  pop.addEventListener("animationend", remove, { once: true });
  setTimeout(remove, 1500); // fallback for prefers-reduced-motion (no animationend fires)
}

function renderOpponentHand(opponent) {
  oppHandCountEl.textContent = String(opponent.hand.length);
  opponentHandEl.innerHTML = "";
  // `opponent.hand.length` is the only thing read from the real hand here —
  // the loop body never looks at what's actually in it, so every back gets
  // the exact same fixed pattern regardless of hand contents (see
  // OPPONENT_CARD_BACK_SVG's own comment).
  for (let i = 0; i < opponent.hand.length; i++) {
    const back = document.createElement("span");
    back.className = "card-back";
    back.innerHTML = OPPONENT_CARD_BACK_SVG;
    opponentHandEl.appendChild(back);
  }
}

function renderHand(state, me) {
  const myTurn = state.status === "active" && state.currentPlayer === myPlayer;
  myHandCountEl.textContent = String(me.hand.length);
  handEl.innerHTML = "";
  me.hand.forEach((card, index) => {
    const button = document.createElement("button");
    // B2: icon is purely decorative (aria-hidden, see CARD_TYPE_ICONS'
    // own comment) — the trailing text node, the full card-type word
    // itself, is what still gives this button its accessible name, same
    // as before this stage. `card` (the server-sent CardType string) is
    // unchanged and still what's read on click below.
    button.innerHTML = CARD_TYPE_ICONS[card];
    button.appendChild(document.createTextNode(card));
    button.classList.toggle("selected", index === selectedHandIndex);
    button.setAttribute("aria-pressed", String(index === selectedHandIndex));
    button.disabled = !myTurn;
    button.addEventListener("click", () => {
      selectedHandIndex = index;
      render();
      // render() rebuilt the hand, dropping focus; keep keyboard users on
      // the card they just picked instead of resetting to the page start.
      handEl.children[index]?.focus();
    });
    handEl.appendChild(button);
  });
}

// Stage 3 (Hand Limit): mirrors engine.ts's own MAX_HAND_SIZE. Display-only
// and disables the Draw button purely as a courtesy — the server rejects an
// over-cap Draw regardless, same as every other illegal-action guard this
// client already treats as advisory only (see this file's own top comment).
const MAX_HAND_SIZE = 5;

function renderActionButtons(state) {
  const myTurn = state.status === "active" && state.currentPlayer === myPlayer;
  const handFull = state.players[myPlayer].hand.length >= MAX_HAND_SIZE;
  drawBtn.disabled = !myTurn || handFull;
  endTurnBtn.disabled = !myTurn;
  forfeitBtn.disabled = state.status !== "active";
}

function renderQuitPanel(state, opponentId) {
  if (state.status !== "active") {
    setVisible(quitPanel, false);
    return;
  }
  setVisible(quitPanel, true);

  const myOffer = state.quitRequested[myPlayer];
  const theirOffer = state.quitRequested[opponentId];

  setVisible(requestQuitBtn, !myOffer && !theirOffer);
  setVisible(cancelQuitBtn, myOffer);
  setVisible(acceptQuitBtn, theirOffer && !myOffer);
  setVisible(declineQuitBtn, theirOffer && !myOffer);

  if (myOffer) {
    quitStatusEl.textContent = "You offered to end this game early — waiting for your opponent.";
  } else if (theirOffer) {
    quitStatusEl.textContent = "Your opponent wants to end this game early.";
  } else {
    quitStatusEl.textContent = "";
  }
}

function renderNewGamePanel(state, opponentId) {
  if (state.status === "active") {
    setVisible(newGamePanel, false);
    return;
  }
  setVisible(newGamePanel, true);
  const myConfirm = state.restartConfirmed[myPlayer];
  const theirConfirm = state.restartConfirmed[opponentId];
  newGameBtn.disabled = myConfirm;
  if (myConfirm && !theirConfirm) {
    newGameStatusEl.textContent = "Waiting for your opponent to confirm the next game...";
  } else if (!myConfirm && theirConfirm) {
    newGameStatusEl.textContent = "Your opponent is ready for the next game.";
  } else {
    newGameStatusEl.textContent = "";
  }
}

joinQueueBtn.addEventListener("click", () => send({ type: "joinQueue" }));
drawBtn.addEventListener("click", () => send({ type: "draw" }));
endTurnBtn.addEventListener("click", () => send({ type: "endTurn" }));
newGameBtn.addEventListener("click", () => send({ type: "confirmNewGame" }));
requestQuitBtn.addEventListener("click", () => send({ type: "requestQuit" }));
cancelQuitBtn.addEventListener("click", () => send({ type: "rejectQuit" }));
acceptQuitBtn.addEventListener("click", () => send({ type: "requestQuit" }));
declineQuitBtn.addEventListener("click", () => send({ type: "rejectQuit" }));
forfeitBtn.addEventListener("click", () => {
  if (confirm("Forfeit the whole match? Your opponent wins immediately.")) {
    send({ type: "forfeitSeries" });
  }
});
