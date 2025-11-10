// Firebase SDK Imports (version 9.x)
import { initializeApp } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js";
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
    collection,
    getDocs,
    setDoc,
    doc,
    onSnapshot
} from "https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore.js";

// Firebase Configuration
const firebaseConfig = {
    apiKey: "AIzaSyBQieeHbz8glgWcp8_BDdoNFGGnBjodbRk",
    authDomain: "apigame-34134.firebaseapp.com",
    projectId: "apigame-34134",
    storageBucket: "apigame-34134.firebasestorage.app",
    messagingSenderId: "648910176965",
    appId: "1:648910176965:web:d93bf1f3348d9c3d60a6ac",
    measurementId: "G-WYL7L5K6C7"
};

// Initialize Firebase
let app;
try {
    app = initializeApp(firebaseConfig);
} catch (error) {
    console.error("Firebase initialization error:", error);
    uiLog("Firebase initialization failed. Check console for details.");
}

// Initialize Firebase services
const auth = getAuth(app);
const db = getFirestore(app);

// Reference to users collection
const usersCollection = collection(db, 'users');

// Firebase initialization and Firestore sync will be initialized after UI helpers are defined below.

// Basic client-side UI for a minefield gamble prototype.
// Users stored in localStorage as "mg_users".
const defaultUsersKey = 'mg_users_v1';

// --- Helpers ---
const $ = id => document.getElementById(id);
const fmt = v => Number(v).toFixed(2);

// --- State ---
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

// Current user data
let currentUser = null;
let userBalance = 100; // Default starting balance

// --- Init UI refs ---
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
function updateBalanceDisplay() {
    if (!auth.currentUser) {
        balanceEl.textContent = '--';
        return;
    }
    
    try {
        // Get balance from local storage with fallback to default
        let storedBalance = localStorage.getItem(`balance_${auth.currentUser.uid}`);
        
        // If no balance exists, initialize it
        if (storedBalance === null) {
            storedBalance = '100';
            localStorage.setItem(`balance_${auth.currentUser.uid}`, storedBalance);
        }
        
        // Convert to number and format
        userBalance = Number(storedBalance);
        balanceEl.textContent = '$' + fmt(userBalance);
        
        // Log balance update for debugging
        console.log(`Balance updated for ${auth.currentUser.displayName || auth.currentUser.email}: $${userBalance}`);
    } catch (error) {
        console.error('Error updating balance display:', error);
        balanceEl.textContent = 'Error';
    }
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
    if(game.active || !auth.currentUser) return false;
    
    const bet = Number(betEl.value) || 0;
    const gridSize = Number(gridSizeEl.value);
    const mineCount = Number(mineCountEl.value);
    
    if(bet <= 0){ 
        alert('Set a positive bet'); 
        return false; 
    }

    // Check current balance from local storage
    const balance = Number(localStorage.getItem(`balance_${auth.currentUser.uid}`)) || 0;
    if(bet > balance){ 
        // Only show Banana Challenge prompt if balance is 0 and round is idle
        if (balance === 0 && roundStatusEl.textContent === 'Idle') {
            const playChallenge = confirm('💰 You\'re out of money! Want to try the Banana Challenge to earn $100?');
            if (playChallenge) {
                log('🍌 Starting Banana Challenge to earn more funds...');
                showBananaChallenge().then(success => {
                    if (success) {
                        // Retry the round after successful challenge
                        startRound();
                    }
                });
            }
        } else {
            alert('Insufficient balance for this bet');
        }
        return false;
    }
    // lock bet by updating local storage
    localStorage.setItem(`balance_${auth.currentUser.uid}`, balance - bet);
    updateBalanceDisplay();
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
    startBtn.classList.remove('button-loading');
    log(`${auth.currentUser.displayName || 'Player'} started a round with $${fmt(bet)} on ${gridSize}x${gridSize} (${game.mineCount} mines)`);
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
    if(!game.active || !auth.currentUser) return;
    const win = game.potential;
    const currentBalance = Number(localStorage.getItem(`balance_${auth.currentUser.uid}`)) || 0;
    localStorage.setItem(`balance_${auth.currentUser.uid}`, currentBalance + win);
    log(`${auth.currentUser.displayName || 'Player'} cashed out $${fmt(win)} after picking ${game.picked} safe tiles.`);
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
    if(!auth.currentUser) return;
    
    // Disable cash out button immediately
    cashBtn.disabled = true;
    
    log(`${auth.currentUser.displayName || 'Player'} hit a mine and lost $${fmt(game.lockedBet)}.`);
    renderBoard(true);
    resetRound();
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
document.getElementById("submitBanana").addEventListener("click", async () => {
  // Get user's answer and remove any whitespace
  const userAnswer = document.getElementById("bananaAnswer").value.trim();
  
  // Get references to DOM elements we need
  const modal = document.getElementById("bananaModal");
  const resultElement = document.getElementById("bananaResult");
  
  if (!auth.currentUser) return;

  // Convert both user's answer and stored solution to numbers
  const userNum = Number(userAnswer);
  const solutionNum = Number(bananaSolution);

  if (!isNaN(userNum) && !isNaN(solutionNum) && userNum === solutionNum) {
    // CORRECT ANSWER HANDLING
    try {
      // Update local balance
      const currentBalance = Number(localStorage.getItem(`balance_${auth.currentUser.uid}`) || 0);
      localStorage.setItem(`balance_${auth.currentUser.uid}`, currentBalance + 100);

      // Visual feedback: Green success message
      resultElement.style.color = '#4CAF50';
      resultElement.textContent = '🎉 Correct! You earned $100! 🎉';
      
      // Show success message in game log
      log('🌟 Banana Challenge completed successfully! +$100 added to your balance.');
      
      // Update UI directly from local storage
      updateBalanceDisplay();
      
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
    // Visual feedback: Red error message with emoji
    resultElement.style.color = '#f44336';
    resultElement.textContent = '❌ Incorrect. Try again! ❌';
    
    // Shake the input field to indicate error
    const answerInput = document.getElementById("bananaAnswer");
    answerInput.classList.add('shake');
    setTimeout(() => answerInput.classList.remove('shake'), 500);
    
    // Log the failure with encouraging message
    log('❌ Challenge failed. Keep trying - you can do it!');
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

// Event listeners for game actions only
startBtn.addEventListener('click', (e) => {
    const button = e.target;
    button.classList.add('button-loading');
    const result = startRound();
    if (!result) {
        button.classList.remove('button-loading');
    }
});

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
// Initialize game board immediately
function initializeGame() {
    game.board = createBoard(game.gridSize, 0);
    renderBoard(true);
    updateHUD();
    log('Game board initialized');
}

// Initialize everything when DOM is ready
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

// Function to sync users to Firestore
async function syncUsersToFirestore() {
    if (!window.users || !Array.isArray(window.users)) {
        uiLog('No users to sync');
        return;
    }

    try {
        // Create a batch of promises to update all users
        const updatePromises = window.users.map(user => {
            const userDoc = doc(usersCollection, user.id);
            return setDoc(userDoc, {
                ...user,
                lastUpdated: new Date().toISOString()
            }, { merge: true });
        });

        // Wait for all updates to complete
        await Promise.all(updatePromises);
        uiLog('Successfully synced users to Firestore');
    } catch (error) {
        console.error('Error syncing users:', error);
        uiLog('Failed to sync users to Firestore');
    }
}

// Function to load users from Firestore
async function loadUsersFromFirestore() {
    try {
        const snapshot = await getDocs(usersCollection);
        if (snapshot.empty) {
            uiLog('No users found in Firestore');
            return;
        }

        // Update local users array
        window.users = snapshot.docs.map(doc => doc.data());
        refreshUserList();
        uiLog('Successfully loaded users from Firestore');
    } catch (error) {
        console.error('Error loading users:', error);
        uiLog('Failed to load users from Firestore');
    }
}

// Set up real-time sync
function setupRealtimeSync() {
    return onSnapshot(usersCollection, (snapshot) => {
        // Update local users array with changes
        window.users = snapshot.docs.map(doc => doc.data());
        refreshUserList();
        uiLog('Real-time update received from Firestore');
    }, (error) => {
        console.error('Realtime sync error:', error);
        uiLog('Real-time sync error occurred');
    });
}

// Override the original saveUsers function to include Firestore sync
const originalSaveUsers = window.saveUsers || (() => {});
window.saveUsers = async function() {
    // First call the original function
    originalSaveUsers();
    // Then sync to Firestore
    await syncUsersToFirestore();
};

// Authentication state observer
onAuthStateChanged(auth, async (user) => {
    if (user) {
        // User is signed in
        uiLog(`Authenticated as ${user.uid}`);
        
        // Load initial data
        await loadUsersFromFirestore();
        
        // Set up real-time sync
        const unsubscribe = setupRealtimeSync();
        
        // Store unsubscribe function for cleanup
        window.unsubscribeFirestore = unsubscribe;
    } else {
        // User is signed out
        uiLog('No user authenticated. Signing in anonymously...');
        try {
            await signInAnonymously(auth);
        } catch (error) {
            console.error('Anonymous auth error:', error);
            uiLog('Failed to sign in anonymously');
        }
    }
});

    // preserve original saveUsers/local behavior
// Auth UI Elements
const authModal = document.getElementById('authModal');
const signInForm = document.getElementById('signInForm');
const signUpForm = document.getElementById('signUpForm');
const showSignUpBtn = document.getElementById('showSignUp');
const showSignInBtn = document.getElementById('showSignIn');
const authError = document.getElementById('authError');
const userInfo = document.getElementById('userInfo');
const currentUsername = document.getElementById('currentUsername');
const signOutBtn = document.getElementById('signOut');

// Auth UI Functions
function showAuthError(message) {
    authError.textContent = message;
    authError.style.display = 'block';
}

function clearAuthError() {
    authError.textContent = '';
    authError.style.display = 'none';
}

function toggleAuthForms() {
    signInForm.style.display = signInForm.style.display === 'none' ? 'block' : 'none';
    signUpForm.style.display = signUpForm.style.display === 'none' ? 'block' : 'none';
    clearAuthError();
}

// Auth Event Handlers
signInForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearAuthError();

    const email = document.getElementById('signInEmail').value;
    const password = document.getElementById('signInPassword').value;

    try {
        const userCredential = await signInWithEmailAndPassword(auth, email, password);
        // Initialize balance if it doesn't exist
        const currentBalance = localStorage.getItem(`balance_${userCredential.user.uid}`);
        if (currentBalance === null) {
            localStorage.setItem(`balance_${userCredential.user.uid}`, '100');
        }
        updateBalanceDisplay();
        authModal.style.display = 'none';
        signInForm.reset();
    } catch (error) {
        showAuthError('Sign in failed: ' + error.message);
    }
});

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
            balance: 100, // Initial balance
            created: new Date().toISOString()
        });

        authModal.style.display = 'none';
        signUpForm.reset();
    } catch (error) {
        showAuthError('Sign up failed: ' + error.message);
    }
});

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
(async function initializeFirebaseSync() {
    // Expose helper functions to window
    window.refreshUserList = refreshUserList;
    window.log = log;
    
    // Show auth modal if not authenticated
    if (!auth.currentUser) {
        authModal.style.display = 'block';
    }

    // Set up auth state monitoring
    onAuthStateChanged(auth, async (user) => {
        if (user) {
            // Update UI
            authModal.style.display = 'none';
            currentUsername.textContent = user.displayName || user.email;
            userInfo.style.display = 'flex';
            
            // Initialize balance if it doesn't exist
            const currentBalance = localStorage.getItem(`balance_${user.uid}`);
            if (currentBalance === null) {
                localStorage.setItem(`balance_${user.uid}`, '100');
            }
            
            // Update balance display
            updateBalanceDisplay();
            
            uiLog(`Signed in as ${user.displayName || user.email}`);
            
            // Initial data load
            await loadUsersFromFirestore();
            
            // Set up real-time sync
            const unsubscribe = setupRealtimeSync();
            
            // Store unsubscribe function
            window.unsubscribeFirestore = unsubscribe;
        } else {
            // User is signed out
            authModal.style.display = 'block';
            currentUsername.textContent = '';
            userInfo.style.display = 'none';
            
            // Clear any sensitive data
            window.users = [];
            refreshUserList();
        }
    });

    // Override saveUsers to include Firestore sync
    const originalSaveUsers = window.saveUsers;
    window.saveUsers = async function() {
        if (typeof originalSaveUsers === 'function') {
            originalSaveUsers();
        }
        await syncUsersToFirestore();
    };
})();
