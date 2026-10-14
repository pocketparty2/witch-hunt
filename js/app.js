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

const registerSubmitButton = $("register-form")
  .querySelector("button[type='submit']");

const originalRegisterButtonText =
  registerSubmitButton?.textContent || "Create account";

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
    "auth-screen",
    "home-screen",
    "lobby-screen",
    "game-screen"
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

  if (!value && currentRoom?.status === "lobby") {
    renderLobby();
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
  let code = "";

  for (let i = 0; i < 4; i++) {
    code += letters[Math.floor(Math.random() * letters.length)];
  }

  return code;
}

function friendlyError(error) {
  const code = error?.code || "";

  const messages = {
    "auth/invalid-credential":
      "Your email or password is incorrect.",
    "auth/email-already-in-use":
      "An account already uses that email. Choose Log in, or finish setting up the account if you are already signed in.",
    "auth/invalid-email":
      "Enter a valid email address.",
    "auth/weak-password":
      "Your password must be at least 6 characters.",
    "auth/too-many-requests":
      "Too many attempts. Please wait a while and try again.",
    "auth/network-request-failed":
      "Network error. Check your internet connection.",
    "PERMISSION_DENIED":
      "Firebase denied access. Check your published database rules.",
    "database/permission-denied":
      "Firebase denied access. Check your published Realtime Database rules."
  };

  if (messages[code]) return messages[code];

  if (error?.message?.includes("PERMISSION_DENIED")) {
    return "Firebase denied access. Check your published Realtime Database rules.";
  }

  return error?.message || "Something went wrong.";
}

/* -------------------------------------------------------
   PROFILE PICTURES
------------------------------------------------------- */

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

    const cropSize = Math.min(sourceWidth, sourceHeight);
    const sourceX = (sourceWidth - cropSize) / 2;
    const sourceY = (sourceHeight - cropSize) / 2;

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

        setMessage(
          previewId === "register-avatar-preview"
            ? "auth-message"
            : "home-message"
        );
      } catch (error) {
        setMessage(
          previewId === "register-avatar-preview"
            ? "auth-message"
            : "home-message",
          error.message,
          "error"
        );
      }

      event.target.value = "";
    });
  });
}

connectPhotoPicker(
  "register-avatar-file",
  "register-camera-file",
  "register-avatar-preview",
  file => { selectedRegisterFile = file; }
);

connectPhotoPicker(
  "profile-avatar-file",
  "profile-camera-file",
  "profile-avatar-preview",
  file => { selectedProfileFile = file; }
);

/* -------------------------------------------------------
   PLAYER PROFILES
------------------------------------------------------- */

function validProfile(name, profile) {
  const avatarUrl = profile?.avatarUrl || profile?.avatar;

  return typeof name === "string" &&
    name.trim().length >= 1 &&
    name.trim().length <= 20 &&
    typeof avatarUrl === "string" &&
    avatarUrl.length > 0;
}

async function updateRoomPlayerProfile(profile) {
  if (!currentRoomCode || !currentUser) return;

  await update(
    ref(db, `rooms/${currentRoomCode}/players/${currentUser.uid}`),
    {
      displayName: profile.displayName,
      avatarUrl: profile.avatarUrl || profile.avatar || null
    }
  );
}

async function saveProfile(name, file = null) {
  if (!currentUser) {
    throw new Error("You must be logged in to save your profile.");
  }

  const clean = cleanName(name);

  if (!clean) {
    throw new Error("Your player name must be 1–20 characters.");
  }

  let avatarUrl =
    currentProfile?.avatarUrl || currentProfile?.avatar || null;

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

  showAvatar(
    $("home-avatar"),
    currentProfile.avatarUrl || currentProfile.avatar || null
  );

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
      "Your account already exists, but its profile hasn't been saved. Choose a player name and picture to finish setting it up."
    );

    setConnection("Profile setup required");
    return;
  }

  const profile = snapshot.val();

  if (!validProfile(profile.displayName, profile)) {
    throw new Error(
      "Your saved profile is incomplete. Please choose a profile picture and finish setting up your profile."
    );
  }

  if (!profile.avatarUrl && profile.avatar) {
    profile.avatarUrl = profile.avatar;
  }

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
   ACCOUNT REGISTRATION AND LOGIN
------------------------------------------------------- */

async function switchAuthTab(register) {
  if (busy) return;

  if (!register && profileSetupMode && auth.currentUser) {
    setProfileSetupMode(false);
    await signOut(auth);
    return;
  }

  if (!auth.currentUser) {
    setProfileSetupMode(false);
  }

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
    setMessage("auth-message", "Please choose or take a profile picture.", "error");
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
      if (!auth.currentUser) {
        throw new Error("Your session has expired. Please log in again.");
      }

      currentUser = auth.currentUser;
    } else {
      const credential = await createUserWithEmailAndPassword(
        auth,
        email,
        password
      );

      currentUser = credential.user;
    }

    const avatarUrl = await uploadAvatar(selectedRegisterFile);

    const profile = {
      displayName: name,
      avatarUrl,
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
      const roomRef = ref(db, `rooms/${code}`);

      const result = await runTransaction(
        roomRef,
        existing => {
          if (existing !== null) return;

          return {
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
          };
        },
        { applyLocally: false }
      );

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

    if (
      !players[currentUser.uid] &&
      Object.keys(players).length >= MAX_PLAYERS
    ) {
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

  resetRoleCard();

  $("display-room-code").textContent = code;
  showScreen("lobby-screen");

  setMessage("lobby-message", "Connecting to the waiting room...");

  stopRoomListener = onValue(
    ref(db, `rooms/${code}`),
    snapshot => {
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

        if (currentSecret && loadedSecretFor === `${code}:${currentUser?.uid}`) {
          renderRole(currentSecret);
        } else {
          loadMySecret(code);
        }

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
    },
    error => {
      setMessage("lobby-message", friendlyError(error), "error");
    }
  );
}

function renderLobby() {
  if (!currentRoom || currentRoom.status !== "lobby") return;

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

  $("start-game").disabled =
    !isHost || count < MIN_PLAYERS || busy;

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

    setTimeout(() => {
      $("copy-code").textContent = "Copy code";
    }, 1500);
  } catch {
    setMessage("lobby-message", `Your room code is ${currentRoomCode}.`);
  }
});

/* -------------------------------------------------------
   ROLE ASSIGNMENT
------------------------------------------------------- */

function shuffled(items) {
  const result = [...items];

  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }

  return result;
}

function getWitchCount(playerCount) {
  return Math.max(2, Math.ceil(playerCount / 3));
}

async function startGame() {
  if (
    busy ||
    !currentRoom ||
    !currentRoomCode ||
    currentRoom.hostUid !== currentUser?.uid
  ) {
    return;
  }

  setBusy(true);
  setMessage("lobby-message", "Preparing the secret roles...");

  const code = currentRoomCode;
  const writtenUids = [];
  let gameStarted = false;

  try {
    const snapshot = await get(ref(db, `rooms/${code}`));

    if (!snapshot.exists()) {
      throw new Error("This room no longer exists.");
    }

    const room = snapshot.val();

    if (room.hostUid !== currentUser.uid) {
      throw new Error("Only the current host can start the game.");
    }

    if (room.status !== "lobby") {
      throw new Error("This game has already started.");
    }

    const players = Object.entries(room.players || {});

    if (players.length < MIN_PLAYERS) {
      throw new Error(`You need at least ${MIN_PLAYERS} players to start.`);
    }

    if (players.length > MAX_PLAYERS) {
      throw new Error(`A game can have no more than ${MAX_PLAYERS} players.`);
    }

    const randomisedPlayers = shuffled(players);
    const witchCount = getWitchCount(randomisedPlayers.length);

    if (witchCount + 1 >= randomisedPlayers.length) {
      throw new Error("There aren't enough players for these roles.");
    }

    const witchPlayers = randomisedPlayers.slice(0, witchCount);
    const oraclePlayer = randomisedPlayers[witchCount];

    const witchNames = {};

    witchPlayers.forEach(([uid, player]) => {
      witchNames[uid] = player.displayName || "Player";
    });

    const roles = {};

    randomisedPlayers.forEach(([uid]) => {
      roles[uid] = "townsperson";
    });

    witchPlayers.forEach(([uid]) => {
      roles[uid] = "witch";
    });

    roles[oraclePlayer[0]] = "oracle";

    const assignedAt = Date.now();

    /*
      Secret role records are written outside /rooms.
      The room is not marked as playing until all role records
      have been written successfully.
    */

    for (const [uid] of randomisedPlayers) {
      const role = roles[uid];

      const secret = {
        role,
        assignedAt
      };

      if (role === "witch") {
        secret.knownWitches = {};

        Object.entries(witchNames).forEach(([witchUid, name]) => {
          if (witchUid !== uid) {
            secret.knownWitches[witchUid] = name;
          }
        });
      }

      if (role === "oracle") {
        secret.knownWitches = { ...witchNames };
      }

      await set(ref(db, `playerSecrets/${code}/${uid}`), secret);
      writtenUids.push(uid);
    }

    await update(ref(db, `rooms/${code}`), {
      status: "playing",
      startedAt: assignedAt,
      playerCount: randomisedPlayers.length,
      witchCount
    });

    gameStarted = true;
    setMessage("lobby-message");
  } catch (error) {
    if (!gameStarted) {
      await Promise.all(
        writtenUids.map(uid =>
          remove(ref(db, `playerSecrets/${code}/${uid}`)).catch(() => {})
        )
      );
    }

    setMessage("lobby-message", friendlyError(error), "error");
  } finally {
    setBusy(false);
  }
}

$("start-game").addEventListener("click", startGame);

/* -------------------------------------------------------
   PERMANENT ROLE CARD
------------------------------------------------------- */

function resetRoleCard() {
  const card = $("role-card");

  card.className = "role-card";
  $("role-symbol").textContent = "🔮";
  $("role-status").textContent = "RETRIEVING YOUR ROLE";
  $("role-title").textContent = "Your secret role is being prepared...";
  $("role-description").textContent =
    "Your private role information is being retrieved from the village records.";

  $("known-witches-section").hidden = true;
  $("known-witches-title").textContent = "The Witches";
  $("known-witches-intro").textContent = "Keep this information secret.";
  $("known-witches-list").replaceChildren();

  $("role-error").hidden = true;
  $("role-error").textContent = "";
  $("retry-role").hidden = true;
}

function renderRoleLoading(message = "Your private role information is being retrieved.") {
  resetRoleCard();

  $("role-status").textContent = "RETRIEVING YOUR ROLE";
  $("role-title").textContent = "One moment...";
  $("role-description").textContent = message;
}

function renderRoleError(message) {
  $("role-status").textContent = "ROLE NOT LOADED";
  $("role-title").textContent = "Your role hasn't appeared yet";
  $("role-description").textContent =
    "Your game is running, but your private role record couldn't be loaded.";

  $("role-error").textContent = message;
  $("role-error").hidden = false;
  $("retry-role").hidden = false;
}

function renderKnownWitches(secret) {
  const section = $("known-witches-section");
  const list = $("known-witches-list");

  list.replaceChildren();

  const knownWitches = secret.knownWitches &&
    typeof secret.knownWitches === "object"
      ? Object.entries(secret.knownWitches)
      : [];

  if (knownWitches.length === 0) {
    $("known-witches-title").textContent =
      secret.role === "oracle" ? "The Witches" : "Your fellow Witches";

    $("known-witches-intro").textContent =
      "No Witch names were included in your role record. If you expected to see names, ask the host to check the game setup.";

    section.hidden = false;
    return;
  }

  $("known-witches-title").textContent =
    secret.role === "oracle" ? "The Witches" : "Your fellow Witches";

  $("known-witches-intro").textContent =
    secret.role === "oracle"
      ? "These are the players you must identify without revealing that you know."
      : "You are on the same side. Keep your identities hidden from the Town.";

  knownWitches.forEach(([uid, name]) => {
    const item = document.createElement("li");
    item.textContent = String(name || "Player");
    item.dataset.playerUid = uid;
    list.appendChild(item);
  });

  section.hidden = false;
}

function renderRole(secret) {
  currentSecret = secret;

  const card = $("role-card");

  card.className = "role-card";
  $("known-witches-section").hidden = true;
  $("known-witches-list").replaceChildren();
  $("role-error").hidden = true;
  $("retry-role").hidden = true;

  const roleDetails = {
    witch: {
      className: "role-witch",
      symbol: "🧙",
      status: "YOUR SECRET ROLE",
      title: "You are a Witch!",
      description:
        "Your job is to secretly work against the Town. When you're selected for a mission, you can choose to Succeed or Ruin it. Keep your identity hidden."
    },
    oracle: {
      className: "role-oracle",
      symbol: "🔮",
      status: "YOUR SECRET ROLE",
      title: "You are also the Oracle!",
      description:
        "You are a Townsperson with a secret advantage. You must help the Town complete its missions while keeping your identity hidden. If the Town wins, the Witches get one final chance to identify you and steal the victory."
    },
    townsperson: {
      className: "role-townsperson",
      symbol: "🏘️",
      status: "YOUR SECRET ROLE",
      title: "You are a Townsperson!",
      description:
        "Your goal is to help the Town complete its missions. Pay attention to players' decisions and work out who the Witches are. If you're selected for a mission, you must choose Succeed."
    }
  };

  const details = roleDetails[secret.role];

  if (!details) {
    renderRoleError("The role record contains an unknown role. Ask the host to check the game setup.");
    return;
  }

  card.classList.add(details.className);

  $("role-symbol").textContent = details.symbol;
  $("role-status").textContent = details.status;
  $("role-title").textContent = details.title;
  $("role-description").textContent = details.description;

  /*
    Witches and the Oracle get their known-Witch list
    directly inside the same permanent card.
    Ordinary Townspeople never see that list.
  */
  if (secret.role === "witch" || secret.role === "oracle") {
    renderKnownWitches(secret);
  }
}

async function loadMySecret(code, force = false) {
  if (!currentUser || !code) return;

  const uid = currentUser.uid;
  const key = `${code}:${uid}`;

  if (
    !force &&
    loadedSecretFor === key &&
    currentSecret
  ) {
    showScreen("game-screen");
    renderRole(currentSecret);
    return;
  }

  if (loadingSecretFor === key) return;

  const thisLoadVersion = ++secretLoadVersion;
  loadingSecretFor = key;

  showScreen("game-screen");
  renderRoleLoading();

  try {
    const snapshot = await get(
      ref(db, `playerSecrets/${code}/${uid}`)
    );

    /*
      Ignore a response if the player has left the room,
      signed out, or started loading a different room.
    */
    if (
      thisLoadVersion !== secretLoadVersion ||
      currentRoomCode !== code ||
      currentUser?.uid !== uid
    ) {
      return;
    }

    if (!snapshot.exists()) {
      throw new Error(
        "No private role record was found for your account. Ask the host to check that all roles were assigned, then try again."
      );
    }

    const secret = snapshot.val();

    if (!secret || !["witch", "townsperson", "oracle"].includes(secret.role)) {
      throw new Error(
        "Your private role record is invalid. Ask the host to check the game setup."
      );
    }

    /*
      Do not mark the role as loaded until it has been
      validated and can be rendered.
    */
    currentSecret = secret;
    loadedSecretFor = key;

    renderRole(secret);
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
    if (loadingSecretFor === key) {
      loadingSecretFor = null;
    }
  }
}

$("retry-role").addEventListener("click", () => {
  if (currentRoomCode && currentRoom?.status === "playing") {
    loadMySecret(currentRoomCode, true);
  }
});

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
    setMessage(
      room?.status === "lobby" ? "lobby-message" : "home-message",
      friendlyError(error),
      "error"
    );
    return;
  } finally {
    setBusy(false);
  }

  if (stopRoomListener) stopRoomListener();

  stopRoomListener = null;
  secretLoadVersion++;

  currentRoomCode = null;
  currentRoom = null;
  currentSecret = null;

  loadedSecretFor = null;
  loadingSecretFor = null;

  resetRoleCard();
  showScreen("home-screen");
}

$("leave-room").addEventListener("click", leaveRoom);

$("return-lobby").addEventListener("click", async () => {
  if (currentRoom?.status === "playing") {
    await leaveRoom();
    return;
  }

  if (currentRoomCode) {
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
    if (currentRoomCode) {
      await leaveRoom();
    }

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
