import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js";

import {
  ref, get, set, update, remove, onValue, runTransaction
} from "https://www.gstatic.com/firebasejs/12.4.0/firebase-database.js";

import { auth, authReady, db } from "./firebase.js";

const $ = id => document.getElementById(id);

const MAX_PLAYERS = 12;
const MIN_PLAYERS = 5;
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;
const MAX_COMPRESSED_LENGTH = 35000;

const ALLOWED_IMAGE_TYPES = [
  "image/jpeg", "image/png", "image/gif", "image/webp"
];

const TEAM_SIZES = {
  5: [2, 3, 2, 3, 3],
  6: [2, 3, 4, 3, 4],
  7: [2, 3, 3, 4, 4],
  8: [3, 4, 4, 5, 5],
  9: [3, 4, 4, 5, 5],
  10: [3, 4, 4, 5, 5],
  11: [3, 4, 4, 5, 6],
  12: [3, 4, 5, 6, 6]
};

let currentUser = null;
let currentProfile = null;
let currentRoomCode = null;
let currentRoom = null;
let currentSecret = null;

let selectedRegisterFile = null;
let selectedProfileFile = null;
let stopRoomListener = null;
let busy = false;
let profileSetupMode = false;
let authStateVersion = 0;

let loadedSecretFor = null;
let loadingSecretFor = null;
let secretLoadVersion = 0;

let selectedTeam = new Set();
let missionMessage = "";
let missionMessageType = "";

const registerSubmitButton =
  $("register-form").querySelector("button[type='submit']");

const originalRegisterButtonText =
  registerSubmitButton?.textContent || "Create account";

/* -------------------------------------------------------
   SIMPLE, FIXED-SCREEN GAME INTERFACE
------------------------------------------------------- */


function installGameInterface() {
  if ($("mission-panel")) return;

  const oracle = document.createElement("section");
  oracle.id = "oracle-bonus-card";
  oracle.className = "oracle-bonus";
  oracle.hidden = true;
  oracle.innerHTML = `
    <h3>🔮 Your bonus: The Oracle</h3>
    <p>
      Your main role is Townsperson, just like the other Townspeople.
      Your exclusive bonus is that you know who the Witches are.
      Keep this information secret and use it to help the Town.
    </p>
    <div id="oracle-witch-list"></div>
  `;

  $("role-card").insertAdjacentElement("afterend", oracle);

  const controls = document.createElement("section");
  controls.id = "host-page-controls";
  controls.className = "host-page-controls";
  controls.hidden = true;
  controls.innerHTML = `
    <p id="host-page-hint">
      Wait until everyone has had a chance to view their role.
    </p>
    <button id="host-continue-button" type="button">
      Begin team selection
    </button>
  `;

  oracle.insertAdjacentElement("afterend", controls);

  const panel = document.createElement("section");
  panel.id = "mission-panel";
  panel.className = "mission-panel";
  panel.hidden = true;
  panel.setAttribute("aria-live", "polite");
  panel.innerHTML = `
    <div class="mission-topline">
      <span id="mission-round">MISSION 1 OF 5</span>
      <span id="mission-phase">Preparing</span>
    </div>
    <div id="mission-content"></div>
    <p id="mission-message" class="mission-message" role="status"></p>
  `;

  controls.insertAdjacentElement("afterend", panel);

  $("host-continue-button").addEventListener("click", advanceGamePage);
}

installGameInterface();

/* -------------------------------------------------------
   GENERAL HELPERS
------------------------------------------------------- */

function setProfileSetupMode(enabled) {
  profileSetupMode = enabled;

  $("register-email").disabled = enabled;
  $("register-password").disabled = enabled;
  $("register-email").required = !enabled;
  $("register-password").required = !enabled;

  if (registerSubmitButton) {
    registerSubmitButton.textContent = enabled
      ? "Finish profile setup"
      : originalRegisterButtonText;
  }
}

function showScreen(screenId) {
  [
    "auth-screen", "home-screen", "lobby-screen", "game-screen"
  ].forEach(id => {
    $(id).hidden = id !== screenId;
  });
}

function setMessage(id, message = "", type = "") {
  const element = $(id);
  element.textContent = message;
  element.className = `message ${type}`.trim();
}

function setConnection(message) {
  $("connection-status").textContent = message;
}

function setBusy(value) {
  busy = value;

  document.querySelectorAll(
    "#login-form button[type='submit'], " +
    "#register-form button[type='submit'], " +
    "#profile-form button[type='submit'], " +
    "#join-form button[type='submit'], " +
    "#create-room, #start-game"
  ).forEach(button => {
    button.disabled = value;
  });

  if (!value && currentRoom?.status === "lobby") renderLobby();
  if (!value && currentRoom?.status === "playing") {
    renderGamePage();
  }
}

function cleanName(value) {
  return value.trim().replace(/\s+/g, " ").slice(0, 20);
}

function normaliseCode(value) {
  return value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);
}

function randomCode() {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  return Array.from({ length: 4 }, () =>
    letters[Math.floor(Math.random() * letters.length)]
  ).join("");
}

function shuffled(items) {
  const result = [...items];

  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }

  return result;
}

function friendlyError(error) {
  const messages = {
    "auth/invalid-credential": "Your email or password is incorrect.",
    "auth/email-already-in-use": "An account already uses that email.",
    "auth/invalid-email": "Enter a valid email address.",
    "auth/weak-password": "Your password must be at least 6 characters.",
    "auth/too-many-requests": "Too many attempts. Please wait and try again.",
    "auth/network-request-failed": "Check your internet connection.",
    "PERMISSION_DENIED": "Firebase denied access. Check your database rules.",
    "database/permission-denied": "Firebase denied access. Check your database rules."
  };

  if (messages[error?.code]) return messages[error.code];

  if (error?.message?.includes("PERMISSION_DENIED")) {
    return "Firebase denied access. Check your published database rules.";
  }

  return error?.message || "Something went wrong.";
}

function missionError(message) {
  missionMessage = message;
  missionMessageType = "error";
  renderMission();
}

function missionSuccess(message) {
  missionMessage = message;
  missionMessageType = "success";
  renderMission();
}

function getPlayers() {
  return Object.entries(currentRoom?.players || {})
    .sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0));
}

function getPlayerName(uid) {
  return currentRoom?.players?.[uid]?.displayName || "Player";
}

function getTeamSize(playerCount, round) {
  const schedule = TEAM_SIZES[playerCount] || TEAM_SIZES[12];
  return schedule[Math.min(Math.max(round - 1, 0), schedule.length - 1)];
}

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;",
    '"': "&quot;", "'": "&#39;"
  })[character]);
}

function avatarMarkup(player, className = "mission-team-avatar") {
  const url = player?.avatarUrl || player?.avatar;

  if (typeof url === "string" && url.startsWith("data:image/")) {
    return `<div class="${className}"><img src="${url}" alt=""></div>`;
  }

  return `<div class="${className}">👤</div>`;
}

/* -------------------------------------------------------
   PROFILE PICTURES
------------------------------------------------------- */

function validateImage(file) {
  if (!file) throw new Error("Please choose a profile picture.");

  if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
    throw new Error("Choose a JPG, PNG, GIF or WebP image.");
  }

  if (file.size > MAX_IMAGE_SIZE) {
    throw new Error("Your original image must be 5 MB or smaller.");
  }
}

async function uploadAvatar(file) {
  validateImage(file);

  const objectUrl = URL.createObjectURL(file);

  try {
    const image = new Image();
    image.src = objectUrl;

    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error("Couldn't open that picture."));
    });

    const width = image.naturalWidth;
    const height = image.naturalHeight;
    const cropSize = Math.min(width, height);
    const sourceX = (width - cropSize) / 2;
    const sourceY = (height - cropSize) / 2;

    for (const attempt of [
      { size: 128, quality: .68 },
      { size: 128, quality: .58 },
      { size: 112, quality: .55 },
      { size: 96, quality: .50 }
    ]) {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = attempt.size;

      const context = canvas.getContext("2d");
      if (!context) throw new Error("Couldn't process that picture.");

      context.fillStyle = "#fff";
      context.fillRect(0, 0, attempt.size, attempt.size);
      context.drawImage(
        image, sourceX, sourceY, cropSize, cropSize,
        0, 0, attempt.size, attempt.size
      );

      const dataUrl = canvas.toDataURL("image/jpeg", attempt.quality);
      if (dataUrl.length <= MAX_COMPRESSED_LENGTH) return dataUrl;
    }

    throw new Error("Try a simpler picture; this one couldn't be compressed enough.");
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function showPhotoPreview(containerId, fileOrUrl) {
  const container = $(containerId);
  container.replaceChildren();

  if (!fileOrUrl) {
    const placeholder = document.createElement("span");
    placeholder.className = "photo-placeholder";
    placeholder.textContent = "Choose a photo";
    container.appendChild(placeholder);
    return;
  }

  const image = document.createElement("img");
  image.alt = "Profile picture preview";
  image.className = "profile-photo";
  image.src = fileOrUrl instanceof File
    ? URL.createObjectURL(fileOrUrl)
    : fileOrUrl;

  image.onerror = () => {
    container.textContent = "Image unavailable";
  };

  container.appendChild(image);
}

function showAvatar(container, photoUrl) {
  container.replaceChildren();

  if (photoUrl && typeof photoUrl === "string") {
    const image = document.createElement("img");
    image.className = "profile-photo";
    image.alt = "Player profile picture";
    image.src = photoUrl;
    image.onerror = () => { container.textContent = "👤"; };
    container.appendChild(image);
  } else {
    const fallback = document.createElement("span");
    fallback.className = "photo-placeholder";
    fallback.textContent = "👤";
    container.appendChild(fallback);
  }
}

function connectPhotoPicker(fileInputId, cameraInputId, previewId, onSelect) {
  [fileInputId, cameraInputId].forEach(id => {
    $(id).addEventListener("change", event => {
      const file = event.target.files?.[0];
      if (!file) return;

      try {
        validateImage(file);
        onSelect(file);
        showPhotoPreview(previewId, file);
        setMessage(
          previewId === "register-avatar-preview"
            ? "auth-message" : "home-message"
        );
      } catch (error) {
        setMessage(
          previewId === "register-avatar-preview"
            ? "auth-message" : "home-message",
          error.message,
          "error"
        );
      }

      event.target.value = "";
    });
  });
}

connectPhotoPicker(
  "register-avatar-file", "register-camera-file",
  "register-avatar-preview", file => { selectedRegisterFile = file; }
);

connectPhotoPicker(
  "profile-avatar-file", "profile-camera-file",
  "profile-avatar-preview", file => { selectedProfileFile = file; }
);

/* -------------------------------------------------------
   PLAYER PROFILES
------------------------------------------------------- */

function validProfile(name, profile) {
  const avatar = profile?.avatarUrl || profile?.avatar;
  return typeof name === "string" &&
    name.trim().length >= 1 &&
    name.trim().length <= 20 &&
    typeof avatar === "string" &&
    avatar.length > 0;
}

async function updateRoomPlayerProfile(profile) {
  if (!currentRoomCode || !currentUser) return;

  await update(ref(
    db, `rooms/${currentRoomCode}/players/${currentUser.uid}`
  ), {
    displayName: profile.displayName,
    avatarUrl: profile.avatarUrl || profile.avatar || null
  });
}

async function saveProfile(name, file = null) {
  if (!currentUser) throw new Error("You must be logged in.");

  const displayName = cleanName(name);
  if (!displayName) throw new Error("Enter a player name of 1–20 characters.");

  let avatarUrl = currentProfile?.avatarUrl || currentProfile?.avatar || null;
  if (file) avatarUrl = await uploadAvatar(file);
  if (!avatarUrl) throw new Error("Please choose a profile picture.");

  const profile = { displayName, avatarUrl, updatedAt: Date.now() };

  await set(ref(db, `users/${currentUser.uid}`), profile);
  currentProfile = profile;

  await updateRoomPlayerProfile(profile);
  renderHomeProfile();
}

function renderHomeProfile() {
  if (!currentProfile) return;

  $("home-name").textContent = currentProfile.displayName || "Player";
  showAvatar($("home-avatar"), currentProfile.avatarUrl || currentProfile.avatar);
  $("profile-name").value = currentProfile.displayName || "";

  if (!selectedProfileFile) {
    showPhotoPreview(
      "profile-avatar-preview",
      currentProfile.avatarUrl || currentProfile.avatar || null
    );
  }
}

async function loadProfile(user) {
  const snapshot = await get(ref(db, `users/${user.uid}`));

  if (!snapshot.exists()) {
    currentProfile = null;
    setProfileSetupMode(true);

    $("register-form").reset();
    $("register-email").value = user.email || "";
    $("register-email").disabled = true;
    $("register-password").value = "";
    $("register-password").disabled = true;

    selectedRegisterFile = null;
    showPhotoPreview("register-avatar-preview", null);

    $("login-form").hidden = true;
    $("register-form").hidden = false;
    $("show-login").hidden = false;
    $("show-register").hidden = false;
    $("show-login").classList.remove("active");
    $("show-register").classList.add("active");

    showScreen("auth-screen");
    setMessage(
      "auth-message",
      "Choose a player name and picture to finish setting up your account."
    );
    setConnection("Profile setup required");
    return;
  }

  const profile = snapshot.val();
  if (!validProfile(profile.displayName, profile)) {
    throw new Error("Your saved profile is incomplete. Please finish setting it up.");
  }

  if (!profile.avatarUrl && profile.avatar) profile.avatarUrl = profile.avatar;

  setProfileSetupMode(false);
  currentProfile = profile;

  $("login-form").hidden = false;
  $("register-form").hidden = true;
  $("show-login").hidden = false;
  $("show-register").hidden = false;

  renderHomeProfile();
  showScreen("home-screen");
  setConnection("Connected");
}

/* -------------------------------------------------------
   LOGIN AND REGISTRATION
------------------------------------------------------- */

async function switchAuthTab(register) {
  if (busy) return;

  if (!register && profileSetupMode && auth.currentUser) {
    setProfileSetupMode(false);
    await signOut(auth);
    return;
  }

  if (!auth.currentUser) setProfileSetupMode(false);

  $("login-form").hidden = register;
  $("register-form").hidden = !register;
  $("show-login").classList.toggle("active", !register);
  $("show-register").classList.toggle("active", register);
  $("show-login").hidden = false;
  $("show-register").hidden = false;
  setMessage("auth-message");
}

$("show-login").addEventListener("click", () => switchAuthTab(false));
$("show-register").addEventListener("click", () => switchAuthTab(true));

$("register-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (busy) return;

  const name = cleanName($("register-name").value);
  const email = $("register-email").value.trim();
  const password = $("register-password").value;

  if (!name) {
    setMessage("auth-message", "Enter a player name.", "error");
    return;
  }

  if (!selectedRegisterFile) {
    setMessage("auth-message", "Choose or take a profile picture.", "error");
    return;
  }

  try {
    validateImage(selectedRegisterFile);
  } catch (error) {
    setMessage("auth-message", error.message, "error");
    return;
  }

  setBusy(true);

  try {
    await authReady;

    if (profileSetupMode) {
      if (!auth.currentUser) throw new Error("Your session has expired.");
      currentUser = auth.currentUser;
    } else {
      const credential = await createUserWithEmailAndPassword(auth, email, password);
      currentUser = credential.user;
    }

    const profile = {
      displayName: name,
      avatarUrl: await uploadAvatar(selectedRegisterFile),
      updatedAt: Date.now()
    };

    await set(ref(db, `users/${currentUser.uid}`), profile);

    currentProfile = profile;
    selectedRegisterFile = null;
    setProfileSetupMode(false);
    $("register-form").reset();

    $("login-form").hidden = false;
    $("register-form").hidden = true;
    $("show-login").hidden = false;
    $("show-register").hidden = false;

    renderHomeProfile();
    showScreen("home-screen");
    setMessage("home-message", "Your account is ready!", "success");
    setConnection("Connected");
  } catch (error) {
    setMessage("auth-message", friendlyError(error), "error");
  } finally {
    setBusy(false);
  }
});

$("login-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (busy) return;

  setBusy(true);
  try {
    await authReady;
    await signInWithEmailAndPassword(
      auth,
      $("login-email").value.trim(),
      $("login-password").value
    );
  } catch (error) {
    setMessage("auth-message", friendlyError(error), "error");
  } finally {
    setBusy(false);
  }
});

/* -------------------------------------------------------
   ROOM CREATION AND JOINING
------------------------------------------------------- */

async function createRoom() {
  if (busy || !currentUser || !currentProfile) return;

  setBusy(true);
  setMessage("home-message", "Creating your room...");

  try {
    for (let attempt = 0; attempt < 10; attempt++) {
      const code = randomCode();

      const result = await runTransaction(
        ref(db, `rooms/${code}`),
        existing => existing !== null ? undefined : {
          code,
          hostUid: currentUser.uid,
          status: "lobby",
          createdAt: Date.now(),
          players: {
            [currentUser.uid]: {
              displayName: currentProfile.displayName,
              avatarUrl: currentProfile.avatarUrl || currentProfile.avatar || null,
              joinedAt: Date.now()
            }
          }
        },
        { applyLocally: false }
      );

      if (result.committed) {
        enterRoom(code);
        return;
      }
    }

    throw new Error("Couldn't find an available room code. Try again.");
  } catch (error) {
    setMessage("home-message", friendlyError(error), "error");
  } finally {
    setBusy(false);
  }
}

$("create-room").addEventListener("click", createRoom);

$("join-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (busy || !currentUser || !currentProfile) return;

  const code = normaliseCode($("room-code").value);
  $("room-code").value = code;

  if (code.length !== 4) {
    setMessage("home-message", "Enter a four-letter room code.", "error");
    return;
  }

  setBusy(true);

  try {
    const snapshot = await get(ref(db, `rooms/${code}`));
    if (!snapshot.exists()) throw new Error("That room doesn't exist.");

    const room = snapshot.val();
    if (room.status !== "lobby") throw new Error("That game has already started.");

    const players = room.players || {};
    if (!players[currentUser.uid] && Object.keys(players).length >= MAX_PLAYERS) {
      throw new Error("That room is full.");
    }

    await set(ref(db, `rooms/${code}/players/${currentUser.uid}`), {
      displayName: currentProfile.displayName,
      avatarUrl: currentProfile.avatarUrl || currentProfile.avatar || null,
      joinedAt: players[currentUser.uid]?.joinedAt ?? Date.now()
    });

    enterRoom(code);
  } catch (error) {
    setMessage("home-message", friendlyError(error), "error");
  } finally {
    setBusy(false);
  }
});

$("room-code").addEventListener("input", event => {
  event.target.value = normaliseCode(event.target.value);
});

/* -------------------------------------------------------
   LOBBY AND ROOM LISTENER
------------------------------------------------------- */

function enterRoom(code) {
  if (stopRoomListener) stopRoomListener();

  secretLoadVersion++;
  currentRoomCode = code;
  currentRoom = null;
  currentSecret = null;
  loadedSecretFor = null;
  loadingSecretFor = null;
  selectedTeam = new Set();
  missionMessage = "";
  missionMessageType = "";

  resetRoleCard();

  $("display-room-code").textContent = code;
  showScreen("lobby-screen");
  setMessage("lobby-message", "Connecting to the waiting room...");

  stopRoomListener = onValue(ref(db, `rooms/${code}`), snapshot => {
    if (currentRoomCode !== code) return;

    if (!snapshot.exists()) {
      currentRoomCode = null;
      currentRoom = null;
      currentSecret = null;
      secretLoadVersion++;

      if (stopRoomListener) stopRoomListener();
      stopRoomListener = null;
      showScreen("home-screen");
      setMessage("home-message", "This room has been closed.");
      return;
    }

    currentRoom = snapshot.val();

    if (currentRoom.status === "playing") {
      showScreen("game-screen");

      if (currentSecret &&
          loadedSecretFor === `${code}:${currentUser?.uid}`) {
        renderRole(currentSecret);
      } else {
        loadMySecret(code);
      }

      renderGamePage();
      return;
    }

    if (currentRoom.status !== "lobby") {
      showScreen("home-screen");
      setMessage("home-message", "This room is no longer available.");
      return;
    }

    showScreen("lobby-screen");
    renderLobby();
    setMessage("lobby-message");
    setConnection("Connected");
  }, error => {
    setMessage("lobby-message", friendlyError(error), "error");
  });
}

function renderLobby() {
  if (!currentRoom || currentRoom.status !== "lobby") return;

  const players = getPlayers();
  const isHost = currentRoom.hostUid === currentUser?.uid;
  const count = players.length;

  $("display-room-code").textContent = currentRoomCode;
  $("player-count").textContent = `${count} / ${MAX_PLAYERS} players`;
  $("lobby-status").textContent = isHost ? "You are the host" : "Waiting";

  $("lobby-hint").textContent = isHost
    ? count < MIN_PLAYERS
      ? `You need at least ${MIN_PLAYERS} players to start.`
      : "Everyone ready? Start when you're happy with the lobby."
    : "Waiting for the host to start the game...";

  $("start-game").disabled = !isHost || count < MIN_PLAYERS || busy;

  const list = $("players-list");
  list.replaceChildren();

  players.forEach(([uid, player]) => {
    const card = document.createElement("div");
    card.className = "player-card";

    const avatar = document.createElement("div");
    avatar.className = "player-avatar";
    showAvatar(avatar, player.avatarUrl || player.avatar || null);

    const details = document.createElement("div");
    details.className = "player-details";

    const name = document.createElement("div");
    name.className = "player-name";
    name.textContent = player.displayName || "Player";
    details.appendChild(name);

    if (uid === currentRoom.hostUid) {
      const host = document.createElement("div");
      host.className = "host-tag";
      host.textContent = "✦ HOST";
      details.appendChild(host);
    }

    card.append(avatar, details);
    list.appendChild(card);
  });
}

$("copy-code").addEventListener("click", async () => {
  if (!currentRoomCode) return;

  try {
    await navigator.clipboard.writeText(currentRoomCode);
    $("copy-code").textContent = "Copied!";
    setTimeout(() => { $("copy-code").textContent = "Copy code"; }, 1500);
  } catch {
    setMessage("lobby-message", `Your room code is ${currentRoomCode}.`);
  }
});

/* -------------------------------------------------------
   ROLE ASSIGNMENT AND HOST-CONTROLLED PAGE ONE
------------------------------------------------------- */

function getWitchCount(playerCount) {
  return Math.max(2, Math.ceil(playerCount / 3));
}

async function startGame() {
  if (
    busy || !currentRoom || !currentRoomCode ||
    currentRoom.hostUid !== currentUser?.uid
  ) return;

  setBusy(true);
  setMessage("lobby-message", "Preparing the secret roles...");

  const code = currentRoomCode;
  const writtenUids = [];
  let gameStarted = false;

  try {
    const snapshot = await get(ref(db, `rooms/${code}`));
    if (!snapshot.exists()) throw new Error("This room no longer exists.");

    const room = snapshot.val();

    if (room.hostUid !== currentUser.uid) throw new Error("Only the host can start.");
    if (room.status !== "lobby") throw new Error("This game has already started.");

    const players = Object.entries(room.players || {});
    if (players.length < MIN_PLAYERS) {
      throw new Error(`You need at least ${MIN_PLAYERS} players.`);
    }
    if (players.length > MAX_PLAYERS) {
      throw new Error(`A game can have no more than ${MAX_PLAYERS} players.`);
    }

    const randomisedPlayers = shuffled(players);
    const witchCount = getWitchCount(randomisedPlayers.length);
    const witchPlayers = randomisedPlayers.slice(0, witchCount);
    const oraclePlayer = randomisedPlayers[witchCount];

    const witchNames = {};
    witchPlayers.forEach(([uid, player]) => {
      witchNames[uid] = player.displayName || "Player";
    });

    const roles = {};
    randomisedPlayers.forEach(([uid]) => { roles[uid] = "townsperson"; });
    witchPlayers.forEach(([uid]) => { roles[uid] = "witch"; });
    roles[oraclePlayer[0]] = "oracle";

    const assignedAt = Date.now();

    for (const [uid] of randomisedPlayers) {
      const role = roles[uid];
      const secret = { role, assignedAt };

      if (role === "witch") {
        secret.knownWitches = {};
        Object.entries(witchNames).forEach(([witchUid, name]) => {
          if (witchUid !== uid) secret.knownWitches[witchUid] = name;
        });
      }

      if (role === "oracle") {
        secret.knownWitches = { ...witchNames };
      }

      await set(ref(db, `playerSecrets/${code}/${uid}`), secret);
      writtenUids.push(uid);
    }

    const initialMission = {
      round: 1,
      phase: "proposal",
      leaderUid: randomisedPlayers[0][0],
      teamSize: getTeamSize(randomisedPlayers.length, 1),
      rejectionCount: 0,
      proposal: null,
      updatedAt: assignedAt
    };

    await update(ref(db, `rooms/${code}`), {
      status: "playing",
      gamePhase: "role-reveal",
      startedAt: assignedAt,
      playerCount: randomisedPlayers.length,
      witchCount,
      mission: initialMission
    });

    gameStarted = true;
    setMessage("lobby-message");
  } catch (error) {
    if (!gameStarted) {
      await Promise.all(writtenUids.map(uid =>
        remove(ref(db, `playerSecrets/${code}/${uid}`)).catch(() => {})
      ));
    }
    setMessage("lobby-message", friendlyError(error), "error");
  } finally {
    setBusy(false);
  }
}

$("start-game").addEventListener("click", startGame);

/* -------------------------------------------------------
   ROLE CARD AND ORACLE BONUS
------------------------------------------------------- */

function resetRoleCard() {
  $("role-card").className = "role-card";
  $("role-symbol").textContent = "🔮";
  $("role-status").textContent = "RETRIEVING YOUR ROLE";
  $("role-title").textContent = "Your secret role is being prepared...";
  $("role-description").textContent = "Retrieving your private role information.";

  $("known-witches-section").hidden = true;
  $("known-witches-title").textContent = "The Witches";
  $("known-witches-intro").textContent = "Keep this information secret.";
  $("known-witches-list").replaceChildren();

  $("role-error").hidden = true;
  $("role-error").textContent = "";
  $("retry-role").hidden = true;

  $("oracle-bonus-card").hidden = true;
  $("oracle-witch-list").replaceChildren();
}

function renderRoleLoading(message = "Retrieving your private role information.") {
  resetRoleCard();
  $("role-status").textContent = "RETRIEVING YOUR ROLE";
  $("role-title").textContent = "One moment...";
  $("role-description").textContent = message;
}

function renderRoleError(message) {
  $("role-status").textContent = "ROLE NOT LOADED";
  $("role-title").textContent = "Your role hasn't appeared yet";
  $("role-description").textContent = "Your private role record couldn't be loaded.";
  $("role-error").textContent = message;
  $("role-error").hidden = false;
  $("retry-role").hidden = false;
}

function renderKnownWitches(secret, targetId = "known-witches-list") {
  const list = $(targetId);
  list.replaceChildren();

  const witches = secret.knownWitches &&
    typeof secret.knownWitches === "object"
    ? Object.entries(secret.knownWitches)
    : [];

  witches.forEach(([uid, name]) => {
    const item = document.createElement("div");
    item.textContent = String(name || "Player");
    item.dataset.playerUid = uid;
    list.appendChild(item);
  });

  return witches.length;
}

function renderRole(secret) {
  currentSecret = secret;
  resetRoleCard();

  const card = $("role-card");

  const detailsByRole = {
    witch: {
      className: "role-witch",
      symbol: "🧙",
      title: "You are a Witch!",
      description: "Secretly work against the Town. If selected for a mission, you can choose to Succeed or Ruin it. Keep your identity hidden."
    },
    townsperson: {
      className: "role-townsperson",
      symbol: "🏘️",
      title: "You are a Townsperson!",
      description: "Help the Town complete its missions. Pay attention to decisions and work out who the Witches are. If selected for a mission, you must choose Succeed."
    },
    oracle: {
      className: "role-townsperson",
      symbol: "🏘️",
      title: "You are a Townsperson!",
      description: "Help the Town complete its missions. Pay attention to decisions and work out who the Witches are. If selected for a mission, you must choose Succeed."
    }
  };

  const details = detailsByRole[secret.role];

  if (!details) {
    renderRoleError("Unknown role. Ask the host to check the game setup.");
    return;
  }

  card.classList.add(details.className);
  $("role-symbol").textContent = details.symbol;
  $("role-status").textContent = "YOUR SECRET ROLE";
  $("role-title").textContent = details.title;
  $("role-description").textContent = details.description;

  if (secret.role === "witch") {
    $("known-witches-title").textContent = "Your fellow Witches";
    $("known-witches-intro").textContent = "You're on the same side. Keep your identities hidden.";
    renderKnownWitches(secret);
    $("known-witches-section").hidden = false;
  }

  if (secret.role === "oracle") {
    $("oracle-bonus-card").hidden = false;
    renderKnownWitches(secret, "oracle-witch-list");

    if (!secret.knownWitches || Object.keys(secret.knownWitches).length === 0) {
      $("oracle-witch-list").textContent =
        "The Witch list is missing. Ask the host to check the role assignment.";
    }
  }
}

async function loadMySecret(code, force = false) {
  if (!currentUser || !code) return;

  const uid = currentUser.uid;
  const key = `${code}:${uid}`;

  if (!force && loadedSecretFor === key && currentSecret) {
    renderRole(currentSecret);
    renderGamePage();
    return;
  }

  if (loadingSecretFor === key) return;

  const thisLoadVersion = ++secretLoadVersion;
  loadingSecretFor = key;

  renderRoleLoading();

  try {
    const snapshot = await get(ref(db, `playerSecrets/${code}/${uid}`));

    if (
      thisLoadVersion !== secretLoadVersion ||
      currentRoomCode !== code ||
      currentUser?.uid !== uid
    ) return;

    if (!snapshot.exists()) {
      throw new Error("No private role record was found. Ask the host to check the setup.");
    }

    const secret = snapshot.val();

    if (!secret || !["witch", "townsperson", "oracle"].includes(secret.role)) {
      throw new Error("Your role record is invalid. Ask the host to check the setup.");
    }

    currentSecret = secret;
    loadedSecretFor = key;
    renderRole(secret);
    renderGamePage();
    setConnection("Connected");
  } catch (error) {
    if (
      thisLoadVersion === secretLoadVersion &&
      currentRoomCode === code &&
      currentUser?.uid === uid
    ) {
      currentSecret = null;
      loadedSecretFor = null;
      renderRoleError(friendlyError(error));
    }
  } finally {
    if (loadingSecretFor === key) loadingSecretFor = null;
  }
}

$("retry-role").addEventListener("click", () => {
  if (currentRoomCode && currentRoom?.status === "playing") {
    loadMySecret(currentRoomCode, true);
  }
});

/* -------------------------------------------------------
   HOST-CONTROLLED PAGE TRANSITION
------------------------------------------------------- */

function renderGamePage() {
  if (!currentRoom || currentRoom.status !== "playing") return;

  const rolePage = !currentRoom.gamePhase ||
    currentRoom.gamePhase === "role-reveal";

  $("role-card").hidden = !rolePage;
  $("oracle-bonus-card").hidden =
    !rolePage || currentSecret?.role !== "oracle";

  $("host-page-controls").hidden =
    !rolePage || currentRoom.hostUid !== currentUser?.uid;

  $("mission-panel").hidden = rolePage;

  if (rolePage) {
    $("host-page-hint").textContent =
      "Wait until everyone has viewed their secret role before continuing.";
    $("host-continue-button").textContent = "Begin team selection";
  } else {
    renderMission();
  }
}

async function advanceGamePage() {
  if (
    busy ||
    !currentRoom ||
    currentRoom.status !== "playing" ||
    currentRoom.hostUid !== currentUser?.uid ||
    currentRoom.gamePhase === "team-selection"
  ) return;

  setBusy(true);

  try {
    const snapshot = await get(ref(db, `rooms/${currentRoomCode}`));
    if (!snapshot.exists()) throw new Error("This room no longer exists.");

    const room = snapshot.val();

    if (room.hostUid !== currentUser.uid) {
      throw new Error("Only the host can advance the game.");
    }

    if (room.status !== "playing" || room.gamePhase === "team-selection") return;

    await update(ref(db, `rooms/${currentRoomCode}`), {
      gamePhase: "team-selection",
      pageChangedAt: Date.now()
    });
  } catch (error) {
    missionError(friendlyError(error));
  } finally {
    setBusy(false);
  }
}

/* -------------------------------------------------------
   MISSION: TEAM PROPOSAL AND ACCEPT/REJECT
------------------------------------------------------- */

function renderMissionMessage() {
  const element = $("mission-message");
  element.textContent = missionMessage;
  element.className = `mission-message ${missionMessageType}`.trim();
}

function renderMission() {
  const panel = $("mission-panel");

  if (
    !panel || !currentRoom ||
    currentRoom.status !== "playing" ||
    currentRoom.gamePhase === "role-reveal"
  ) {
    if (panel) panel.hidden = true;
    return;
  }

  panel.hidden = false;

  const mission = currentRoom.mission;

  if (!mission?.leaderUid) {
    $("mission-round").textContent = "MISSION";
    $("mission-phase").textContent = "Preparing";
    $("mission-content").innerHTML = "<p>Preparing the mission...</p>";
    renderMissionMessage();
    return;
  }

  const players = getPlayers();
  const leaderUid = mission.leaderUid;
  const isLeader = leaderUid === currentUser?.uid;
  const round = Number(mission.round) || 1;
  const teamSize = Number(mission.teamSize) || getTeamSize(players.length, round);
  const leader = currentRoom.players?.[leaderUid] || {};
  const leaderName = leader.displayName || "Player";

  $("mission-round").textContent = `MISSION ${round} OF 5`;

  $("mission-phase").textContent = ({
    proposal: "Choose a team",
    pending: "Team proposed",
    accepted: "Team approved"
  })[mission.phase] || "Mission";

  const leaderCard = `
    <div class="mission-leader-card">
      ${avatarMarkup(leader, "mission-leader-avatar")}
      <div>
        <div class="mission-leader-label">MISSION LEADER</div>
        <div class="mission-leader-name">${escapeHTML(leaderName)}</div>
      </div>
    </div>
  `;

  let content = leaderCard;

  if (mission.phase === "proposal") {
    content += `
      <h2>${isLeader ? "Choose your team" : "The leader is choosing"}</h2>
      <p>${isLeader
        ? `Select exactly ${teamSize} players. You can include yourself.`
        : `Mission ${round} requires ${teamSize} players. Discuss who should be selected.`}
      </p>
    `;

    if (isLeader) {
      content += `
        <div class="mission-team-list">
          ${players.map(([uid, player]) => `
            <label class="mission-player-option">
              <input type="checkbox" class="mission-team-checkbox"
                value="${escapeHTML(uid)}"
                ${selectedTeam.has(uid) ? "checked" : ""}>
              ${avatarMarkup(player)}
              <span class="mission-player-option-name">${escapeHTML(player.displayName || "Player")}</span>
              ${uid === currentUser.uid
                ? '<span class="mission-player-option-note">You</span>' : ""}
            </label>
          `).join("")}
        </div>
        <div id="mission-selection-count" class="mission-selection-count">
          ${selectedTeam.size} / ${teamSize} selected
        </div>
        <div class="mission-actions">
          <button id="submit-mission-team" type="button"
            ${selectedTeam.size !== teamSize || busy ? "disabled" : ""}>
            Propose team
          </button>
        </div>
      `;
    } else {
      content += `<div class="mission-notice">Waiting for ${escapeHTML(leaderName)} to propose a team.</div>`;
    }
  } else if (mission.phase === "pending" && mission.proposal) {
    const teamUids = Array.isArray(mission.proposal.teamUids)
      ? mission.proposal.teamUids : [];

    content += `
      <h2>Proposed team</h2>
      <p>${isLeader
        ? "Discuss the team with everyone, then record the group's collective decision."
        : "Discuss the proposed team. The leader will record the group's decision."}
      </p>
      <div class="mission-team-list">
        ${teamUids.map(uid => {
          const player = currentRoom.players?.[uid];
          if (!player) return "";
          return `<div class="mission-team-member">
            ${escapeHTML(player.displayName || "Player")}
            ${uid === leaderUid ? " · Leader" : ""}
          </div>`;
        }).join("")}
      </div>
      <div class="mission-notice">${teamUids.length} players selected. Individual votes are not shown.</div>
    `;

    if (isLeader) {
      content += `
        <div class="mission-actions">
          <button id="approve-mission-team" type="button" ${busy ? "disabled" : ""}>Accept team</button>
          <button id="reject-mission-team" class="mission-button-danger" type="button" ${busy ? "disabled" : ""}>Reject team</button>
        </div>
      `;
    }
  } else if (mission.phase === "accepted") {
    const teamUids = Array.isArray(mission.proposal?.teamUids)
      ? mission.proposal.teamUids : [];

    content += `
      <h2>Team approved!</h2>
      <p>The team for Mission ${round} is locked in.</p>
      <div class="mission-team-list">
        ${teamUids.map(uid => {
          const player = currentRoom.players?.[uid];
          if (!player) return "";
          return `<div class="mission-team-member">
            ${escapeHTML(player.displayName || "Player")}
            ${uid === leaderUid ? " · Leader" : ""}
          </div>`;
        }).join("")}
      </div>
      <div class="mission-notice success">
        The team is ready. Secret mission voting and scoring will be added next.
      </div>
    `;
  } else {
    content += `<h2>Mission unavailable</h2><p>Ask the host to check the game.</p>`;
  }

  $("mission-content").innerHTML = content;
  renderMissionMessage();

  panel.querySelectorAll(".mission-team-checkbox").forEach(checkbox => {
    checkbox.addEventListener("change", event => {
      const uid = event.target.value;

      if (event.target.checked) {
        if (selectedTeam.size >= teamSize) {
          event.target.checked = false;
          missionError(`Select exactly ${teamSize} players.`);
          return;
        }
        selectedTeam.add(uid);
      } else {
        selectedTeam.delete(uid);
      }

      const count = $("mission-selection-count");
      if (count) count.textContent = `${selectedTeam.size} / ${teamSize} selected`;

      const submit = $("submit-mission-team");
      if (submit) submit.disabled = selectedTeam.size !== teamSize || busy;

      missionMessage = "";
      missionMessageType = "";
      renderMissionMessage();
    });
  });

  $("submit-mission-team")?.addEventListener("click", submitMissionTeam);
  $("approve-mission-team")?.addEventListener("click", approveMissionTeam);
  $("reject-mission-team")?.addEventListener("click", rejectMissionTeam);
}

async function submitMissionTeam() {
  const mission = currentRoom?.mission;

  if (
    busy || !mission || mission.phase !== "proposal" ||
    mission.leaderUid !== currentUser?.uid
  ) return;

  const teamUids = [...selectedTeam];

  if (teamUids.length !== Number(mission.teamSize)) {
    missionError(`Select exactly ${mission.teamSize} players.`);
    return;
  }

  if (teamUids.some(uid => !currentRoom.players?.[uid])) {
    missionError("A selected player is no longer in the room.");
    return;
  }

  setBusy(true);

  try {
    const snapshot = await get(ref(db, `rooms/${currentRoomCode}`));
    if (!snapshot.exists()) throw new Error("This room no longer exists.");

    const room = snapshot.val();
    const fresh = room.mission;

    if (
      room.status !== "playing" ||
      room.gamePhase !== "team-selection" ||
      fresh?.phase !== "proposal" ||
      fresh?.leaderUid !== currentUser.uid
    ) throw new Error("The mission has changed. Check the current team.");

    if (teamUids.length !== Number(fresh.teamSize)) {
      throw new Error("The required team size changed. Select again.");
    }

    await update(ref(db, `rooms/${currentRoomCode}/mission`), {
      phase: "pending",
      proposal: {
        teamUids,
        proposedBy: currentUser.uid,
        proposedAt: Date.now()
      },
      updatedAt: Date.now()
    });

    selectedTeam = new Set();
    missionSuccess("Team proposed. Discuss it before recording the decision.");
  } catch (error) {
    missionError(friendlyError(error));
  } finally {
    setBusy(false);
  }
}

async function approveMissionTeam() {
  const mission = currentRoom?.mission;

  if (
    busy || !mission || mission.phase !== "pending" ||
    mission.leaderUid !== currentUser?.uid || !mission.proposal
  ) return;

  setBusy(true);

  try {
    const snapshot = await get(ref(db, `rooms/${currentRoomCode}`));
    if (!snapshot.exists()) throw new Error("This room no longer exists.");

    const room = snapshot.val();
    const fresh = room.mission;

    if (
      room.status !== "playing" ||
      room.gamePhase !== "team-selection" ||
      fresh?.phase !== "pending" ||
      fresh?.leaderUid !== currentUser.uid ||
      !fresh?.proposal
    ) throw new Error("The proposal has changed.");

    if ((fresh.proposal.teamUids || []).length !== Number(fresh.teamSize)) {
      throw new Error("The proposed team has the wrong size.");
    }

    await update(ref(db, `rooms/${currentRoomCode}/mission`), {
      phase: "accepted",
      approvedAt: Date.now(),
      updatedAt: Date.now()
    });

    missionSuccess("The team has been approved!");
  } catch (error) {
    missionError(friendlyError(error));
  } finally {
    setBusy(false);
  }
}

async function rejectMissionTeam() {
  const mission = currentRoom?.mission;

  if (
    busy || !mission || mission.phase !== "pending" ||
    mission.leaderUid !== currentUser?.uid
  ) return;

  setBusy(true);

  try {
    const snapshot = await get(ref(db, `rooms/${currentRoomCode}`));
    if (!snapshot.exists()) throw new Error("This room no longer exists.");

    const room = snapshot.val();
    const fresh = room.mission;

    if (
      room.status !== "playing" ||
      room.gamePhase !== "team-selection" ||
      fresh?.phase !== "pending" ||
      fresh?.leaderUid !== currentUser.uid
    ) throw new Error("The proposal has changed.");

    const playerUids = Object.keys(room.players || {});
    if (playerUids.length < MIN_PLAYERS) {
      throw new Error("There are no longer enough players to continue.");
    }

    const otherPlayers = playerUids.filter(uid => uid !== currentUser.uid);
    const nextLeaderUid = otherPlayers.length
      ? otherPlayers[Math.floor(Math.random() * otherPlayers.length)]
      : currentUser.uid;

    const rejectionCount = (Number(fresh.rejectionCount) || 0) + 1;

    await update(ref(db, `rooms/${currentRoomCode}/mission`), {
      phase: "proposal",
      leaderUid: nextLeaderUid,
      teamSize: getTeamSize(playerUids.length, Number(fresh.round) || 1),
      proposal: null,
      rejectionCount,
      lastRejectedAt: Date.now(),
      updatedAt: Date.now()
    });

    selectedTeam = new Set();
    missionSuccess(`Team rejected. ${getPlayerName(nextLeaderUid)} is the new leader.`);
  } catch (error) {
    missionError(friendlyError(error));
  } finally {
    setBusy(false);
  }
}

/* -------------------------------------------------------
   LEAVING A ROOM
------------------------------------------------------- */

async function leaveRoom() {
  if (!currentRoomCode || !currentUser || busy) return;

  const code = currentRoomCode;
  const room = currentRoom;
  const uid = currentUser.uid;

  setBusy(true);

  try {
    if (room?.hostUid === uid) {
      const otherPlayers = Object.keys(room.players || {}).filter(id => id !== uid);

      if (otherPlayers.length === 0) {
        await remove(ref(db, `rooms/${code}`));
      } else {
        await update(ref(db, `rooms/${code}`), { hostUid: otherPlayers[0] });
        await remove(ref(db, `rooms/${code}/players/${uid}`));
      }
    } else {
      await remove(ref(db, `rooms/${code}/players/${uid}`));
    }
  } catch (error) {
    setMessage(
      room?.status === "lobby" ? "lobby-message" : "home-message",
      friendlyError(error),
      "error"
    );
    setBusy(false);
    return;
  }

  setBusy(false);

  if (stopRoomListener) stopRoomListener();
  stopRoomListener = null;
  secretLoadVersion++;

  currentRoomCode = null;
  currentRoom = null;
  currentSecret = null;
  loadedSecretFor = null;
  loadingSecretFor = null;
  selectedTeam = new Set();

  resetRoleCard();
  showScreen("home-screen");
}

$("leave-room").addEventListener("click", leaveRoom);

$("return-lobby").addEventListener("click", async () => {
  if (currentRoom?.status === "playing") {
    await leaveRoom();
  } else if (currentRoomCode) {
    showScreen("lobby-screen");
  } else {
    showScreen("home-screen");
  }
});

/* -------------------------------------------------------
   PROFILE EDITING AND LOGOUT
------------------------------------------------------- */

$("edit-profile").addEventListener("click", () => {
  selectedProfileFile = null;
  $("profile-editor").hidden = false;
  renderHomeProfile();
});

$("cancel-profile").addEventListener("click", () => {
  selectedProfileFile = null;
  $("profile-avatar-file").value = "";
  $("profile-camera-file").value = "";
  $("profile-editor").hidden = true;
});

$("profile-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (busy) return;

  setBusy(true);

  try {
    await saveProfile($("profile-name").value, selectedProfileFile);

    selectedProfileFile = null;
    $("profile-avatar-file").value = "";
    $("profile-camera-file").value = "";
    $("profile-editor").hidden = true;
    setMessage("home-message", "Profile updated!", "success");
  } catch (error) {
    setMessage("home-message", friendlyError(error), "error");
  } finally {
    setBusy(false);
  }
});

$("logout").addEventListener("click", async () => {
  if (busy) return;

  try {
    if (currentRoomCode) await leaveRoom();
    await signOut(auth);
  } catch (error) {
    setMessage("home-message", friendlyError(error), "error");
  }
});

/* -------------------------------------------------------
   AUTHENTICATION STATE
------------------------------------------------------- */

onAuthStateChanged(auth, async user => {
  const thisVersion = ++authStateVersion;
  currentUser = user;

  if (!user) {
    if (stopRoomListener) stopRoomListener();

    stopRoomListener = null;
    secretLoadVersion++;
    currentProfile = null;
    currentRoomCode = null;
    currentRoom = null;
    currentSecret = null;
    loadedSecretFor = null;
    loadingSecretFor = null;
    selectedRegisterFile = null;
    selectedProfileFile = null;
    selectedTeam = new Set();

    setProfileSetupMode(false);
    resetRoleCard();
    showScreen("auth-screen");

    $("login-form").hidden = false;
    $("register-form").hidden = true;
    $("show-login").hidden = false;
    $("show-register").hidden = false;

    switchAuthTab(false);
    setConnection("Signed out");
    return;
  }

  setConnection("Loading profile...");

  try {
    await authReady;
    if (thisVersion !== authStateVersion) return;

    await loadProfile(user);
    if (thisVersion !== authStateVersion) return;
  } catch (error) {
    if (thisVersion !== authStateVersion) return;
    showScreen("auth-screen");
    setMessage("auth-message", friendlyError(error), "error");
    setConnection("Connection error");
  }
});
// ============================================================
// WITCH HUNT — COMPLETE GAMEPLAY ENGINE
// ============================================================

const WH_GAME_MAX_REJECTIONS = 5;

function whPlayers() {
  const raw = currentRoom?.players || {};

  if (Array.isArray(raw)) {
    return raw
      .filter(Boolean)
      .map((p, i) => ({
        uid: p.uid || p.id || String(i),
        name: p.name || p.displayName || "Player",
        ...p
      }));
  }

  return Object.entries(raw)
    .filter(([, p]) => p && typeof p === "object")
    .map(([uid, p]) => ({
      uid,
      name: p.name || p.displayName || "Player",
      ...p,
      uid
    }));
}

function whPlayerName(uid) {
  return whPlayers().find(p => p.uid === uid)?.name || "Player";
}

function whIsHost() {
  return Boolean(
    currentUser &&
    currentRoom &&
    (
      currentRoom.hostUid === currentUser.uid ||
      currentRoom.host === currentUser.uid ||
      currentRoom.hostId === currentUser.uid
    )
  );
}

function whIsWitch() {
  return currentSecret?.role === "witch";
}

function whIsOracle() {
  return currentSecret?.role === "oracle";
}

function whIsTown() {
  return currentSecret?.role === "townsperson";
}

function whMissionRef() {
  return ref(db, `rooms/${currentRoomCode}/mission`);
}

function whRoomRef() {
  return ref(db, `rooms/${currentRoomCode}`);
}

function whEscape(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function whButton(id, text, disabled = false, secondary = false) {
  return `
    <button
      id="${id}"
      type="button"
      ${disabled ? "disabled" : ""}
      class="${secondary ? "secondary-button" : ""}"
    >${whEscape(text)}</button>
  `;
}

function whBind(id, callback) {
  document.getElementById(id)?.addEventListener("click", callback);
}

function whMessage(text, error = false) {
  const target = document.getElementById("mission-message");
  if (!target) return;

  target.textContent = text;
  target.style.color = error ? "#ff9cae" : "";
}

async function whUpdateMission(callback) {
  if (!currentRoomCode || !currentUser) return;

  const result = await runTransaction(whMissionRef(), mission => {
    if (!mission) return;

    return callback(mission);
  });

  if (!result.committed) {
    throw new Error("The game state changed. Please try again.");
  }

  return result.snapshot.val();
}

function whGetTeamSize(round, playerCount) {
  const sizes = {
    5: [2, 3, 2, 3, 3],
    6: [2, 3, 4, 3, 4],
    7: [2, 3, 3, 4, 4],
    8: [3, 4, 4, 5, 5],
    9: [3, 4, 4, 5, 5],
    10: [3, 4, 4, 5, 5],
    11: [3, 4, 4, 5, 6],
    12: [3, 4, 5, 6, 6]
  };

  const schedule = sizes[playerCount] || sizes[5];
  return schedule[Math.min(round - 1, 4)];
}

function whGetLeaderUid(mission, players) {
  const previous = players.findIndex(p => p.uid === mission.leaderUid);
  const next = (previous + 1 + players.length) % players.length;
  return players[next]?.uid || players[0]?.uid;
}

function whMajority(votes, players) {
  const yes = players.filter(p => votes?.[p.uid] === "approve").length;
  const no = players.filter(p => votes?.[p.uid] === "reject").length;

  return {
    yes,
    no,
    approved: yes > no
  };
}

function whResultSummary(mission) {
  const result = mission.result;
  if (!result) return "";

  return `
    <div class="wh-result">
      <h3>${result.success ? "Mission succeeded" : "Mission failed"}</h3>
      <p>${result.success
        ? "The team completed the mission."
        : "The witches sabotaged the mission."
      }</p>
      <p>Town: <strong>${mission.townPoints || 0}/3</strong></p>
      <p>Witches: <strong>${mission.witchPoints || 0}/3</strong></p>
    </div>
  `;
}

// Replace the previous renderer with the full gameplay renderer.
function renderMission() {
  const panel = document.getElementById("mission-panel");
  const content = document.getElementById("mission-content");
  const roundLabel = document.getElementById("mission-round");
  const phaseLabel = document.getElementById("mission-phase");

  if (!panel || !content || !currentRoom || !currentUser) return;

  const mission = currentRoom.mission;

  if (!mission) {
    content.innerHTML = "<p>Waiting for the host to start the game.</p>";
    return;
  }

  const players = whPlayers();
  const myUid = currentUser.uid;
  const isHost = whIsHost();
  const team = Array.isArray(mission.proposal?.teamUids)
    ? mission.proposal.teamUids
    : [];

  const approvalVotes = mission.approvalVotes || {};
  const missionVotes = mission.missionVotes || {};
  const alreadyApproved = Object.prototype.hasOwnProperty.call(
    approvalVotes, myUid
  );
  const alreadyVotedMission = Object.prototype.hasOwnProperty.call(
    missionVotes, myUid
  );

  roundLabel && (roundLabel.textContent =
    mission.round ? `Round ${mission.round} of 5` : "Game");

  phaseLabel && (phaseLabel.textContent =
    String(mission.phase || "proposal").replace(/-/g, " "));

  let html = `
    <div class="wh-scoreboard">
      <div><span>Town</span><strong>${mission.townPoints || 0}/3</strong></div>
      <div><span>Witches</span><strong>${mission.witchPoints || 0}/3</strong></div>
    </div>
    <p>Team leader: <strong>${whEscape(whPlayerName(mission.leaderUid))}</strong></p>
  `;

  if (mission.phase === "proposal") {
    const isLeader = mission.leaderUid === myUid;

    html += `
      <h3>Choose the mission team</h3>
      <p>Select ${mission.teamSize} player(s) for this mission.</p>
    `;

    if (isLeader) {
      html += `
        <div class="wh-player-list">
          ${players.map(p => `
            <label class="wh-player-option">
              <input
                type="checkbox"
                name="wh-team-player"
                value="${whEscape(p.uid)}"
                ${team.includes(p.uid) ? "checked" : ""}
              >
              <span>${whEscape(p.name)}</span>
            </label>
          `).join("")}
        </div>
        ${whButton("wh-submit-team", "Propose team")}
      `;
    } else {
      html += `<p>Waiting for the leader to propose a team.</p>`;
    }

    if ((mission.rejectionCount || 0) > 0) {
      html += `<p>Rejected teams: ${mission.rejectionCount}/${WH_GAME_MAX_REJECTIONS}</p>`;
    }
  }

  else if (mission.phase === "pending") {
    html += `
      <h3>Vote on the proposed team</h3>
      <p>Everyone must vote. The result stays hidden until all players have voted.</p>
      <div class="wh-team-list">
        ${team.map(uid => `<span>${whEscape(whPlayerName(uid))}</span>`).join("")}
      </div>
      <p>Votes submitted: ${players.filter(p =>
        Object.prototype.hasOwnProperty.call(approvalVotes, p.uid)
      ).length}/${players.length}</p>
    `;

    if (!alreadyApproved) {
      html += `
        <div class="wh-actions">
          ${whButton("wh-approve-team", "Approve team")}
          ${whButton("wh-reject-team", "Reject team", false, true)}
        </div>
      `;
    } else {
      html += `<p>Your vote has been recorded.</p>`;
    }
  }

  else if (mission.phase === "accepted") {
    html += `
      <h3>Team approved</h3>
      <p>The team will now secretly decide whether the mission succeeds or fails.</p>
      <div class="wh-team-list">
        ${team.map(uid => `<span>${whEscape(whPlayerName(uid))}</span>`).join("")}
      </div>
      <p>Approval: ${mission.approvalResult?.yes ?? 0} approve,
      ${mission.approvalResult?.no ?? 0} reject.</p>
    `;

    if (!team.includes(myUid)) {
      html += `<p>You are not on this mission team. Waiting for the team to vote.</p>`;
    } else if (alreadyVotedMission) {
      html += `<p>Your secret mission decision has been recorded.</p>`;
    } else if (whIsWitch()) {
      html += `
        <h3>Choose your secret decision</h3>
        <p>As a witch, you may help the mission succeed or sabotage it.</p>
        <div class="wh-actions">
          ${whButton("wh-mission-succeed", "Succeed")}
          ${whButton("wh-mission-ruin", "Ruin mission", false, true)}
        </div>
      `;
    } else {
      html += `
        <h3>Your secret decision</h3>
        <p>You must choose Succeed.</p>
        ${whButton("wh-mission-succeed", "Succeed")}
      `;
    }

    html += `
      <p>Mission votes submitted: ${team.filter(uid =>
        Object.prototype.hasOwnProperty.call(missionVotes, uid)
      ).length}/${team.length}</p>
    `;
  }

  else if (mission.phase === "results" || mission.phase === "oracle-guess") {
    html += whResultSummary(mission);

    if (mission.phase === "oracle-guess") {
      html += `
        <h3>Final round: identify the Oracle</h3>
        <p>The town has completed three successful missions. The witches get one chance to identify the Oracle.</p>
      `;

      if (whIsWitch()) {
        html += `
          <label for="wh-oracle-guess">Who do you think the Oracle is?</label>
          <select id="wh-oracle-guess">
            <option value="">Choose a player</option>
            ${players.filter(p => p.uid !== myUid).map(p => `
              <option value="${whEscape(p.uid)}">${whEscape(p.name)}</option>
            `).join("")}
          </select>
          ${whButton("wh-submit-oracle-guess", "Submit guess")}
        `;
      } else if (whIsOracle()) {
        html += `<p>The witches are making their final guess.</p>`;
      } else {
        html += `<p>Waiting for the witches' final guess.</p>`;
      }

      if (mission.oracleGuessUid) {
        html += `
          <p>The witches have submitted their guess. The Oracle must resolve the final result.</p>
        `;

        if (whIsOracle()) {
          html += `
            ${whButton("wh-oracle-guess-correct", "They guessed correctly")}
            ${whButton("wh-oracle-guess-wrong", "They guessed incorrectly", false, true)}
          `;
        }
      }
    } else if (isHost) {
      html += whButton(
        "wh-next-round",
        mission.round >= 5 ? "Finish game" : "Start next round"
      );
    } else {
      html += `<p>Waiting for the host to continue.</p>`;
    }
  }

  else if (mission.phase === "finished") {
    const winner = mission.winner === "town" ? "The Town" : "The Witches";

    html += `
      <div class="wh-result">
        <h2>${whEscape(winner)} win!</h2>
        <p>Final score: Town ${mission.townPoints || 0},
        Witches ${mission.witchPoints || 0}.</p>
      </div>
      <p>The game is over.</p>
    `;
  }

  else {
    html += `<p>Waiting for the next game action.</p>`;
  }

  content.innerHTML = html;

  whBind("wh-submit-team", whSubmitTeam);
  whBind("wh-approve-team", () => whCastApproval("approve"));
  whBind("wh-reject-team", () => whCastApproval("reject"));
  whBind("wh-mission-succeed", () => whCastMissionVote("succeed"));
  whBind("wh-mission-ruin", () => whCastMissionVote("ruin"));
  whBind("wh-next-round", whNextRound);
  whBind("wh-submit-oracle-guess", whSubmitOracleGuess);
  whBind("wh-oracle-guess-correct", () => whResolveOracleGuess(true));
  whBind("wh-oracle-guess-wrong", () => whResolveOracleGuess(false));
}

async function whSubmitTeam() {
  const selected = Array.from(
    document.querySelectorAll('input[name="wh-team-player"]:checked')
  ).map(input => input.value);

  const mission = currentRoom?.mission;
  const players = whPlayers();

  if (!mission || mission.leaderUid !== currentUser?.uid) {
    return whMessage("Only the current leader can propose a team.", true);
  }

  if (selected.length !== Number(mission.teamSize)) {
    return whMessage(`Choose exactly ${mission.teamSize} players.`, true);
  }

  if (new Set(selected).size !== selected.length ||
      selected.some(uid => !players.some(p => p.uid === uid))) {
    return whMessage("That team selection is invalid.", true);
  }

  try {
    await whUpdateMission(m => {
      if (m.phase !== "proposal" || m.leaderUid !== currentUser.uid) {
        return;
      }

      m.proposal = {
        teamUids: selected,
        leaderUid: currentUser.uid,
        createdAt: Date.now()
      };
      m.approvalVotes = {};
      m.missionVotes = {};
      m.approvalResult = null;
      m.result = null;
      m.phase = "pending";

      return m;
    });
  } catch (error) {
    whMessage(error.message || "Couldn't submit the team.", true);
  }
}

async function whCastApproval(vote) {
  const players = whPlayers();
  const myUid = currentUser?.uid;

  if (!myUid || !["approve", "reject"].includes(vote)) return;

  try {
    await whUpdateMission(m => {
      if (m.phase !== "pending") return;

      m.approvalVotes ||= {};

      if (Object.prototype.hasOwnProperty.call(m.approvalVotes, myUid)) {
        return;
      }

      m.approvalVotes[myUid] = vote;

      const everyoneVoted = players.every(p =>
        Object.prototype.hasOwnProperty.call(m.approvalVotes, p.uid)
      );

      if (!everyoneVoted) return m;

      const tally = whMajority(m.approvalVotes, players);

      m.approvalResult = {
        yes: tally.yes,
        no: tally.no,
        approved: tally.approved,
        completedAt: Date.now()
      };

      if (tally.approved) {
        m.phase = "accepted";
        m.missionVotes = {};
      } else {
        const rejections = (m.rejectionCount || 0) + 1;
        m.rejectionCount = rejections;

        if (rejections >= WH_GAME_MAX_REJECTIONS) {
          m.phase = "finished";
          m.winner = "witches";
          m.finishReason = "Five consecutive teams were rejected.";
          return m;
        }

        m.leaderUid = whGetLeaderUid(m, players);
        m.phase = "proposal";
        m.proposal = null;
        m.approvalVotes = {};
        m.missionVotes = {};
      }

      return m;
    });
  } catch (error) {
    whMessage(error.message || "Couldn't record your vote.", true);
  }
}

async function whCastMissionVote(vote) {
  const myUid = currentUser?.uid;
  const players = whPlayers();

  if (!myUid || !["succeed", "ruin"].includes(vote)) return;

  try {
    await whUpdateMission(m => {
      if (m.phase !== "accepted") return m;

      const team = m.proposal?.teamUids || [];

      if (!team.includes(myUid)) return m;
      if (m.missionVotes?.[myUid]) return m;

      // Only witches may sabotage a mission.
      if (vote === "ruin" && !whIsWitch()) return m;

      m.missionVotes ||= {};
      m.missionVotes[myUid] = vote;

      const allVoted = team.every(uid =>
        Object.prototype.hasOwnProperty.call(m.missionVotes, uid)
      );

      if (!allVoted) return m;

      const ruinCount = team.filter(uid =>
        m.missionVotes[uid] === "ruin"
      ).length;

      // In a 7+ player game, mission four requires two sabotages.
      const ruinThreshold =
        m.round === 4 && players.length >= 7 ? 2 : 1;

      const success = ruinCount < ruinThreshold;

      m.townPoints = Number(m.townPoints || 0) + (success ? 1 : 0);
      m.witchPoints = Number(m.witchPoints || 0) + (success ? 0 : 1);

      m.result = {
        success,
        completedAt: Date.now()
      };

      if (m.townPoints >= 3) {
        m.phase = "oracle-guess";
        m.oracleGuessUid = null;
      } else if (m.witchPoints >= 3) {
        m.phase = "finished";
        m.winner = "witches";
        m.finishReason = "The witches sabotaged three missions.";
      } else if (Number(m.round) >= 5) {
        m.phase = "finished";
        m.winner = m.townPoints > m.witchPoints ? "town" : "witches";
        m.finishReason = "All five missions have been played.";
      } else {
        m.phase = "results";
      }

      return m;
    });
  } catch (error) {
    whMessage(error.message || "Couldn't record your mission vote.", true);
  }
}

async function whNextRound() {
  if (!whIsHost()) {
    return whMessage("Only the host can start the next round.", true);
  }

  const players = whPlayers();

  try {
    await whUpdateMission(m => {
      if (m.phase !== "results") return m;

      const nextRound = Number(m.round || 1) + 1;

      if (nextRound > 5) {
        m.phase = "finished";
        m.winner =
          Number(m.townPoints || 0) > Number(m.witchPoints || 0)
            ? "town"
            : "witches";
        return m;
      }

      m.round = nextRound;
      m.teamSize = whGetTeamSize(nextRound, players.length);
      m.leaderUid = whGetLeaderUid(m, players);
      m.rejectionCount = 0;
      m.proposal = null;
      m.approvalVotes = {};
      m.approvalResult = null;
      m.missionVotes = {};
      m.result = null;
      m.phase = "proposal";

      return m;
    });
  } catch (error) {
    whMessage(error.message || "Couldn't start the next round.", true);
  }
}

async function whSubmitOracleGuess() {
  const select = document.getElementById("wh-oracle-guess");
  const guessUid = select?.value;

  if (!whIsWitch()) {
    return whMessage("Only a witch can submit the final guess.", true);
  }

  if (!guessUid) {
    return whMessage("Choose a player first.", true);
  }

  try {
    await whUpdateMission(m => {
      if (m.phase !== "oracle-guess" || m.oracleGuessUid) return m;

      m.oracleGuessUid = guessUid;
      m.oracleGuessSubmittedAt = Date.now();

      return m;
    });
  } catch (error) {
    whMessage(error.message || "Couldn't submit the guess.", true);
  }
}

async function whResolveOracleGuess(correct) {
  if (!whIsOracle()) {
    return whMessage("Only the Oracle can resolve the final guess.", true);
  }

  try {
    await whUpdateMission(m => {
      if (m.phase !== "oracle-guess" || !m.oracleGuessUid) return m;

      m.phase = "finished";
      m.winner = correct ? "witches" : "town";
      m.finishReason = correct
        ? "The witches identified the Oracle."
        : "The witches failed to identify the Oracle.";

      return m;
    });
  } catch (error) {
    whMessage(error.message || "Couldn't finish the game.", true);
  }
}

// Ensure the existing page renderer uses the new mission UI.
const whOriginalRenderGamePage = renderGamePage;

renderGamePage = function (...args) {
  whOriginalRenderGamePage.apply(this, args);

  const mission = currentRoom?.mission;
  const panel = document.getElementById("mission-panel");

  if (panel && mission && currentRoom?.status === "playing") {
    panel.style.display = "";
    renderMission();
  }
};
