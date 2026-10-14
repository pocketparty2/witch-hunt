import { initializeApp } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js";
import {
  getAuth,
  setPersistence,
  browserLocalPersistence
} from "https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-database.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-storage.js";

const firebaseConfig = {
  apiKey: "AIzaSyDnDxTwg6mBoUjHiSsXdkQyYs9kkhVAVdU",
  authDomain: "witch-hunt-5bd40.firebaseapp.com",

  // Keep the REAL database URL that works in your current version.
  databaseURL: "https://witch-hunt-5bd40-default-rtdb.europe-west1.firebasedatabase.app/",

  projectId: "witch-hunt-5bd40",
  storageBucket: "witch-hunt-5bd40.firebasestorage.app",
  messagingSenderId: "763008278485",
  appId: "1:763008278485:web:9870ee02974f66e8cf675c",
  measurementId: "G-E7GWJ4LH0G"
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const authReady = setPersistence(auth, browserLocalPersistence);
export const db = getDatabase(
  app,
  "https://witch-hunt-5bd40-default-rtdb.europe-west1.firebasedatabase.app/"
);
export const storage = getStorage(app);
