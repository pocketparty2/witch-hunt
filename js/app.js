import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js";

import {
  ref,
  get,
  set,
  update,
  remove,
  onValue,
  runTransaction
} from "https://www.gstatic.com/firebasejs/12.4.0/firebase-database.js";

import { auth, db } from "./firebase.js";

const $ = (id) => document.getElementById(id);

const avatars = ["🦇", "🕯️", "🔮", "🐈‍⬛", "🌙", "🕸️", "🦉", "🧙", "🗝️", "🍄", "🦋", "💀"];
const MAX_PLAYERS = 12;
const MIN_PLAYERS = 5;

let currentUser = null;
let currentProfile = null;
let currentRoomCode = null;
let currentRoom = null;
let selectedRegisterAvatar = avatars[0];
let selectedProfileAvatar = avatars[0];
let stopRoomListener = null;
let busy = false;

function showScreen(screenId) {
  ["auth-screen", "home-screen", "lobby-screen", "game-screen"].forEach(id => {
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
  document.querySelectorAll("button[type='submit'], #create-room, #start-game")
    .forEach(button => button.disabled = value);
}

function cleanName(value) {
  return value.trim().replace(/\s+/g, " ").slice(0, 20);
}

function normaliseCode(value) {
  return value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);
}

function randomCode() {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  let code = "";
  for (let i = 0; i < 4; i++) {
    code += letters[Math.floor(Math.random() * letters.length)];
  }
  return code;
}

function makeAvatarPicker(containerId, selected, onSelect) {
  const container = $(containerId);
  container.replaceChildren();

  avatars.forEach(avatar => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `avatar-choice ${avatar === selected ? "selected" : ""}`;
    button.textContent = avatar;
    button.setAttribute("aria-label", `Choose avatar ${avatar}`);
    button.setAttribute("aria-pressed", String(avatar === selected));

    button.addEventListener("click", () => {
      onSelect(avatar);
      makeAvatarPicker(containerId, avatar, onSelect);
    });

    container.appendChild(button);
  });
}

function renderAvatarPickers() {
  makeAvatarPicker("register-avatars", selectedRegisterAvatar, avatar => {
    selectedRegisterAvatar = avatar;
  });

  makeAvatarPicker("profile-avatars", selectedProfileAvatar, avatar => {
    selectedProfileAvatar = avatar;
  });
}

function validProfile(name, avatar) {
  return typeof name === "string" &&
    name.trim().length >= 1 &&
    name.trim().length <= 20 &&
    avatars.includes(avatar);
}

async function saveProfile(name, avatar) {
  const clean = cleanName(name);

  if (!validProfile(clean, avatar)) {
    throw new Error("Choose a name of 1–20 characters and a valid avatar.");
  }

  const profile = {
    displayName: clean,
    avatar,
    updatedAt: Date.now()
  };

  await set(ref(db, `users/${currentUser.uid}`), profile);
  currentProfile = profile;

  if (currentRoomCode) {
    await set(ref(db, `rooms/${currentRoomCode}/players/${currentUser.uid}`), {
      displayName: profile.displayName,
      avatar: profile.avatar,
      joinedAt: currentRoom?.players?.[currentUser.uid]?.joinedAt ?? Date.now()
    });
  }

  renderHomeProfile();
}

function renderHomeProfile() {
  if (!currentProfile) return;

  $("home-name").textContent = currentProfile.displayName;
  $("home-avatar").textContent = currentProfile.avatar;
  $("profile-name").value = currentProfile.displayName;
  selectedProfileAvatar = currentProfile.avatar;
  makeAvatarPicker("profile-avatars", selectedProfileAvatar, avatar => {
    selectedProfileAvatar = avatar;
  });
}

async function loadProfile(user) {
  const snapshot = await get(ref(db, `users/${user.uid}`));

  if (snapshot.exists()) {
    currentProfile = snapshot.val();
    if (!validProfile(currentProfile.displayName, currentProfile.avatar)) {
      currentProfile = null;
    }
  } else {
    currentProfile = null;
  }

  if (!currentProfile) {
    showScreen("auth-screen");
    $("login-form").hidden = true;
    $("register-form").hidden = true;
    setMessage("auth-message", "Please create a profile before continuing.");
    $("register-form").hidden = false;
    $("show-login").hidden = true;
    $("show-register").hidden = true;
    return;
  }

  $("login-form").hidden = false;
  $("register-form").hidden = true;
  $("show-login").hidden = false;
  $("show-register").hidden = false;

  renderHomeProfile();
  showScreen("home-screen");
  setConnection("Connected");
}

function switchAuthTab(register) {
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

  if (!validProfile(name, selectedRegisterAvatar)) {
    setMessage("auth-message", "Choose a player name and avatar.", "error");
    return;
  }

  setBusy(true);
  try {
    const credential = await createUserWithEmailAndPassword(auth, email, password);
    currentUser = credential.user;

    currentProfile = {
      displayName: name,
      avatar: selectedRegisterAvatar,
      updatedAt: Date.now()
    };

    await set(ref(db, `users/${currentUser.uid}`), currentProfile);
    renderHomeProfile();
    showScreen("home-screen");
    setMessage("home-message", "Your account is ready!", "success");
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

function friendlyError(error) {
  const messages = {
    "auth/invalid-credential": "Your email or password is incorrect.",
    "auth/email-already-in-use": "An account already uses that email.",
    "auth/invalid-email": "Enter a valid email address.",
    "auth/weak-password": "Your password must be at least 6 characters.",
    "auth/too-many-requests": "Too many attempts. Please wait a while and try again.",
    "auth/network-request-failed": "Network error. Check your internet connection.",
    "PERMISSION_DENIED": "Firebase denied access. Check your database security rules."
  };

  return messages[error.code] || error.message || "Something went wrong.";
}

async function createRoom() {
  if (busy || !currentUser || !currentProfile) return;

  setBusy(true);
  setMessage("home-message", "Creating your room...");

  try {
    for (let attempt = 0; attempt < 10; attempt++) {
      const code = randomCode();
      const roomRef = ref(db, `rooms/${code}`);

      const result = await runTransaction(roomRef, existing => {
        if (existing !== null) return;
        return {
          code,
          hostUid: currentUser.uid,
          status: "lobby",
          createdAt: Date.now(),
          players: {
            [currentUser.uid]: {
              displayName: currentProfile.displayName,
              avatar: currentProfile.avatar,
              joinedAt: Date.now()
            }
          }
        };
      }, { applyLocally: false });

      if (result.committed) {
        enterRoom(code);
        return;
      }
    }

    throw new Error("Couldn't find an available room code. Please try again.");
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
    const roomRef = ref(db, `rooms/${code}`);
    const snapshot = await get(roomRef);

    if (!snapshot.exists()) {
      throw new Error("That room doesn't exist. Check the code.");
    }

    const room = snapshot.val();

    if (room.status !== "lobby") {
      throw new Error("That game has already started.");
    }

    const players = room.players || {};

    if (!players[currentUser.uid] && Object.keys(players).length >= MAX_PLAYERS) {
      throw new Error("That room is full.");
    }

    await set(ref(db, `rooms/${code}/players/${currentUser.uid}`), {
      displayName: currentProfile.displayName,
      avatar: currentProfile.avatar,
      joinedAt: Date.now()
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

function enterRoom(code) {
  if (stopRoomListener) stopRoomListener();

  currentRoomCode = code;
  $("display-room-code").textContent = code;
  showScreen("lobby-screen");
  setMessage("lobby-message", "Connecting to the waiting room...");

  const roomRef = ref(db, `rooms/${code}`);

  stopRoomListener = onValue(roomRef, snapshot => {
    if (!snapshot.exists()) {
      currentRoomCode = null;
      currentRoom = null;
      stopRoomListener = null;
      showScreen("home-screen");
      setMessage("home-message", "This room has been closed.");
      return;
    }

    currentRoom = snapshot.val();

    if (currentRoom.status === "playing") {
      showScreen("game-screen");
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
  if (!currentRoom) return;

  const players = Object.entries(currentRoom.players || {})
    .sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0));

  const isHost = currentRoom.hostUid === currentUser?.uid;
  const count = players.length;

  $("display-room-code").textContent = currentRoomCode;
  $("player-count").textContent = `${count} / ${MAX_PLAYERS} players`;
  $("lobby-status").textContent = isHost ? "You are the host" : "Waiting";
  $("lobby-hint").textContent = isHost
    ? count < MIN_PLAYERS
      ? `You need at least ${MIN_PLAYERS} players to start. Invite your friends!`
      : "Everyone ready? You can start when you're happy with the lobby."
    : "Waiting for the host to start the game...";

  $("start-game").disabled = !isHost || count < MIN_PLAYERS || busy;

  const list = $("players-list");
  list.replaceChildren();

  players.forEach(([uid, player]) => {
    const card = document.createElement("div");
    card.className = "player-card";

    const avatar = document.createElement("div");
    avatar.className = "player-avatar";
    avatar.textContent = player.avatar || "🦇";

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
  try {
    await navigator.clipboard.writeText(currentRoomCode);
    $("copy-code").textContent = "Copied!";
    setTimeout(() => $("copy-code").textContent = "Copy code", 1500);
  } catch {
    setMessage("lobby-message", `Your room code is ${currentRoomCode}.`);
  }
});

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
        const nextHost = otherPlayers[0];
        await update(ref(db, `rooms/${code}`), {
          hostUid: nextHost
        });
        await remove(ref(db, `rooms/${code}/players/${uid}`));
      }
    } else {
      await remove(ref(db, `rooms/${code}/players/${uid}`));
    }
  } catch (error) {
    setMessage("lobby-message", friendlyError(error), "error");
    return;
  } finally {
    setBusy(false);
  }

  if (stopRoomListener) stopRoomListener();
  stopRoomListener = null;
  currentRoomCode = null;
  currentRoom = null;
  showScreen("home-screen");
}

$("leave-room").addEventListener("click", leaveRoom);

$("edit-profile").addEventListener("click", () => {
  $("profile-editor").hidden = false;
  renderHomeProfile();
});

$("cancel-profile").addEventListener("click", () => {
  $("profile-editor").hidden = true;
});

$("profile-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (busy) return;

  setBusy(true);
  try {
    await saveProfile($("profile-name").value, selectedProfileAvatar);
    $("profile-editor").hidden = true;
    setMessage("home-message", "Profile updated!", "success");
  } catch (error) {
    setMessage("home-message", friendlyError(error), "error");
  } finally {
    setBusy(false);
  }
});

$("logout").addEventListener("click", async () => {
  if (currentRoomCode) await leaveRoom();
  await signOut(auth);
});

$("start-game").addEventListener("click", async () => {
  if (!currentRoom || currentRoom.hostUid !== currentUser?.uid) return;

  setMessage("lobby-message",
    "The lobby is ready! The gameplay engine will be added in the next stage.");
});

$("return-lobby").addEventListener("click", () => {
  if (currentRoomCode) showScreen("lobby-screen");
  else showScreen("home-screen");
});

onAuthStateChanged(auth, async user => {
  currentUser = user;

  if (!user) {
    if (stopRoomListener) stopRoomListener();
    stopRoomListener = null;
    currentProfile = null;
    currentRoomCode = null;
    currentRoom = null;
    showScreen("auth-screen");
    switchAuthTab(false);
    setConnection("Signed out");
    return;
  }

  setConnection("Loading profile...");

  try {
    await loadProfile(user);
  } catch (error) {
    showScreen("auth-screen");
    setMessage("auth-message", friendlyError(error), "error");
    setConnection("Connection error");
  }
});

renderAvatarPickers();
