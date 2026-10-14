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

import { auth, authReady, db } from "./firebase.js";

const $ = id => document.getElementById(id);

const MAX_PLAYERS = 12;
const MIN_PLAYERS = 5;
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;
const MAX_COMPRESSED_LENGTH = 35000;

const ALLOWED_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp"
];

let currentUser = null;
let currentProfile = null;
let currentRoomCode = null;
let currentRoom = null;
let selectedRegisterFile = null;
let selectedProfileFile = null;
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

  document.querySelectorAll(
    "#login-form button[type='submit'], " +
    "#register-form button[type='submit'], " +
    "#profile-form button[type='submit'], " +
    "#join-form button[type='submit'], " +
    "#create-room, #start-game"
  ).forEach(button => {
    button.disabled = value;
  });
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

function validateImage(file) {
  if (!file) {
    throw new Error("Please choose a profile picture first.");
  }

  if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
    throw new Error("Choose a JPG, PNG, GIF or WebP image.");
  }

  if (file.size > MAX_IMAGE_SIZE) {
    throw new Error("Your original image must be 5 MB or smaller.");
  }

  return true;
}

// Compress the selected image in the browser.
// No Firebase Storage or external image hosting is used.
async function uploadAvatar(file) {
  validateImage(file);

  const objectUrl = URL.createObjectURL(file);

  try {
    const image = new Image();
    image.src = objectUrl;

    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(
        new Error("This picture couldn't be opened. Try another image.")
      );
    });

    const sourceWidth = image.naturalWidth;
    const sourceHeight = image.naturalHeight;

    if (!sourceWidth || !sourceHeight) {
      throw new Error("This picture appears to be invalid.");
    }

    // Crop to a centred square so profile pictures display consistently.
    const cropSize = Math.min(sourceWidth, sourceHeight);
    const sourceX = (sourceWidth - cropSize) / 2;
    const sourceY = (sourceHeight - cropSize) / 2;

    // Try a few small sizes and quality levels to keep database usage low.
    const attempts = [
      { size: 128, quality: 0.68 },
      { size: 128, quality: 0.58 },
      { size: 112, quality: 0.55 },
      { size: 96, quality: 0.50 }
    ];

    for (const attempt of attempts) {
      const canvas = document.createElement("canvas");
      canvas.width = attempt.size;
      canvas.height = attempt.size;

      const context = canvas.getContext("2d");

      if (!context) {
        throw new Error("Your browser couldn't process the picture.");
      }

      // JPEG has no transparency, so transparent areas become white.
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, attempt.size, attempt.size);

      context.drawImage(
        image,
        sourceX,
        sourceY,
        cropSize,
        cropSize,
        0,
        0,
        attempt.size,
        attempt.size
      );

      const dataUrl = canvas.toDataURL("image/jpeg", attempt.quality);

      if (dataUrl.length <= MAX_COMPRESSED_LENGTH) {
        return dataUrl;
      }
    }

    throw new Error(
      "This picture couldn't be compressed enough. Please try a simpler picture."
    );
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

  if (fileOrUrl instanceof File) {
    image.src = URL.createObjectURL(fileOrUrl);
  } else {
    image.src = fileOrUrl;
  }

  image.onerror = () => {
    container.replaceChildren();
    const placeholder = document.createElement("span");
    placeholder.className = "photo-placeholder";
    placeholder.textContent = "Image unavailable";
    container.appendChild(placeholder);
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

    image.onerror = () => {
      container.replaceChildren();
      const fallback = document.createElement("span");
      fallback.className = "photo-placeholder";
      fallback.textContent = "?";
      container.appendChild(fallback);
    };

    container.appendChild(image);
    return;
  }

  const fallback = document.createElement("span");
  fallback.className = "photo-placeholder";
  fallback.textContent = "👤";
  container.appendChild(fallback);
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
      } catch (error) {
        setMessage(
          previewId === "register-avatar-preview"
            ? "auth-message"
            : "home-message",
          error.message,
          "error"
        );
      }

      // Clearing the input allows the same file to be selected again.
      event.target.value = "";
    });
  });
}

connectPhotoPicker(
  "register-avatar-file",
  "register-camera-file",
  "register-avatar-preview",
  file => {
    selectedRegisterFile = file;
  }
);

connectPhotoPicker(
  "profile-avatar-file",
  "profile-camera-file",
  "profile-avatar-preview",
  file => {
    selectedProfileFile = file;
  }
);

function validProfile(name, profile) {
  return typeof name === "string" &&
    name.trim().length >= 1 &&
    name.trim().length <= 20 &&
    profile &&
    (typeof profile.avatarUrl === "string" ||
      typeof profile.avatar === "string");
}

async function updateRoomPlayerProfile(profile) {
  if (!currentRoomCode || !currentUser) return;

  await update(
    ref(db, `rooms/${currentRoomCode}/players/${currentUser.uid}`),
    {
      displayName: profile.displayName,
      avatarUrl: profile.avatarUrl || null
    }
  );
}

async function saveProfile(name, file = null) {
  const clean = cleanName(name);

  if (!clean || clean.length > 20) {
    throw new Error("Your player name must be 1–20 characters.");
  }

  let avatarUrl = currentProfile?.avatarUrl || null;

  if (file) {
    avatarUrl = await uploadAvatar(file);
  }

  if (!avatarUrl) {
    throw new Error("Please choose a profile picture.");
  }

  const profile = {
    displayName: clean,
    avatarUrl,
    updatedAt: Date.now()
  };

  await set(ref(db, `users/${currentUser.uid}`), profile);
  currentProfile = profile;

  await updateRoomPlayerProfile(profile);
  renderHomeProfile();
}

function renderHomeProfile() {
  if (!currentProfile) return;

  $("home-name").textContent = currentProfile.displayName || "Player";
  showAvatar($("home-avatar"), currentProfile.avatarUrl || null);
  $("profile-name").value = currentProfile.displayName || "";

  if (!selectedProfileFile) {
    showPhotoPreview(
      "profile-avatar-preview",
      currentProfile.avatarUrl || null
    );
  }
}

async function loadProfile(user) {
  const snapshot = await get(ref(db, `users/${user.uid}`));

  if (!snapshot.exists()) {
    currentProfile = null;
    showScreen("auth-screen");
    $("login-form").hidden = true;
    $("register-form").hidden = false;
    $("show-login").hidden = true;
    $("show-register").hidden = true;
    setMessage(
      "auth-message",
      "Your account has no saved profile yet. Choose a name and picture, then contact the site owner if you cannot finish setup."
    );
    return;
  }

  const profile = snapshot.val();

  if (!validProfile(profile.displayName, profile)) {
    throw new Error(
      "Your saved profile is incomplete. Please contact the site owner."
    );
  }

  currentProfile = profile;

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

  if (!name) {
    setMessage("auth-message", "Enter a player name.", "error");
    return;
  }

  if (!selectedRegisterFile) {
    setMessage(
      "auth-message",
      "Please choose or take a profile picture.",
      "error"
    );
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

    const credential = await createUserWithEmailAndPassword(
      auth,
      email,
      password
    );

    currentUser = credential.user;

    const avatarUrl = await uploadAvatar(selectedRegisterFile);

    currentProfile = {
      displayName: name,
      avatarUrl,
      updatedAt: Date.now()
    };

    await set(ref(db, `users/${currentUser.uid}`), currentProfile);

    selectedRegisterFile = null;
    $("register-form").reset();

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

function friendlyError(error) {
  const messages = {
    "auth/invalid-credential":
      "Your email or password is incorrect.",
    "auth/email-already-in-use":
      "An account already uses that email.",
    "auth/invalid-email":
      "Enter a valid email address.",
    "auth/weak-password":
      "Your password must be at least 6 characters.",
    "auth/too-many-requests":
      "Too many attempts. Please wait a while and try again.",
    "auth/network-request-failed":
      "Network error. Check your internet connection.",
    "PERMISSION_DENIED":
      "Firebase denied access. Check your database security rules."
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
              avatarUrl: currentProfile.avatarUrl || null,
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

    throw new Error(
      "Couldn't find an available room code. Please try again."
    );
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

    if (
      !players[currentUser.uid] &&
      Object.keys(players).length >= MAX_PLAYERS
    ) {
      throw new Error("That room is full.");
    }

    await set(ref(db, `rooms/${code}/players/${currentUser.uid}`), {
      displayName: currentProfile.displayName,
      avatarUrl: currentProfile.avatarUrl || null,
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
    showAvatar(avatar, player.avatarUrl || null);

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
      const otherPlayers = Object.keys(room.players || {})
        .filter(id => id !== uid);

      if (otherPlayers.length === 0) {
        await remove(ref(db, `rooms/${code}`));
      } else {
        await update(ref(db, `rooms/${code}`), {
          hostUid: otherPlayers[0]
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
  if (currentRoomCode) await leaveRoom();
  await signOut(auth);
});

$("start-game").addEventListener("click", async () => {
  if (!currentRoom || currentRoom.hostUid !== currentUser?.uid) return;

  setMessage(
    "lobby-message",
    "The lobby is ready! The gameplay engine will be added in the next stage."
  );
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
    await authReady;
    await loadProfile(user);
  } catch (error) {
    showScreen("auth-screen");
    setMessage("auth-message", friendlyError(error), "error");
    setConnection("Connection error");
  }
});
