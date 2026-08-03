# LS Trivia

A live, host-run quiz game for team game nights — the third game in the LS
Engagement Games set (alongside Skwibble and Bingo). Reuses the same Firebase
project and the shared cross-game leaderboard.

## How it plays
- The **host** creates a game, picks a **category** (Mixed or one of 7),
  **difficulty** (Level 1–5), number of **questions**, and **seconds per
  question**. The host presents and controls the game and is **not scored**.
- **Players** join with a name + Employee ID and answer on their own devices.
- Each question shows four choices and a countdown. **Faster correct answers
  score more** (10–100 points, same scale as Skwibble/Bingo).
- After each question the correct answer is revealed with the running
  scoreboard. Highest total after all questions wins. Points feed the
  cross-game leaderboard under `byGame.trivia`.

## No repeats
Questions never repeat — within a game or across replays in the same room —
until the level's pool is used up, then it resets (host-authoritative,
persisted in `usedQ`).

## Answer security
Only the **host** loads `trivia-content.js` (the questions + answer key).
Players receive just the question text and choices via the database, so the
answer key never reaches players' browsers.

## Files
`index.html`, `styles.css`, `trivia.js`, `trivia-content.js`,
`firebase-config.js`.

## Your content (`trivia-content.js`)
7 categories × 5 levels × 10 questions. Each question is
`{ q, a: [four options], c: correctIndex }`. Edit freely; keep facts evergreen.

## One-time Firebase setup (Realtime Database → Rules)
Add a `trivia` path alongside the existing rules (`lb` should already be there
from the leaderboard):
```json
"trivia": { "$code": { ".read": "auth != null", ".write": "auth != null" } }
```

## Deploy
Commit the files and enable GitHub Pages from `main`; the game lives at
`https://<you>.github.io/ls-trivia/`.
