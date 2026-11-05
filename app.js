const $ = (selector) => document.querySelector(selector);
const settings = { operations: ["addition", "subtraction"], range: "single", questionCount: 10, cardPlayMode: "solo", voiceMode: "answer", cardSet: "たしざん①" };
const operationInfo = {
  addition: { symbol: "+", calculate: (a, b) => a + b },
  subtraction: { symbol: "−", calculate: (a, b) => a - b },
  // 追加時は問題生成のルールも operationGenerators に登録する。
  multiplication: { symbol: "×", calculate: (a, b) => a * b },
  division: { symbol: "÷", calculate: (a, b) => a / b },
};
let game = null;
let recognition = null;
let isListening = false;
let pendingMode = null;
let shootingStarTimer = null;
let cardTable = [];
let cardTableLoadPromise = null;
const LEARNING_STATS_KEY = "scpg-learning-stats";
function todayKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
function loadLearningStats() {
  try { return { sessions: [], totalCorrect: 0, cardLastTime: null, ...(JSON.parse(localStorage.getItem(LEARNING_STATS_KEY)) ?? {}) }; } catch (_) { return { sessions: [], totalCorrect: 0, cardLastTime: null }; }
}
function saveLearningStats(stats) {
  try { localStorage.setItem(LEARNING_STATS_KEY, JSON.stringify(stats)); } catch (_) { /* 保存できない環境でも学習は続ける。 */ }
}
function addCorrectToTotal() {
  const stats = loadLearningStats();
  stats.totalCorrect = (stats.totalCorrect ?? 0) + 1;
  saveLearningStats(stats);
}
function recordLearningResult(allAnswers) {
  if (!game.sessionId) return null;
  const stats = loadLearningStats();
  const correct = allAnswers.filter((answer) => answer.correct).length;
  if (game.firstCorrect === undefined) game.firstCorrect = correct;
  const record = { id: game.sessionId, date: todayKey(), mode: game.originalMode, total: allAnswers.length, firstCorrect: game.firstCorrect, finalCorrect: correct, completed: correct === allAnswers.length };
  const existing = stats.sessions.findIndex((session) => session.id === record.id);
  if (existing === -1) stats.sessions.push(record); else stats.sessions[existing] = record;
  saveLearningStats(stats);
  return stats;
}
function renderLearningStats(stats) {
  if (!stats) return;
  const completed = stats.sessions.filter((session) => session.completed).length;
  const days = new Set(stats.sessions.map((session) => session.date)).size;
  const cardLastTime = stats.cardLastTime ? `<p>けいさんカードの まえの きろく：<strong>${formatTime(stats.cardLastTime)}</strong></p>` : "";
  const content = `<h2>がくしゅうの きろく</h2><p>これまでの せいかい：<strong>${stats.totalCorrect ?? 0}もん</strong></p><p>さいごまで やりきった：<strong>${completed}かい</strong></p><p>れんしゅうしたひ：<strong>${days}にち</strong></p>${cardLastTime}`;
  document.querySelectorAll(".learning-stats").forEach((element) => { element.innerHTML = content; });
}

function showScreen(id) { document.querySelectorAll(".screen").forEach((screen) => screen.classList.remove("active")); $(id).classList.add("active"); if (id !== "#result-screen") stopShootingStars(); if (id === "#home-screen") renderLearningStats(loadLearningStats()); }
function randomInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function createQuestion(operation) {
  // 2けた設定では、足し算は答えが99以下、引き算はマイナスにならない問題だけを作る。
  if (settings.range === "twoDigit") {
    if (operation === "addition") {
      const total = randomInt(20, 99);
      const a = randomInt(10, total - 10);
      return { a, b: total - a, operation };
    }
    const a = randomInt(20, 99);
    return { a, b: randomInt(10, a), operation: "subtraction" };
  }
  if (operation === "addition") {
    if (settings.range === "singleTwoDigit") return { a: randomInt(0, 9), b: randomInt(0, 9), operation };
    const a = randomInt(0, 9); return { a, b: randomInt(0, 9 - a), operation };
  }
  const a = randomInt(0, 9); return { a, b: randomInt(0, a), operation: "subtraction" };
}
function answerOf(question) { return operationInfo[question.operation].calculate(question.a, question.b); }
function questionText(question) { return `${question.a} ${operationInfo[question.operation].symbol} ${question.b}`; }
function setupGame(mode) {
  const questions = mode === "cards" ? createCards(settings.cardSet) : Array.from({ length: settings.questionCount }, () => createQuestion(settings.operations[randomInt(0, settings.operations.length - 1)]));
  questions.forEach((question, index) => { question.id = index; });
  game = { mode, originalMode: mode, cardPlayMode: settings.cardPlayMode, sessionId: `${Date.now()}-${Math.random()}`, firstCorrect: undefined, questions, index: 0, answers: [], startedAt: Date.now(), wrongAttempts: 0, streak: 0, isSubmitting: false, awaitingNext: false };
  $("#game-message").textContent = cardMessage() ?? (mode === "test" ? "さいごまで がんばろう！" : "こたえを いれてね");
  showScreen("#game-screen"); renderQuestion();
}
function parseCardTable(csvText) {
  const lines = csvText.replace(/^\uFEFF/, "").trim().split(/\r?\n/);
  const headers = lines.shift().split(",").map((value) => value.trim());
  const columns = Object.fromEntries(headers.map((name, index) => [name, index]));
  if (["order", "set", "a", "operation", "b"].some((name) => columns[name] === undefined)) throw new Error("CSVの見出しに order,set,a,operation,b が必要です。");
  const rows = lines.filter((line) => line.trim()).map((line) => {
    const cells = line.split(",").map((value) => value.trim());
    const order = Number(cells[columns.order]), a = Number(cells[columns.a]), b = Number(cells[columns.b]);
    const operator = cells[columns.operation];
    if (!Number.isInteger(order) || !cells[columns.set] || !Number.isInteger(a) || !Number.isInteger(b) || !["+", "-"].includes(operator)) throw new Error(`CSVの行を読み取れません: ${line}`);
    return { order, set: cells[columns.set], a, b, operation: operator === "+" ? "addition" : "subtraction" };
  });
  if (!rows.length) throw new Error("CSVにカードの行がありません。");
  for (const setName of ["たしざん①", "ひきざん①", "たしざん②", "ひきざん②"]) {
    if (!rows.some((row) => row.set === setName)) throw new Error(`CSVに${setName}のカードがありません。`);
  }
  return rows;
}
function readSelectedCardTableFile() {
  const input = $("#card-table-file");
  return new Promise((resolve, reject) => {
    input.value = "";
    input.onchange = async () => {
      if (!input.files?.[0]) { reject(new Error("CSVファイルが選ばれていません。")); return; }
      try { resolve(parseCardTable(await input.files[0].text())); } catch (error) { reject(error); }
    };
    input.oncancel = () => reject(new Error("カードCSVの読み込みをキャンセルしました。"));
    input.click();
  });
}
async function loadCardTable() {
  if (cardTable.length) return cardTable;
  if (!cardTableLoadPromise) {
    cardTableLoadPromise = (async () => {
      try {
        if (location.protocol === "file:") return await readSelectedCardTableFile();
        const response = await fetch("table.csv");
        if (!response.ok) throw new Error(`table.csvを読み込めませんでした (${response.status})`);
        return parseCardTable(await response.text());
      } catch (error) {
        if (location.protocol === "file:") throw error;
        return await readSelectedCardTableFile();
      }
    })();
  }
  try { cardTable = await cardTableLoadPromise; return cardTable; }
  catch (error) { cardTableLoadPromise = null; throw error; }
}
function createCards(setName) {
  const cards = cardTable.filter((card) => card.set === setName).sort((left, right) => left.order - right.order).map(({ a, b, operation }) => ({ a, b, operation }));
  if (!cards.length) throw new Error(`${setName}のカードがtable.csvにありません。`);
  return cards;
}
function setAnswerLocked(locked) {
  game.isSubmitting = locked;
  $("#answer-input").disabled = locked;
  $("#submit-button").disabled = locked;
  $("#mic-button").disabled = locked;
  $("#card-wrong-button").disabled = locked;
  $("#card-correct-button").disabled = locked;
  document.querySelectorAll("[data-number-key], [data-number-delete]").forEach((button) => { button.disabled = locked; });
  if (locked) stopListening();
}
function renderQuestion() {
  const question = game.questions[game.index];
  $("#question").textContent = `${questionText(question)} =`;
  $("#progress-label").textContent = game.mode === "cards" ? `${game.index + 1} / ${game.questions.length} まい` : `${game.index + 1} / ${game.questions.length} もん`;
  $("#progress-fill").style.width = `${(game.index / game.questions.length) * 100}%`;
  const adultCards = game.mode === "cards" && game.cardPlayMode === "adult";
  $("#answer-form").hidden = adultCards;
  $(".number-keypad").hidden = settings.voiceMode === "equation" && !adultCards;
  $("#card-judge-controls").hidden = !adultCards;
  $("#voice-hint").hidden = adultCards;
  setAnswerLocked(false);
  game.awaitingNext = false;
  $("#submit-button").textContent = "こたえる";
  $("#answer-input").value = "";
}
function cardMessage() {
  if (game?.mode !== "cards") return null;
  return game.cardPlayMode === "adult" ? `${settings.cardSet}。こえに だして こたえよう。おとなの ひとが ○か×を おしてね` : `${settings.cardSet}。せいかいするまで、つぎのカードには すすまないよ`;
}
function judgeCard(isCorrect) {
  if (!game || game.mode !== "cards" || game.cardPlayMode !== "adult" || game.isSubmitting) return;
  setAnswerLocked(true);
  if (!isCorrect) { game.wrongAttempts += 1; game.streak = 0; feedback("もういちど、ゆっくり いってみよう", "encourage"); setTimeout(() => setAnswerLocked(false), 250); return; }
  game.streak += 1; addCorrectToTotal(); game.correctCelebrations = (game.correctCelebrations ?? 0) + 1; showCorrectEffect(game.correctCelebrations, game.streak); feedback("せいかい！", "correct"); setTimeout(nextQuestion, 450);
}
function submitAnswer(event) {
  event.preventDefault(); if (!game) return;
  if (game.awaitingNext) { game.awaitingNext = false; game.isSubmitting = false; nextQuestion(); return; }
  if (game.isSubmitting) return;
  const raw = $("#answer-input").value.trim();
  const question = game.questions[game.index];
  const equationMode = settings.voiceMode === "equation" && game.mode !== "cards";
  if (!equationMode && !/^\d+$/.test(raw)) { feedback("すうじを いれてね", "incorrect"); return; }
  if (equationMode && !raw) { feedback("しきと こたえを いってね", "incorrect"); return; }
  setAnswerLocked(true);
  const isCorrect = equationMode ? isCorrectSpokenEquation(raw, question) : Number(raw) === answerOf(question);
  if (game.mode === "cards") {
    if (!isCorrect) { game.wrongAttempts += 1; game.streak = 0; feedback("おしい！ もういちど やってみよう", "incorrect"); setTimeout(() => { setAnswerLocked(false); }, 450); return; }
    game.streak += 1; addCorrectToTotal(); game.correctCelebrations = (game.correctCelebrations ?? 0) + 1; showCorrectEffect(game.correctCelebrations, game.streak); feedback("せいかい！", "correct"); setTimeout(nextQuestion, 450); return;
  }
  game.answers.push({ question: { ...question }, given: equationMode ? (isCorrect ? answerOf(question) : raw) : Number(raw), correct: isCorrect });
  if (game.mode === "practice" || game.mode === "review") {
    game.streak = isCorrect ? game.streak + 1 : 0;
    if (isCorrect) { addCorrectToTotal(); game.correctCelebrations = (game.correctCelebrations ?? 0) + 1; showCorrectEffect(game.correctCelebrations, game.streak); feedback("せいかい！ いいね！", "correct"); setTimeout(nextQuestion, 800); }
    else { game.awaitingNext = true; feedback("だいじょうぶ。つぎのもんだいも やってみよう！", "encourage"); $("#submit-button").disabled = false; $("#submit-button").textContent = "つぎへ"; }
  }
  else { if (isCorrect) addCorrectToTotal(); nextQuestion(); }
}
function showCorrectEffect(correctCount, streak) {
  const layer = $("#effect-layer");
  // その回の正解が増えるほど、星の数と大きさを少しずつ増やす。
  const level = Math.min(correctCount, 10);
  const count = Math.min(2 + level, 12);
  const size = Math.min(1 + (level - 1) * 0.09, 1.8);
  for (let index = 0; index < count; index += 1) {
    const star = document.createElement("span");
    star.className = streak >= 3 ? "effect-star rainbow-star" : "effect-star";
    star.textContent = "★";
    star.style.fontSize = `${2 * size}rem`;
    const endX = randomInt(-180, 180);
    const endY = randomInt(25, 130);
    const lift = randomInt(130, 210) + level * 6;
    const frames = Array.from({ length: 15 }, (_, step) => {
      const t = step / 14;
      // x は一定速度、y は y = 終点×t - 4×高さ×t×(1-t) の放物線。
      const y = endY * t - 4 * lift * t * (1 - t);
      return { offset: t, transform: `translate(-50%, -50%) translate(${endX * t}px, ${y}px) scale(${0.25 + 0.85 * t}) rotate(${190 * t}deg)`, opacity: t < 0.12 ? t / 0.12 : 1 - (t - 0.12) / 0.88 };
    });
    layer.append(star); star.animate(frames, { duration: 900 + level * 12, delay: index * 45, easing: "linear", fill: "both" }); setTimeout(() => star.remove(), 1200);
  }
  if (streak >= 3) {
    const badge = document.createElement("div"); badge.className = "streak-badge"; badge.textContent = `${streak}れんぞく せいかい！`;
    layer.append(badge); setTimeout(() => badge.remove(), 1200);
  }
}
function stopShootingStars() {
  if (shootingStarTimer !== null) clearInterval(shootingStarTimer);
  shootingStarTimer = null;
  document.querySelectorAll(".shooting-star").forEach((star) => star.remove());
}
function addShootingStar() {
  if (shootingStarTimer === null) return;
  const star = document.createElement("span");
  star.className = "shooting-star";
  star.textContent = "★";
  star.style.setProperty("--left", `${randomInt(-8, 92)}vw`);
  star.style.setProperty("--drift", `${randomInt(90, 250)}px`);
  star.style.setProperty("--drop", `${randomInt(300, 620)}px`);
  star.style.setProperty("--turn", `${randomInt(380, 900)}deg`);
  star.style.setProperty("--size", `${randomInt(18, 38)}px`);
  star.style.setProperty("--color", ["#ffd75a", "#ff9ab7", "#7cd6f4", "#a99aff", "#87d9a2"][randomInt(0, 4)]);
  $("#effect-layer").append(star);
  setTimeout(() => star.remove(), 2000);
}
function startShootingStars() {
  if (!$("#result-screen").classList.contains("active")) return;
  stopShootingStars();
  shootingStarTimer = setInterval(() => {
    const count = randomInt(2, 4);
    for (let index = 0; index < count; index += 1) setTimeout(addShootingStar, index * 130);
  }, 850);
  for (let index = 0; index < 8; index += 1) setTimeout(addShootingStar, index * 100);
}
function feedback(text, className) { const el = $("#game-message"); el.textContent = text; el.className = `game-message ${className}`; if (className === "incorrect") { $(".game-card").classList.add("shake"); setTimeout(() => $(".game-card").classList.remove("shake"), 350); } }
function nextQuestion() { game.index += 1; if (game.index >= game.questions.length) finishGame(); else { $("#game-message").className = "game-message"; $("#game-message").textContent = cardMessage() ?? "こたえを いれてね"; renderQuestion(); } }
function formatTime(milliseconds) { const seconds = Math.max(1, Math.round(milliseconds / 1000)); return `${Math.floor(seconds / 60)}ふん${String(seconds % 60).padStart(2, "0")}びょう`; }
function finishGame() {
  $("#progress-fill").style.width = "100%"; showScreen("#result-screen");
  if (game.mode === "cards") return showCardResult();
  // 復習では、最初の10問の回答記録を今回の回答で更新してから集計する。
  const allAnswers = game.originalAnswers
    ? game.originalAnswers.map((original) => game.answers.find((answer) => answer.question.id === original.question.id) ?? original)
    : game.answers;
  const total = allAnswers.length;
  const correct = allAnswers.filter((answer) => answer.correct).length;
  const missed = allAnswers.filter((answer) => !answer.correct);
  const reviewQuestions = missed.map((answer) => ({ ...answer.question }));
  $("#result-kicker").textContent = "テスト・れんしゅう かんりょう！"; $("#result-title").textContent = correct === total ? "ぜんぶ せいかい！" : "さいごまで できたね！";
  $("#result-summary").innerHTML = `<strong>${correct}もん できたよ</strong><br><span>${total}もん ちゅう ${correct}もん せいかい</span>`;
  showQuestionList(allAnswers);
  recordLearningResult(allAnswers);
  if (correct === total) setTimeout(startShootingStars, 150);
  $("#result-action").innerHTML = missed.length ? `<button class="primary-button" id="review-button" type="button">まちがえたもんだいを れんしゅう</button>` : `<p class="record">すてき！ またちがうもんだいにも ちょうせんしてね</p>`;
  $("#review-button")?.addEventListener("click", () => {
    game = { mode: "review", originalMode: game.originalMode, sessionId: game.sessionId, firstCorrect: game.firstCorrect, questions: reviewQuestions, index: 0, answers: [], startedAt: Date.now(), wrongAttempts: 0, streak: 0, isSubmitting: false, awaitingNext: false, originalAnswers: allAnswers };
    $("#game-message").className = "game-message";
    $("#game-message").textContent = "こたえを いれてね";
    showScreen("#game-screen"); renderQuestion();
  });
}
function showQuestionList(answers) {
  const cells = answers.map((answer) => {
    const expression = questionText(answer.question);
    const equation = answer.correct ? `${expression} = ${answerOf(answer.question)}` : `${expression} = ${answer.given}`;
    return `<td class="answer-mark ${answer.correct ? "answer-correct" : "answer-incorrect"}">${answer.correct ? "○" : "×"}</td><td class="answer-equation ${answer.correct ? "answer-correct" : "answer-incorrect"}">${equation}</td>`;
  });
  const rows = [];
  for (let index = 0; index < cells.length; index += 2) {
    rows.push(`<tr>${cells[index] ?? "<td></td><td></td>"}${cells[index + 1] ?? "<td></td><td></td>"}</tr>`);
  }
  $("#question-list").innerHTML = `<h2>もんだい いちらん</h2><table><tbody>${rows.join("")}</tbody></table>`;
}
function showCardResult() {
  $("#question-list").innerHTML = "";
  const elapsed = Date.now() - game.startedAt;
  const stats = loadLearningStats(); stats.cardLastTime = elapsed; saveLearningStats(stats);
  const key = "scpg-card-best"; const oldBest = Number(localStorage.getItem(key) || 0); const isBest = !oldBest || elapsed < oldBest; if (isBest) localStorage.setItem(key, String(elapsed));
  $("#result-kicker").textContent = "けいさんカード かんりょう！"; $("#result-title").textContent = "ぜんぶ できたね！";
  $("#result-summary").innerHTML = `<strong>きろく：${formatTime(elapsed)}</strong><br><span>${game.questions.length}まい ぜんぶ せいかい！</span>${isBest ? `<br><span class="record">${oldBest ? "さいこうきろく こうしん！" : "はじめての きろく！"}</span>` : `<br><small>さいこうきろく：${formatTime(oldBest)}</small>`}`;
  setTimeout(startShootingStars, 150);
  $("#result-action").innerHTML = `<button class="primary-button" id="again-button" type="button">もういちど チャレンジ</button>`; $("#again-button").addEventListener("click", () => setupGame("cards"));
}
function parseSpokenNumber(transcript) {
  const source = transcript.trim().replace(/[\s、。．]/g, "").replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xFEE0));
  if (/^\d{1,2}$/.test(source)) return Number(source);

  // Chromeが返すひらがな・漢字の両方を、計算で使う0〜99の数へ正規化する。
  const normalized = source
    .replace(/〇|零/g, "ぜろ").replace(/一/g, "いち").replace(/二/g, "に").replace(/三/g, "さん")
    .replace(/四/g, "よん").replace(/五/g, "ご").replace(/六/g, "ろく").replace(/七/g, "なな")
    .replace(/八/g, "はち").replace(/九/g, "きゅう").replace(/十/g, "じゅう");
  const digits = new Map([["ぜろ", 0], ["れい", 0], ["まる", 0], ["いち", 1], ["に", 2], ["さん", 3], ["よん", 4], ["し", 4], ["ご", 5], ["ろく", 6], ["なな", 7], ["しち", 7], ["ひち", 7], ["はち", 8], ["きゅう", 9], ["く", 9]]);
  if (digits.has(normalized)) return digits.get(normalized);

  const tenIndex = normalized.indexOf("じゅう");
  if (tenIndex === -1 || normalized.indexOf("じゅう", tenIndex + 1) !== -1) return null;
  const tensText = normalized.slice(0, tenIndex);
  const onesText = normalized.slice(tenIndex + 3);
  const tens = tensText === "" ? 1 : digits.get(tensText);
  const ones = onesText === "" ? 0 : digits.get(onesText);
  if (tens === undefined || tens === 0 || ones === undefined) return null;
  const result = tens * 10 + ones;
  return result <= 99 ? result : null;
}
function normalizeSpeechText(text) {
  return text.trim().toLowerCase().replace(/[\s、。．,]/g, "").replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xFEE0))
    .replace(/〇|零/g, "ぜろ").replace(/一/g, "いち").replace(/二/g, "に").replace(/三/g, "さん").replace(/四/g, "よん")
    .replace(/五/g, "ご").replace(/六/g, "ろく").replace(/七/g, "なな").replace(/八/g, "はち").replace(/九/g, "きゅう").replace(/十/g, "じゅう");
}
function spokenNumberVariants(number) {
  const digits = [["ぜろ"], ["いち"], ["に"], ["さん"], ["よん", "し"], ["ご"], ["ろく"], ["なな", "しち", "ひち"], ["はち"], ["きゅう", "く"]];
  if (number < 10) return [...digits[number], String(number)];
  const tens = Math.floor(number / 10), ones = number % 10;
  const tenWords = tens === 1 ? ["じゅう"] : digits[tens].map((word) => `${word}じゅう`);
  return [...(ones === 0 ? tenWords : tenWords.flatMap((prefix) => digits[ones].map((word) => prefix + word))), String(number)];
}
function isCorrectSpokenEquation(text, question) {
  const source = normalizeSpeechText(text);
  const opWords = question.operation === "addition" ? ["たす", "ぷらす", "+"] : ["ひく", "まいなす", "−", "-"];
  const equalsWords = ["", "は", "わ", "いこーる", "="];
  return spokenNumberVariants(question.a).some((a) => opWords.some((op) => spokenNumberVariants(question.b).some((b) => equalsWords.some((joiner) => spokenNumberVariants(answerOf(question)).some((answer) => source === `${a}${op}${b}${joiner}${answer}`)))));
}
function updateMicButton() {
  const button = $("#mic-button");
  button.classList.toggle("listening", isListening);
  button.setAttribute("aria-label", isListening ? "おんせいにんしきをとめる" : "おんせいにんしきをはじめる");
  $("#voice-hint").textContent = isListening ? "おんせいにんしきちゅう。もういちどおすと おわるよ" : "まいくをおして こえでこたえられるよ";
}
function stopListening() {
  if (!recognition || !isListening) return;
  isListening = false;
  recognition.stop();
  updateMicButton();
}
function startListening() {
  if (!recognition || !game || game.isSubmitting) return;
  $("#answer-input").value = "";
  isListening = true;
  updateMicButton();
  try { recognition.start(); } catch (_) { /* 直前の終了処理中なら、次の操作で再開する。 */ }
}
function initialiseSpeech() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) { $("#mic-button").hidden = true; $("#voice-hint").textContent = "すうじをにゅうりょくしてこたえよう"; return; }
  recognition = new SpeechRecognition(); recognition.lang = "ja-JP"; recognition.continuous = true; recognition.interimResults = false; recognition.maxAlternatives = 1;
  recognition.onresult = (event) => {
    const spoken = event.results[event.results.length - 1][0].transcript;
    if (settings.voiceMode === "equation") $("#answer-input").value = spoken.trim();
    else {
      const number = parseSpokenNumber(spoken);
      if (number !== null) $("#answer-input").value = String(number);
      else $("#voice-hint").textContent = "すうじだけを いってみてね";
    }
  };
  recognition.onend = () => {
    if (isListening && game && !game.isSubmitting) { setTimeout(() => { try { recognition.start(); } catch (_) {} }, 120); }
    else { isListening = false; updateMicButton(); }
  };
  recognition.onerror = () => { $("#voice-hint").textContent = "こえをききとれなかったよ。もういちどどうぞ"; };
  $("#mic-button").addEventListener("click", () => { if (isListening) stopListening(); else startListening(); });
  updateMicButton();
}
document.querySelectorAll(".mode-card").forEach((button) => button.addEventListener("click", () => openStartSettings(button.dataset.mode)));
$("#answer-form").addEventListener("submit", submitAnswer);
document.querySelector(".number-keypad").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button || button.disabled || !game || game.isSubmitting) return;
  const input = $("#answer-input");
  if (button.dataset.numberDelete) input.value = input.value.slice(0, -1);
  else if (button.dataset.numberKey && input.value.length < 2) input.value += button.dataset.numberKey;
  input.focus();
}); $("#home-button").addEventListener("click", () => showScreen("#home-screen")); $("#home-link").addEventListener("click", (event) => { event.preventDefault(); showScreen("#home-screen"); }); $("#quit-button").addEventListener("click", () => showScreen("#home-screen"));
async function openStartSettings(mode) {
  pendingMode = mode;
  const cards = mode === "cards";
  if (cards) {
    try { await loadCardTable(); }
    catch (error) { pendingMode = null; alert(`カードのCSVを読み込めませんでした。\n${error.message}`); return; }
  }
  $("#settings-title").textContent = cards ? "けいさんカード" : "もんだいの せってい";
  $("#settings-description").textContent = cards ? "カードの しゅるいを えらんで、さいごまで やってみよう" : "もんだいを えらんでから はじめよう";
  ["#operation-settings", "#range-settings", "#count-settings"].forEach((selector) => { $(selector).hidden = cards; });
  $("#voice-mode-settings").hidden = cards;
  $("#card-set-settings").hidden = !cards;
  $("#card-play-settings").hidden = !cards;
  $("#save-settings").textContent = "スタート";
  $("#settings-dialog").showModal();
}
$("#close-settings-button").addEventListener("click", () => { pendingMode = null; $("#settings-dialog").close(); });
$("#settings-button").addEventListener("click", () => {
  pendingMode = null;
  $("#settings-title").textContent = "れんしゅうの せってい";
  $("#settings-description").textContent = "つぎの れんしゅうから つかえるよ";
  ["#operation-settings", "#range-settings", "#count-settings"].forEach((selector) => { $(selector).hidden = false; });
  $("#card-play-settings").hidden = true;
  $("#voice-mode-settings").hidden = false;
  $("#card-set-settings").hidden = true;
  $("#save-settings").textContent = "せっていを ほぞん";
  $("#settings-dialog").showModal();
});
$("#settings-form").addEventListener("submit", (event) => {
  const ops = [...document.querySelectorAll('input[name="operation"]:checked')].map((input) => input.value);
  if (!pendingMode && !ops.length) { event.preventDefault(); alert("たしざんか ひきざんを えらんでね"); return; }
  if (ops.length) settings.operations = ops;
  settings.range = document.querySelector('input[name="range"]:checked').value;
  settings.questionCount = Number(document.querySelector('input[name="questionCount"]:checked').value);
  settings.cardPlayMode = document.querySelector('input[name="cardPlayMode"]:checked').value;
  settings.voiceMode = document.querySelector('input[name="voiceMode"]:checked').value;
  settings.cardSet = document.querySelector('input[name="cardSet"]:checked').value;
  const mode = pendingMode; pendingMode = null;
  if (mode) setTimeout(() => setupGame(mode), 0);
});
$("#card-wrong-button").addEventListener("click", () => judgeCard(false));
$("#card-correct-button").addEventListener("click", () => judgeCard(true));
renderLearningStats(loadLearningStats());
initialiseSpeech();
