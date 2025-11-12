// Import the modular Firebase SDK pieces we need for auth and Firestore access.
import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js";
import {
    getAuth,
    onAuthStateChanged,
    createUserWithEmailAndPassword,
    signInWithEmailAndPassword,
    signOut,
    updateProfile
} from "https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js";
import {
    getFirestore,
    doc,
    getDoc,
    setDoc,
    updateDoc,
    onSnapshot,
    runTransaction,
    serverTimestamp
} from "https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore.js";

// Firebase project configuration pulled from the Firebase console for this game client.
const firebaseConfig = {
    apiKey: "AIzaSyBQieeHbz8glgWcp8_BDdoNFGGnBjodbRk",
    authDomain: "apigame-34134.firebaseapp.com",
    projectId: "apigame-34134",
    storageBucket: "apigame-34134.firebasestorage.app",
    messagingSenderId: "648910176965",
    appId: "1:648910176965:web:d93bf1f3348d9c3d60a6ac",
    measurementId: "G-WYL7L5K6C7"
};

// Initialize (or reuse) the Firebase app instance so the SDK can talk to the backend services.
let app;
try {
    app = getApps().length ? getApp() : initializeApp(firebaseConfig);
} catch (error) {
    console.error("Firebase initialization error:", error);
    uiLog("Firebase initialization failed. Check console for details.");
}

// Set up handles for Authentication and Firestore once the app is available.
const auth = getAuth(app);
const db = getFirestore(app);

// Additional Firebase-powered helpers are defined below so they can share the same context.

// DOM helper to grab elements and currency formatter shared across the UI.
const $ = id => document.getElementById(id);
const fmt = v => Number(v).toFixed(2);

// Track the live round state; this drives the board rendering and balance calculations.
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

// Cache the signed-in user, their synced balance, and a listener cleanup handle.
let currentUser = null;
let userBalance = 0;
let unsubscribeUserDoc = null;

// Cache all recurring DOM lookups so handlers don’t keep querying the document.
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
const authModal = $('authModal');
const signInForm = $('signInForm');
const signUpForm = $('signUpForm');
const showSignUpBtn = $('showSignUp');
const showSignInBtn = $('showSignIn');
const authError = $('authError');
const userInfo = $('userInfo');
const currentUsername = $('currentUsername');
const signOutBtn = $('signOut');

// Hide auth-dependent UI until Firebase notifies us about the session state.
if (userInfo) {
    userInfo.style.display = 'none';
}
if (currentUsername) {
    currentUsername.textContent = '';
}

// Reflect the player’s bankroll in the header, or placeholder text if not signed in yet.
function updateBalanceDisplay() {
    if (!currentUser) {
        balanceEl.textContent = '--';
        return;
    }

    balanceEl.textContent = '$' + fmt(userBalance);
}
// Append timestamped messages into the debug log feed shown in the UI.
function log(msg){
    const t = new Date().toLocaleTimeString();
    logEl.innerHTML = `<div>[${t}] ${msg}</div>` + logEl.innerHTML;
}

// Convenience helper so every function uses the same location for Firestore docs.
function getUserDocRef(uid) {
    return doc(db, 'users', uid);
}

// Make sure each authenticated player has a Firestore document with required fields.
async function ensureUserDocument(user) {
    if (!user) return;

    const ref = getUserDocRef(user.uid);
    const snapshot = await getDoc(ref);

    if (!snapshot.exists()) {
        // Seed first-time players with a starting balance and metadata timestamps.
        await setDoc(ref, {
            username: user.displayName || null,
            email: user.email || null,
            balance: 100,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
        });
        return;
    }

    const data = snapshot.data() || {};
    const updates = {};

    // Fill in defaults if older docs are missing fields.
    if (data.balance == null) {
        updates.balance = 100;
    }
    if (!data.username && user.displayName) {
        updates.username = user.displayName;
    }
    if (!data.email && user.email) {
        updates.email = user.email;
    }

    if (Object.keys(updates).length) {
        // Only write back when we actually changed something to avoid needless writes.
        updates.updatedAt = serverTimestamp();
        await updateDoc(ref, updates);
    }
}

// Stop listening to Firestore updates when a different user signs in/out.
function clearUserSubscription() {
    if (unsubscribeUserDoc) {
        unsubscribeUserDoc();
        unsubscribeUserDoc = null;
    }
}

// Subscribe to balance changes for the active player so the UI stays live.
function subscribeToUserDocument(user) {
    clearUserSubscription();
    if (!user) return;

    const ref = getUserDocRef(user.uid);
    unsubscribeUserDoc = onSnapshot(ref, (snapshot) => {
        const data = snapshot.data();
        userBalance = Number(data?.balance ?? 0);
        updateBalanceDisplay();
    }, (error) => {
        console.error('User document listener error:', error);
        uiLog('Realtime balance sync failed; check console for details.');
    });
}

// Atomically add or remove chips from the player’s bankroll while enforcing no overdraft.
async function adjustBalance(delta) {
    if (!currentUser) {
        throw new Error('No authenticated user');
    }

    const ref = getUserDocRef(currentUser.uid);

    // Use a Firestore transaction so concurrent plays never corrupt the balance.
    const updatedBalance = await runTransaction(db, async (transaction) => {
        const snapshot = await transaction.get(ref);

        if (!snapshot.exists()) {
            // If the document vanished, recreate it with default funds and our delta applied.
            const startingBalance = Math.max(0, 100 + delta);
            transaction.set(ref, {
                username: currentUser.displayName || null,
                email: currentUser.email || null,
                balance: startingBalance,
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp()
            });
            return startingBalance;
        }

        const data = snapshot.data() || {};
        const currentBalanceValue = Number(data.balance ?? 0);
        const nextBalance = currentBalanceValue + delta;

        if (nextBalance < 0) {
            // Throwing aborts the transaction so callers know the bet cannot proceed.
            const err = new Error('Insufficient funds');
            err.code = 'INSUFFICIENT_FUNDS';
            throw err;
        }

        transaction.set(ref, {
            balance: nextBalance,
            updatedAt: serverTimestamp()
        }, { merge: true });

        return nextBalance;
    });

    userBalance = Number(updatedBalance);
    updateBalanceDisplay();
    return userBalance;
}

// --- Board generation & game logic ---
// Build the full tile array for a new board including random mine placement.
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

// Kick off a new round by locking the player’s bet and creating a fresh board.
async function startRound(){
    if(game.active || !currentUser) return false;

    const bet = Number(betEl.value) || 0;
    const gridSize = Number(gridSizeEl.value);
    const mineCount = Number(mineCountEl.value);

    if(bet <= 0){ 
        alert('Set a positive bet'); 
        return false; 
    }

    if(bet > userBalance){ 
        if (userBalance === 0 && roundStatusEl.textContent === 'Idle') {
            const playChallenge = confirm('💰 You\'re out of money! Want to try the Banana Challenge to earn $100?');
            if (playChallenge) {
                log('🍌 Starting Banana Challenge to earn more funds...');
                showBananaChallenge().then(async success => {
                    if (success) {
                        await startRound();
                    }
                });
            }
        } else {
            alert('Insufficient balance for this bet');
        }
        return false;
    }

    try {
        await adjustBalance(-bet);
    } catch (error) {
        if (error?.code === 'INSUFFICIENT_FUNDS') {
            alert('Insufficient balance for this bet');
        } else {
            console.error('Error locking bet:', error);
            uiLog('Failed to lock bet. Please try again.');
        }
        return false;
    }

    game = {
        active: true,
        gridSize,
        mineCount: Math.min(mineCount, gridSize*gridSize-1),
        bet,
        board: createBoard(gridSize, Math.min(mineCount, gridSize*gridSize-1)),
        picked: 0,
        potential: bet,
        lockedBet: bet
    };
    renderBoard();
    updateHUD();
    log(`${currentUser.displayName || currentUser.email || 'Player'} started a round with $${fmt(bet)} on ${gridSize}x${gridSize} (${game.mineCount} mines)`);
    startBtn.disabled = true;
    cashBtn.disabled = false;
    roundStatusEl.textContent = 'In progress';
    return true;
}

// Handle a user click on an individual tile and update round progress.
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

// Pay out the current potential winnings and close the round on demand.
async function cashOut(){
    if(!game.active || !currentUser) return;
    const win = game.potential;

    try {
        await adjustBalance(win);
        log(`${currentUser.displayName || currentUser.email || 'Player'} cashed out $${fmt(win)} after picking ${game.picked} safe tiles.`);
    } catch (error) {
        console.error('Cash out error:', error);
        uiLog('Failed to cash out winnings. Please try again.');
        return;
    }

    endRoundWin();
}

// Wrap win flow: reveal remaining tiles and reset controls.
function endRoundWin(){
    // reveal board then reset
    renderBoard(true);
    resetRound();
}

// Banana API Challenge integration
// Launch the Banana Challenge modal that lets busted players earn extra funds.
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
    if(!currentUser) return;
    
    // Disable cash out button immediately
    cashBtn.disabled = true;
    
    log(`${currentUser.displayName || currentUser.email || 'Player'} hit a mine and lost $${fmt(game.lockedBet)}.`);
    renderBoard(true);
    resetRound();
}

// Flip every tile in the grid, optionally leaving a breadcrumb in the log.
function revealAll(showLog){
    if(!game.board.length) {
        renderBoard(true);
        return;
    }
    renderBoard(true);
    if(showLog) log('All tiles revealed.');
}

// Return controls to their idle state so a new round can start cleanly.
function resetRound(){
    game.active = false;
    game.lockedBet = 0;
    startBtn.disabled = false;
    cashBtn.disabled = true;
    roundStatusEl.textContent = 'Idle';
    updateHUD();
}

// --- Rendering ---
// Paint the game board based on the current model, optionally revealing hidden tiles.
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

// Refresh the live stats panel so the player sees their progress.
function updateHUD(){
    pickedCountEl.textContent = game.picked || 0;
    payoutEl.textContent = '$' + fmt(game.potential || 0);
}

// --- User actions ---
// Remember the current Banana Challenge answer so the submit handler can validate entries.
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
document.getElementById("submitBanana").addEventListener("click", async () => {
        // Get user's answer and remove any whitespace
        const userAnswer = document.getElementById("bananaAnswer").value.trim();

        // Get references to DOM elements we need
        const modal = document.getElementById("bananaModal");
        const resultElement = document.getElementById("bananaResult");

        if (!currentUser) return;

        // Convert both user's answer and stored solution to numbers
        const userNum = Number(userAnswer);
        const solutionNum = Number(bananaSolution);

        if (!isNaN(userNum) && !isNaN(solutionNum) && userNum === solutionNum) {
                // CORRECT ANSWER HANDLING
                try {
                        await adjustBalance(100);

                        // Visual feedback: Green success message
                        resultElement.style.color = '#4CAF50';
                        resultElement.textContent = '🎉 Correct! You earned $100! 🎉';

                        // Show success message in game log
                        log('🌟 Banana Challenge completed successfully! +$100 added to your balance.');

                        // Auto-close modal after showing success
                        setTimeout(() => {
                                modal.style.display = "none";
                                resultElement.textContent = '';
                        }, 2000);

                        // Create success animation
                        const successMsg = document.createElement('div');
                        successMsg.textContent = '+$100';
                        successMsg.style.cssText = `
                                position: fixed;
                                top: 50%;
                                left: 50%;
                                transform: translate(-50%, -50%);
                                color: #4CAF50;
                                font-size: 48px;
                                font-weight: bold;
                                animation: floatUp 2s ease-out forwards;
                                z-index: 1000;
                        `;
                        document.body.appendChild(successMsg);
                        setTimeout(() => successMsg.remove(), 2000);

                } catch (error) {
                        console.error('Error updating balance:', error);
                        log('Error processing reward. Please try again.');
                }
        } else {
                // WRONG ANSWER HANDLING
                resultElement.style.color = '#f44336';
                resultElement.textContent = '❌ Incorrect. Try again! ❌';

                // Shake the input field to indicate error
                const answerInput = document.getElementById("bananaAnswer");
                answerInput.classList.add('shake');
                setTimeout(() => answerInput.classList.remove('shake'), 500);

                log('❌ Challenge failed. Keep trying - you can do it!');
        }
});

document.getElementById("skipBanana").addEventListener("click", () => {
  document.getElementById("bananaModal").style.display = "none";
  log('Banana Challenge skipped.');
});

// Event listeners for game actions only
startBtn.addEventListener('click', async (e) => {
    const button = e.currentTarget;
    button.classList.add('button-loading');
    try {
        await startRound();
    } finally {
        button.classList.remove('button-loading');
    }
});

// Wire the icon buttons into the game flow.
cashBtn.addEventListener('click', cashOut);
revealAllBtn.addEventListener('click', ()=>revealAll(true));
newBoardBtn.addEventListener('click', ()=>{ game.board=[]; renderBoard(true); });

// sync inputs
// Clamp grid size updates and ensure mine count remains a valid value.
gridSizeEl.addEventListener('change', ()=>{ 
    const newSize = Number(gridSizeEl.value);
    game.gridSize = newSize; 
    // clamp mine count to valid range (max cells - 1)
    const maxMines = Math.max(1, newSize * newSize - 1);
    mineCountEl.max = String(maxMines);
    if(Number(mineCountEl.value) > maxMines) mineCountEl.value = String(maxMines);
});
// Keep the mine count sane even if people type outside the numeric input’s constraints.
mineCountEl.addEventListener('change', ()=>{ 
    const val = Number(mineCountEl.value) || 1;
    const maxMines = Math.max(1, (Number(gridSizeEl.value) || game.gridSize) ** 2 - 1);
    game.mineCount = Math.min(Math.max(1, val), maxMines);
    // reflect clamped value
    mineCountEl.value = String(game.mineCount);
});

// --- Startup ---
// Initialize game board immediately
function initializeGame() {
    game.board = createBoard(game.gridSize, 0);
    renderBoard(true);
    updateHUD();
    log('Game board initialized');
}

// Kick off the initial board render and balance display when the DOM is ready.
document.addEventListener('DOMContentLoaded', () => {
    initializeGame();
    updateBalanceDisplay();
    log('UI ready');
});

// Utility function for UI logging with timestamps
function uiLog(message) {
    const timestamp = new Date().toLocaleTimeString();
    const logElement = document.getElementById('log');
    const logEntry = `[${timestamp}] ${message}`;
    
    if (logElement) {
        // Add new message at the top
        logElement.innerHTML = `<div>${logEntry}</div>${logElement.innerHTML}`;
    }
    // Also log to console for debugging
    console.log(logEntry);
}


// --- Authentication UI helpers ---
// Show an error banner inside the auth dialog.
function showAuthError(message) {
    authError.textContent = message;
    authError.style.display = 'block';
}

// Hide the auth error banner when retrying.
function clearAuthError() {
    authError.textContent = '';
    authError.style.display = 'none';
}

// Toggle between the login and sign-up panes inside the modal.
function toggleAuthForms() {
    signInForm.style.display = signInForm.style.display === 'none' ? 'block' : 'none';
    signUpForm.style.display = signUpForm.style.display === 'none' ? 'block' : 'none';
    clearAuthError();
}

// Auth Event Handlers
// Handle email/password sign-in submissions and ensure user metadata exists.
signInForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearAuthError();

    const email = document.getElementById('signInEmail').value;
    const password = document.getElementById('signInPassword').value;

    try {
        const userCredential = await signInWithEmailAndPassword(auth, email, password);
        await ensureUserDocument(userCredential.user);
        authModal.style.display = 'none';
        signInForm.reset();
    } catch (error) {
        showAuthError('Sign in failed: ' + error.message);
    }
});

// Handle new account creation and seed the corresponding Firestore document.
signUpForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearAuthError();

    const email = document.getElementById('signUpEmail').value;
    const password = document.getElementById('signUpPassword').value;
    const username = document.getElementById('signUpUsername').value;

    try {
        // Create user account
        const userCredential = await createUserWithEmailAndPassword(auth, email, password);
        
        // Update profile with username
        await updateProfile(userCredential.user, {
            displayName: username
        });

        // Create user document in Firestore
        await setDoc(doc(db, 'users', userCredential.user.uid), {
            username: username,
            email: email,
            balance: 100,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
        });

        authModal.style.display = 'none';
        signUpForm.reset();
    } catch (error) {
        showAuthError('Sign up failed: ' + error.message);
    }
});

// Disconnect the current user session when the pill button gets clicked.
signOutBtn.addEventListener('click', async () => {
    try {
        await signOut(auth);
        uiLog('Signed out successfully');
    } catch (error) {
        uiLog('Sign out failed: ' + error.message);
    }
});

showSignUpBtn.addEventListener('click', toggleAuthForms);
showSignInBtn.addEventListener('click', toggleAuthForms);

// Initialize Firebase sync immediately
if (!auth.currentUser && authModal) {
    authModal.style.display = 'block';
}

// React to Firebase auth changes by wiring up Firestore listeners and updating the UI.
onAuthStateChanged(auth, async (user) => {
    clearUserSubscription();
    currentUser = user || null;

    if (user) {
        try {
            await ensureUserDocument(user);
            subscribeToUserDocument(user);

            authModal.style.display = 'none';
            currentUsername.textContent = user.displayName || user.email || 'Player';
            userInfo.style.display = 'flex';
            uiLog(`Signed in as ${currentUser.displayName || currentUser.email || currentUser.uid}`);
        } catch (error) {
            console.error('Post-auth initialization error:', error);
            uiLog('Failed to load account data; please refresh the page.');
        }
    } else {
        // Fall back to anonymous/idle UI when no authenticated session exists.
        currentUsername.textContent = '';
        userInfo.style.display = 'none';
        userBalance = 0;
        updateBalanceDisplay();

        if (authModal) {
            authModal.style.display = 'block';
        }
    }
});
