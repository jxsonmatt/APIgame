// Firebase initialization
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.5.0/firebase-app.js";
import { getApp } from "https://www.gstatic.com/firebasejs/12.5.0/firebase-app.js";
import {
    getFirestore,
    collection,
    getDocs,
    setDoc,
    doc,
    onSnapshot
} from "https://www.gstatic.com/firebasejs/12.5.0/firebase-firestore.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/12.5.0/firebase-analytics.js";

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyBQieeHbz8glgWcp8_BDdoNFGGnBjodbRk",
  authDomain: "apigame-34134.firebaseapp.com",
  projectId: "apigame-34134",
  storageBucket: "apigame-34134.firebasestorage.app",
  messagingSenderId: "648910176965",
  appId: "1:648910176965:web:d93bf1f3348d9c3d60a6ac",
  measurementId: "G-WYL7L5K6C7"
};

// Firebase initialization and Firestore sync will be initialized after UI helpers are defined below.

// Basic client-side UI for a minefield gamble prototype.
// Users stored in localStorage as "mg_users".
const defaultUsersKey = 'mg_users_v1';

// --- Helpers ---
const $ = id => document.getElementById(id);
const fmt = v => Number(v).toFixed(2);

// --- State ---
let users = loadUsers();
let currentUserId = users.length ? users[0].id : null;
let game = {
    active: false,
    gridSize: 5,
    mineCount: 5,
    bet: 0,
    board: [], // {mine:boolean, opened:boolean, index}
    picked: 0,
    potential: 0,
    lockedBet: 0
};

// --- Init UI refs ---
const userSelect = $('userSelect');
const addUserBtn = $('addUser');
const resetUsersBtn = $('resetUsers');
const balanceEl = $('balance');
const gridEl = $('grid');
const gridSizeEl = $('gridSize');
const mineCountEl = $('mineCount');
const betEl = $('betAmount');
const startBtn = $('startRound');
const cashBtn = $('cashOut');
const pickedCountEl = $('pickedCount');
const payoutEl = $('payout');
const roundStatusEl = $('roundStatus');
const logEl = $('log');
const revealAllBtn = $('revealAll');
const newBoardBtn = $('newBoard');

// --- LocalStorage user helpers ---
function loadUsers(){
    try{
        const raw = localStorage.getItem(defaultUsersKey);
        if(!raw) {
            const u = [{id: idGen(), name:'Player1', balance:100}];
            localStorage.setItem(defaultUsersKey, JSON.stringify(u));
            return u;
        }
        return JSON.parse(raw);
    }catch(e){ return [{id:idGen(), name:'Player1', balance:100}]; }
}
function saveUsers(){ localStorage.setItem(defaultUsersKey, JSON.stringify(users)); }
function idGen(){ return 'u'+Math.random().toString(36).slice(2,9); }

// --- UI update ---
function refreshUserList(){
    userSelect.innerHTML = '';
    users.forEach(u=>{
        const opt = document.createElement('option');
        opt.value = u.id; opt.textContent = u.name;
        userSelect.appendChild(opt);
    });
    if(!users.length) {
        users.push({id:idGen(),name:'Player1',balance:100});
        saveUsers();
        refreshUserList();
        return;
    }
    if(!currentUserId) currentUserId = users[0].id;
    userSelect.value = currentUserId;
    updateBalanceDisplay();
}
function updateBalanceDisplay(){
    const u = users.find(x=>x.id===currentUserId);
    balanceEl.textContent = u ? '$' + fmt(u.balance) : '--';
}
function log(msg){
    const t = new Date().toLocaleTimeString();
    logEl.innerHTML = `<div>[${t}] ${msg}</div>` + logEl.innerHTML;
}

// --- Board generation & game logic ---
function createBoard(size, mines){
    const total = size*size;
    const arr = new Array(total).fill(0).map((_,i)=>({index:i,mine:false,opened:false}));
    // place mines
    const indices = Array.from({length:total},(_,i)=>i);
    for(let i=0;i<mines;i++){
        const pick = Math.floor(Math.random()*indices.length);
        const idx = indices.splice(pick,1)[0];
        arr[idx].mine = true;
    }
    return arr;
}

function startRound(){
    if(game.active) return;
    const u = users.find(x=>x.id===currentUserId);
    if(!u) return;
    const bet = Number(betEl.value) || 0;
    const gridSize = Number(gridSizeEl.value);
    const mineCount = Number(mineCountEl.value);
    if(bet <= 0){ alert('Set a positive bet'); return; }
    if(bet > u.balance){ alert('Insufficient balance'); return; }
    // lock bet
    u.balance -= bet;
    saveUsers(); updateBalanceDisplay();
    game = {
        active: true,
        gridSize,
        mineCount: Math.min(mineCount, gridSize*gridSize-1),
        bet,
        board: createBoard(gridSize, Math.min(mineCount, gridSize*gridSize-1)),
        picked: 0,
        potential: bet, // initial potential equals bet (multiplier grows)
        lockedBet: bet
    };
    renderBoard();
    updateHUD();
    log(`${u.name} started a round with $${fmt(bet)} on ${gridSize}x${gridSize} (${game.mineCount} mines)`);
    startBtn.disabled = true;
    cashBtn.disabled = false;
    roundStatusEl.textContent = 'In progress';
}

function tileClick(idx){
    if(!game.active) return;
    const cell = game.board[idx];
    if(!cell || cell.opened) return;
    cell.opened = true;
    if(cell.mine){
        // lose
        revealAll(true);
        endRoundLose();
    } else {
        game.picked++;
        // increase potential: simple multiplier growth
        // base multiplier: 1.0 + 0.25 * picked
        game.potential = game.lockedBet * (1 + 0.25 * game.picked);
        updateHUD();
        renderBoard();
        log(`Safe tile uncovered (#${game.picked}). Potential: $${fmt(game.potential)}`);
    }
}

function cashOut(){
    if(!game.active) return;
    const u = users.find(x=>x.id===currentUserId);
    if(!u) return;
    const win = game.potential;
    u.balance += win;
    saveUsers();
    log(`${u.name} cashed out $${fmt(win)} after picking ${game.picked} safe tiles.`);
    endRoundWin();
    updateBalanceDisplay();
}

function endRoundWin(){
    // reveal board then reset
    renderBoard(true);
    resetRound();
}

// Banana API Challenge integration
async function showBananaChallenge() {
    const modal = $('bananaModal');
    const img = $('bananaImage');
    const answer = $('bananaAnswer');

    // Build API URL using current page protocol to avoid mixed-content issues
    const proto = (location && location.protocol === 'https:') ? 'https:' : 'http:';
    const apiBase = `${proto}//marcconrad.com/uob/banana/api.php`;

    // Helper to open modal with given image src and solution
    function openModal(imageSrc, solution) {
        img.onerror = null; // reset
        img.src = imageSrc;
        answer.value = '';
        modal.dataset.answer = String(solution);
        modal.classList.add('show');
        answer.focus();

        return new Promise((resolve) => {
            const submit = $('submitBanana');
            const skip = $('skipBanana');

            function cleanup() {
                submit.removeEventListener('click', handleSubmit);
                skip.removeEventListener('click', handleSkip);
                answer.removeEventListener('keyup', handleKeyUp);
                modal.classList.remove('show');
            }

            function handleSubmit() {
                const userAnswer = Number(answer.value);
                if (isNaN(userAnswer)) {
                    alert('Please enter a valid number');
                    return;
                }
                const correct = userAnswer === Number(modal.dataset.answer);
                cleanup();
                resolve(correct);
            }

            function handleSkip() {
                cleanup();
                resolve(false);
            }

            function handleKeyUp(e) {
                if (e.key === 'Enter') handleSubmit();
                if (e.key === 'Escape') handleSkip();
            }

            submit.addEventListener('click', handleSubmit);
            skip.addEventListener('click', handleSkip);
            answer.addEventListener('keyup', handleKeyUp);

            // If the image fails to load, try fallback or resolve false
            img.onerror = () => {
                log('Challenge image failed to load. Trying fallback...');
                cleanup();
                resolve(false);
            };
        });
    }

    try {
        // Try base64 endpoint first (returns image data as base64)
        const resp = await fetch(`${apiBase}?out=json&base64=yes`);
        if (!resp.ok) throw new Error('Network response not ok');
        const data = await resp.json();

        // API may return different field names depending on options
        // prefer data.image (base64) or data.question (data URI or URL)
        let imageSrc = null;
        if (data.image) {
            imageSrc = `data:image/png;base64,${data.image}`;
        } else if (data.question) {
            imageSrc = data.question;
        }
        const solution = data.solution ?? data[1] ?? null;

        if (imageSrc && solution != null) {
            return await openModal(imageSrc, solution);
        }

        // If response is not in expected form, fall through to try non-base64
        log('Unexpected Banana API response format, trying non-base64 endpoint');
    } catch (err) {
        // Could be CORS, mixed-content or other network error
        console.warn('Base64 fetch failed:', err);
    }

    // Fallback: try JSON with URL to image (base64=no)
    try {
        const resp2 = await fetch(`${apiBase}?out=json&base64=no`);
        if (!resp2.ok) throw new Error('Network response not ok (fallback)');
        const data2 = await resp2.json();
        const imageSrc = data2.question;
        const solution = data2.solution ?? null;
        if (imageSrc && solution != null) {
            return await openModal(imageSrc, solution);
        }
        log('Banana API returned unexpected data on fallback.');
        return false;
    } catch (err) {
        console.error('Banana API error (fallback):', err);
        // If a mixed-content or CORS error happens, advise the user
        log('Failed to load Banana Challenge. Common causes: mixed HTTP/HTTPS or CORS restrictions.');
        log('If you are opening the file via file:// or https, try serving the site over http (python -m http.server) or use a server-side proxy.');
        return false;
    }
}

function endRoundLose(){
    const u = users.find(x=>x.id===currentUserId);
    if(!u) return;
    
    log(`${u.name} hit a mine and lost $${fmt(game.lockedBet)}.`);
    renderBoard(true);
    resetRound();
    
    // Check if user is out of money
    if(u.balance <= 0) {
        log('Out of money! Time for a Banana Challenge!');
        showBananaChallenge().then(success => {
            if(success) {
                u.balance += 100;
                saveUsers();
                updateBalanceDisplay();
                log(`${u.name} solved the Banana Challenge and earned $100!`);
            } else {
                log('Better luck next time! Add more funds or try another challenge.');
            }
        });
    }
}

function revealAll(showLog){
    if(!game.board.length) {
        renderBoard(true);
        return;
    }
    renderBoard(true);
    if(showLog) log('All tiles revealed.');
}

function resetRound(){
    game.active = false;
    game.lockedBet = 0;
    startBtn.disabled = false;
    cashBtn.disabled = true;
    roundStatusEl.textContent = 'Idle';
    updateHUD();
}

// --- Rendering ---
function renderBoard(reveal=false){
    const size = game.gridSize || 5;
    gridEl.style.gridTemplateColumns = `repeat(${size}, auto)`;
    gridEl.innerHTML = '';
    const total = size*size;
    for(let i=0;i<total;i++){
        const cell = game.board[i] || {index:i,opened:false,mine:false};
        const el = document.createElement('div');
        el.className = 'tile' + (cell.opened || reveal ? ' open' : '');
        if(cell.opened || reveal){
            if(cell.mine){
                el.classList.add('mine');
                el.textContent = '💣';
            } else {
                el.textContent = '✓';
            }
        } else {
            el.textContent = '';
            el.addEventListener('click',()=>tileClick(i));
        }
        gridEl.appendChild(el);
    }
}

function updateHUD(){
    pickedCountEl.textContent = game.picked || 0;
    payoutEl.textContent = '$' + fmt(game.potential || 0);
}

// --- User actions ---
let bananaSolution = null;

// Event handler for when user clicks "Try Banana Challenge" button
document.getElementById("tryBanana").addEventListener("click", async () => {
  // Get references to DOM elements we'll need to manipulate
  const modal = document.getElementById("bananaModal");
  const resultElement = document.getElementById("bananaResult");
  const answerInput = document.getElementById("bananaAnswer");
  
  // Reset the UI state for a fresh challenge
  modal.style.display = "block";      // Show the modal
  resultElement.textContent = '';     // Clear any previous result message
  answerInput.value = '';            // Clear any previous answer
  
  try {
    // CORS Proxy Setup
    // We use a proxy because the Banana API doesn't support direct browser requests (CORS issues)
    const proxyUrl = "https://corsproxy.io/?";
    // Target URL with parameters:
    // - out=json: Request JSON response format
    // - base64=yes: Get image as base64 string instead of URL
    const targetUrl = "http://marcconrad.com/uob/banana/api.php?out=json&base64=yes";

    // Make the API request through the proxy
    // encodeURIComponent ensures the URL is properly encoded for the proxy
    const response = await fetch(proxyUrl + encodeURIComponent(targetUrl));
    const data = await response.json();

    // Set the challenge image using base64 data
    // data:image/png;base64 prefix tells browser this is a base64 encoded PNG
    document.getElementById("bananaImage").src = "data:image/png;base64," + data.question;
    
    // Store the correct answer for later comparison
    bananaSolution = data.solution;

    log('Starting Banana Challenge...');
  } catch (error) {
    console.error('Banana API error:', error);
    log('Failed to load challenge image. Check console for details.');
  }
});

// Event handler for when user submits their answer
document.getElementById("submitBanana").addEventListener("click", () => {
  // Get user's answer and remove any whitespace
  const userAnswer = document.getElementById("bananaAnswer").value.trim();
  
  // Get references to DOM elements we need
  const modal = document.getElementById("bananaModal");
  const resultElement = document.getElementById("bananaResult");
  
  // Find the current user in our users array
  const u = users.find(x=>x.id===currentUserId);
  // Safety check: if no user found, exit early
  if (!u) return;

  // Convert both user's answer and stored solution to numbers
  // This ensures consistent comparison (string "5" equals number 5)
  const userNum = Number(userAnswer);
  const solutionNum = Number(bananaSolution);

  // Check if conversion was successful (!isNaN) and numbers match
  if (!isNaN(userNum) && !isNaN(solutionNum) && userNum === solutionNum) {
    // CORRECT ANSWER HANDLING
    
    // Visual feedback: Green success message
    resultElement.style.color = '#4CAF50';  // Green color
    resultElement.textContent = 'Correct! +$100 reward';
    
    // Log the success to game history
    log('Challenge solved! +$100 reward.');
    
    // Update user's balance
    u.balance = Number(u.balance || 0) + 100;  // Add $100 reward
    saveUsers();  // Save to persistent storage
    updateBalanceDisplay();  // Update UI to show new balance
    
    // Auto-close modal after showing success
    setTimeout(() => {
      modal.style.display = "none";  // Hide modal
      resultElement.textContent = '';  // Clear result message
    }, 1500);  // 1.5 second delay
  } else {
    // WRONG ANSWER HANDLING
    
    // Visual feedback: Red error message
    resultElement.style.color = '#f44336';  // Red color
    resultElement.textContent = 'Incorrect. Try again!';
    
    // Log the failure to game history
    log('Challenge failed. Try again!');
  }
});

document.getElementById("skipBanana").addEventListener("click", () => {
  document.getElementById("bananaModal").style.display = "none";
  log('Banana Challenge skipped.');
});

// Utility functions (adapted to app helpers)
function logMessage(msg) {
  // reuse the existing log function so messages are timestamped and consistent
  log(msg);
}

function updateBalance(amount) {
  const u = users.find(x=>x.id===currentUserId);
  if (!u) return;
  u.balance = Number(u.balance || 0) + Number(amount || 0);
  saveUsers();
  updateBalanceDisplay();
}

addUserBtn.addEventListener('click',()=>{
    const name = prompt('New user name:','Player' + (users.length+1));
    if(!name) return;
    const bal = parseFloat(prompt('Starting balance','100')) || 100;
    const u = {id:idGen(), name:name.trim(), balance:Number(bal)};
    users.push(u);
    saveUsers();
    currentUserId = u.id;
    refreshUserList();
    log(`User ${u.name} added with $${fmt(u.balance)}`);
});

resetUsersBtn.addEventListener('click',()=>{
    if(!confirm('Reset all users and balances?')) return;
    localStorage.removeItem(defaultUsersKey);
    users = loadUsers();
    currentUserId = users[0].id;
    refreshUserList();
    log('Users reset');
});

userSelect.addEventListener('change', ()=>{
    currentUserId = userSelect.value;
    updateBalanceDisplay();
    // end any active round
    if(game.active) {
        if(confirm('Switching users will end the active round. Continue?')){
            revealAll();
            resetRound();
        } else {
            // revert selection
            userSelect.value = currentUserId;
        }
    }
});

startBtn.addEventListener('click', startRound);
cashBtn.addEventListener('click', cashOut);
revealAllBtn.addEventListener('click', ()=>revealAll(true));
newBoardBtn.addEventListener('click', ()=>{ game.board=[]; renderBoard(true); });

// sync inputs
gridSizeEl.addEventListener('change', ()=>{ 
    const newSize = Number(gridSizeEl.value);
    game.gridSize = newSize; 
    // clamp mine count to valid range (max cells - 1)
    const maxMines = Math.max(1, newSize * newSize - 1);
    mineCountEl.max = String(maxMines);
    if(Number(mineCountEl.value) > maxMines) mineCountEl.value = String(maxMines);
});
mineCountEl.addEventListener('change', ()=>{ 
    const val = Number(mineCountEl.value) || 1;
    const maxMines = Math.max(1, (Number(gridSizeEl.value) || game.gridSize) ** 2 - 1);
    game.mineCount = Math.min(Math.max(1, val), maxMines);
    // reflect clamped value
    mineCountEl.value = String(game.mineCount);
});

// --- Startup ---
refreshUserList();
// initialize an empty board (no mines) for the current grid size so UI shows a proper grid
game.board = createBoard(game.gridSize, 0);
renderBoard(true);
updateHUD();
log('UI ready');

// expose UI helper functions to window so external integrations (e.g., Firestore) can hook in
window.refreshUserList = refreshUserList;
window.log = log;
window.saveUsers = saveUsers;

// Initialize Firebase and Firestore sync now that UI helpers exist
(async () => {
    let app;
    try {
        app = initializeApp(firebaseConfig);
    } catch (err) {
        console.warn('Failed to initialize Firebase:', err);
        return;
    }
    try { getAnalytics(app); } catch(e) { /* analytics optional */ }

    const db = getFirestore(app);
    const colRef = collection(db, 'mg_users');

    // preserve original saveUsers/local behavior
    const originalSaveUsers = window.saveUsers || (() => {});
    // never overwrite user's log/refresh functions, but use them
    const uiLog = window.log || ((m)=>console.log(m));
    const uiRefresh = window.refreshUserList || (()=>{});

    async function pushUsersToFirestore(){
        if(!Array.isArray(window.users)) return;
        try{
            await Promise.all(window.users.map(u=>{
                const d = Object.assign({}, u);
                return setDoc(doc(colRef, d.id), d);
            }));
            uiLog('Pushed local users to Firestore.');
        }catch(e){ console.error('pushUsersToFirestore', e); uiLog('Failed pushing users to Firestore'); }
    }

    async function fetchAndMergeUsers(){
        try{
            const snap = await getDocs(colRef);
            if(snap.empty){
                // nothing in firestore yet -> push local users
                await pushUsersToFirestore();
                return;
            }
            const remote = snap.docs.map(d=>d.data());
            // if local storage has different data, replace it with remote
            window.users = remote;
            // persist locally using original function
            try { originalSaveUsers(); } catch(e){}
            // pick current user if unset
            if(!window.currentUserId && window.users.length) window.currentUserId = window.users[0].id;
            uiRefresh();
            uiLog('Loaded users from Firestore.');
        }catch(e){ console.error('fetchAndMergeUsers', e); uiLog('Failed loading users from Firestore'); }
    }

    // override window.saveUsers so UI actions also sync to Firestore
    window.saveUsers = async function(){
        try{
            originalSaveUsers();
        }catch(e){ console.warn('originalSaveUsers failed', e); }
        try{
            await pushUsersToFirestore();
        }catch(e){ /* already logged */ }
    };

    // realtime listener -> update local users when remote changes
    onSnapshot(colRef, snapshot => {
        const remote = snapshot.docs.map(d=>d.data());
        // simple sync: replace local users with remote and persist locally
        window.users = remote;
        try{ originalSaveUsers(); } catch(e){}
        try{ uiRefresh(); } catch(e){}
        uiLog('Realtime: users updated from Firestore.');
    }, err => {
        console.error('onSnapshot users error', err);
        uiLog('Realtime listener error for Firestore users.');
    });

    // initial fetch/merge
    await fetchAndMergeUsers();
})();
