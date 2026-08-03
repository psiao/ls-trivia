// ---------------------------------------------------------------------------
// firebase-config.js
// Filled in with the "LS Engagement Games" project's web config.
// (These values are client-side and safe to include in a public web app —
// access is protected by the database rules, not by hiding these.)
// ---------------------------------------------------------------------------

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-database.js";

export const firebaseConfig = {
  apiKey: "AIzaSyCLXan01m-b8YQHL-j784dgbRWQCPB7AXg",
  authDomain: "ls-engagement-games.firebaseapp.com",
  databaseURL: "https://ls-engagement-games-default-rtdb.firebaseio.com",
  projectId: "ls-engagement-games",
  storageBucket: "ls-engagement-games.firebasestorage.app",
  messagingSenderId: "73517803847",
  appId: "1:73517803847:web:7ced08b49b48ff46a68462",
  measurementId: "G-QD8FK5QP9N",
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getDatabase(app);
