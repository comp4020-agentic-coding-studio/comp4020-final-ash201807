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
const boardEl = document.getElementById("board");
const oppHandCountEl = document.getElementById("opp-hand-count");
const opponentHandEl = document.getElementById("opponent-hand");
const handEl = document.getElementById("hand");
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

function log(message) {
  logEl.textContent += message + "\n";
  logEl.scrollTop = logEl.scrollHeight;
}

let errorBannerTimeout = null;
function showError(message) {
  errorBanner.textContent = message;
  errorBanner.style.display = "block";
  clearTimeout(errorBannerTimeout);
  errorBannerTimeout = setTimeout(() => {
    errorBanner.style.display = "none";
  }, 5000);
}

const protocol = location.protocol === "https:" ? "wss:" : "ws:";
const ws = new WebSocket(`${protocol}//${location.host}/ws`);

ws.addEventListener("open", () => {
  log("[ws] connected");
  disconnectBanner.style.display = "none";
  // A brand new session (never seated or queued before) gets no further
  // message from the server at all beyond "identity" — resolveSession's own
  // "status === new" branch (server.ts) deliberately sends nothing, since
  // the player hasn't expressed any intent yet. This is what makes the
  // lobby's "Join queue" button reachable for that case; every other status
  // (assigned/queued/waiting) overrides this immediately once its own
  // message arrives.
  statusLine.textContent = "Connected. Click \"Join queue\" to find a match.";
  joinQueueBtn.style.display = "inline-block";
});
ws.addEventListener("close", () => {
  log("[ws] disconnected");
  // Visible, not just logged — per the stage 3 requirement that connection
  // state belongs somewhere a player will actually notice, not only in a
  // debug <pre>. The server's own disconnect-grace-period mechanism (see
  // docs/authorization.md / PROCESS.md Stage 8a) means a reload within the
  // grace window resumes the same seat, so the message says exactly that.
  disconnectBanner.style.display = "block";
});
ws.addEventListener("error", () => log("[ws] error"));

ws.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);

  if (message.type === "identity") {
    identityEl.textContent = `You are ${message.displayId}`;
  } else if (message.type === "assigned") {
    myPlayer = message.player;
    lobbyPanel.style.display = "none";
    gamePanel.style.display = "";
  } else if (message.type === "waiting") {
    gamePanel.style.display = "none";
    lobbyPanel.style.display = "";
    joinQueueBtn.style.display = "none";
    statusLine.textContent = `You are Player ${myPlayer}. Waiting for the second player to join...`;
  } else if (message.type === "queued") {
    lobbyPanel.style.display = "";
    gamePanel.style.display = "none";
    joinQueueBtn.style.display = "none";
    statusLine.textContent = "In queue — waiting for an opponent...";
  } else if (message.type === "state") {
    lastState = message.state;
    lastSeries = message.series;
    render();
  } else if (message.type === "seriesEnded") {
    myPlayer = null;
    lastState = null;
    lastSeries = null;
    gamePanel.style.display = "none";
    lobbyPanel.style.display = "";
    joinQueueBtn.style.display = "";
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
    ? `Match score — you: ${series.gamesWon[myPlayer]}  opponent: ${series.gamesWon[opponentId]}`
    : "";

  myHpEl.textContent = `Your HP: ${me.hp}`;
  oppHpEl.textContent = `Opponent HP: ${opponent.hp}`;
  apDisplayEl.textContent = `AP: ${state.ap}`;

  renderTurnIndicator(state);
  renderBoard(state);
  renderOpponentHand(opponent);
  renderHand(state, me);
  renderActionButtons(state);
  renderQuitPanel(state, opponentId);
  renderNewGamePanel(state, opponentId);
}

function renderTurnIndicator(state) {
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
  boardEl.style.gridTemplateColumns = `repeat(${size}, 52px)`;

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const cell = state.board[r][c];
      const button = document.createElement("button");
      button.textContent = cell ? `${cell.owner}:${cell.type.slice(0, 2)}` : "";
      // A filled cell, or it not being your turn, or no card selected yet,
      // all disable the button — the server would reject the action anyway
      // in every one of those cases, this just avoids sending a request that
      // can only fail.
      button.disabled = !myTurn || cell !== null || selectedHandIndex === null;
      button.addEventListener("click", () => {
        send({ type: "play", handIndex: selectedHandIndex, row: r, col: c });
        selectedHandIndex = null;
        render();
      });
      boardEl.appendChild(button);
    }
  }
}

function renderOpponentHand(opponent) {
  oppHandCountEl.textContent = String(opponent.hand.length);
  opponentHandEl.innerHTML = "";
  for (let i = 0; i < opponent.hand.length; i++) {
    const back = document.createElement("span");
    back.className = "card-back";
    opponentHandEl.appendChild(back);
  }
}

function renderHand(state, me) {
  const myTurn = state.status === "active" && state.currentPlayer === myPlayer;
  handEl.innerHTML = "";
  me.hand.forEach((card, index) => {
    const button = document.createElement("button");
    button.textContent = card;
    button.style.fontWeight = index === selectedHandIndex ? "bold" : "normal";
    button.disabled = !myTurn;
    button.addEventListener("click", () => {
      selectedHandIndex = index;
      render();
    });
    handEl.appendChild(button);
  });
}

function renderActionButtons(state) {
  const myTurn = state.status === "active" && state.currentPlayer === myPlayer;
  drawBtn.disabled = !myTurn;
  endTurnBtn.disabled = !myTurn;
  forfeitBtn.disabled = state.status !== "active";
}

function renderQuitPanel(state, opponentId) {
  if (state.status !== "active") {
    quitPanel.style.display = "none";
    return;
  }
  quitPanel.style.display = "block";

  const myOffer = state.quitRequested[myPlayer];
  const theirOffer = state.quitRequested[opponentId];

  requestQuitBtn.style.display = !myOffer && !theirOffer ? "inline-block" : "none";
  cancelQuitBtn.style.display = myOffer ? "inline-block" : "none";
  acceptQuitBtn.style.display = theirOffer && !myOffer ? "inline-block" : "none";
  declineQuitBtn.style.display = theirOffer && !myOffer ? "inline-block" : "none";

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
    newGamePanel.style.display = "none";
    return;
  }
  newGamePanel.style.display = "block";
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
