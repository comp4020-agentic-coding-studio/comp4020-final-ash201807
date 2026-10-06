// Plain JS, no build step, no framework — this is a debug client for
// manually verifying realtime sync and persistence, not the real UI.
let selectedHandIndex = null;
let myPlayer = null;
let lastState = null;

const statusEl = document.getElementById("status");
const boardEl = document.getElementById("board");
const handEl = document.getElementById("hand");
const logEl = document.getElementById("log");

function log(message) {
  logEl.textContent += message + "\n";
}

const protocol = location.protocol === "https:" ? "wss:" : "ws:";
const ws = new WebSocket(`${protocol}//${location.host}/ws`);

ws.addEventListener("open", () => log("[ws] connected"));
ws.addEventListener("close", () => log("[ws] disconnected"));
ws.addEventListener("error", () => log("[ws] error"));

ws.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);

  if (message.type === "assigned") {
    myPlayer = message.player;
  } else if (message.type === "waiting") {
    statusEl.textContent = `You are Player ${myPlayer}. Waiting for the second player to join...`;
  } else if (message.type === "full") {
    statusEl.textContent = "Game is full.";
    boardEl.textContent = "";
    handEl.textContent = "";
  } else if (message.type === "state") {
    lastState = message.state;
    render(lastState);
  } else if (message.type === "error") {
    log("[server error] " + message.message);
  }
});

function send(message) {
  ws.send(JSON.stringify(message));
}

function render(state) {
  const size = state.board.length;

  boardEl.innerHTML = "";
  boardEl.style.display = "grid";
  boardEl.style.gridTemplateColumns = `repeat(${size}, 48px)`;
  boardEl.style.gap = "2px";

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const cell = state.board[r][c];
      const button = document.createElement("button");
      button.style.width = "48px";
      button.style.height = "48px";
      button.textContent = cell ? `${cell.owner}:${cell.type.slice(0, 2)}` : "";
      button.addEventListener("click", () => {
        if (selectedHandIndex === null) {
          log("select a hand card first");
          return;
        }
        send({ type: "play", handIndex: selectedHandIndex, row: r, col: c });
        selectedHandIndex = null;
      });
      boardEl.appendChild(button);
    }
  }

  const opponentId = myPlayer === "A" ? "B" : "A";
  const me = state.players[myPlayer];
  const opponent = state.players[opponentId];

  handEl.innerHTML = "";
  me.hand.forEach((card, index) => {
    const button = document.createElement("button");
    button.textContent = card;
    button.style.fontWeight = index === selectedHandIndex ? "bold" : "normal";
    button.addEventListener("click", () => {
      selectedHandIndex = index;
      render(state);
    });
    handEl.appendChild(button);
  });

  const turnInfo = state.currentPlayer === myPlayer ? "YOUR TURN" : "opponent's turn";
  let text =
    `You are Player ${myPlayer} | HP you:${me.hp} opp:${opponent.hp} | ` +
    `AP:${state.ap} | ${turnInfo} | status:${state.status}`;
  if (state.winner) text += ` | winner:${state.winner}`;
  if (state.status !== "active") {
    text += ` | New Game confirmed — you:${state.restartConfirmed[myPlayer]} opponent:${state.restartConfirmed[opponentId]}`;
  }
  statusEl.textContent = text;
}

document.getElementById("draw-btn").addEventListener("click", () => send({ type: "draw" }));
document.getElementById("endturn-btn").addEventListener("click", () => send({ type: "endTurn" }));
document.getElementById("newgame-btn").addEventListener("click", () => send({ type: "confirmNewGame" }));
